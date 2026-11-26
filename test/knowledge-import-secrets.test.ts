import { test } from "node:test";
import assert from "node:assert/strict";
import { looksSecret } from "../src/knowledge/importer.ts";

test("a PayPal approval link's order ID is not a credential; other token assignments still are", () => {
  assert.ok(
    !looksSecret(
      '{ "href": "https://www.paypal.com/checkoutnow?token=5O190127TN364715T", "rel": "approve" }',
    ),
  );
  assert.ok(!looksSecret("https://www.sandbox.paypal.com/checkoutnow?token=9SY02093A2155714D"));
  assert.ok(looksSecret("https://evil.example.com/checkoutnow?token=5O190127TN364715T"));
  assert.ok(looksSecret("access_token=A21AAJ8sd9f8sdf98sd7f98sdf"));
  assert.ok(looksSecret('client_secret: "EBWKjlELKMYqRNQ6sYvFo64FtaRLRR5BdHEESmha49TM"'));
});
