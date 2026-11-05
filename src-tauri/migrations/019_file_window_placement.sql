-- Window placement (ADR-0051): where a File window was — its monitor, its
-- spot on that monitor, its size, maximised/fullscreen and desktop — as the
-- JSON of `window_placement::Remembered`. NULL until the window is first
-- placed, and for every row written before this.
ALTER TABLE file_windows ADD COLUMN placement TEXT;
