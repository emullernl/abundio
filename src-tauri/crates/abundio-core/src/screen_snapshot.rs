//! A PTY's screen as the bytes that draw it again (docs/plans/remote-hosts.md
//! phase 9, **skip-ahead**). A Client that falls too far behind a pane's
//! output stops getting it; once it can keep up again it gets this instead:
//! the screen and scrollback as the Host's emulator ([`crate::screen`]) has
//! them, with their colours, the cursor and the input modes a program set,
//! so the Window is where it would have been had it seen every byte.
//!
//! It starts with [`RESYNC_MARK`], which tells the Window to clear its
//! terminal first and write the rest as it is (`terminalManager.ts`).
//!
//! What it leaves out: the main screen's scrollback while a program uses the
//! alternate screen (the emulator gives only the screen in use), a scroll
//! region and the character sets. The server asks the program to redraw
//! after sending one, which sets those again for a full-screen program.

use alacritty_terminal::grid::Dimensions;
use alacritty_terminal::index::{Column, Line};
use alacritty_terminal::term::cell::{Cell, Flags};
use alacritty_terminal::term::{Term, TermMode};
use alacritty_terminal::vte::ansi::{Color, NamedColor};

/// The private sequence a snapshot starts with (OSC 7771, Abundio's own).
pub const RESYNC_MARK: &[u8] = b"\x1b]7771;resync\x07";

/// What changes a cell's look, for SGR.
#[derive(Clone, Copy, PartialEq)]
struct Pen {
    fg: Color,
    bg: Color,
    flags: Flags,
}

const LOOK: Flags = Flags::BOLD
    .union(Flags::DIM)
    .union(Flags::ITALIC)
    .union(Flags::ALL_UNDERLINES)
    .union(Flags::INVERSE)
    .union(Flags::HIDDEN)
    .union(Flags::STRIKEOUT);

impl Pen {
    const PLAIN: Pen = Pen {
        fg: Color::Named(NamedColor::Foreground),
        bg: Color::Named(NamedColor::Background),
        flags: Flags::empty(),
    };

    fn of(cell: &Cell) -> Pen {
        Pen { fg: cell.fg, bg: cell.bg, flags: cell.flags & LOOK }
    }

    fn sgr(&self, out: &mut Vec<u8>) {
        let mut p: Vec<String> = vec!["0".into()];
        let f = self.flags;
        for (flag, code) in [
            (Flags::BOLD, "1"),
            (Flags::DIM, "2"),
            (Flags::ITALIC, "3"),
            (Flags::INVERSE, "7"),
            (Flags::HIDDEN, "8"),
            (Flags::STRIKEOUT, "9"),
        ] {
            if f.contains(flag) {
                p.push(code.into());
            }
        }
        if f.contains(Flags::DOUBLE_UNDERLINE) {
            p.push("21".into());
        } else if f.intersects(Flags::ALL_UNDERLINES) {
            p.push("4".into());
        }
        color(self.fg, false, &mut p);
        color(self.bg, true, &mut p);
        out.extend_from_slice(format!("\x1b[{}m", p.join(";")).as_bytes());
    }
}

fn color(c: Color, bg: bool, p: &mut Vec<String>) {
    let (base, bright, ext) = if bg { (40, 100, 48) } else { (30, 90, 38) };
    match c {
        Color::Spec(rgb) => p.push(format!("{ext};2;{};{};{}", rgb.r, rgb.g, rgb.b)),
        Color::Indexed(i) => p.push(format!("{ext};5;{i}")),
        Color::Named(n) => {
            let n = n as usize;
            match n {
                0..=7 => p.push((base + n).to_string()),
                8..=15 => p.push((bright + n - 8).to_string()),
                // DimBlack … DimWhite: the colour itself (DIM says dim).
                259..=266 => p.push((base + n - 259).to_string()),
                // Foreground, Background, Cursor, Bright/DimForeground: the
                // default the reset already gave.
                _ => {}
            }
        }
    }
}

