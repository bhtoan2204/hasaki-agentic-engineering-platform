import { before, test } from "node:test";
import assert from "node:assert/strict";
import { pool, q } from "../src/db/pool.ts";
import { migrate } from "../src/db/migrate.ts";
import { definitions, seedTemplates } from "../src/workflow/definitions.ts";
import { TEMPLATES } from "../src/workflow/templates.ts";
import { validateSpec } from "../src/workflow/graph.ts";

before(async () => {
  await migrate();
  await seedTemplates();
});

test("a template update reaches a definition whose latest version has local edits", async () => {
  const key = "bug-investigation";
  const shipped = validateSpec(TEMPLATES.find((t) => t.key === key)!.spec);
  const analyze = shipped.steps.findIndex((s) => s.key === "analyze");
  const old = structuredClone(shipped);
  old.steps[analyze].config.output_contract = "{ summary }";
  const d = (await definitions.get(key))!;
  await q(pool, "UPDATE workflow_definitions SET template_base = $2 WHERE id = $1", [
    d.id,
    JSON.stringify(old),
  ]);
  const local = structuredClone(old);
  local.steps[0].ui = { x: 11, y: 22 };
  await definitions.saveDraft(key, local);
  await definitions.publish(key, "re-laid out the graph");

  await seedTemplates();
  const after = (await definitions.get(key))!;
  const latest = after.versions[0];
  assert.equal(latest.change_note, "built-in template update (local edits kept)");
  assert.equal(
    latest.spec.steps[analyze].config.output_contract,
    shipped.steps[analyze].config.output_contract,
  );
  assert.deepEqual(latest.spec.steps[0].ui, { x: 11, y: 22 });

  await seedTemplates();
  assert.equal((await definitions.get(key))!.versions[0].version, latest.version);
});

test("an unpublished draft blocks the template update instead of being overwritten", async () => {
  const key = "feature-implementation";
  const d = (await definitions.get(key))!;
  const draft = structuredClone(d.versions[0].spec);
  draft.description = "draft in progress";
  await q(pool, "UPDATE workflow_definitions SET template_base = $2 WHERE id = $1", [
    d.id,
    JSON.stringify({ ...draft, description: "older template" }),
  ]);
  await definitions.saveDraft(key, draft);
  await seedTemplates();
  const after = (await definitions.get(key))!;
  assert.equal(after.versions[0].version, d.versions[0].version);
  assert.equal(after.draft_spec?.description, "draft in progress");
});

test("private versions shadow shared versions and a missing explicit version falls back to shared", async () => {
  const key = "version-scope-test";
  const spec = { name: "Shared v1", steps: [{ key: "first", type: "human_input" }] };
  const { ensureTestOwner } = await import("../src/auth/testOwner.ts");
  const owner = await ensureTestOwner();
  await definitions.create({ key, spec });
  await definitions.saveDraft(key, { ...spec, name: "Shared v2" });
  assert.deepEqual(await definitions.publish(key), { version: 2, unchanged: false });
  await definitions.create({ key, spec: { ...spec, name: "Private v1" }, ownerId: owner });

  assert.equal((await definitions.version(key, undefined, pool, owner))?.spec.name, "Private v1");
  assert.equal((await definitions.version(key, 2, pool, owner))?.spec.name, "Shared v2");
  assert.equal((await definitions.version(key))?.spec.name, "Shared v2");
});
