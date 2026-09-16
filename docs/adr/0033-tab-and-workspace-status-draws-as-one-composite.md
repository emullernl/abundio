---
status: accepted (supersedes the Layout bullet of ADR-0032)
---

# Tab and Workspace status draws as one composite

ADR-0032 split Tab and Workspace status into an **Agent rollup** and a **Terminal rollup** and drew them as two icons of equal weight — stacked in a sidebar row, side by side on a Tab. The model was right; the drawing was not. Two marks of identical size on every row leave the reader to work out each time which one matters, and at a glance a sidebar full of them reads as noise rather than status. We keep the model exactly as ADR-0032 defined it and change only how the pair is drawn: one **Status composite** per Tab, per sidebar row and per **Hidden rollup** — a larger **Primary icon** with an optional small **Status badge** on its lower-right corner.

- **The Primary icon is the Agent rollup whenever any Agent exists**, otherwise the Terminal rollup. It is never displaced. A shell Error next to an idle Agent shows as a red badge on a calm green circle, not as a red primary — so the big icon always answers the same question and never changes what it is describing under the reader.
- **The badge is always the Terminal rollup, and never shows Idle.** It exists to surface what wants attention; idle shells are the normal case. When the Terminal rollup *is* the primary it shows Idle as usual — the suppression belongs to the badge, not to the rollup.
- **Absent when there are no PTYs of either kind.** ADR-0032's "absent, not Idle" rule is untouched; a never-opened Workspace keeps its grey "Not opened" primary.
- **One tooltip for the whole composite**, one line per present rollup. This is the only place a Terminal rollup's Idle count is always visible, so "my terminals are fine" and "I have no terminals" stay tellable apart.
- **Badges are shrunken glyphs, behind one constant.** At 8–9px a three-stroke breathing chevron may read as mush. The glyph-versus-dot choice is a single constant so it can be swapped without touching call sites.
- **The badge is offset outward**, most of it falling outside the primary's box. Every status glyph is a stroked outline, and two overlapping outlines read as neither. Offsetting also avoids a background plate, which would have to track the row's hover and active tints.
- **One geometry, shared by both sidebar widths.** Primary 14px, badge 8px, with the slot width including the badge's outward overhang; the sizes, slot width, left padding and gap live in one module that `WorkspaceItem` and `CollapsedStrip` both read. The narrow strip and the expanded row previously disagreed (12px/3px gap against 14px/4px), so the composite visibly jumped when the sidebar was collapsed or expanded — and worse, hovering a strip pops the expanded row out *on top of it*, animating the mismatch on every hover. The primary stays at 14 rather than growing: it already reads as twice its old weight by being one mark instead of one of two, and any increase is paid for out of the 56px strip's text, the most starved space in the app. Tabs use the same 14/8.
- **On a Worktree set's Primary row the fold chevron replaces the whole composite on hover**, retiring ADR-0032's promise that "the Terminal rollup and the row's Hidden rollup stay visible throughout, so the set's signal is never fully covered" — that reasoning depended on there being two separate icons. The Hidden rollup at the row's right end still stays visible, and the cover lasts only while the pointer is on the row.
- **The narrow strip's Hidden rollup becomes a `+N` label**, since there is no room for a second composite beside the first: neutral grey normally, tinted only for Error, Waiting or Ready — the same set that earns an OS notification, so a colour there means "something in here wants you", never "N things are running".

## Considered options

- **Promote a terminal Error to the primary slot**, demoting the Agent to the badge. Sharper for that one case, but the primary icon's meaning would flip under the reader, which is the entire thing this ADR is buying. Rejected.
- **A plain coloured dot instead of a glyph.** Legible at 7px and already used by the narrow strip's badge, but it drops the shared glyph vocabulary between pane, tab and sidebar. Rejected, with the constant left in place to reverse cheaply.
- **Roll the Hidden rollup's members into the row's own composite.** Would let the strip drop the `+N` tint, but it breaks ADR-0032's rule that the icon beside a name describes the Workspace that row activates. Rejected.

## Consequences

- A permanently cyan Terminal rollup — a dev server — is now a *large* animated element on a row where nothing needs attention. ADR-0032 accepted permanent cyan when it was one of two small equal icons; promoting it to the primary slot when a Workspace has no Agents makes that acceptance costlier. Accepted, and worth revisiting if it grates.
- The absence of a badge covers two states, "shells are idle" and "there are no shells". Only the tooltip separates them.
- The narrow sidebar can no longer show a folded set's mundane running/idle status at all — only attention-worthy states tint the `+N`.
- `ptyActivityStore` is untouched: `computeWorkspaceRollups`, `computeTabRollups`, `mergeRollups`, the encode/decode keys and their test tables all stand. The work is one new presentational component plus four call sites (`WorkspaceItem` left slot, `WorkspaceItem` Hidden rollup, `CollapsedStrip`, `TabBar`). `OverviewBar` and `StatusBar` are unaffected.
