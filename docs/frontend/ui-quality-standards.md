# UI quality standards

Hasaki's existing tokens, branding and light/dark themes are the design system. New components belong in `web/src/ui.tsx` when broadly reusable, or `web/src/components/` when they represent a repeated domain presentation. Do not add a parallel framework.

## 1. Spacing and ownership

Use `--sp-1/2/3/4/5/6/8` (4/8/12/16/20/24/32px). Retain the established 20px token where already used. Use gap on the owning flex/grid container rather than compensating margins on children. A page owns its page-specific spacing; shared components own their internal spacing.

## 2. Controls

Use the established sizes: XS 28px, SM 32px, MD 38px, LG 44px. These are the `--control-h-*` tokens. Border-box sizing includes padding/borders in control dimensions. Text inputs/selects and normal toolbar controls use MD. Small actions use SM. Icon-only controls use the same square size tokens and must have an accessible name.

`Button` supports `primary`, `secondary`, `quiet`, `danger`, `size`, `icon`, `loading`, native `disabled`, and native button attributes. Loading replaces the icon and sets `aria-busy` without inserting a layout row. Existing `button`, `.btn`, `.ghost`, `.quiet`, `.sm`, `.xs`, `.lg` call sites remain compatible. Do not combine competing visual variants.

```tsx
<Button variant="secondary" size="sm" icon={<RefreshCw size={14}/>} loading={refreshing} onClick={reload}>
  {t("an.refresh")}
</Button>
```

Avoid choosing padding separately for two controls that are meant to align. Button text uses a readable line-height; do not use a fixed text line box that clips Vietnamese accents. Preserve shrinkable icons with `flex-shrink: 0`.

## 3. Text and alignment

Buttons center their icon/text. Field labels sit above their controls, with a consistent gap. Table numbers use right alignment and tabular numerals, including headers and custom percentage renderers. Keep text links visually distinct from primary actions.

`button.link-button` is a text action: transparent background, no primary shadow, wrapping text and a visible focus ring. Use an anchor when the destination is directly available. Use a native button for an action that constructs a filtered destination.

## 4. Long dynamic values

Use `min-width: 0` on shrinkable grid/flex children. Prefer controlled wrapping for service names and primary identifiers. Ellipsis/clamping is acceptable when the full value is available in an accessible tooltip, native title or detail view. Never rely on `overflow-wrap` while the same element inherits `white-space: nowrap`.

`ServiceIdentityCell` consistently renders a semibold name and muted namespace. `ServiceVolumeBar` receives precomputed value/share/scale: it must not calculate or reinterpret analytics. Each chart row uses the same name/bar/value/share tracks. At narrow container widths the identity occupies its own line, while counts and shares remain visible.

## 5. Responsive layouts

Use `minmax(0, 1fr)` for fluid grid tracks. Fixed tracks require a documented role, such as a control size or numeric column. Prefer container queries when layout depends on available workspace width, particularly Workflow Studio beside a sidebar or inspector. Viewport queries are appropriate for the application shell/mobile navigation.

Good:

```css
.filter-toolbar-primary {
  display: grid;
  grid-template-columns: repeat(4, minmax(0, 1fr));
  gap: var(--sp-3);
  align-items: end;
}
```

Bad: automatic chart number columns that change each row's bar origin; a fixed-width sidebar plus fixed inspector leaving a 45px canvas; a long nowrap label expanding its grid track.

## 6. Tables

`DataTable` columns can specify `align`, `width`, `minWidth`, `maxWidth` and `responsivePriority`, in addition to existing format/render metadata. Numeric format metadata automatically aligns header and body cells right. Do not add speculative cell abstractions for formatting already handled by the table.

```tsx
{ key: "service", label: "service", width: "30%", minWidth: "12rem", render: row =>
    <ServiceIdentityCell service={row.service} namespace={row.namespace} onSelect={() => openService(row)}/> },
{ key: "events", label: "events", style: "number" },
{ key: "error_share_pct", label: "errorShare", align: "right", render: row => `${fmt(row.error_share_pct)}%` },
{ key: "last_at", label: "lastSeen", responsivePriority: "secondary", render: row => dateCell(row.last_at) },
```

Service identity, event counts and error shares are primary. Optional columns may collapse only with an explicit “Show all metrics” control that reveals every column. Do not silently remove metrics. Tables own horizontal scrolling inside a focusable, named region; table headers wrap rather than clip. Pagination stays outside that horizontal region. Keep native table semantics; do not turn a shared data table into a block at mobile breakpoints.

## 7. Scroll and navigation

The shell is viewport-height (`100dvh`). Normal pages scroll in `main.page`; the document should not gain a second vertical scrollbar. Full workspaces explicitly delegate scrolling to an editor/inspector. Code, transcript, table and evidence regions may have bounded independent scrolling; this is an intentional exception, not a second page scroller.

Normal analytics tabs use document flow. Do not apply sticky rules to every `.tabs` descendant of a page domain. A deliberate sticky toolbar needs its own scroll boundary, background and local stacking level, and must not obscure a control. Route changes restore that route's position. Query/filter changes preserve position and input focus. The SPA owns scroll restoration; focus transfer uses `preventScroll`.

Refresh feedback must not insert/remove height above the user's current position. Keep previous data visible and show activity in an existing control.

## 8. Accessibility

Use native controls, labels, explicit button types, visible `:focus-visible`, and keyboard-operable actions. Interactive stat cards support Enter/Space. Drawers have a name, focus containment, Escape dismissal and focus restoration, and render in a portal outside constrained workspaces. Existing native dialogs keep their top-layer behavior.

Use theme foreground tokens: `--on-brand` handles the dark theme's bright brand background. Warning actions use `--on-warning`. Check normal action text at WCAG AA contrast (4.5:1); disabled controls are exempt. Long text must remain inspectable without relying exclusively on hover. Respect reduced motion; the existing global motion accessibility override is intentional.

## 9. Shared patterns

Use `FilterToolbar` for grouped filters with `FilterField` labels and a separate secondary row. Four primary columns become two and then one; search/actions wrap independently. Use `SearchInput` rather than rebuilding its icon, label and focus behavior. Do not extract every HTML element. Reuse existing Tabs, Segmented, EmptyState, Skeleton and Badge primitives; extend them only for demonstrated needs.

## 10. CSS boundaries and regression checks

Organize tokens/reset/shared components/layout primitives before page rules. Scope domain CSS by its existing domain classes. Keep the service bar component's CSS beside its component. Delete superseded rules when replacing a layout. Do not fix a component with arbitrary negative offsets, additional `!important`, global overflow hiding or escalating z-index. Existing accessibility/third-party overrides require explicit rationale; do not normalize them blindly.

Before submitting layout changes:

- Run typecheck/build and relevant existing tests.
- Run `npm run smoke:ui-quality` with an available Chromium executable.
- Inspect document **and main scroll-container** overflow at 1920×1080, 1440×900, 1280×800, 1024×768, 768×1024 and 390×844.
- Exercise VI/EN, light/dark, sidebar expanded/collapsed, 125%/150% zoom stress, long names, populated/empty/loading/error states, keyboard actions and browser history.
- Measure rectangles for chart identity/bar/count/share overlap; measure control heights, numeric alignment and usable editor canvas width. View screenshots as well as measurement output.
- Report the exact scope and any emulation limitations. Headless CSS/viewport zoom testing must not be described as using browser chrome's zoom menu.
