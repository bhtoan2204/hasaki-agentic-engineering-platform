# Third-party agent skills

The skills in this directory come from open-source repositories. `manifest.json` records, per skill, the upstream
repository, commit, path, license, whether the text was adapted, what was changed and the SHA-256 of every file
(local and upstream). `npm run skills:import-external` loads them into the knowledge registry as `skill.ext.<name>`.

| Skill                          | Upstream                           | License                               | Local copy                          |
| ------------------------------ | ---------------------------------- | ------------------------------------- | ----------------------------------- |
| verification-before-completion | obra/superpowers @ 22f0b46         | MIT, Copyright (c) 2025 Jesse Vincent | unchanged                           |
| systematic-debugging           | obra/superpowers @ 22f0b46         | MIT, Copyright (c) 2025 Jesse Vincent | adapted                             |
| test-driven-development        | obra/superpowers @ 22f0b46         | MIT, Copyright (c) 2025 Jesse Vincent | adapted                             |
| writing-plans                  | obra/superpowers @ 22f0b46         | MIT, Copyright (c) 2025 Jesse Vincent | adapted                             |
| differential-review            | trailofbits/skills @ e4dd0bb       | CC BY-SA 4.0, Trail of Bits           | adapted (shared under CC BY-SA 4.0) |
| frontend-design                | anthropics/skills @ 2c5958e        | Apache-2.0, Anthropic                 | unchanged                           |
| supply-chain-risk-auditor      | trailofbits/skills @ e4dd0bb       | CC BY-SA 4.0, Trail of Bits           | not copied (blocked)                |
| playwright-cli                 | microsoft/playwright-cli @ 8297c9b | Apache-2.0, Microsoft                 | not copied (blocked)                |

License texts: `LICENSE.superpowers-MIT`, `LICENSE.trailofbits-CC-BY-SA-4.0`, `LICENSE.anthropics-Apache-2.0`.

Adapted files differ from upstream only as listed under `origin.adaptation_notes` in `manifest.json`; the upstream
files can be compared with `npm run skills:import-external -- --verify=<dir with upstream clones>`.
No executable script from an upstream skill is copied or imported.

## Additional bundled skills

- brainstorming and receiving-code-review: obra/superpowers @ 22f0b46,
  MIT, Copyright (c) 2025 Jesse Vincent. Adaptations are recorded in the manifest.
- ponytail and ponytail-review: DietrichGebert/ponytail, v5.3.3,
  commit 7801d061243d7b753bad0e0b3c057cd250b11755, MIT, Dietrich Gebert.
  Adapted exclusively from skills/ponytail/SKILL.md and skills/ponytail-review/SKILL.md.
  Removed test-sufficiency exceptions, the shortcut comment requirement and review
  exemption, mode levels, session persistence and slash commands. Tests and
  verification remain governed by TDD, verification skills and platform gates.
  Retained the six-step ladder, never-cut list, reuse-first, minimal diff,
  comments explaining why, and the skipped/checks/risk summary.
  No upstream hooks, scripts, band, webhooks or provider rule files are bundled.

test-driven-development and verification-before-completion apply to the agent steps that write and repair code
(`implement`, `fix`, `refactor`). Their `test`/`regression_test`/`fix_test` keys only reach user-defined agent
steps with those keys: in the built-in templates these, and `targeted_test`, are command steps, whose failures go
back to the agent steps through the verify loop.

### Ponytail MIT license

Copyright (c) Dietrich Gebert

Permission is hereby granted, free of charge, to any person obtaining a copy
of this software and associated documentation files (the "Software"), to deal
in the Software without restriction, including without limitation the rights
to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
copies of the Software, and to permit persons to whom the Software is
furnished to do so, subject to the following conditions:

The above copyright notice and this permission notice shall be included in all
copies or substantial portions of the Software.

THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
SOFTWARE.
