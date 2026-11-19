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
  canvas: "#0d1119"
  surface: "#151b25"
  surface-raised: "#202936"
  hairline: "#303a49"
  control: "#718096"
  on-surface: "#eef2f7"
  text-muted: "#a8b4c4"
  text-faint: "#9aa7b8"
  success: "#4ade80"
  warning: "#facc15"
  error: "#f87171"
  brand-ground: "#020617"
typography:
  headline-lg:
    fontFamily: Inter
    fontSize: 28px
    fontWeight: 500
    lineHeight: 36px
    letterSpacing: -0.56px
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
  card-padding: 20px
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
    backgroundColor: "{colors.surface}"
    borderColor: "{colors.control}"
    textColor: "{colors.ink}"
    rounded: "{rounded.md}"
    padding: 16px
  card:
    backgroundColor: "{colors.surface}"
    textColor: "{colors.ink}"
    rounded: "{rounded.card}"
    padding: "{spacing.card-padding}"
  nav-item-selected:
    backgroundColor: "{colors.surface-raised}"
    textColor: "{colors.ink}"
    markerColor: "{colors.primary-bright}"
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

The shapes follow Linear's design (getdesign.md, MIT): 12px cards, 8px controls, page titles at 28px and weight 500 with tight tracking.

Colour, type and shape tokens live in `frontend/src/index.css` (`@theme`, and the colour-mode blocks under it). Components use the Tailwind classes (`slate-*`, `primary-*`, `ink`), never a hex value, so a token change reaches every screen and every mode. The YAML tokens above are the default mode.

## Colour modes

Chosen on the Account page (Settings → Color mode) and kept in the browser (`utils/colorMode.ts`, key `kubeast.colorMode`); `public/color-mode.js` puts it on `<html data-color-mode>` before the first paint. The modes swap the neutral ladders `slate-*` and `gray-*` (the same ladder), `ink` and, in light, the hue shades; the class names stay the same.

| Step | Use | Default (deep navy) | Dark (neutral grey) | Light (off-white) |
|---|---|---|---|---|
| `slate-900` | page | #0d1119 | #141414 | #f5f7f8 |
| `slate-800` | cards, sidebar | #151b25 | #1c1c1c | #ffffff |
| `slate-700` | hover, selected surface | #202936 | #2a2a2a | #edf1f4 |
| `hairline` | decorative divider | #303a49 | #363636 | #d8e0e7 |
| `control` | control boundary | #718096 | #7b7b7b | #788593 |
| `slate-100`·`ink` | text | #eef2f7 · #ffffff | #f3f3f3 · #ffffff | #1f2328 · #1f2328 |
| `slate-400` | muted text | #a8b4c4 | #a3a3a3 | #454c54 |
| `slate-500` | faint text | #9aa7b8 | #858585 | #59636e |

- **Default:** a low-saturation navy console with a brighter muted text step. Local default scopes on the sign-in pages retain their original brand palette.
- **Dark:** a neutral grey ladder.
- **Light:** an off-white page with white cards; text and line greys from GitHub Primer's light neutral scale (primitives 11.10). The hues turn over around their fills: the text shades made for a dark ground (200-400) take the same hue's 950-800 and the dark tints (800-950) its 200-50, so state text keeps 4.5:1 on its tint; 500-700, the fills, stay. The YAML editor uses Monaco's light theme; terminals stay dark.
- **Sign-in pages** (sign-in, first setup, waiting for approval) carry `data-color-mode="default"` and keep it in every mode.
- Changes to these values require axe-core's color-contrast rule over every sidebar screen in all three modes. The redesign branch has not run that check yet.

## Colors

