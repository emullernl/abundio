//! Backend-internal "this folder changed" notices.
//!
//! The file watcher used to tell the git scheduler about changes by emitting
//! Tauri events that the scheduler listened to. That tied two backend modules
//! together through the desktop app's event bus, which an Abundio server does
//! not have (docs/plans/remote-hosts.md phase 1). Now the watcher calls
//! [`ChangeHub::notify`] and the scheduler subscribes here; the events to the
//! frontend are unchanged.

use std::sync::atomic::{AtomicU64, Ordering};

use crossbeam_channel::Sender;
use dashmap::DashMap;

#[derive(Default)]
pub struct ChangeHub {
    next_id: AtomicU64,
    subs: DashMap<u64, (String, Sender<()>)>,
}

impl ChangeHub {
    pub fn new() -> Self {
        Self::default()
    }

    /// Be told (with a `try_send`, so a busy subscriber coalesces) whenever
    /// something under `root` changes. Returns an id for [`unsubscribe`].
    ///
    /// [`unsubscribe`]: ChangeHub::unsubscribe
    pub fn subscribe(&self, root: &str, tx: Sender<()>) -> u64 {
        let id = self.next_id.fetch_add(1, Ordering::Relaxed);
        self.subs.insert(id, (root.to_string(), tx));
        id
    }

    pub fn unsubscribe(&self, id: u64) {
        self.subs.remove(&id);
    }

    /// Something under `root` changed (a file, or the git state).
    pub fn notify(&self, root: &str) {
        for sub in self.subs.iter() {
            let (r, tx) = sub.value();
            if r == root {
                let _ = tx.try_send(());
            }
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn notifies_only_subscribers_of_that_root() {
        let hub = ChangeHub::new();
        let (a_tx, a_rx) = crossbeam_channel::bounded(1);
        let (b_tx, b_rx) = crossbeam_channel::bounded(1);
        hub.subscribe("/a", a_tx);
        hub.subscribe("/b", b_tx);
        hub.notify("/a");
        assert!(a_rx.try_recv().is_ok());
        assert!(b_rx.try_recv().is_err());
    }

    #[test]
    fn a_full_subscriber_coalesces_instead_of_blocking() {
        let hub = ChangeHub::new();
        let (tx, rx) = crossbeam_channel::bounded(1);
        hub.subscribe("/a", tx);
        hub.notify("/a");
        hub.notify("/a");
        assert!(rx.try_recv().is_ok());
        assert!(rx.try_recv().is_err());
    }

    #[test]
    fn unsubscribed_hears_nothing() {
        let hub = ChangeHub::new();
        let (tx, rx) = crossbeam_channel::bounded(1);
        let id = hub.subscribe("/a", tx);
        hub.unsubscribe(id);
        hub.notify("/a");
        assert!(rx.try_recv().is_err());
    }
}
