# Hasaki AI Workspace — design system

Product: **Hasaki AI Workspace** — "Your Intelligent Engineering Headquarters". A premium internal AI-engineering
SaaS with a beauty-retail identity: Hasaki logo green accent, white + warm surfaces, soft green tints,
rounded cards, soft shadows, generous spacing, Be Vietnam Pro typography, lucide icons. Light theme is the reference;
dark theme is token-driven (`:root[data-theme="dark"]`). Vietnamese UI copy (keep existing wording style).

## Tokens (web/src/styles.css — never hard-code colours in pages)

- Brand: `--brand` (#2f6b4f, the Hasaki logo green), `--brand-600/700` (darker), `--brand-400`, `--brand-100/50` (tints), `--blush`, `--peach`, `--cream`, `--rose-ink` (green-tinted tokens; the names predate this palette).
- Neutrals: `--bg` (cream page), `--surface` (cards), `--surface-2` (subtle), `--surface-3` (wells), `--ink`, `--ink-2`, `--muted`, `--line`, `--line-strong`, `--code`.
- Status: `--st-run` (berry — RUNNING/READY/RETRYING), `--st-wait` (amber — WAITING\_\*), `--st-ok` (green), `--st-err` (red), `--st-idle` (warm grey); each has a `-bg` tint. No SaaS blue anywhere.
- Type: `--font`, `--mono`, `--fs-xs … --fs-3xl`. Space `--sp-1…8`. Radius `--r-sm 8 / md 12 / lg 16 / xl 22 / pill`. Elevation `--shadow-1/2/3`.
- Legacy aliases still work (`--accent`=brand, `--panel`, `--panel2`, `--text`, `--ok`, `--warn`, `--err`) but prefer the new names.

## Components (web/src/ui.tsx — import, don't re-implement)

- `PageHeader({ icon, title, subtitle, crumbs, actions })` — every page starts with it. `crumbs`: `[["Overview", "#/overview"], ["Runs"]]`.
- `StatCard({ icon, label, value, hint, tone: "brand"|"run"|"wait"|"ok"|"err", onClick })`.
- `Badge({ s, label? })` — status pill with dot (pulses for live statuses); `label` shows the localized name from `i18n/messages.ts`. `STATUS_COLORS` and `LIVE_STATUSES` live in api.ts.
- `EmptyState({ icon, title, children, action })`, `Loading({ label })`, `Skeleton`, `SkeletonRows`, `ErrorBox`.
- `Segmented({ options, value, onChange })`, `SearchInput({ value, onChange, placeholder })`, `Tabs`, `Field`, `Drawer({ title, onClose })`.
- `Markdown`, `Json`, `JsonBlock`, `Copy`, `toast`, `act`, `navigate`, `time`, `ago`, `dur` — unchanged behaviour.
- Brand: `BrandLogo` (web/src/brand) — only way to show the logo.
- Icons: `lucide-react` (size 15–18, strokeWidth ~1.9). Never emoji as primary icons (emoji may stay inside user/agent text).

## CSS primitives (classes)

- Buttons: default = brand filled; `.ghost` (white, outlined), `.quiet` (text), `.ok/.warn/.danger`; sizes `.sm/.xs/.icon`. `<a class="btn ghost">` for links styled as buttons.
- Surfaces: `.card` (`.flat`, `.hero`, `.tight`), `.card-head`, `.stat`, `.grid2/3/4`, `.stack`, `.row`, `.toolbar`, `.divider`.
- Data: `table` (rounded, uppercase headers, `tr.click` hover tint), `.table-wrap`, `.badge`, `.pill`, `.chip-brand`, `.kbd`, `.count`, `.progress > span`.
- Inputs: `input/select/textarea` styled globally; `.field`, `.search`.

## Rules

- Pages own their layout; put page-specific CSS in `web/src/pages/<Page>.css` (imported by the page), class names prefixed with the page (`.wi-…`, `.runs-…`). Do not edit `styles.css`, `ui.tsx`, `App.tsx` (the shell already provides sidebar + topbar; pages render inside `.page` with padding, or `.page.full` for canvas pages).
- Keep every API call, route, handler and behaviour. Redesign = layout, hierarchy, components, states — not semantics.
- Real data only. Never invent metrics; show "—" / empty states when data is missing.
- Responsive: must work at 1440 / 1024 / 390 px with no horizontal page overflow (wide tables scroll inside `.table-wrap`).
- Accessibility: buttons are `<button>`, icon-only buttons have `aria-label`, keep keyboard focus visible, contrast via tokens.
- Delight in small doses: subtle hover lift, live status dots, soft gradients (`linear-gradient(135deg, var(--brand-50), var(--blush))`) on hero/empty areas only.
