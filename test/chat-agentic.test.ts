import { test } from "node:test";
import assert from "node:assert/strict";
import { canonicalName, resolveRepositories } from "../src/chat/repoResolver.ts";
import { sniffImage } from "../src/chat/attachments.ts";
import type { RepositoryRow } from "../src/repos/service.ts";

const repo = (name: string, extra: Partial<RepositoryRow> = {}) =>
  ({ name, projects: [], services: [], tags: [], description: "", ...extra }) as RepositoryRow;
const registry = [
  repo("payment_gateway", { projects: ["Payment"] }),
  repo("payment-paypal", { projects: ["Payment"] }),
  repo("payment-wiki", { projects: ["Payment"], description: "Payment architecture documents" }),
  repo("oms-core", { projects: ["OMS"], services: ["order-service"] }),
  repo("common-lib"),
];

test("repository resolver: projects, spelling variants, services; generic words alone resolve nothing", () => {
  const names = (text: string) => resolveRepositories(text, registry).map((r) => r.name);
  assert.deepEqual(names("Techstack Payment gồm những gì?").sort(), ["payment-paypal", "payment-wiki", "payment_gateway"]);
  assert.equal(names("đọc source payment gateway giải thích refund")[0], "payment_gateway");
  assert.equal(names("payment-gateway refund flow")[0], "payment_gateway");
  assert.deepEqual(names("lỗi trong order-service"), ["oms-core"]);
  assert.deepEqual(names("So sánh implementation OMS và Payment").includes("oms-core"), true);
  assert.deepEqual(names("check the common service api code"), [], "generic words are not a repository");
  assert.deepEqual(names(""), []);
  assert.equal(canonicalName("Payment_Gateway"), "payment-gateway");
});

test("image type comes from the bytes", () => {
  assert.equal(sniffImage(Buffer.from("89504e470d0a1a0a0000", "hex")), "image/png");
  assert.equal(sniffImage(Buffer.from("ffd8ffe000104a464946", "hex")), "image/jpeg");
  assert.equal(sniffImage(Buffer.concat([Buffer.from("RIFF"), Buffer.alloc(4), Buffer.from("WEBPVP8 ")])), "image/webp");
  assert.equal(sniffImage(Buffer.from("GIF89a")), null);
  assert.equal(sniffImage(Buffer.from("<svg xmlns=")), null);
});
