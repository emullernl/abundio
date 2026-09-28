/** Stacking layers that must keep their order relative to each other. Page
 *  content stays at 50 or below; menus and dialogs start at 100. */

/** The pane and workspace context menu (`PaneContextMenu`). */
export const Z_CONTEXT_MENU = 100;

/** The collapsed Left sidebar's hover popover. Above the page, but below
 *  every menu and dialog: the workspace context menu opens from it and must
 *  be drawn on top of it. */
export const Z_SIDEBAR_POPOVER = 90;
