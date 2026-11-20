import { test } from "node:test";
import assert from "node:assert/strict";
import { supervisionBudget } from "../src/config.ts";

const remote = { DATABASE_URL: "postgres://u:p@db.example.com:5432/x" };
const local = {
  DATABASE_URL: "postgres://u:p@localhost:5432/x",
  RETRIEVAL_SEMANTIC_ENABLED: "true",
};

test("the limits of every agent and verification slot together never exceed the memory left to workloads", () => {
  for (const hostMb of [2048, 4096, 8192, 15_872, 32_768, 65_536, 262_144])
    for (const cpus of [1, 2, 4, 8, 16, 64])
      for (const env of [remote, local, {}]) {
        const b = supervisionBudget(hostMb, cpus, env);
        const committed = b.slots.agent * b.agentMb + b.slots.verification * b.verifyMb;
        assert.ok(
          committed <= b.workloadMb,
          `${hostMb} MiB, ${cpus} CPUs: ${committed} > ${b.workloadMb}`,
        );
        assert.ok(b.slots.agent >= 1 && b.slots.verification >= 1, "every class can run");
        assert.ok(b.slots.agent <= Math.max(1, Math.floor(cpus / 2)));
        assert.ok(b.slots.verification <= Math.max(1, Math.floor(cpus / 4)));
        assert.ok(b.agentMb <= 4096 && b.verifyMb <= 6144);
      }
});

test("services running on this host keep their memory: local PostgreSQL and a local Ollama model", () => {
  const r = supervisionBudget(15_872, 16, remote);
  const l = supervisionBudget(15_872, 16, local);
  assert.equal(r.reservedMb, 1024 + 512);
  assert.equal(l.reservedMb, 1024 + 512 + 1024 + 2048);
  assert.ok(l.workloadMb < r.workloadMb);
  // A remote embedding provider or Unix-socket database are recognized as well.
  assert.equal(
    supervisionBudget(15_872, 16, {
      DATABASE_URL: "postgres:///x?host=/run/postgresql",
      RETRIEVAL_SEMANTIC_ENABLED: "true",
      EMBEDDING_PROVIDER: "openai",
    }).reservedMb,
    1024 + 512 + 1024,
  );
});

test("the 15 GiB / 16 CPU development host no longer overcommits (was 3 × 4 GiB + 2 × 6 GiB = 24 GiB)", () => {
  const b = supervisionBudget(15_872, 16, { ...remote, RETRIEVAL_SEMANTIC_ENABLED: "true" });
  assert.deepEqual(b.slots, { agent: 2, verification: 1 });
  assert.ok(b.slots.agent * b.agentMb + b.slots.verification * b.verifyMb <= 15_872 - b.reservedMb);
});
