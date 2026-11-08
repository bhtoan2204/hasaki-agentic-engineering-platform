# Living Chibi Companion — Browser Validation

Screenshots in this directory were captured from the production-built SPA using the existing browser verification harness. API routes are deterministic test fixtures; the workflow-status screens are explicitly test data and do not represent production runs.

The smoke verifies the shell-mounted companion on Overview and Work Items, node identity across route navigation, run and attempt provider attribution, approval and completion reactions, preference storage without workflow data, hide and restore, drag positioning, reduced-motion rendering, and Agent Office navigation. It also captures Workflow Studio, Production Errors, Insights, English, Vietnamese, and a 390px viewport.

Run with:

```sh
npm run build
node --disable-warning=ExperimentalWarning test/spa-verification.browser.ts
```

Screenshots: `01-overview-en.png`, `02-companion-working.png`, `03-work-items-en.png`, `04-approval-required.png`, `05-run-view.png`, `06-agent-office.png`, `07-success-reaction.png`, `08-mobile-companion.png`, `09-workflow-studio.png`, `10-production-errors.png`, `11-insights.png`, and `12-overview-vi.png`.
