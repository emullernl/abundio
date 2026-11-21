//! A PTY's screen as text, kept in Rust (ADR-0063).
//!
//! Every PTY feeds its output into a [`Screen`]: an `alacritty_terminal`
//! emulator that only keeps the grid of cells and draws nothing (xterm.js
//! still draws every pane). Agent control reads a pane's text from here, so
//! it works with no Window open, as an Abundio server needs.
//!
//! [`Screen::read`] follows the rules of `src/lib/agentControl/readBuffer.ts`,
//! which reads xterm.js's buffer: wrapped rows are joined back into one line,
//! blank rows at the end are dropped, and a suggestion (dim text after the
//! cursor) is left out. Differences from xterm.js: `visible` is the screen
//! itself (there is no user scroll position here); trailing spaces are always
//! trimmed (a written space and an empty cell look the same); and clearing the
//! screen moves its rows into scrollback instead of erasing them.

use std::sync::{Arc, Mutex};

use alacritty_terminal::event::{Event, EventListener};
use alacritty_terminal::grid::Dimensions;
use alacritty_terminal::index::{Column, Line};
use alacritty_terminal::term::cell::{Cell, Flags};
use alacritty_terminal::term::{Config, Term};
use alacritty_terminal::vte::ansi::Processor;

/// The scrollback when nothing else is said: the app's default setting.
pub const DEFAULT_SCROLLBACK: usize = 1000;

struct Size {
    columns: usize,
    lines: usize,
}

impl Dimensions for Size {
    fn total_lines(&self) -> usize {
        self.lines
    }
    fn screen_lines(&self) -> usize {
        self.lines
    }
    fn columns(&self) -> usize {
        self.columns
    }
}

/// See [`Screen::modes`].
#[derive(Debug, Clone, Copy, Default, PartialEq, Eq)]
pub struct InputModes {
    /// DECSET 2004: wrap a paste in `ESC[200~` … `ESC[201~`.
    pub bracketed_paste: bool,
    /// DECCKM: arrows, Home and End as `ESC O x`.
    pub app_cursor: bool,
}

/// Keeps the titles the program set while output was fed (OSC 0 and 2; a
/// reset is an empty title, as xterm.js reports it). Every other event (the
/// replies a terminal writes back, the bell) is xterm.js's job.
#[derive(Clone, Default)]
struct Titles(Arc<Mutex<Vec<String>>>);

impl EventListener for Titles {
    fn send_event(&self, event: Event) {
        let title = match event {
            Event::Title(t) => t,
            Event::ResetTitle => String::new(),
            _ => return,
        };
        if let Ok(mut v) = self.0.lock() {
            v.push(title);
        }
    }
}

pub struct Screen {
    term: Term<Titles>,
    parser: Processor,
    titles: Titles,
}

impl Screen {
    pub fn new(columns: u16, lines: u16, scrollback: usize) -> Self {
        let size = Size {
            columns: columns.max(1) as usize,
            lines: lines.max(1) as usize,
        };
        let config = Config {
            scrolling_history: scrollback,
            ..Config::default()
        };
        let titles = Titles::default();
        Self {
            term: Term::new(config, &size, titles.clone()),
            parser: Processor::new(),
            titles,
        }
    }

    /// Feed PTY output, in order: the titles it set, in order.
    pub fn feed(&mut self, bytes: &[u8]) -> Vec<String> {
        self.parser.advance(&mut self.term, bytes);
        self.titles.0.lock().map(|mut v| std::mem::take(&mut *v)).unwrap_or_default()
    }

    pub fn resize(&mut self, columns: u16, lines: u16) {
        self.term.resize(Size {
            columns: columns.max(1) as usize,
            lines: lines.max(1) as usize,
        });
    }

    /// Keep this many lines of scrollback from now on.
    pub fn set_scrollback(&mut self, lines: usize) {
        self.term.set_options(Config {
            scrolling_history: lines,
            ..Config::default()
        });
    }

    /// The input modes a program has turned on, which decide the bytes a
    /// key or a paste must be sent as.
    pub fn modes(&self) -> InputModes {
        use alacritty_terminal::term::TermMode;
        let m = self.term.mode();
        InputModes {
            bracketed_paste: m.contains(TermMode::BRACKETED_PASTE),
            app_cursor: m.contains(TermMode::APP_CURSOR),
        }
    }

