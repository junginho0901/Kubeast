---
version: alpha
name: Kubeast console
description: An operations console in three colour modes — deep navy (default), neutral grey (dark), off-white (light) — with one sky accent and colour only where it means something.
colors:
  primary: "#027ac0"
  primary-hover: "#0369a1"
  primary-bright: "#38bdf8"
  on-primary: "#ffffff"
  ink: "#ffffff"
  canvas: "#020618"
  surface: "#0f172b"
  surface-raised: "#1d293d"
  hairline: "#1d293d"
  on-surface: "#f1f5f9"
  text-muted: "#90a1b9"
  text-faint: "#73859d"
  success: "#4ade80"
  warning: "#facc15"
  error: "#f87171"
  brand-ground: "#020617"
typography:
  headline-lg:
    fontFamily: Inter
    fontSize: 30px
    fontWeight: 600
    lineHeight: 36px
    letterSpacing: -0.6px
  headline-md:
    fontFamily: Inter
    fontSize: 18px
    fontWeight: 600
    lineHeight: 28px
    letterSpacing: -0.36px
  stat:
    fontFamily: Inter
    fontSize: 24px
    fontWeight: 600
    lineHeight: 32px
  body-md:
    fontFamily: Inter
    fontSize: 14px
    fontWeight: 400
    lineHeight: 20px
  label-md:
    fontFamily: Inter
    fontSize: 12px
    fontWeight: 600
    lineHeight: 16px
rounded:
  sm: 4px
  md: 8px
  card: 12px
  full: 9999px
spacing:
  unit: 4px
  card-padding: 24px
  gap: 24px
components:
  button-primary:
    backgroundColor: "{colors.primary}"
    textColor: "{colors.on-primary}"
    rounded: "{rounded.md}"
    padding: 16px
  button-primary-hover:
    backgroundColor: "{colors.primary-hover}"
    textColor: "{colors.on-primary}"
  button-secondary:
    backgroundColor: "{colors.surface-raised}"
    textColor: "{colors.ink}"
    rounded: "{rounded.md}"
    padding: 16px
  card:
    backgroundColor: "{colors.surface}"
    textColor: "{colors.ink}"
    rounded: "{rounded.card}"
    padding: "{spacing.card-padding}"
  nav-item-selected:
    backgroundColor: "{colors.primary}"
    textColor: "{colors.on-primary}"
    rounded: "{rounded.md}"
  input:
    backgroundColor: "{colors.canvas}"
    textColor: "{colors.on-surface}"
    rounded: "{rounded.md}"
  caption:
    backgroundColor: "{colors.surface}"
    textColor: "{colors.text-muted}"
  hint:
    backgroundColor: "{colors.surface}"
    textColor: "{colors.text-faint}"
  divider:
    backgroundColor: "{colors.hairline}"
  badge-success:
    backgroundColor: "{colors.surface}"
    textColor: "{colors.success}"
    rounded: "{rounded.full}"
  badge-warning:
    backgroundColor: "{colors.surface}"
    textColor: "{colors.warning}"
    rounded: "{rounded.full}"
  badge-error:
    backgroundColor: "{colors.surface}"
    textColor: "{colors.error}"
    rounded: "{rounded.full}"
  sign-in-page:
    backgroundColor: "{colors.brand-ground}"
    textColor: "{colors.on-surface}"
---

# Kubeast console

## Overview

Kubeast is where an operator keeps a cluster open all day, so the console stays quiet: calm surfaces, readable text, and colour only where it carries a meaning — the thing to press, the selected place, the AI, and the state of a resource. Nothing on the console is there to decorate.

The sign-in page and the project site (`site/`) are the brand surfaces: the navy ground with its glow and the particle logo stay as they are. The console's default colour mode continues that navy, so the two read as one product; the dark and light modes are there for the operator who wants them.

The shapes follow Linear's design (getdesign.md, MIT): 12px cards, 8px controls, page titles at weight 600 with tight tracking.

Colour, type and shape tokens live in `frontend/src/index.css` (`@theme`, and the colour-mode blocks under it). Components use the Tailwind classes (`slate-*`, `primary-*`, `ink`), never a hex value, so a token change reaches every screen and every mode. The YAML tokens above are the default mode.

## Colour modes

Chosen on the Account page (Settings → Color mode) and kept in the browser (`utils/colorMode.ts`, key `kubeast.colorMode`); `public/color-mode.js` puts it on `<html data-color-mode>` before the first paint. The modes swap the neutral ladders `slate-*` and `gray-*` (the same ladder), `ink` and, in light, the hue shades; the class names stay the same.

| Step | Use | Default (deep navy) | Dark (neutral grey) | Light (off-white) |
|---|---|---|---|---|
| `slate-900` | page | #020618 | #141414 | #f7f8f8 |
| `slate-800` | cards, sidebar | #0f172b | #1c1c1c | #ffffff |
| `slate-700` | hover, secondary buttons, hairlines | #1d293d | #2a2a2a | #e0e6eb |
| `slate-100`·`ink` | text | #f1f5f9 · #ffffff | #f3f3f3 · #ffffff | #1f2328 · #1f2328 |
| `slate-400` | muted text | #90a1b9 | #a3a3a3 | #454c54 |
| `slate-500` | faint text | #73859d | #858585 | #59636e |

- **Default:** Tailwind's slate with the surfaces one step down, so the page is the sign-in ground; the faint step is lifted to 61% lightness to keep 4.5:1 on the cards.
- **Dark:** a neutral grey ladder.
- **Light:** an off-white page with white cards; text and line greys from GitHub Primer's light neutral scale (primitives 11.10). The hues turn over around their fills: the text shades made for a dark ground (200-400) take the same hue's 950-800 and the dark tints (800-950) its 200-50, so state text keeps 4.5:1 on its tint; 500-700, the fills, stay. The YAML editor uses Monaco's light theme; terminals stay dark.
- **Sign-in pages** (sign-in, first setup, waiting for approval) carry `data-color-mode="default"` and keep it in every mode.
- Checked with axe-core's color-contrast rule over every sidebar screen in all three modes.

