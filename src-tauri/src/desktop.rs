//! The desktop part of a **Window placement** (ADR-0051): which macOS Space,
//! Windows virtual desktop or X11 workspace a window is on, read as an opaque
//! string and put back at app start. Best effort throughout: a desktop that
//! cannot be read is `None`, and one that cannot be restored leaves the window
//! on the current desktop.
//!
//! - **macOS:** the window's AppKit restorable state (base64 of a keyed
//!   archive), replayed through a decoder that answers the private
//!   `_windowRestorationOptions`, as Chromium does. macOS has no public API for
//!   this (FB22128442). Proven on macOS 26.7.1 by `prototypes/space-restore`.
//! - **Windows:** the desktop GUID from the public `IVirtualDesktopManager`.
//! - **X11:** the `_NET_WM_DESKTOP` number. Wayland has none.
//!
//! Every function here must run on the main thread; [`on_main`] gets there.

use std::sync::mpsc;
use std::time::Duration;
use tauri::{AppHandle, Wry};

static MAIN_THREAD: std::sync::OnceLock<std::thread::ThreadId> = std::sync::OnceLock::new();

/// Records the current thread as the main thread. Call it once, from
/// `setup()`, which Tauri runs on the main thread.
pub fn mark_main_thread() {
    let _ = MAIN_THREAD.set(std::thread::current().id());
}

fn on_main_thread() -> bool {
    #[cfg(target_os = "macos")]
    {
        objc2::MainThreadMarker::new().is_some()
    }
    #[cfg(not(target_os = "macos"))]
    {
        MAIN_THREAD.get() == Some(&std::thread::current().id())
    }
}

/// Runs `f` on the main thread and waits for its result. Runs it directly when
/// already there.
///
/// `None` if the main thread did not answer within two seconds. That is a
/// timeout, not a cancel: `f` is still queued and may run later, so a caller
/// must not treat `None` as "it did not happen".
pub fn on_main<T: Send + 'static>(
    app: &AppHandle<Wry>,
    f: impl FnOnce() -> T + Send + 'static,
) -> Option<T> {
    if on_main_thread() {
        return Some(f());
    }
    let (tx, rx) = mpsc::channel();
    app.run_on_main_thread(move || {
        let _ = tx.send(f());
    })
    .ok()?;
    rx.recv_timeout(Duration::from_secs(2)).ok()
}

pub use platform::{is_on_current, read, restore_after_show, restore_before_show, step_back};

#[cfg(target_os = "macos")]
mod platform {
    use base64::Engine;
    use objc2::rc::Retained;
    use objc2::runtime::{AnyClass, AnyObject, NSObject, NSObjectProtocol, ProtocolObject};
    use objc2::{define_class, msg_send, AllocAnyThread, ClassType, DefinedClass};
    use objc2_app_kit::{NSView, NSWindow};
    use objc2_foundation::{NSData, NSError, NSKeyedArchiver, NSKeyedArchiverDelegate, NSKeyedUnarchiver};
    use std::ptr;
    use tauri::WebviewWindow;

    define_class!(
        /// Keeps the archiver from encoding the window itself, or any view,
        /// when they are referenced from its restorable state (the first
        /// responder, say). AppKit's own restoration coder does the same.
        // SAFETY (all of define_class!): a plain NSObject subclass; the
        // delegate method's signature matches NSKeyedArchiverDelegate's
        // `archiver:willEncodeObject:` (returns the object to encode, or nil).
        #[unsafe(super(NSObject))]
        #[name = "AbundioRestorableStateFilter"]
        #[ivars = usize]
        struct Filter;

        unsafe impl NSObjectProtocol for Filter {}

        unsafe impl NSKeyedArchiverDelegate for Filter {
            #[unsafe(method(archiver:willEncodeObject:))]
            fn will_encode(&self, _archiver: &NSKeyedArchiver, object: &AnyObject) -> *mut AnyObject {
                if object as *const AnyObject as usize == *self.ivars() {
                    return ptr::null_mut();
                }
                // SAFETY: `isKindOfClass:` exists on every object the archiver
                // hands a delegate, and takes and returns plain values.
                let is_view: bool = unsafe { msg_send![object, isKindOfClass: NSView::class()] };
                if is_view {
                    return ptr::null_mut();
                }
                object as *const AnyObject as *mut AnyObject
            }
        }
    );

