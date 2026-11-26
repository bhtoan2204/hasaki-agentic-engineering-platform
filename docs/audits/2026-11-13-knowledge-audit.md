# Knowledge audit

Generated: 2026-11-13T05:52:49.483Z. Window: 7 days. Items: 175.

Private findings are aggregate counts only.

{
  "category": {
    "agent_skill": 88,
    "architecture_guideline": 6,
    "coding_standard": 10,
    "domain_knowledge": 41,
    "repository_convention": 19,
    "security_policy": 1,
    "task_memory": 10
  },
  "scope": {
    "GLOBAL": 25,
    "ORGANIZATION": 9,
    "PROJECT": 64,
    "REPOSITORY": 77
  },
  "ownership": {
    "shared": 175,
    "private": 0
  }
}

| Finding | Classification | Items | Proposed action |
|---|---|---|---|
| unrestricted_global | verified | security-review | Assign explicitly or restrict applicability |
| exact_duplicate | needs human approval | inside-product-worker-usa.claude, oms-background.claude | Keep the older canonical item; deprecate the duplicate through a proposal |
| repeated_truncation | verified | inside-product-worker-usa.claude | Review splitting proposal |
| repeated_truncation | verified | oms-api.claude | Review splitting proposal |
| repeated_truncation | verified | oms-background.claude | Review splitting proposal |
| repeated_truncation | verified | oms-frontend.rule.oms-frontend | Review splitting proposal |
| repeated_truncation | verified | oms-gateway.claude | Review splitting proposal |
| repeated_truncation | verified | payment-vnpay.claude | Review splitting proposal |
| excessive_context | verified | payment-wiki.docs.partners.fiserv.index | Review splitting or on-demand disclosure |
| repeated_truncation | verified | skill.amazon-sp-api | Review splitting proposal |
| codebase_map_consolidation | needs human approval | skill.oms-codebase-map.inside-product-worker-usa | Review replacement by bounded code-intelligence map on Ponytail pilot |
| repeated_truncation | verified | skill.oms-codebase-map.inside-product-worker-usa | Review splitting proposal |
| repeated_truncation | verified | skill.oms-es-search | Review splitting proposal |
| repeated_truncation | verified | skill.oms-grpc-endpoint | Review splitting proposal |
| repeated_truncation | verified | skill.oms-money-model | Review splitting proposal |
| repeated_truncation | verified | skill.oms-outbox-async | Review splitting proposal |
| repeated_truncation | verified | skill.oms-shipment-order-status | Review splitting proposal |
| repeated_truncation | verified | skill.oms-test-baseline | Review splitting proposal |
| repeated_truncation | verified | skill.oms-write-path.inside-product-worker-usa | Review splitting proposal |
| repeated_truncation | verified | skill.solid | Review splitting proposal |
| repeated_truncation | verified | skill.tiktok-shop-us | Review splitting proposal |
| repeated_truncation | verified | skill.uber-go-style | Review splitting proposal |
| codebase_map_consolidation | needs human approval | skill.oms-codebase-map.oms-background | Review replacement by bounded code-intelligence map on Ponytail pilot |
| repeated_truncation | verified | skill.oms-kafka-consumer | Review splitting proposal |
| repeated_truncation | verified | skill.oms-merchant-connector | Review splitting proposal |
| repeated_truncation | verified | skill.oms-ops-endpoint | Review splitting proposal |
| repeated_truncation | verified | skill.oms-outbox-es-sync | Review splitting proposal |
| repeated_truncation | verified | skill.oms-write-path.oms-background | Review splitting proposal |
| repeated_truncation | verified | skill.oms-gateway-auth | Review splitting proposal |
| codebase_map_consolidation | needs human approval | skill.oms-gateway-codebase-map | Review replacement by bounded code-intelligence map on Ponytail pilot |
| repeated_truncation | verified | user.skill.commit | Review splitting proposal |
| repeated_truncation | verified | user.skill.investigate | Review splitting proposal |
| repeated_truncation | verified | user.skill.yagni | Review splitting proposal |
| repeated_truncation | verified | oms-consistency-and-service-boundaries | Review splitting proposal |
| repeated_truncation | verified | oms-search-read-model | Review splitting proposal |
| repeated_truncation | verified | oms-es-db-read-audit | Review splitting proposal |
| unused | suspected | memory.run-10.oms-api.facts | Review usage and reachability; never disable from absence alone |
| repeated_truncation | verified | go-tests-use-mockgen | Review splitting proposal |
| repeated_truncation | verified | payment-wiki.inventory.conflicts | Review splitting proposal |
| repeated_truncation | verified | payment-wiki.docs.architecture.event-sourcing.payment-order-aggregate | Review splitting proposal |
| repeated_truncation | verified | payment-wiki.docs.async.asynq-tasks | Review splitting proposal |
| repeated_truncation | verified | payment-wiki.docs.development.add-gateway-endpoint | Review splitting proposal |
| repeated_truncation | verified | payment-wiki.docs.overview.how-it-works | Review splitting proposal |
| repeated_truncation | verified | payment-wiki.docs.overview.service-catalog | Review splitting proposal |
| truncated_import | suspected | payment-wiki.docs.partners.fiserv.fiserv-commercehub-apis | Review original source before restoring |
| excessive_context | verified | payment-wiki.docs.partners.fiserv.fiserv-commercehub-apis | Review splitting or on-demand disclosure |
| excessive_context | verified | user.skill.oms-carrier-ghn | Review splitting or on-demand disclosure |
| repeated_truncation | verified | user.skill.oms-carrier-ghn | Review splitting proposal |
| excessive_context | verified | user.skill.oms-carrier-ghtk | Review splitting or on-demand disclosure |
| repeated_truncation | verified | user.skill.oms-carrier-ghtk | Review splitting proposal |
| excessive_context | verified | user.skill.oms-carrier-spx | Review splitting or on-demand disclosure |
| repeated_truncation | verified | user.skill.oms-carrier-spx | Review splitting proposal |
| unused | suspected | payment-techcom.claude | Review usage and reachability; never disable from absence alone |
| unreachable | verified | skill.ext.verification-before-completion | Review applicability proposal |
| conflict | needs human approval | skill.ext.systematic-debugging, skill.ext.test-driven-development | Review conflicting shared guidance; retain pending proposal |
| unreachable | verified | skill.ext.systematic-debugging | Review applicability proposal |
| unreachable | verified | skill.ext.systematic-debugging.condition-based-waiting | Review applicability proposal |
| unreachable | verified | skill.ext.systematic-debugging.defense-in-depth | Review applicability proposal |
| unreachable | verified | skill.ext.systematic-debugging.root-cause-tracing | Review applicability proposal |
| unreachable | verified | skill.ext.test-driven-development | Review applicability proposal |
| unreachable | verified | skill.ext.test-driven-development.writing-good-tests | Review applicability proposal |
| provider_unavailable | verified | skill.ext.supply-chain-risk-auditor | Review provider availability |
| unused | suspected | skill.ext.supply-chain-risk-auditor | Review usage and reachability; never disable from absence alone |
| unreachable | verified | skill.ext.playwright-cli | Review applicability proposal |
| provider_unavailable | verified | skill.ext.playwright-cli | Review provider availability |
| unused | suspected | skill.ext.playwright-cli | Review usage and reachability; never disable from absence alone |
| codebase_map_consolidation | needs human approval | skill.oms-codebase-map.oms-background.references.architecture | Review replacement by bounded code-intelligence map on Ponytail pilot |
| truncated_import | suspected | skill.uber-go-style.references.uber-go-guide | Review original source before restoring |
| excessive_context | verified | skill.uber-go-style.references.uber-go-guide | Review splitting or on-demand disclosure |
| unused | suspected | skill.stripe-best-practices.references.billing | Review usage and reachability; never disable from absence alone |
| unused | suspected | skill.stripe-best-practices.references.connect | Review usage and reachability; never disable from absence alone |
| unused | suspected | skill.stripe-best-practices.references.payments | Review usage and reachability; never disable from absence alone |
| unused | suspected | skill.stripe-best-practices.references.security | Review usage and reachability; never disable from absence alone |
| unused | suspected | skill.stripe-best-practices.references.tax | Review usage and reachability; never disable from absence alone |
| unused | suspected | skill.stripe-best-practices.references.treasury | Review usage and reachability; never disable from absence alone |
| unused | suspected | skill.fiserv-commercehub.reference.api-catalog | Review usage and reachability; never disable from absence alone |
| unused | suspected | skill.fiserv-commercehub.reference.authentication | Review usage and reachability; never disable from absence alone |
| unused | suspected | skill.fiserv-commercehub.reference.checkouts-hpp | Review usage and reachability; never disable from absence alone |
| unused | suspected | skill.fiserv-commercehub.reference.pix-qr | Review usage and reachability; never disable from absence alone |
| unused | suspected | skill.fiserv-commercehub.reference.project-integration | Review usage and reachability; never disable from absence alone |
| unrestricted_global | verified | latency-service-boundaries | Assign explicitly or restrict applicability |
| unused | suspected | latency-service-boundaries | Review usage and reachability; never disable from absence alone |
| unused | suspected | skill.ext.ponytail | Review usage and reachability; never disable from absence alone |
| unused | suspected | skill.ext.ponytail-review | Review usage and reachability; never disable from absence alone |
| unrestricted_global | verified | unit-test-generation | Assign explicitly or restrict applicability |
| unused | suspected | unit-test-generation | Review usage and reachability; never disable from absence alone |

Sources: {"database":true,"external":true,"seeds":true}

Private aggregates: {"category":{"business_rule":5,"task_memory":160},"scope":{"GLOBAL":1,"PROJECT":3,"REPOSITORY":161},"ownership":{"shared":0,"private":165},"findings":{"near_duplicate":3}}
