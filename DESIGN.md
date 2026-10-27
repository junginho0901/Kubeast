---
version: alpha
name: Kubeast console
description: A dark operations console — neutral grey surfaces, one sky accent, colour only where it means something.
colors:
  primary: "#0369a1"
  primary-hover: "#075985"
  primary-bright: "#38bdf8"
  on-primary: "#ffffff"
  canvas: "#141414"
  surface: "#1c1c1c"
  surface-raised: "#2a2a2a"
  hairline: "#2a2a2a"
  on-surface: "#f3f3f3"
  text-muted: "#a3a3a3"
  text-faint: "#858585"
  success: "#4ade80"
  warning: "#facc15"
  error: "#f87171"
  brand-ground: "#020617"
typography:
  headline-lg:
    fontFamily: Inter
    fontSize: 30px
    fontWeight: 700
    lineHeight: 36px
  headline-md:
    fontFamily: Inter
    fontSize: 18px
    fontWeight: 600
    lineHeight: 28px
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
  card: 24px
  full: 9999px
spacing:
  unit: 4px
  card-padding: 24px
  gap: 24px
components:
  button-primary:
    backgroundColor: "{colors.primary}"
    textColor: "{colors.on-primary}"
    rounded: "{rounded.full}"
    padding: 16px
  button-primary-hover:
    backgroundColor: "{colors.primary-hover}"
    textColor: "{colors.on-primary}"
  button-secondary:
    backgroundColor: "{colors.surface-raised}"
    textColor: "{colors.on-surface}"
    rounded: "{rounded.full}"
    padding: 16px
  card:
    backgroundColor: "{colors.surface}"
    textColor: "{colors.on-surface}"
    rounded: "{rounded.card}"
    padding: "{spacing.card-padding}"
  nav-item-selected:
    backgroundColor: "{colors.surface-raised}"
    textColor: "{colors.on-surface}"
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

Kubeast is where an operator keeps a cluster open all day, so the console stays quiet: grey surfaces, readable text, and colour only where it carries a meaning — the thing to press, the selected place, the AI, and the state of a resource. Nothing on the console is there to decorate.

The sign-in page and the project site (`site/`) are the brand surfaces: the navy ground with its glow and the particle logo stay as they are. After sign-in the console is neutral grey with the same sky accent, so the two read as one product.

Colour, type and shape tokens live in `frontend/src/index.css` (`@theme`). Components use the Tailwind classes (`slate-*`, `primary-*`), never a hex value, so a token change reaches every screen.

## Colors

- **Neutral grey (`slate-*`):** the `slate` ladder is a neutral grey, not Tailwind's blue slate (`gray-*` is set to the same ladder for the few screens written with it). Canvas `slate-900` (#141414) for the page, surface `slate-800` (#1c1c1c) for cards and the sidebar, raised `slate-700` (#2a2a2a) for the selected row and secondary buttons and hairlines. Text `slate-100` (#f3f3f3), muted `slate-400` (#a3a3a3), faint `slate-500` (#858585).
- **Sky accent (`primary-*`):** the one accent. Filled controls use `primary-600` (#0369a1, white text 5.9:1) with `primary-700` on hover; text, lines and focus on the dark grey use `primary-400` (#38bdf8). It marks what can be pressed (the page's main button, links), what is selected, focus, and the way into the AI (the floating chat button).
- **State:** green (healthy), yellow/amber (needs a look), red (failed) — only for the state of something. A count that is not a state (Total, Exposed, Total rules) stays grey.
- **Not used on the console:** cyan, indigo, purple, pink as decoration, gradients, glows. Charts with one series use the sky accent; charts by state use the state colours. Where many series or kinds must be told apart — the chat's charts (`utils/chatChart.ts`), the Resource Graph's relation lines — a categorical palette is data, not decoration, and stays.
- **Literals:** a library that takes a colour value instead of a class (the xterm terminal theme, the three.js particles) uses the token's hex; SVG attributes and inline styles use the variable (`var(--color-slate-700)`).
- **Brand ground (#020617):** the navy of the pages before the console — sign-in, first setup, waiting for approval — pinned there (`bg-[#020617]`) so it does not follow the console's grey.

## Typography

Inter, served with the app (`frontend/public/fonts/InterVariable.woff2`, SIL OFL 1.1 — the gateway's CSP allows fonts from `'self'` only). Korean text falls back to the system's Hangul font. Page titles (h1) are `text-3xl font-bold` (the full-screen tools keep a smaller one), card titles `text-lg font-semibold`, body `text-sm`, form labels `text-xs font-semibold`. Labels are in sentence case: no all-caps, no widened letter spacing. Numbers that line up use `tabular-nums`.

## Layout

A 4px spacing unit: cards pad 24px (`p-6`), sections sit 24px apart (`gap-6`). Lists fit their box (`useAdaptiveTable`) and page through `ListPager`; the page structure is described in `CLAUDE.md`.

## Elevation & Depth

Flat. Depth comes from the grey steps (canvas → surface → raised) and a hairline border (`border-slate-700/70`), not from shadows. Only what floats over the page — modals, the detail drawer, dropdowns, the floating chat — keeps a shadow to separate it.

## Shapes

Cards 24px (`rounded-3xl`). Buttons are pills (`.btn` is `rounded-full`). Inputs, list rows, dropdowns and the sidebar's rows 8px (`rounded-lg`). Badges are pills.

## Components

- **Buttons:** `.btn .btn-primary` for a page's refresh and create actions (one filled sky button per area); `.btn .btn-secondary` for the rest.
- **Sidebar:** group names in `text-xs font-semibold` sentence case; the open group's name is brighter. The selected item is the raised grey with a 2px `primary-400` line on its left.
- **Cards:** `.card` — surface grey, 24px corners, hairline, no shadow, no card inside a card (rows inside use dividers).
- **Badges:** `badge-success`, `badge-warning`, `badge-error` for state, `badge-info` in the sky accent, `badge-neutral` for a state that needs no attention.
- **Charts:** flat bars and lines, no 3D, no gradient fills; grid lines in the grey ladder.

## Do's and Don'ts

- Do use `slate-*` and `primary-*` classes; don't write a hex colour in a component.
- Do keep text at 4.5:1 against its background (WCAG 2.2 1.4.3) and controls at 3:1 (1.4.11).
- Do colour a count only when it is a state; don't tint tiles for decoration.
- Don't add a second accent (cyan, indigo, purple, pink), gradients, glows, 3D charts, or rainbow icon chips.
- Don't use all-caps or tracked labels.
- Don't use sparkle icons or colour to say "AI"; the floating chat button and the AI pages are enough.
- Don't change the sign-in page's ground or the site's look along with the console.
