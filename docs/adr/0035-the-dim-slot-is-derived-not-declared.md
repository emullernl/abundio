---
status: accepted
---

# The dim slot is derived, not declared

A theme's **Dim slot** — ANSI colour 8, xterm's `brightBlack` — is no longer taken at face value from `themes.ts`. Two settings are computed from the theme instead: xterm's contrast floor, which becomes per-theme rather than the flat WCAG 4.5, and the slot's colour itself, which is overridden on the themes whose declared value cannot satisfy the contract.

See the **Dim slot** entry in CONTEXT.md.

## The bug this comes from

zsh-autosuggestions paints its suggestion with `fg=8`. On Solarized Dark the suggestion was indistinguishable from the command being typed — not merely similar, but measurably the same colour: 1.06:1 between them.

The cause is a three-step chain, and no step is wrong on its own.

Solarized ships `#002B36` in slot 8. That is not a mistake in our transcription; it is base03, and Solarized deliberately treats the sixteen slots as one shared palette with the base tones parked in 0, 8, 10, 11, 12, 14 and 15 rather than as eight light/dark pairs. In Solarized Dark, base03 *is* the background. Slot 8 is therefore invisible ink, which the spec tolerates because it does not expect anyone to print colour-8 text.

`terminalManager` then sets `minimumContrastRatio: 4.5`, for a good reason recorded in its own comment: powerline prompts paint light text on light ANSI backgrounds, and without a floor those segments are unreadable. xterm measures slot 8 at 1.00:1 against the background, concludes the text is illegible, and lightens it until it reaches 4.5:1.

And Solarized Dark's foreground is 4.75:1. The rescued slot and the body text end up a twentieth of a stop apart.

So the floor is not a one-off repair that a better palette value would settle — it is a permanent floor, reapplied on every paint. Any colour we write into slot 8 below 4.5:1 is lifted straight back to 4.5:1. On a theme whose foreground sits at 4.75:1 there is no room left underneath to be dim in.

## The contract binds the effective colour

Measured on the value declared in `themes.ts`, Solarized Dark's slot 8 scores a perfectly healthy 4.75:1 against the foreground. The theme looks fine. It is only after the floor lifts it that it collapses to 1.06:1.

This is the trap, and it is why the rule and its test are written against the **effective** colour — declared value, then floor applied — and never against the palette as authored. A reviewer checking hex codes would have cleared every theme in the file.

## What "dim" means

Slot 8's role is to recede: present, subordinate to what the user typed. The contract is that it lies **between the background and the foreground in luminance, nearer the background**, and at least **2:1** from the foreground.

Direction is not decoration on top of the ratio; it is half the rule. Solarized Light declares slot 8 as base03 again — near-black `#002B36` — which scores 3.37:1 from its `#657B83` foreground and passes any ratio test comfortably, while reading as *emphasis*. The suggestion shouts louder than the command. A rule made only of contrast would have certified it.

**Only slot 8 carries this contract.** Seventeen of nineteen themes have `white` or `brightWhite` within a hair of the foreground, and all seventeen are correct — slots 7 and 15 are supposed to be the body colour. Two themes have a further collision (Solarized Dark's `brightBlue` and Solarized Light's `brightYellow` are byte-identical to their foregrounds, the same base-tones-in-bright-slots wart), and those are left alone. The chromatic slots owe their hue, not their dimness; separating bright blue from the foreground would mean desaturating it or shifting it, and a bright blue that is not Solarized blue is a larger deviation than the grey nudge below. There is no palette-wide distinctness rule here, only one slot with a legibility contract.

## The floor is per theme

`minimumContrastRatio` becomes `min(4.5, fgContrast / 2)`.

The divisor *is* the contract: a floor of `fgContrast / 2` is exactly what leaves the rescued slot sitting 2:1 below the body text. High-contrast themes divide to more than 4.5 and clamp there, so fourteen of nineteen themes keep the full WCAG floor unchanged. Only the low-contrast ones move: Solarized Dark to 2.37, Solarized Light to 2.06, Tokyo Night Day to 2.26, One Dark to 3.28, Rosé Pine Dawn to 3.33, Catppuccin Latte to 3.53.