## Colors

- **Ink and white:** text on a surface is `ink` (`text-ink`: white in default and dark, near-black in light); `text-white` is only for text on a filled colour (a sky button, the selected sidebar item, a red delete button). Inside a filled sky, red or green element `ink` is white again in light, so a child's text stays readable.
- **Neutral ladder (`slate-*`):** canvas `slate-900` for the page, surface `slate-800` for cards and the sidebar, raised `slate-700` for hover, secondary buttons and hairlines; text `slate-100`, muted `slate-400`, faint `slate-500` — values per mode above.
- **Sky accent (`primary-*`):** the one accent, the same in every mode. Filled controls and selections use `primary-600` (#027ac0 — the brightest sky that keeps white text at 4.5:1, here 4.6:1) with `primary-700` on hover; text and focus use `primary-400` (#38bdf8; #075985 in light); bars, chart series and highlight rings use `primary-bright` (#38bdf8; #0284c7 on white). It marks what can be pressed (the page's main button, links), what is selected — the sidebar item, a tab or segment, the open chat in the history, the drawer's Info/YAML, a filter that is on, a switch that is on, the check on a dropdown's chosen entry — focus, and the way into the AI (the floating chat button). A check that reports a state (Ready, no issues) stays green.
- **State:** green (healthy), yellow/amber (needs a look), red (failed) — only for the state of something. A count that is not a state (Total, Exposed, Total rules) stays grey.
- **Not used on the console:** cyan, indigo, purple, pink as decoration, gradients, glows. Charts with one series use the sky accent; charts by state use the state colours. Where many series or kinds must be told apart — the chat's charts (`utils/chatChart.ts`), the Resource Graph's relation lines — a categorical palette is data, not decoration, and stays.
- **Literals:** a library that takes a colour value instead of a class (the xterm terminal theme, the three.js particles) uses the token's hex; SVG attributes and inline styles use the variable (`var(--color-slate-700)`).
- **Brand ground (#020617):** the navy of the pages before the console — sign-in, first setup, waiting for approval — pinned there (`bg-[#020617]`, `data-color-mode="default"`) so it does not follow the colour mode.

## Typography

Inter, served with the app (`frontend/public/fonts/InterVariable.woff2`, SIL OFL 1.1 — the gateway's CSP allows fonts from `'self'` only). Korean text falls back to the system's Hangul font. Page titles (h1) are `text-3xl font-semibold` (the full-screen tools keep a smaller one) and h1 and h2 track at -0.02em, card titles `text-lg font-semibold`, body `text-sm`, form labels `text-xs font-semibold`. Labels are in sentence case: no all-caps, no widened letter spacing. Numbers that line up use `tabular-nums`.

## Layout

A 4px spacing unit: cards pad 24px (`p-6`), sections sit 24px apart (`gap-6`). Lists fit their box (`useAdaptiveTable`) and page through `ListPager`; the page structure is described in `CLAUDE.md`.

## Elevation & Depth

Flat. Depth comes from the ladder's steps (canvas → surface → raised) and a hairline border (`border-slate-700/70`), not from shadows. Only what floats over the page — modals, the detail drawer, dropdowns, the floating chat — keeps a shadow to separate it.

## Shapes

Cards 12px (`.card` is `rounded-xl`). Buttons, inputs, list rows, dropdowns and the sidebar's rows 8px (`.btn` is `rounded-lg`). Badges are pills. The sign-in pages keep their 24px card and pill buttons.

## Components

- **Buttons:** `.btn .btn-primary` for a page's refresh and create actions (one filled sky button per area); `.btn .btn-secondary` for the rest.
- **Sidebar:** group names in `text-xs font-semibold` sentence case; the open group's name is brighter. The selected item is filled with the accent (`bg-primary-600 text-white`).
- **Cards:** `.card` — surface, 12px corners, hairline, no shadow, no card inside a card (rows inside use dividers).
- **Badges:** `badge-success`, `badge-warning`, `badge-error` for state, `badge-info` in the sky accent, `badge-neutral` for a state that needs no attention.
- **Charts:** bars with a thin top and side face of their own colour (lighter top, darker side; the dashboard's status charts) and flat lines; no gradient fills, glow or animation, flat axes; grid lines in the neutral ladder. A usage bar (CPU, memory, GPU, disk) is the accent (`primary-bright`) while normal and turns yellow/amber, then red, past its thresholds; its number stays grey until then.
- **Icons:** one tone (`slate-300`/`slate-400`); an icon is coloured only when it reports a state (a green Ready check, an amber warning).

## Do's and Don'ts

- Do use `slate-*`, `primary-*` and `ink` classes; don't write a hex colour in a component.
- Do use `text-ink` for text on a surface and `text-white` only on a filled colour; check new screens in all three colour modes.
- Do keep text at 4.5:1 against its background (WCAG 2.2 1.4.3) and controls at 3:1 (1.4.11).
- Do colour a count only when it is a state; don't tint tiles for decoration.
- Don't add a second accent (cyan, indigo, purple, pink), gradients, glows, perspective floors or walls on charts, or rainbow icon chips.
- Don't use all-caps or tracked labels.
- Don't use sparkle icons or colour to say "AI"; the floating chat button and the AI pages are enough.
- Don't change the sign-in page's ground or the site's look along with the console or its colour mode.
