//! Raise windows above others **without focusing them**: the **Markdown
//! window raise** (see GLOSSARY.md). Tauri has `set_focus()` but no raise that
//! leaves keyboard focus where it is, so each platform gets a few native calls.
//!
//! Only windows already visible on the current desktop are raised. A minimised
//! window stays minimised, and a window on another macOS Space or virtual
//! desktop stays there, so a raise never moves the user to another desktop.
//! Everything is best effort: where the platform refuses, the window stays put.

use tauri::{AppHandle, WebviewWindow, Wry};

/// Raises `windows` without taking focus. The native calls run on the main
/// thread, which AppKit and GTK both require.
pub fn raise_without_focus(app: &AppHandle<Wry>, windows: Vec<WebviewWindow>) {
    if windows.is_empty() {
        return;
    }
    if let Err(e) = app.run_on_main_thread(move || platform::raise(&windows)) {
        eprintln!("[abundio] window raise: {e}");
    }
}

#[cfg(target_os = "macos")]
mod platform {
    use objc2::MainThreadMarker;
    use objc2_app_kit::{NSApplication, NSWindow};
    use tauri::WebviewWindow;

    pub fn raise(windows: &[WebviewWindow]) {
        let Some(mtm) = MainThreadMarker::new() else {
            return;
        };
        let mut targets: Vec<*const NSWindow> = windows
            .iter()
            .filter_map(|w| w.ns_window().ok())
            .map(|p| p as *const NSWindow)
            .filter(|p| !p.is_null())
            .collect();

        // Keep their order among themselves: raise back-to-front, using the
        // app's current stacking (`orderedWindows` is frontmost first). A window
        // missing from it counts as backmost.
        let ordered = NSApplication::sharedApplication(mtm).orderedWindows();
        let depth = |p: *const NSWindow| -> usize {
            (0..ordered.count())
                .find(|&i| std::ptr::eq(&*ordered.objectAtIndex(i), p))
                .unwrap_or(usize::MAX)
        };
        targets.sort_by_key(|&p| std::cmp::Reverse(depth(p)));

        for p in targets {
            // SAFETY: `p` came from `ns_window()` earlier in this same
            // main-thread closure, and we still hold its `WebviewWindow`.
            // AppKit frees windows only on the main thread, so nothing can
            // release it between that call and this dereference.
            let w: &NSWindow = unsafe { &*p };
            if !w.isVisible() || w.isMiniaturized() || !w.isOnActiveSpace() {
                continue;
            }
            // `orderFront:` moves the window up without making it key, so
            // keyboard input stays in the Window the user switched in.
            w.orderFront(None);
        }
    }
}

#[cfg(windows)]
mod platform {
    use tauri::WebviewWindow;
    use windows::Win32::UI::WindowsAndMessaging::{
        IsIconic, IsWindowVisible, SetWindowPos, HWND_TOP, SWP_NOACTIVATE, SWP_NOMOVE,
        SWP_NOSIZE,
    };

    pub fn raise(windows: &[WebviewWindow]) {
        for w in windows {
            let Ok(hwnd) = w.hwnd() else { continue };
            // SAFETY: these calls take a handle, not a pointer. A handle that
            // went stale since `hwnd()` makes them fail or return false;
            // no memory is read through it.
            unsafe {
                if IsIconic(hwnd).as_bool() || !IsWindowVisible(hwnd).as_bool() {
                    continue;
                }
                // `SWP_NOACTIVATE`: raise only. This never switches virtual
                // desktop, so no desktop check is needed.
                let _ = SetWindowPos(
                    hwnd,
                    Some(HWND_TOP),
                    0,
                    0,
                    0,
                    0,
                    SWP_NOMOVE | SWP_NOSIZE | SWP_NOACTIVATE,
                );
            }
        }
    }
}

#[cfg(target_os = "linux")]
mod platform {
    use gtk::prelude::*;
    use tauri::WebviewWindow;

    pub fn raise(windows: &[WebviewWindow]) {
        for w in windows {
            let Ok(gtk_window) = w.gtk_window() else { continue };
            if !gtk_window.is_visible() {
                continue;
            }
            let Some(gdk_window) = gtk_window.window() else { continue };
            if gdk_window.state().contains(gtk::gdk::WindowState::ICONIFIED) {
                continue;
            }
            // Works on X11. Wayland compositors usually ignore it, and the
            // window stays where it is.
            gdk_window.raise();
        }
    }
}

#[cfg(not(any(target_os = "macos", windows, target_os = "linux")))]
mod platform {
    pub fn raise(_windows: &[tauri::WebviewWindow]) {}
}
