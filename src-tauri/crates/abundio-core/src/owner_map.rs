//! Which Windows hold each per-workspace background worker.
//!
//! The git scheduler and file watcher are started and stopped from React
//! effects, but React cleanup never runs when a webview is destroyed — so a
//! closed Window used to leave its workers running for the rest of the
//! session, recomputing git status on every file change for nobody. Recording
//! the owning Window label lets the `Destroyed` handler release them, and keeps
//! one Window's stop from cutting off another Window watching the same key.

use std::collections::{HashMap, HashSet};
use std::sync::Mutex;

#[derive(Default)]
pub struct OwnerMap {
    owners: Mutex<HashMap<String, HashSet<String>>>,
}

impl OwnerMap {
    pub fn new() -> Self {
        Self::default()
    }

    /// Record `owner` as holding `key`. Returns true when `key` had no owner
    /// before, i.e. the caller should start the worker.
    pub fn claim(&self, key: &str, owner: &str) -> bool {
        let mut owners = self.owners.lock().unwrap();
        let set = owners.entry(key.to_string()).or_default();
        let first = set.is_empty();
        set.insert(owner.to_string());
        first
    }

    /// Drop `owner`'s hold on `key`. Returns true when nobody holds it any
    /// more, i.e. the caller should stop the worker. A key that was never
    /// claimed also returns true, so a stray stop still stops.
    pub fn release(&self, key: &str, owner: &str) -> bool {
        let mut owners = self.owners.lock().unwrap();
        match owners.get_mut(key) {
            None => true,
            Some(set) => {
                set.remove(owner);
                if set.is_empty() {
                    owners.remove(key);
                    true
                } else {
                    false
                }
            }
        }
    }

    /// Drop every hold `owner` has. Returns the keys nobody holds any more.
    pub fn release_owner(&self, owner: &str) -> Vec<String> {
        let mut owners = self.owners.lock().unwrap();
        let mut freed = Vec::new();
        owners.retain(|key, set| {
            set.remove(owner);
            if set.is_empty() {
                freed.push(key.clone());
                false
            } else {
                true
            }
        });
        freed
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn first_claim_starts_and_last_release_stops() {
        let m = OwnerMap::new();
        assert!(m.claim("ws", "window-a"));
        assert!(!m.claim("ws", "window-b"));
        assert!(!m.release("ws", "window-a"));
        assert!(m.release("ws", "window-b"));
    }

    #[test]
    fn repeat_claim_by_same_owner_is_one_hold() {
        let m = OwnerMap::new();
        assert!(m.claim("ws", "window-a"));
        assert!(!m.claim("ws", "window-a"));
        assert!(m.release("ws", "window-a"));
    }

    #[test]
    fn release_of_unclaimed_key_stops() {
        let m = OwnerMap::new();
        assert!(m.release("ws", "window-a"));
    }

    #[test]
    fn release_owner_frees_only_keys_nobody_else_holds() {
        let m = OwnerMap::new();
        m.claim("solo", "window-a");
        m.claim("shared", "window-a");
        m.claim("shared", "window-b");
        m.claim("other", "window-b");
        let mut freed = m.release_owner("window-a");
        freed.sort();
        assert_eq!(freed, vec!["solo".to_string()]);
        // window-b still holds "shared", and a fresh claim is not a first one.
        assert!(!m.claim("shared", "window-c"));
    }
}