    /// The bytes that draw this screen again on a cleared terminal, for a
    /// Client that skipped ahead (phase 9, `screen_snapshot.rs`).
    pub fn snapshot(&self) -> Vec<u8> {
        crate::screen_snapshot::snapshot(&self.term)
    }

    /// The text as drawn, for `abundio pane read`. `visible` limits it to the
    /// screen; `lines` keeps only the last N lines after joining.
    pub fn read(&self, visible: bool, lines: Option<usize>) -> Vec<String> {
        let grid = self.term.grid();
        let columns = grid.columns();
        let top = if visible { Line(0) } else { grid.topmost_line() };
        let bottom = grid.bottommost_line();
        let cursor = grid.cursor.point;
        let wraps = |line: Line| grid[line][Column(columns - 1)].flags.contains(Flags::WRAPLINE);

        let mut out: Vec<String> = Vec::new();
        let mut line = top;
        while line <= bottom {
            let row = &grid[line];
            // Rows that continue onto the next keep their trailing spaces:
            // they are real characters in the middle of the joined line.
            let continues = line < bottom && wraps(line);
            let is_wrapped = line > top && wraps(line - 1);
            let cut = if line == cursor.line {
                suggestion_start(row, cursor.column.0, columns)
            } else {
                None
            };
            let end = cut.unwrap_or(columns);
            let mut text = row_text(row, end);
            if cut.is_some() || !continues {
                text.truncate(text.trim_end().len());
            }
            match out.last_mut() {
                Some(last) if is_wrapped => last.push_str(&text),
                _ => out.push(text),
            }
            line += 1;
        }
        while out.last().is_some_and(|l| l.trim().is_empty()) {
            out.pop();
        }
        match lines {
            Some(n) if n < out.len() => out.split_off(out.len() - n),
            _ => out,
        }
    }
}

fn row_text(row: &alacritty_terminal::grid::Row<Cell>, end: usize) -> String {
    let mut text = String::new();
    for x in 0..end {
        let cell = &row[Column(x)];
        if cell
            .flags
            .intersects(Flags::WIDE_CHAR_SPACER | Flags::LEADING_WIDE_CHAR_SPACER)
        {
            continue;
        }
        text.push(cell.c);
        if let Some(extra) = cell.zerowidth() {
            text.extend(extra.iter());
        }
    }
    text
}

/// Where a **suggestion** starts on a row, if it holds one from `from`: an
/// Agent's input box shows a suggested prompt as dim text right after the
/// cursor. Only when everything from the cursor on is dim or blank, and some
/// of it is dim text. Same rule as `suggestionStart` in `readBuffer.ts`.
fn suggestion_start(
    row: &alacritty_terminal::grid::Row<Cell>,
    from: usize,
    columns: usize,
) -> Option<usize> {
    let mut dim_text = false;
    for x in from..columns {
        let cell = &row[Column(x)];
        if cell.c.is_whitespace() || cell.flags.contains(Flags::WIDE_CHAR_SPACER) {
            continue;
        }
        if !cell.flags.contains(Flags::DIM) {
            return None;
        }
        dim_text = true;
    }
    dim_text.then_some(from)
}

#[cfg(test)]
mod tests {
    use super::*;

