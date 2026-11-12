---
name: Shipkeep identity
description: Black workspace built from the dashboard and sign-in mockups, with a red accent in the dashboard and a neutral gray one on the sign-in pages.
colors:
  black: '#000000'
  paper: '#f2f2f3'
  fg: '#ededef'
  fg2: '#c8c8cf'
  fg3: '#a6a6ae'
  mute: '#8b8b93'
  mute2: '#7c7c85'
  dim: '#7e7e87'
  dim2: '#7b7b84'
  line: '#1c1c1e'
  line2: '#17171b'
  control: '#262628'
  hover: '#141417'
  selected: '#111113'
  rose: '#ff8a8a'
  coral: '#ff5c5c'
  red: 'oklch(0.68 0.17 25)'
  amber: 'oklch(0.80 0.12 80)'
  green: 'oklch(0.78 0.13 155)'
  blue: 'oklch(0.72 0.13 250)'
typography:
  dashboard: { fontFamily: 'Outfit Variable', lineHeight: normal }
  sign-in: { fontFamily: 'Geist Variable', lineHeight: normal }
  code: { fontFamily: 'Geist Mono Variable' }
  page-title: { fontSize: '26px', fontWeight: 600, letterSpacing: '-0.02em' }
rounded:
  card: '16px'
  control: '10px'
  button: '12px'
---

# Shipkeep web design system

The web UI follows the dashboard and sign-in mockups, screen by screen. This file says how the port is built, so new screens stay consistent with it.

## Sources

- Design tokens: `@theme` in `src/styles.css`. Use the token classes (`text-mute`, `border-line`, `bg-hover`…), not raw hex values.
- Fonts: Outfit (dashboard), Geist (sign-in) and Geist Mono (code, identifiers), self-hosted through `@fontsource-variable` because the Content-Security-Policy only allows fonts from `'self'` (ADR 0014).
- Icons: Tabler outline icons as path data in `src/app/shell/icons.ts` (`<sk-icon>`), stroke 2. Brand marks: Simple Icons path data in `src/app/shell/brands.ts` (`<sk-brand>`), drawn in the current text color.
- No inline `style` attributes (CSP `style-src-attr 'none'`). Dynamic values use `[style.x]` bindings, which go through CSSOM.

## Accent colors

The dashboard uses the red accent (`rose`, `coral`). The sign-in pages and the landing page use a neutral gray one (`#bebec2`, `#d0d0d4`). On sign-in pages, field errors stay red.

## Deliberate differences from the mockups

- The three dimmest grays of the mockups (#6b6b74, #5e5e67, #4c4c55) fail WCAG AA contrast as text on black. They are raised to #7e7e87 and #7b7b84; the accessibility gate (axe, WCAG 2.2 AA) runs on every screen.
- Checkboxes and other targets are at least 24 by 24 pixels (WCAG 2.5.8).
- Pages outside an organization (organization chooser, account) use the sign-in header; every frame has a skip link.

## Building blocks

- Frame: `dashboard/dashboard-layout.*` (sidebar with counts, projects and profile; top bar with breadcrumb, language switch and agent count; drawer under 1024 px; Cmd+K palette). `shell/public-frame.ts` for pages without an organization.
- Generic screens: a screen is data (`dashboard/screen-model.ts`) drawn by `screen-view.ts` and `block-view.ts`: stats, fields, tables, cards, code, steps, notes and danger zones, with sections in a side menu or tabs.
- Classes for repeated parts in `styles.css`: `.card`, `.btn` (`-primary`, `-sm`, `-danger`), `.pill`, `.dot`, `.seg`, `.tabbar`, `.sidenav-item`, `.field-row`, `.note`, `.alert`, `.code-box`.
- Open tabs and sections live in the URL (`?tab=`, `?section=`), so reload and shared links keep them.
- Tables are grids; a row that opens something uses a stretched link on its name cell, so the link's name stays short.

## Honesty rules

- A screen whose feature does not exist yet shows the mockup's sample data with the "Preview · sample data" label (`<sk-preview-pill>`), never as if it were live.
- Buttons of features that are not built stay where the design puts them and say so through the notice (`Notice.notYet()`).
- Values that come from `shipkeep.yml` are read-only in the settings sections and carry the `shipkeep.yml` tag; they change through the editor.

## Language

English is the source text. French lives in `src/app/ui/fr.ts`, keyed by the English text; the pipe `| t` and `I18n.t()` translate, with `{name}` placeholders. Names typed by users are never translated. The language is the browser's, or the one chosen with the FR/EN switch (kept in `localStorage`).