    define_class!(
        /// The decoder that makes AppKit put a restored window back on its
        /// Space. Returning a default-initialised `NSWindowRestorationOptions`
        /// from `_windowRestorationOptions` is the whole trick (Chromium's
        /// `RestorationOptionsKeyedUnarchiver`).
        // SAFETY (all of define_class!): the superclass chain is AppKit's own
        // (NSKeyedUnarchiver → NSCoder → NSObject), and the one method added
        // takes no arguments and returns an autoreleased object or nil.
        #[unsafe(super(NSKeyedUnarchiver, objc2_foundation::NSCoder, NSObject))]
        #[name = "AbundioRestorationOptionsUnarchiver"]
        struct Unarchiver;

        impl Unarchiver {
            #[unsafe(method(_windowRestorationOptions))]
            fn restoration_options(&self) -> *mut AnyObject {
                let Some(class) = AnyClass::get(c"NSWindowRestorationOptions") else {
                    return ptr::null_mut();
                };
                // SAFETY: `new` on a class that exists (checked just above)
                // returns a +1 object, which `Retained` takes over.
                let options: Retained<AnyObject> = unsafe { msg_send![class, new] };
                Retained::autorelease_return(options)
            }
        }
    );

    fn ns_window(window: &WebviewWindow) -> Option<&NSWindow> {
        let p = window.ns_window().ok()? as *const NSWindow;
        // SAFETY: called on the main thread while `window` is held, so AppKit
        // cannot free the NSWindow under us (see window_raise.rs).
        (!p.is_null()).then(|| unsafe { &*p })
    }

    pub fn read(window: &WebviewWindow) -> Option<String> {
        let w = ns_window(window)?;
        let archiver = NSKeyedArchiver::initRequiringSecureCoding(NSKeyedArchiver::alloc(), true);
        let filter = Filter::alloc().set_ivars(w as *const NSWindow as usize);
        // SAFETY: NSObject's `init` on our freshly allocated subclass, whose
        // ivars were just set.
        let filter: Retained<Filter> = unsafe { msg_send![super(filter), init] };
        // SAFETY: main thread (see the module docs), `w` is alive (above), and
        // `filter` outlives the archiver's use of it: both live to the end of
        // this function, and `finishEncoding` runs before either is dropped.
        unsafe {
            archiver.setDelegate(Some(ProtocolObject::from_ref(&*filter)));
            w.encodeRestorableStateWithCoder(&archiver);
        }
        archiver.finishEncoding();
        let data = archiver.encodedData();
        Some(base64::engine::general_purpose::STANDARD.encode(data.to_vec()))
    }

    pub fn restore_before_show(window: &WebviewWindow, key: &str) {
        let Some(w) = ns_window(window) else { return };
        let Ok(bytes) = base64::engine::general_purpose::STANDARD.decode(key) else {
            return;
        };
        let data = NSData::with_bytes(&bytes);
        // `initForReadingFromData:error:` requires secure coding, which
        // AppKit's restoration asserts on: with it off the app aborts.
        // SAFETY: `initForReadingFromData:error:` on a freshly allocated
        // NSKeyedUnarchiver subclass; a null error pointer is allowed. The data
        // is our own archive, read back from windows.json or the database.
        let decoder: Option<Retained<Unarchiver>> = unsafe {
            msg_send![
                Unarchiver::alloc(),
                initForReadingFromData: &*data,
                error: ptr::null_mut::<*mut NSError>()
            ]
        };
        let Some(decoder) = decoder else { return };
        // SAFETY: main thread, `w` is alive, and the decoder requires secure
        // coding, so only NSSecureCoding classes can come out of the archive.
        unsafe {
            w.restoreStateWithCoder(&decoder);
            decoder.finishDecoding();
        }
    }

    /// The Space was set before the window was shown, and macOS gives no
    /// public way to check which one it landed on.
    pub fn restore_after_show(_window: &WebviewWindow, _key: &str) -> bool {
        true
    }

    pub fn is_on_current(window: &WebviewWindow) -> bool {
        ns_window(window).is_none_or(|w| w.isOnActiveSpace())
    }

    /// Stops being the active app. An active app that shows a window while it
    /// has no key window gets that window made key by AppKit, and a key window
    /// on another Space switches the user there. tao activates the app at
    /// launch, before any window exists, so restored windows are shown with
    /// the app stepped back, and one is focused afterwards.
    pub fn step_back() {
        if let Some(mtm) = objc2::MainThreadMarker::new() {
            objc2_app_kit::NSApplication::sharedApplication(mtm).deactivate();
        }
    }
}

#[cfg(windows)]
mod platform {
    use tauri::WebviewWindow;
    use windows::core::GUID;
    use windows::Win32::System::Com::{CoCreateInstance, CLSCTX_ALL};
    use windows::Win32::UI::Shell::{IVirtualDesktopManager, VirtualDesktopManager};

    fn manager() -> Option<IVirtualDesktopManager> {
        // SAFETY: COM is initialised on the main thread by WebView2.
        unsafe { CoCreateInstance(&VirtualDesktopManager, None, CLSCTX_ALL).ok() }
    }