    /// A snapshot drawn on a fresh screen gives the same screen: text and
    /// scrollback, wrapped lines, colours, the cursor and the modes.
    #[test]
    fn a_snapshot_draws_the_same_screen_again() {
        use alacritty_terminal::term::TermMode;
        use crate::screen_snapshot::RESYNC_MARK;
        let mut a = Screen::new(20, 5, 100);
        for i in 0..12 {
            a.feed(format!("line {i}\r\n").as_bytes());
        }
        a.feed(b"\x1b[1;31mred\x1b[0m \x1b[48;5;22mbg\x1b[0m \x1b[38;2;1;2;3mrgb\x1b[0m\r\n");
        a.feed("a line long enough to wrap around twice, \u{4e16}\u{754c}\r\n".as_bytes());
        a.feed(b"\x1b[?2004h\x1b[?1h\x1b[?1000h\x1b[?1006h\x1b[?25lprompt> ");
        let snap = a.snapshot();
        assert!(snap.starts_with(RESYNC_MARK));
        let mut b = Screen::new(20, 5, 100);
        b.feed(&snap[RESYNC_MARK.len()..]);
        assert_eq!(b.read(false, None), a.read(false, None));
        assert_eq!(b.read(true, None), a.read(true, None));
        let (ga, gb) = (a.term.grid(), b.term.grid());
        assert_eq!(gb.cursor.point, ga.cursor.point);
        let modes = TermMode::BRACKETED_PASTE | TermMode::APP_CURSOR | TermMode::MOUSE_REPORT_CLICK | TermMode::SGR_MOUSE;
        assert!(b.term.mode().contains(modes));
        assert!(!b.term.mode().contains(TermMode::SHOW_CURSOR));
        // Every cell looks the same.
        let mut line = ga.topmost_line();
        while line <= ga.bottommost_line() {
            for x in 0..ga.columns() {
                let (ca, cb) = (&ga[line][Column(x)], &gb[line][Column(x)]);
                assert_eq!((ca.c, ca.fg, ca.bg), (cb.c, cb.fg, cb.bg), "{line:?} {x}");
            }
            line += 1;
        }
    }

    #[test]
    fn a_snapshot_of_the_alternate_screen_puts_each_row_in_place() {
        use crate::screen_snapshot::RESYNC_MARK;
        let mut a = Screen::new(20, 5, 100);
        a.feed(b"shell history\r\n\x1b[?1049h\x1b[2J\x1b[1;1Htop\x1b[5;3Hbottom\x1b[3;4H");
        let mut b = Screen::new(20, 5, 100);
        b.feed(&a.snapshot()[RESYNC_MARK.len()..]);
        assert_eq!(b.read(true, None), a.read(true, None));
        assert_eq!(b.term.grid().cursor.point, a.term.grid().cursor.point);
        assert!(b.term.mode().contains(alacritty_terminal::term::TermMode::ALT_SCREEN));
    }

    fn screen(cols: u16, rows: u16, input: &str) -> Screen {
        let mut s = Screen::new(cols, rows, 100);
        s.feed(input.as_bytes());
        s
    }

    #[test]
    fn reports_the_titles_a_program_sets() {
        let mut s = Screen::new(80, 24, 100);
        assert_eq!(s.feed(b"\x1b]0;>> Vibe\x07hi\x1b]2;? Vibe\x1b\\"), vec![">> Vibe", "? Vibe"]);
        assert!(s.feed(b"more").is_empty());
        // Split across reads, and a reset.
        assert!(s.feed(b"\x1b]2;Vi").is_empty());
        assert_eq!(s.feed(b"be\x07\x1b]2;\x07"), vec!["Vibe", ""]);
    }

    #[test]
    fn reads_lines_and_drops_the_blank_screen_below() {
        let s = screen(20, 5, "hello\r\nworld\r\n");
        assert_eq!(s.read(false, None), vec!["hello", "world"]);
    }

    #[test]
    fn trims_trailing_spaces() {
        let s = screen(20, 3, "a   \r\n");
        assert_eq!(s.read(false, None), vec!["a"]);
    }

    #[test]
    fn joins_a_line_the_terminal_wrapped() {
        let s = screen(5, 5, "abcdefghij-k\r\nnext");
        assert_eq!(s.read(false, None), vec!["abcdefghij-k", "next"]);
    }

    #[test]
    fn keeps_spaces_inside_a_wrapped_line() {
        // "abc  " fills the first row exactly, then wraps into "de".
        let s = screen(5, 3, "abc  de");
        assert_eq!(s.read(false, None), vec!["abc  de"]);
    }

    #[test]
    fn lines_keeps_only_the_last_n() {
        let s = screen(10, 6, "1\r\n2\r\n3\r\n4");
        assert_eq!(s.read(false, Some(2)), vec!["3", "4"]);
        assert_eq!(s.read(false, Some(10)), vec!["1", "2", "3", "4"]);
    }

