//! Where Abundio's own code may touch the OS clipboard.
//!
//! **macOS: the main thread only.** `NSPasteboard` is not thread-safe, and
//! WebKit reads it on the main thread for every native paste (Cmd+V). Smart
//! image paste lets that native paste run *and* asks Rust about the clipboard
//! at the same moment; when that read ran on a worker thread, the two could
//! overlap and macOS stopped the app (`__NSFastEnumerationMutationHandler`,
//! "Trace/BPT trap: 5", v4.2.0). Running every `arboard` call on the main
//! thread puts it in line behind WebKit's paste, so they can never overlap.
//!
//! Windows and Linux keep a blocking worker thread: their clipboards (an
//! `OpenClipboard` lock, X11 through arboard's own server thread) are safe to
//! use from any thread.
//!
//! Keep the work handed to [`on_clipboard_thread`] to the clipboard calls
//! themselves: on macOS it holds up the UI while it runs. Encoding and file
//! writes belong on a blocking thread after it.
//!
//! Not yet covered: `set_clipboard_rgba_arboard` (`clipboard_image.rs`) writes
//! from a blocking thread, which is fine only because it never runs on macOS;
//! and `tauri-plugin-clipboard-manager`'s `readText` / `writeText` (copy, the
//! right-click Paste) run on the plugin's own worker thread. Neither overlaps a
//! native paste today, but both should move here before macOS relies on them
//! alongside these reads.

use crate::error::AbundioError;
use std::panic::{catch_unwind, AssertUnwindSafe};
use std::time::Duration;

/// A job for the thread that may use the clipboard.
pub type Job = Box<dyn FnOnce() + Send + 'static>;

/// Something that runs a [`Job`] on another thread: the app's main thread in
/// the app, a plain thread in tests.
pub trait Runner {
    fn run(&self, job: Job) -> Result<(), String>;
}

impl<R: tauri::Runtime> Runner for tauri::AppHandle<R> {
    fn run(&self, job: Job) -> Result<(), String> {
        self.run_on_main_thread(job).map_err(|e| e.to_string())
    }
}

/// Run `f` on `runner`'s thread and wait for its result without blocking the
/// async runtime. A panic in `f` becomes an error instead of unwinding into
/// the event loop (which would end the app — the very thing this prevents).
///
/// Waits at most `wait`: the main thread only *queues* the job, and a modal
/// run loop (a native dialog, a menu being tracked) or a shutting-down event
/// loop can hold it back. Giving up is an error, which every caller already
/// treats as "nothing usable on the clipboard" (a paste falls back to the
/// native one). A job that runs after that only reads, so running late is
/// harmless.
pub async fn run_on<T, F>(runner: &impl Runner, wait: Duration, f: F) -> Result<T, AbundioError>
where
    T: Send + 'static,
    F: FnOnce() -> Result<T, AbundioError> + Send + 'static,
{
    let (tx, rx) = tokio::sync::oneshot::channel();
    runner
        .run(Box::new(move || {
            let out = catch_unwind(AssertUnwindSafe(f)).unwrap_or_else(|_| {
                Err(AbundioError::Clipboard("clipboard access panicked".into()))
            });
            let _ = tx.send(out);
        }))
        .map_err(|e| AbundioError::Clipboard(format!("main thread unavailable: {e}")))?;
    match tokio::time::timeout(wait, rx).await {
        Ok(Ok(out)) => out,
        Ok(Err(_)) => Err(AbundioError::Clipboard(
            "clipboard access was dropped".into(),
        )),
        Err(_) => Err(AbundioError::Clipboard(format!(
            "clipboard access timed out after {} ms",
            wait.as_millis()
        ))),
    }
}

