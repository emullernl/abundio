---
status: accepted
---

# The dim slot is derived, not declared

A theme's **Dim slot** — ANSI colour 8, xterm's `brightBlack` — is no longer taken at face value from `themes.ts`. Two settings are computed from the theme instead: xterm's contrast floor, which becomes per-theme rather than the flat WCAG 4.5, and the slot's colour itself, which is overridden on the themes whose declared value cannot satisfy the contract.

See the **Dim slot** entry in CONTEXT.md.

## The bug this comes from

zsh-autosuggestions paints its suggestion with `fg=8`. On Solarized Dark the suggestion was indistinguishable from the command being typed — not merely similar, but measurably the same colour: 1.05:1 between them.

The cause is a three-step chain, and no step is wrong on its own.

Solarized ships `#002B36` in slot 8. That is not a mistake in our transcription; it is base03, and Solarized deliberately treats the sixteen slots as one shared palette with the base tones parked in 0, 8, 10, 11, 12, 14 and 15 rather than as eight light/dark pairs. In Solarized Dark, base03 *is* the background. Slot 8 is therefore invisible ink, which the spec tolerates because it does not expect anyone to print colour-8 text.

`terminalManager` then sets `minimumContrastRatio: 4.5`, for a good reason recorded in its own comment: powerline prompts paint light text on light ANSI backgrounds, and without a floor those segments are unreadable. xterm measures slot 8 at 1.00:1 against the background, concludes the text is illegible, and lightens it until it reaches 4.5:1.

And Solarized Dark's foreground is 4.75:1. The rescued slot and the body text end up a twentieth of a stop apart.

So the floor is not a one-off repair that a better palette value would settle — it is a permanent floor, reapplied on every paint. Any colour we write into slot 8 below 4.5:1 is lifted straight back to 4.5:1. On a theme whose foreground sits at 4.75:1 there is no room left underneath to be dim in.

## The contract binds the effective colour

Measured on the value declared in `themes.ts`, Solarized Dark's slot 8 scores a perfectly healthy 4.75:1 against the foreground. The theme looks fine. It is only after the correction lifts it that it collapses to 1.05:1.

This is the trap, and it is why the rule and its test are written against the **effective** colour — declared value, then floor applied — and never against the palette as authored. A reviewer checking hex codes would have cleared every theme in the file.

## What "dim" means

Slot 8's role is to recede: present, subordinate to what the user typed. The contract is that it lies **between the background and the foreground in luminance, nearer the background**, and at least **2:1** from the foreground.

Direction is not decoration on top of the ratio; it is half the rule. Solarized Light declares slot 8 as base03 again — near-black `#002B36` — which scores 3.37:1 from its `#657B83` foreground and passes any ratio test comfortably, while reading as *emphasis*. The suggestion shouts louder than the command. A rule made only of contrast would have certified it.

**Only slot 8 carries this contract.** Seventeen of nineteen themes have `white` or `brightWhite` within a hair of the foreground, and all seventeen are correct — slots 7 and 15 are supposed to be the body colour. Two themes have a further collision (Solarized Dark's `brightBlue` and Solarized Light's `brightYellow` are byte-identical to their foregrounds, the same base-tones-in-bright-slots wart), and those are left alone. The chromatic slots owe their hue, not their dimness; separating bright blue from the foreground would mean desaturating it or shifting it, and a bright blue that is not Solarized blue is a larger deviation than the grey nudge below. There is no palette-wide distinctness rule here, only one slot with a legibility contract.

## The floor guards the slot; it never places it

`minimumContrastRatio` becomes `min(4.5, fgContrast / 2.1)`.

The first design here let the floor do the *placing*: set the floor to `fgContrast / 2` and a lifted slot 8 lands exactly 2:1 under the body text. That is arithmetic about a minimal correction, and xterm's correction is not minimal. `increaseLuminance`/`reduceLuminance` (`common/Color.ts`) walk each channel 10% of its remaining distance per iteration and stop at the **first step past** the ratio, so the result overshoots the floor — away from the background, which is toward the foreground. How far depends on where a 10% step happens to land. Solarized Dark under that design would have come out around **1.59:1**, not the 2.00 the model predicted.

So the floor's only job is to be a floor: low enough that it never fires on slot 8, high enough to keep catching the powerline case it was added for. Fourteen of nineteen themes divide to more than 4.5 and clamp there, keeping the full WCAG floor. Only the low-contrast ones move — Solarized Dark to 2.26, Tokyo Night Day to 2.15, Solarized Light to 1.97, One Dark to 3.13, Rosé Pine Dawn to 3.17, Catppuccin Latte to 3.36.

