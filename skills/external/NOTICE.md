# Third-party agent skills

The skills in this directory come from open-source repositories. `manifest.json` records, per skill, the upstream
repository, commit, path, license, whether the text was adapted, what was changed and the SHA-256 of every file
(local and upstream). `npm run skills:import-external` loads them into the knowledge registry as `skill.ext.<name>`.

| Skill | Upstream | License | Local copy |
|---|---|---|---|
| verification-before-completion | obra/superpowers @ 22f0b46 | MIT, Copyright (c) 2025 Jesse Vincent | unchanged |
| systematic-debugging | obra/superpowers @ 22f0b46 | MIT, Copyright (c) 2025 Jesse Vincent | adapted |
| test-driven-development | obra/superpowers @ 22f0b46 | MIT, Copyright (c) 2025 Jesse Vincent | adapted |
| writing-plans | obra/superpowers @ 22f0b46 | MIT, Copyright (c) 2025 Jesse Vincent | adapted |
| differential-review | trailofbits/skills @ e4dd0bb | CC BY-SA 4.0, Trail of Bits | adapted (shared under CC BY-SA 4.0) |
| frontend-design | anthropics/skills @ 2c5958e | Apache-2.0, Anthropic | unchanged |
| supply-chain-risk-auditor | trailofbits/skills @ e4dd0bb | CC BY-SA 4.0, Trail of Bits | not copied (blocked) |
| playwright-cli | microsoft/playwright-cli @ 8297c9b | Apache-2.0, Microsoft | not copied (blocked) |

License texts: `LICENSE.superpowers-MIT`, `LICENSE.trailofbits-CC-BY-SA-4.0`, `LICENSE.anthropics-Apache-2.0`.

Adapted files differ from upstream only as listed under `origin.adaptation_notes` in `manifest.json`; the upstream
files can be compared with `npm run skills:import-external -- --verify=<dir with upstream clones>`.
No executable script from an upstream skill is copied or imported.