- **Ink and white:** text on a surface is `ink` (`text-ink`: white in default and dark, near-black in light); `text-white` is only for text on a filled colour (a sky action button or a red delete button). Inside a filled sky, red or green element `ink` is white again in light, so a child's text stays readable.
- **Neutral ladder (`slate-*`):** canvas `slate-900` for the page, surface `slate-800` for cards and the sidebar, raised `slate-700` for hover and selected surfaces, `hairline` for decorative dividers, `control` for control boundaries; text `slate-100`, muted `slate-400`, faint `slate-500` — values per mode above.
- **Sky accent (`primary-*`):** the one accent, the same in every mode. Primary actions and filled switches use `primary-600` (#027ac0 — the brightest sky that keeps white text at 4.5:1, here 4.6:1) with `primary-700` on hover; text and focus use `primary-400` (#38bdf8; #075985 in light); bars, chart series and highlight rings use `primary-bright` (#38bdf8; #0284c7 on white). It marks what can be pressed (the page's main button, links), what is selected — the sidebar item, a tab or segment, the open chat in the history, the drawer's Info/YAML, a filter that is on, a switch that is on, the check on a dropdown's chosen entry — focus, and the way into the AI (the floating chat button). A check that reports a state (Ready, no issues) stays green.
- **Selection:** the sidebar and chat history use a neutral selected surface with a narrow sky marker. Drawer tabs use a sky outline. The floating chat uses a neutral surface and a sky icon. The original AI particle animation, its size, colour and speed stay unchanged.
- **State:** green (healthy), yellow/amber (needs a look), red (failed) — only for the state of something. A count that is not a state (Total, Exposed, Total rules) stays grey.
- **Not used on the console:** cyan, indigo, purple, pink as decoration, gradients, glows. Charts with one series use the sky accent; charts by state use the state colours. Where many series or kinds must be told apart — the chat's charts (`utils/chatChart.ts`), the Resource Graph's relation lines — a categorical palette is data, not decoration, and stays.
- **Literals:** a library that takes a colour value instead of a class (the xterm terminal theme, the three.js particles) uses the token's hex; SVG attributes and inline styles use the variable (`var(--color-slate-700)`).
- **Brand ground (#020617):** the navy of the pages before the console — sign-in, first setup, waiting for approval — pinned there (`bg-[#020617]`, `data-color-mode="default"`) so it does not follow the colour mode.

## Typography

Inter, served with the app (`frontend/public/fonts/InterVariable.woff2`, SIL OFL 1.1 — the gateway's CSP allows fonts from `'self'` only). Korean text falls back to the system's Hangul font. Page titles (h1) in `.page-head` keep the `text-3xl` hook and render at 28px/36px, weight 500; standalone titles use the same values (the full-screen tools keep a smaller one) and h1 and h2 track at -0.02em, card titles `text-lg font-semibold`, body `text-sm`, form labels `text-xs font-semibold`. Labels are in sentence case: no all-caps, no widened letter spacing. Numbers that line up use `tabular-nums`.

## Layout

A 4px spacing unit: cards pad 20px (`p-5`), sections sit 16–24px apart. A standalone table card removes its surrounding padding because its cells and footer already have their own. Screen-sized lists retain `useAdaptiveTable` and its row-by-row Fit measurement inside the table body, with `ListPager` below it. Styling does not replace that measurement or hide its filler rows. Advanced Search keeps its existing height measurement on the transparent parent and lets the bordered table shrink. The page structure is described in `CLAUDE.md`. Page-ending controls retain the shared space that keeps them clear of the floating chat button.

## Elevation & Depth

Flat. Depth comes from the ladder's steps (canvas → surface → raised) and a hairline border (`border-hairline`), not from shadows. Only what floats over the page — modals, the detail drawer, dropdowns, the floating chat — keeps a shadow to separate it.

## Shapes

Cards 12px (`.card` is `rounded-xl`). Buttons, inputs, list rows, dropdowns and the sidebar's rows 8px (`.btn` is `rounded-lg`). Badges are pills. The sign-in pages keep their 24px card and pill buttons.

## Components

- **Buttons:** page header actions, including refresh, create and export, retain `.btn .btn-primary`. Other secondary actions use `.btn .btn-secondary`. Changing refresh to secondary is a separate proposal and is not part of this design branch's button contract. Secondary buttons draw their boundary inside the box so they retain the same height as primary buttons and adjacent fields.
- **Sidebar:** group names in `text-xs font-semibold` sentence case; the open group's name is brighter. The selected item has a neutral raised surface, a 2px sky marker and `aria-current="page"`.
- **Cards:** `.card` — surface, 12px corners, hairline, no shadow, no card inside a card (rows inside use dividers).
- **Badges:** `badge-success`, `badge-warning`, `badge-error` for state, `badge-info` in the sky accent, `badge-neutral` for a state that needs no attention. The count of access requests waiting for approval is a pill in `badge-surface-pending` with `badge-text-pending` text, the same on the sidebar's Access Requests item, the Access Requests Pending tab and User Management's Pending button.
- **Charts:** the dashboard's status charts use horizontal rows with the state name, a flat bar and the actual count. The full row remains clickable, including a zero state. Other charts keep their data and interaction; no gradient fills, glow or animation; grid lines use the neutral ladder. A usage bar (CPU, memory, GPU, disk) is the accent (`primary-bright`) while normal and turns yellow/amber, then red, past its thresholds; its number stays grey until then.
- **Icons:** one tone (`slate-300`/`slate-400`); an icon is coloured only when it reports a state (a green Ready check, an amber warning).
- **Result notices:** `notice-text-*` roles name failure, success, waiting, empty data and supporting text; `notice-icon-*`, `notice-surface-*` and `notice-border-*` keep those uses separate. Drain state roles distinguish queued, active, completed, interrupted and failed. These aliases follow each mode's existing palette and do not change notice wording or lifetime.

## Interaction

- Keyboard focus uses a 2px `primary-400` outline, 2px outside the control, unless the control already has its own visible ring. Scroll menus retain their inset ring.
- A list row that opens a drawer takes the Tab order, opens on Enter or Space and shows the same `primary-400` as a 2px ring inside the row, which the list's scroll box does not cut.
- Pressed buttons use a neutral 10% shade over their fill; text, borders and focus rings stay visible. Normal and hover colours stay the same.
- Buttons outside dense table rows have a transparent hit area of at least 24×24px. Close, back and floating chat controls use `hit-area-40` for at least 40×40px without enlarging the visible button. Keep adjacent hit areas apart; the drawer's 24px back and close buttons have a 20px gap.
- Reduced motion removes console menu, disclosure, chevron and meter transitions and the movement of waiting indicators. The original AI welcome particles and sign-in scene stay unchanged.
- A Resource Graph box or traffic line with the keyboard focus opens on Enter what a press opens; Space keeps React Flow's selection. A line's panel opened with Enter takes the focus to its title. Closing a box's drawer or pod list, or a line's panel by Escape or its X, puts the focus back on it.
- The floating chat launcher stays 48×48px at bottom/right 24px and moves left of an open detail drawer at 1348px and above. It hides while scrolling down and returns immediately on upward scrolling or keyboard focus, or 500ms after scrolling stops. It stays visible near the bottom-right 110px corner, near the displaced launcher, while chat is open and when there is no scroll room. A scroll-hidden launcher remains keyboard reachable. Reduced motion removes its visibility transition.

## Do's and Don'ts

- Do use `slate-*`, `primary-*` and `ink` classes; don't write a hex colour in a component.
- Do use `text-ink` for text on a surface and `text-white` only on a filled colour; check new screens in all three colour modes.
- Do keep text at 4.5:1 against its background (WCAG 2.2 1.4.3) and controls at 3:1 (1.4.11).
- Do colour a count only when it is a state; don't tint tiles for decoration.
- Don't add a second accent (cyan, indigo, purple, pink), gradients, glows, perspective floors or walls on charts, or rainbow icon chips.
- Don't use all-caps or tracked labels.
- Don't use sparkle icons or colour to say "AI"; the floating chat button and the AI pages are enough.
- Don't change the sign-in page's ground or the site's look along with the console or its colour mode.

## Design workflow source

The redesign workflow is adapted from [unslop](https://github.com/heydamir/unslop) by Damir Sokolovsky, licensed under [CC BY 4.0](https://creativecommons.org/licenses/by/4.0/). The palette, action priorities and layout rules above are adapted for Kubeast.
