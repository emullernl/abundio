//! **Last-actor PTY sizing** (docs/plans/remote-hosts.md phase 9). A pane
//! shown by several Clients (two desktop apps on one Host) has one PTY and
//! so one size. Each Client reports the size its own view of the pane has;
//! the PTY takes the size of whichever Client acted last: resized it, or
//! typed into it. Typing from a Client whose size is not the PTY's
//! switches the PTY to that Client's size first, so the program redraws
//! for the screen the user is looking at.

use std::collections::HashMap;
use std::sync::Mutex;

pub type Size = (u16, u16);

#[derive(Default)]
struct PtySize {
    /// Each Client's last reported size.
    by_client: HashMap<String, Size>,
    /// The size the PTY has now.
    applied: Option<Size>,
}

#[derive(Default)]
pub struct PtySizes {
    ptys: Mutex<HashMap<String, PtySize>>,
}

impl PtySizes {
    /// `client` sized its view of `pty`: the size to give the PTY (always
    /// this one: a resize is an act), or `None` when it already has it.
    pub fn resized(&self, client: &str, pty: &str, size: Size) -> Option<Size> {
        let mut ptys = self.ptys.lock().unwrap();
        let p = ptys.entry(pty.to_string()).or_default();
        p.by_client.insert(client.to_string(), size);
        (p.applied != Some(size)).then(|| {
            p.applied = Some(size);
            size
        })
    }

    /// `client` typed into `pty`: its size, if the PTY has another one.
    pub fn typed(&self, client: &str, pty: &str) -> Option<Size> {
        let mut ptys = self.ptys.lock().unwrap();
        let p = ptys.get_mut(pty)?;
        let size = *p.by_client.get(client)?;
        (p.applied != Some(size)).then(|| {
            p.applied = Some(size);
            size
        })
    }

    /// The PTY was sized by something other than a Client (a spawn).
    pub fn applied(&self, pty: &str, size: Size) {
        self.ptys.lock().unwrap().entry(pty.to_string()).or_default().applied = Some(size);
    }

    /// A Client is gone: its sizes no longer count.
    pub fn forget_client(&self, client: &str) {
        for p in self.ptys.lock().unwrap().values_mut() {
            p.by_client.remove(client);
        }
    }

    /// A PTY is gone.
    pub fn forget_pty(&self, pty: &str) {
        self.ptys.lock().unwrap().remove(pty);
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn the_size_follows_whoever_acted_last() {
        let s = PtySizes::default();
        s.applied("p", (80, 24));
        // A small laptop, then a big monitor, each resizing its view.
        assert_eq!(s.resized("laptop", "p", (100, 30)), Some((100, 30)));
        assert_eq!(s.resized("desk", "p", (200, 60)), Some((200, 60)));
        // Typing on the desk: already its size.
        assert_eq!(s.typed("desk", "p"), None);
        // Typing on the laptop: the PTY takes the laptop's size, once.
        assert_eq!(s.typed("laptop", "p"), Some((100, 30)));
        assert_eq!(s.typed("laptop", "p"), None);
        // Back to the desk.
        assert_eq!(s.typed("desk", "p"), Some((200, 60)));
        // A resize to the size it has already is no change.
        assert_eq!(s.resized("desk", "p", (200, 60)), None);
    }

    #[test]
    fn a_client_that_never_sized_the_pane_or_left_changes_nothing() {
        let s = PtySizes::default();
        assert_eq!(s.typed("w", "p"), None);
        s.resized("a", "p", (90, 20));
        s.resized("b", "p", (120, 40));
        s.forget_client("a");
        assert_eq!(s.typed("a", "p"), None);
        s.forget_pty("p");
        assert_eq!(s.typed("b", "p"), None);
    }
}