**Three constants, not one, and the gaps between them are load-bearing.** Contrast ratios multiply along an ordered luminance triple: `cr(fg, c) · cr(c, bg) = fgContrast`. So "at least `DIM_SEPARATION` from the foreground" and "at least the floor from the background" are the *same* constraint from opposite ends, and dividing the floor by `DIM_SEPARATION` exactly would make them meet at a single point — which 8-bit rounding always falls off, on whichever side. A slot placed there lands a hair under the floor and is handed straight back to the correction it was written to escape, which pushes it toward the foreground and undoes the placement. Hence `DIM_SEPARATION` 2 (the contract), `DIM_PLACEMENT` 2.05 (what a placed slot aims for, so rounding cannot drop it under the contract), `DIM_FLOOR_DIVISOR` 2.1 (so a slot at 2.05 clears the floor outright).

**K = 2 rather than something nearer what already works.** Vesper, the theme that prompted the comparison, sits at 2.31. We cannot have that everywhere. The dim colour has to fit *underneath* the foreground, so on a theme whose foreground is only 4.75:1 off the background, a larger gap is bought by pushing the suggestion fainter until it starts to disappear on a bright screen. Low-contrast themes trade boldness for separation; K is where that dial is set.

## Six themes get an explicit slot

Any theme whose slot 8 fails the contract — after the real correction, not a model of it — gets a colour placed at `DIM_PLACEMENT` instead: Solarized Dark, Solarized Light, Tokyo Night Day, One Dark, Rosé Pine Dawn, Catppuccin Latte. Thirteen keep their palette byte for byte.

The placement preserves the declared colour's hue by blending it toward white or black until it reaches a target *luminance*. Walking toward the background instead is the obvious move and is wrong twice: for an inverted slot like Solarized Light's it has to pass through the foreground on the way, so a ratio-only predicate is satisfied before the walk starts and returns the colour unchanged; and a luminance target is always reachable, while a walk can run out of room.

**This changes colour 8 as a *background* too.** xterm has one slot for both roles and exposes no way to split them, so on Solarized Light a program painting `ESC[48;5;8m` now gets a pale grey bar where it got a near-black one. Accepted: the case is rare, and text painted on that bar is caught by the very floor this ADR makes per-theme.

## The model has to be the real algorithm

`xtermEnsureContrast` is a port of `rgba.ensureContrastRatio`, not an approximation, because two details that looked like implementation noise both changed the answer.

**It steps, it does not solve** — the overshoot above.

**Its direction is relative.** xterm goes *away from the background* (`fgL < bgL ? reduceLuminance : increaseLuminance`), not "toward white on a dark theme". The two rules agree on all nineteen built-ins, since every dark theme's slot 8 is lighter than its background and every light theme's is darker. They diverge for a slot darker than a dark background — modelled as a lift toward white while xterm pushes it toward black. A guard test whose whole job is to stop a future theme reintroducing this would have passed on a colour the app never paints.

The both-directions fallback is ported too: when one direction runs out of room without reaching the ratio, xterm tries the other and keeps whichever got closer.

## One seam, not four

`terminalThemeFor(theme)` returns `{ theme, fontWeight, minimumContrastRatio }` and is spread at both the construction site and `setAllTerminalsTheme`.

The looser shape — a fourth exported helper alongside `transparentBg` and `normalFontWeightFor`, called in both places — is what the file already did, and it had already failed once. `minimumContrastRatio` was added at construction and never added to `setAllTerminalsTheme`. That was harmless only while the value was a constant; the moment it varies by theme, switching Solarized Dark → Vesper at runtime would have carried Solarized's 2.37 floor into Vesper. Folding the derived settings into one object makes a fifth of them a field rather than two edits in two functions.

## Consequences

- **Powerline prompts are less protected on low-contrast themes.** The 4.5 floor exists for light text on a light ANSI background, and we lower it exactly where a segment is most likely to go unreadable. This is the trade, made knowingly: a prompt is glanced at, a suggestion is read on every keystroke. Anyone who later finds an illegible prompt on Solarized Dark and "fixes" it by restoring the 4.5 constant reintroduces the original bug invisibly — nothing tests a prompt, and the suggestion collapse is silent.
- **The contract is enforced across every theme by a table-driven test**, evaluated on the effective colour. A theme added later cannot reintroduce the bug by shipping a plausible-looking hex code, which is the failure mode that produced it the first time.
- **Two of the six deviate from a published palette.** Solarized purists can object, and the answer is that both deviations are the same known wart in the spec rather than a preference of ours: base03 sits in slot 8 in both Solarized variants, landing on the background in one and as near-black "dim" text in the other.