That alone repairs Solarized Dark (1.06 → 2.00), Tokyo Night Day (1.01 → 2.00), One Dark (1.46 → 2.00) and Rosé Pine Dawn (1.48 → 2.00).

**K = 2 rather than something closer to what already works.** Vesper, the theme that prompted the comparison, sits at 2.80 and is comfortable. We cannot have that everywhere. The dim colour has to fit *underneath* the foreground, so on a theme whose foreground is only 4.75:1 off the background, a larger gap is bought by pushing the suggestion fainter — K = 2.5 would drop Solarized Dark's slot to 1.90:1 against the background, faint enough to start disappearing on a bright screen. Vesper affords 2.80 only because its text is at 12.59:1 and there is room below. Low-contrast themes trade boldness for separation; K is where that dial is set, and 2 keeps the suggestion legible on the worst case.

## Two themes still need their slot replaced

The floor cannot help where the declared slot already clears it.

Catppuccin Latte's `#6C6F85` is 1.62:1 from its foreground and stays there. It is nudged to `#7C7F92`.

Solarized Light's `#002B36` is the inverted case and no floor touches it. It becomes `#A6B1A8`.

Seventeen themes keep their palette byte for byte.

**This changes colour 8 as a *background* too.** xterm has one slot for both roles and exposes no way to split them, so on Solarized Light a program painting `ESC[48;5;8m` now gets a pale sage bar where it got a near-black one. Accepted: the case is rare, and text painted on that bar is caught by the very floor this ADR makes per-theme. The alternative was to exempt Solarized Light, which is the worst-affected theme of the nineteen — exempting it would exempt the one that most needs the fix.

## Two boundary facts the implementation had to learn

**The rule and the floor meet exactly.** Contrast ratios along an ordered luminance triple multiply exactly, so a slot held up by the floor sits `fgContrast / floor` from the foreground — and `floor` is `fgContrast / 2` by construction. Every theme rescued by the floor alone therefore lands on 2.00, not above it, approached from below by the search and then rounded to 8-bit channels. Six of nineteen themes failed their own rule by a few thousandths before `DIM_SEPARATION_TOLERANCE` was added. It is slack at the boundary the design puts most themes on, not defensive rounding.

**The override predicate carries direction, not just ratio.** Walking Solarized Light's near-black slot toward its cream background passes *through* the foreground. A ratio-only predicate is satisfied before the walk starts — colour 8 is already 3.37:1 from the foreground, on the wrong side of it — and returns the colour unchanged. Only points past the foreground count. The combined predicate is still monotonic along the blend, so the binary search remains valid.

## One seam, not four

`terminalThemeFor(theme)` returns `{ theme, fontWeight, minimumContrastRatio }` and is spread at both the construction site and `setAllTerminalsTheme`.

The looser shape — a fourth exported helper alongside `transparentBg` and `normalFontWeightFor`, called in both places — is what the file already did, and it had already failed once. `minimumContrastRatio` was added at construction and never added to `setAllTerminalsTheme`. That was harmless only while the value was a constant; the moment it varies by theme, switching Solarized Dark → Vesper at runtime would have carried Solarized's 2.37 floor into Vesper. Folding the derived settings into one object makes a fifth of them a field rather than two edits in two functions.

## Consequences

- **Powerline prompts are less protected on low-contrast themes.** The 4.5 floor exists for light text on a light ANSI background, and we lower it exactly where a segment is most likely to go unreadable. This is the trade, made knowingly: a prompt is glanced at, a suggestion is read on every keystroke. Anyone who later finds an illegible prompt on Solarized Dark and "fixes" it by restoring the 4.5 constant reintroduces the original bug invisibly — nothing tests a prompt, and the suggestion collapse is silent.
- **The contract is enforced across every theme by a table-driven test**, evaluated on the effective colour. A theme added later cannot reintroduce the bug by shipping a plausible-looking hex code, which is the failure mode that produced it the first time.
- **Two themes deviate from their published palette.** Solarized purists can object, and the answer is that both deviations are the same known wart in the spec rather than a preference of ours: base03 sits in slot 8 in both Solarized variants, landing on the background in one and as near-black "dim" text in the other.
