---
name: Shipkeep identity
description: Dark workspace from the Claude Design mockups. Sidebar, cards and tabs, no inline styles.
colors:
  accent: '#ff8a8a'
  ink: '#ededef'
  muted: '#9a9aa2'
  line: '#1f1f22'
  control: '#2e2e33'
  panel: '#0c0c0e'
  black: '#000000'
  danger: '#ff6b6b'
  success: '#3dd68c'
  warning: '#f5a524'
typography:
  headline: { fontSize: '1.75rem', fontWeight: 600, lineHeight: 1.25 }
  title: { fontSize: '1.25rem', fontWeight: 600, lineHeight: 1.4 }
  body:
    fontFamily: 'ui-sans-serif, system-ui, sans-serif'
    fontSize: '1rem'
    fontWeight: 400
    lineHeight: 1.5
  label: { fontSize: '0.875rem', fontWeight: 600, lineHeight: '1.25rem' }
rounded:
  md: '0.375rem'
spacing:
  '2': '0.5rem'
  '3': '0.75rem'
  '4': '1rem'
  '5': '1.25rem'
  '6': '1.5rem'
  '8': '2rem'
components:
  button-primary:
    {
      backgroundColor: '{colors.ink}',
      textColor: '{colors.black}',
      typography: '{typography.label}',
      rounded: '{rounded.md}',
      padding: '0.625rem 1.25rem',
    }
  button-secondary:
    {
      backgroundColor: '{colors.black}',
      textColor: '{colors.ink}',
      typography: '{typography.label}',
      rounded: '{rounded.md}',
      padding: '0.625rem 1.25rem',
    }
  input:
    {
      backgroundColor: '{colors.black}',
      textColor: '{colors.ink}',
      typography: '{typography.body}',
      rounded: '{rounded.md}',
      padding: '0.5rem 0.75rem',
    }
  navigation: { textColor: '{colors.ink}', rounded: '{rounded.md}', padding: '0.5rem 0.75rem' }
  feedback: { backgroundColor: '{colors.panel}', rounded: '{rounded.md}', padding: '{spacing.4}' }
---

# Design System: Shipkeep identity

## Overview

**Creative North Star: "Access ledger"**

The implemented identity UI uses a compact operator workspace: a cool navigation surface, white working area, ruled sections and explicit action results. The access-ledger description is an implementation assumption, not a user-approved aesthetic or a product-wide brand commitment.

This record covers the Angular identity screens. Ground truth is [global styles](src/styles.css), the [application shell](src/app/app.html), and the [authentication](src/app/identity/auth-page.html), [account](src/app/identity/account-page.html), [MFA](src/app/identity/mfa-panel.html) and [token](src/app/identity/token-panel.html) templates. The [surface contract](.impeccable/surfaces/apps-web-src-app-app-ts.md) records direction provenance; [PRODUCT.md](../../docs/PRODUCT.md) supplies the security context.

**Key Characteristics:**

- Bounded forms and ruled settings sections.
- Blue actions, slate text and literal status labels.
- Keyboard-visible focus and nearby field guidance.

## Colors

### Primary

**Action blue** is used for primary actions, links, the current navigation item, caret and focus outlines.

### Neutral

**Ink slate** carries primary text; **muted slate** carries explanations. **Cool panel** distinguishes navigation, feedback and disabled controls from **white** working surfaces. **Divider gray** separates sections; **control gray** outlines enabled inputs and selects. Keep these two border roles distinct.

Danger red accompanies field errors and some alerts; success green reinforces enabled or active text. These are semantic states, not additional brand accents. Sidecar tonal ramps are generated preview aids, not implemented state colors.

**The Explicit State Rule.** Pair state color with words; enabled, active, loading and unavailable states remain understandable without color.

## Typography

System sans is the inherited UI typeface. Headline is the page heading; title is the settings-section heading; label is the semibold field/action role. Body text uses the body token, with paragraphs and hints using relaxed line-height (1.625). Supporting copy is generally small (0.875rem); token metadata and recovery codes use the smallest text (0.75rem). Monospace identifies displayed credentials, while countdowns and pagination use tabular numerals.

No separate display face or approved brand typography is established. Keep headings in sentence case and let size, weight and spacing establish hierarchy.

## Layout

Below the medium breakpoint (48rem), navigation wraps above the content. At and above it, the shell uses a fixed rail (13rem) and a flexible main column. Main padding grows from horizontal (1.25rem) and vertical (2rem) to (3rem), then horizontal (4rem) at the large breakpoint (64rem).

Authentication and inline security forms stop at (28rem); the account column stops at (42rem). Field groups use vertical spacing (1.25–1.5rem), with section separation (2rem). Actions wrap with gaps (0.75rem); authentication submit buttons fill the narrow screen until the small breakpoint (40rem). Controls and navigation have a minimum height (2.75rem).

The token table keeps its readable minimum width (36rem) inside a focusable horizontal scroll region. Its linked scroll instruction appears only when measured content overflows; retain that behavior at intermediate widths and zoom levels. The skip link focuses and scrolls the existing main element without replacing the current form.

## Elevation & Depth

The UI uses no shadows. Tonal surfaces and single-pixel rules establish grouping. Focus uses an action-blue outline (3px), offset from the element (3px); feedback also receives this outline when focused programmatically.

## Shapes

Buttons, inputs, feedback and navigation share the modest rounded token. Recovery-code rows use slightly tighter corners (0.25rem). Account sections remain open, separated by rules rather than enclosed in cards. The current system has no chip, decorative icon or raster-image vocabulary.

## Components

**Buttons.** Primary actions are solid blue; secondary actions are white with a divider-gray border. Both share the label role and minimum control height. Primary hover and pressed colors are defined in the sidecar; secondary hover uses the panel color. Disabled controls use panel and muted colors. Background changes take (160ms), ease-out; reduced-motion preference removes transitions.

**Inputs and selects.** White fields use the control border and visible external labels. Hints and field errors sit beneath the field. Invalid inputs use the danger border; disabled fields use panel and muted colors. Native selects share field dimensions. Error summaries use alert semantics, and success messages use status semantics.

**Navigation.** Plain links sit on the panel surface; hover adds white. The current page adds white, semibold weight and action-blue text through `aria-current`. Help links sit below a separating rule and retain underlines.

**Feedback.** A bordered panel with relaxed small text carries a result or problem close to the affected task. It can receive programmatic focus after submission; field-level errors retain their own descriptions.

**Security sections and token list.** Settings are ruled sections with headings, status text and wrapping actions. Credential displays use selectable monospace text plus copy and explicit dismissal actions; their temporary visibility is stated nearby. The token list uses semantic headings, metadata and row actions, with the scroll behavior described in Layout.

## Do's and Don'ts

### Do:

- **Do** preserve the separate divider and enabled-control border colors.
- **Do** pair status text with color and keep explanations beside their controls.
- **Do** retain visible focus, minimum control heights and the overflow-aware token scroll cue.

### Don't:

- **Don't** replace the observed ruled account sections with an invented card or chip system.
- **Don't** present the access-ledger assumption as user-approved branding.
- **Don't** treat generated swatch ramps as additional application tokens.