/// Write the cells of one row, from column 0 to `end`.
fn row<T>(term: &Term<T>, line: Line, end: usize, pen: &mut Pen, out: &mut Vec<u8>) {
    let grid = term.grid();
    let r = &grid[line];
    let mut buf = [0u8; 4];
    for x in 0..end {
        let cell = &r[Column(x)];
        if cell.flags.intersects(Flags::WIDE_CHAR_SPACER | Flags::LEADING_WIDE_CHAR_SPACER) {
            continue;
        }
        let look = Pen::of(cell);
        if look != *pen {
            look.sgr(out);
            *pen = look;
        }
        out.extend_from_slice(cell.c.encode_utf8(&mut buf).as_bytes());
        for z in cell.zerowidth().unwrap_or(&[]) {
            out.extend_from_slice(z.encode_utf8(&mut buf).as_bytes());
        }
    }
}

/// Where a row's content ends: past its last cell that is not a plain
/// space, so a row's trailing blanks cost nothing.
fn content_end<T>(term: &Term<T>, line: Line) -> usize {
    let grid = term.grid();
    let r = &grid[line];
    (0..grid.columns())
        .rev()
        .find(|&x| {
            let c = &r[Column(x)];
            c.c != ' ' || Pen::of(c) != Pen::PLAIN || c.zerowidth().is_some()
        })
        .map_or(0, |x| x + 1)
}

/// The bytes that draw `term` again on a cleared terminal of its size.
pub fn snapshot<T>(term: &Term<T>) -> Vec<u8> {
    let grid = term.grid();
    let columns = grid.columns();
    let mode = *term.mode();
    let mut out = RESYNC_MARK.to_vec();
    let mut pen = Pen::PLAIN;
    let wraps = |line: Line| grid[line][Column(columns - 1)].flags.contains(Flags::WRAPLINE);
    if mode.contains(TermMode::ALT_SCREEN) {
        // The alternate screen: each row in its place, no scrollback.
        out.extend_from_slice(b"\x1b[?1049h\x1b[H\x1b[2J");
        for y in 0..grid.screen_lines() {
            let line = Line(y as i32);
            out.extend_from_slice(format!("\x1b[{};1H", y + 1).as_bytes());
            row(term, line, content_end(term, line), &mut pen, &mut out);
        }
    } else {
        // Scrollback, then the screen, as lines: the last screen row ends
        // up on the last row, the rows above it scroll into scrollback.
        let mut line = grid.topmost_line();
        let bottom = grid.bottommost_line();
        while line <= bottom {
            // A wrapped row is written whole, so the next one continues it.
            let end = if line < bottom && wraps(line) { columns } else { content_end(term, line) };
            row(term, line, end, &mut pen, &mut out);
            if line < bottom && !wraps(line) {
                if pen.bg != Pen::PLAIN.bg {
                    // A new row must not take this one's background.
                    Pen::PLAIN.sgr(&mut out);
                    pen = Pen::PLAIN;
                }
                out.extend_from_slice(b"\r\n");
            }
            line += 1;
        }
    }
    // The pen the program was writing with, then the cursor.
    let cursor = &grid.cursor;
    let template = Pen { fg: cursor.template.fg, bg: cursor.template.bg, flags: cursor.template.flags & LOOK };
    template.sgr(&mut out);
    out.extend_from_slice(format!("\x1b[{};{}H", cursor.point.line.0 + 1, cursor.point.column.0 + 1).as_bytes());
    // The modes it set.
    let set = |on: bool, code: &str, out: &mut Vec<u8>| {
        if on {
            out.extend_from_slice(format!("\x1b[?{code}h").as_bytes());
        }
    };
    set(mode.contains(TermMode::APP_CURSOR), "1", &mut out);
    set(mode.contains(TermMode::MOUSE_REPORT_CLICK), "1000", &mut out);
    set(mode.contains(TermMode::MOUSE_DRAG), "1002", &mut out);
    set(mode.contains(TermMode::MOUSE_MOTION), "1003", &mut out);
    set(mode.contains(TermMode::FOCUS_IN_OUT), "1004", &mut out);
    set(mode.contains(TermMode::SGR_MOUSE), "1006", &mut out);
    set(mode.contains(TermMode::BRACKETED_PASTE), "2004", &mut out);
    if mode.contains(TermMode::APP_KEYPAD) {
        out.extend_from_slice(b"\x1b=");
    }
    if !mode.contains(TermMode::LINE_WRAP) {
        out.extend_from_slice(b"\x1b[?7l");
    }
    if !mode.contains(TermMode::SHOW_CURSOR) {
        out.extend_from_slice(b"\x1b[?25l");
    }
    out
}