    #[test]
    fn visible_reads_only_the_screen_but_all_reads_scrollback() {
        let s = screen(10, 2, "1\r\n2\r\n3\r\n4");
        assert_eq!(s.read(true, None), vec!["3", "4"]);
        assert_eq!(s.read(false, None), vec!["1", "2", "3", "4"]);
    }

    #[test]
    fn scrollback_is_limited_by_the_setting() {
        let mut s = Screen::new(10, 2, 1);
        s.feed(b"1\r\n2\r\n3\r\n4");
        assert_eq!(s.read(false, None), vec!["2", "3", "4"]);
    }

    #[test]
    fn leaves_out_a_dim_suggestion_after_the_cursor() {
        // "> " typed, then a dim suggestion drawn after the cursor and the
        // cursor moved back to where typing continues.
        let s = screen(30, 3, "> \x1b[2mfix the tests\x1b[0m\x1b[13D");
        assert_eq!(s.read(false, None), vec![">"]);
    }

    #[test]
    fn keeps_normal_text_after_the_cursor() {
        let s = screen(30, 3, "> hello world\x1b[5D");
        assert_eq!(s.read(false, None), vec!["> hello world"]);
    }

    #[test]
    fn keeps_dim_text_that_is_not_on_the_cursor_row() {
        let s = screen(30, 3, "\x1b[2mdim\x1b[0m\r\n> ");
        assert_eq!(s.read(false, None), vec!["dim", ">"]);
    }

    #[test]
    fn wide_characters_are_read_once() {
        let s = screen(10, 2, "a\u{4e2d}b");
        assert_eq!(s.read(false, None), vec!["a\u{4e2d}b"]);
    }

    #[test]
    fn alternate_screen_shows_only_what_is_on_it() {
        let s = screen(10, 3, "shell\r\n\x1b[?1049h\x1b[Htui");
        assert_eq!(s.read(false, None), vec!["tui"]);
    }

    #[test]
    fn resize_rewraps() {
        let mut s = screen(10, 3, "abcdefgh");
        s.resize(4, 3);
        assert_eq!(s.read(false, None), vec!["abcdefgh"]);
    }

    /// The cases `screenReadFixtures.test.ts` also runs through xterm.js.
    #[test]
    fn shared_fixtures() {
        let raw = include_str!("../../../../src/lib/__tests__/fixtures/screenRead.json");
        let doc: serde_json::Value = serde_json::from_str(raw).unwrap();
        for c in doc["cases"].as_array().unwrap() {
            let mut s = Screen::new(
                c["cols"].as_u64().unwrap() as u16,
                c["rows"].as_u64().unwrap() as u16,
                c["scrollback"].as_u64().unwrap() as usize,
            );
            s.feed(c["input"].as_str().unwrap().as_bytes());
            let got = s.read(
                c["visible"].as_bool().unwrap(),
                c["lines"].as_u64().map(|n| n as usize),
            );
            let want: Vec<String> = c["expected"]
                .as_array()
                .unwrap()
                .iter()
                .map(|v| v.as_str().unwrap().to_string())
                .collect();
            assert_eq!(got, want, "case: {}", c["name"]);
        }
    }

    #[test]
    fn a_clear_screen_keeps_the_old_rows_in_scrollback() {
        let s = screen(10, 3, "old\r\nrows\x1b[2J\x1b[Hnew");
        assert_eq!(s.read(true, None), vec!["new"]);
        assert_eq!(s.read(false, None), vec!["old", "rows", "new"]);
    }

    #[test]
    fn a_clear_screen_leaves_nothing_visible() {
        let s = screen(10, 3, "old\x1b[2J\x1b[H");
        assert_eq!(s.read(true, None), Vec::<String>::new());
    }

    #[test]
    fn reports_the_input_modes_a_program_turns_on() {
        let mut s = Screen::new(20, 5, 100);
        assert_eq!(s.modes(), InputModes::default());
        s.feed(b"\x1b[?2004h\x1b[?1h");
        assert_eq!(s.modes(), InputModes { bracketed_paste: true, app_cursor: true });
        s.feed(b"\x1b[?2004l");
        assert!(!s.modes().bracketed_paste);
    }

}
