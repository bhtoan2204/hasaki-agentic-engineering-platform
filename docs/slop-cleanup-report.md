# Slop cleanup report (REQ-109)

Measurement: `tsc -p . --noUnusedLocals --noUnusedParameters` and `eslint src web/src test` (existing `eslint.config.mjs`). No dedicated Slop Detector or architecture-check command exists in the repo.

| Finding type | Before | After |
|---|---|---|
| tsc unused locals/params | 0 | 0 |
| `no-explicit-any` | 1418 | 1418 |
| `no-empty` (empty catch/block) | 40 | 40 |
| `no-unused-expressions` | 55 | 55 |
| `no-control-regex` | 7 | 7 |
| `no-unused-vars` | 10 | 10 |
| `no-useless-escape` | 11 | 0 |
| `prefer-const` | 4 | 1 |
| `no-regex-spaces` | 1 | 0 |
| `no-unsafe-finally` | 1 | 1 |
| `react-hooks/exhaustive-deps` | 11 | 11 |
| **Total** | **1558** | **1543** |

## Changed
- Removed redundant regex escapes inside character classes (semantics identical, no `u` flag).
- `let` -> `const` where never reassigned; regex multi-space literal -> `{3}`.

## Intentionally kept
- `no-unused-vars` in `redactGroup` / `rescope-knowledge`: rest-destructuring used to omit keys.
- `prefer-const` in `splunk.ts`: `rest` shares a destructuring with a reassigned `base`.
- Empty catches, `any`, `no-unsafe-finally` (telegram updates): best-effort or contract-bearing; changing them risks behaviour, and they are out of scope for a behaviour-preserving cleanup.
- Dependencies: `@alibaba-group/open-code-review`, `playwright-core`, `mysql2` are all still imported; none removed.

## Architecture check substitute
No command exists; `src/authz`, `src/repos/access.ts`, `migrations/`, `package.json` untouched (see `git diff --stat`).
