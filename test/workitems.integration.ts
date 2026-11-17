import assert from "node:assert/strict";
import { test } from "node:test";
import { workItems } from "../src/workitems/service.ts";

test("a rejected work item patch does not mark the imported description as manual", async () => {
  const input = {
    code: "IMPORT-DESCRIPTION",
    source: "jira" as const,
    title: "Imported issue",
    description: "Original description",
  };
  const { item } = await workItems.upsertImported(input);
  await assert.rejects(
    workItems.update(item.id, { description: "Rejected edit", status: "invalid" }),
    { code: "23514" },
  );
  const { item: refreshed, created } = await workItems.upsertImported({
    ...input,
    description: "Updated by Jira",
  });
  assert.equal(created, false);
  assert.equal(refreshed.id, item.id);
  assert.equal(refreshed.description, "Updated by Jira");
});