    fn desktop_of(window: &WebviewWindow) -> Option<GUID> {
        let hwnd = window.hwnd().ok()?;
        // SAFETY: takes a handle; a stale one makes the call fail.
        let id = unsafe { manager()?.GetWindowDesktopId(hwnd).ok()? };
        (id != GUID::zeroed()).then_some(id)
    }

    pub fn read(window: &WebviewWindow) -> Option<String> {
        desktop_of(window).map(|g| format!("{:032x}", g.to_u128()))
    }

    pub fn restore_before_show(_window: &WebviewWindow, _key: &str) {}

    /// Moves the shown window to its desktop. `false` when that desktop is
    /// gone (the move fails, or the window is elsewhere afterwards).
    pub fn restore_after_show(window: &WebviewWindow, key: &str) -> bool {
        let Ok(n) = u128::from_str_radix(key, 16) else { return false };
        let target = GUID::from_u128(n);
        let (Some(mgr), Ok(hwnd)) = (manager(), window.hwnd()) else {
            return false;
        };
        // SAFETY: as above.
        if unsafe { mgr.MoveWindowToDesktop(hwnd, &target) }.is_err() {
            return false;
        }
        desktop_of(window) == Some(target)
    }

    pub fn is_on_current(window: &WebviewWindow) -> bool {
        let (Some(mgr), Ok(hwnd)) = (manager(), window.hwnd()) else {
            return true;
        };
        // SAFETY: as above.
        unsafe { mgr.IsWindowOnCurrentVirtualDesktop(hwnd) }
            .map(|b| b.as_bool())
            .unwrap_or(true)
    }

    /// Windows does not focus a window shown with `SW_SHOWNOACTIVATE`.
    pub fn step_back() {}
}

#[cfg(target_os = "linux")]
mod platform {
    use gdkx11::{X11Screen, X11Window};
    use gtk::glib::Cast;
    use gtk::prelude::*;
    use tauri::WebviewWindow;

    /// `None` on Wayland, where a window has no desktop the app can see.
    fn x11(window: &WebviewWindow) -> Option<X11Window> {
        window.gtk_window().ok()?.window()?.downcast::<X11Window>().ok()
    }

    fn screen_of(w: &X11Window) -> Option<X11Screen> {
        // `screen` is gdk::Window's own method; on the subclass, the gtk
        // prelude would pick GtkWindowExt::screen instead.
        w.upcast_ref::<gtk::gdk::Window>().screen().downcast::<X11Screen>().ok()
    }

    pub fn read(window: &WebviewWindow) -> Option<String> {
        x11(window).map(|w| w.desktop().to_string())
    }

    pub fn restore_before_show(_window: &WebviewWindow, _key: &str) {}

    /// `false` when the desktop is gone (fewer desktops than its number).
    ///
    /// The move waits until the window is mapped: Tauri shows it
    /// asynchronously, and window managers ignore a desktop request for a
    /// window that is not on screen yet (EWMH: only non-withdrawn windows).
    pub fn restore_after_show(window: &WebviewWindow, key: &str) -> bool {
        let Ok(n) = key.parse::<u32>() else { return false };
        let Ok(gtk_window) = window.gtk_window() else { return false };
        let screen = WidgetExt::screen(&gtk_window).and_then(|s| s.downcast::<X11Screen>().ok());
        let Some(screen) = screen else {
            return false;
        };
        if n >= screen.number_of_desktops() {
            return false;
        }
        let move_to = move |w: &gtk::ApplicationWindow| {
            if let Some(x) = w.window().and_then(|g| g.downcast::<X11Window>().ok()) {
                x.move_to_desktop(n);
            }
        };
        if gtk_window.is_mapped() {
            move_to(&gtk_window);
            return true;
        }
        let handler = std::rc::Rc::new(std::cell::RefCell::new(None));
        let handler_in = handler.clone();
        let id = gtk_window.connect_map_event(move |w, _| {
            move_to(w);
            if let Some(id) = handler_in.take() {
                w.disconnect(id);
            }
            gtk::glib::Propagation::Proceed
        });
        handler.replace(Some(id));
        true
    }

    pub fn is_on_current(window: &WebviewWindow) -> bool {
        let Some(w) = x11(window) else { return true };
        screen_of(&w).is_none_or(|s| s.current_desktop() == w.desktop())
    }

    pub fn step_back() {}
}

#[cfg(not(any(target_os = "macos", windows, target_os = "linux")))]
mod platform {
    use tauri::WebviewWindow;
    pub fn read(_window: &WebviewWindow) -> Option<String> {
        None
    }
    pub fn restore_before_show(_window: &WebviewWindow, _key: &str) {}
    pub fn restore_after_show(_window: &WebviewWindow, _key: &str) -> bool {
        false
    }
    pub fn is_on_current(_window: &WebviewWindow) -> bool {
        true
    }
    pub fn step_back() {}
}