/// Run `f`, which uses the clipboard, where that is safe: the main thread on
/// macOS (waiting at most `wait`, see [`run_on`]), a blocking worker
/// elsewhere.
pub async fn on_clipboard_thread<T, F, R>(
    app: &tauri::AppHandle<R>,
    wait: Duration,
    f: F,
) -> Result<T, AbundioError>
where
    T: Send + 'static,
    F: FnOnce() -> Result<T, AbundioError> + Send + 'static,
    R: tauri::Runtime,
{
    #[cfg(target_os = "macos")]
    {
        run_on(app, wait, f).await
    }
    #[cfg(not(target_os = "macos"))]
    {
        let _ = (app, wait);
        off_main_thread(f).await
    }
}

/// Run CPU-bound or blocking work (encoding, file writes) off the async
/// runtime.
pub async fn off_main_thread<T, F>(f: F) -> Result<T, AbundioError>
where
    T: Send + 'static,
    F: FnOnce() -> Result<T, AbundioError> + Send + 'static,
{
    tauri::async_runtime::spawn_blocking(f)
        .await
        .map_err(|e| AbundioError::Clipboard(format!("task join failed: {e}")))?
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::sync::mpsc;
    use std::thread;

    const WAIT: Duration = Duration::from_secs(5);

    /// Stands in for the main thread: one long-lived thread running jobs in
    /// order, as the event loop does.
    struct FakeMain {
        jobs: mpsc::Sender<Job>,
        id: thread::ThreadId,
    }

    impl FakeMain {
        fn start() -> Self {
            let (jobs, rx) = mpsc::channel::<Job>();
            let (id_tx, id_rx) = mpsc::channel();
            thread::spawn(move || {
                id_tx.send(thread::current().id()).unwrap();
                for job in rx {
                    job();
                }
            });
            Self {
                jobs,
                id: id_rx.recv().unwrap(),
            }
        }
    }

    impl Runner for FakeMain {
        fn run(&self, job: Job) -> Result<(), String> {
            self.jobs.send(job).map_err(|e| e.to_string())
        }
    }

    struct Refusing;

    impl Runner for Refusing {
        fn run(&self, _job: Job) -> Result<(), String> {
            Err("event loop gone".into())
        }
    }

    #[tokio::test]
    async fn the_work_runs_on_the_runners_thread_and_its_result_comes_back() {
        let main = FakeMain::start();
        let ran_on = run_on(&main, WAIT, || Ok(thread::current().id()))
            .await
            .unwrap();
        assert_eq!(ran_on, main.id);
        assert_ne!(ran_on, thread::current().id());
    }

    #[tokio::test]
    async fn an_error_from_the_work_is_returned_as_is() {
        let main = FakeMain::start();
        let err = run_on(&main, WAIT, || -> Result<(), _> {
            Err(AbundioError::Clipboard("read failed: x".into()))
        })
        .await
        .unwrap_err();
        assert_eq!(err.to_string(), "Clipboard error: read failed: x");
    }

    #[tokio::test]
    async fn a_panic_is_an_error_and_the_thread_lives_on() {
        let main = FakeMain::start();
        let err = run_on(&main, WAIT, || -> Result<(), _> { panic!("boom") })
            .await
            .unwrap_err();
        assert!(err.to_string().contains("panicked"), "{err}");
        // The "main thread" survived and still runs work.
        assert_eq!(run_on(&main, WAIT, || Ok(7)).await.unwrap(), 7);
    }

    #[tokio::test]
    async fn a_runner_that_refuses_the_job_is_an_error() {
        let err = run_on(&Refusing, WAIT, || Ok(())).await.unwrap_err();
        assert!(err.to_string().contains("main thread unavailable"), "{err}");
    }

    #[tokio::test]
    async fn a_job_held_back_past_the_wait_is_an_error_not_a_hang() {
        let main = FakeMain::start();
        // Something else holds the "main thread", as a modal run loop would.
        main.run(Box::new(|| thread::sleep(Duration::from_millis(500))))
            .unwrap();
        let err = run_on(&main, Duration::from_millis(50), || Ok(()))
            .await
            .unwrap_err();
        assert!(err.to_string().contains("timed out"), "{err}");
    }
}
