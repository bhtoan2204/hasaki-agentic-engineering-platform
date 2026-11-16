import { test } from "node:test";
import assert from "node:assert/strict";
import { cookiePairs, parseCurl, shellWords } from "../src/integrations/curl.ts";
import { parseSplunkCookie } from "../src/integrations/splunk.ts";
import { parseKafkaCookie } from "../src/integrations/kafka.ts";

// Same shape as Chrome "Copy as cURL (cmd)" on Windows; values are fake.
const CMD = [
  'curl --url ^"https://siem.hasaki.work/en-GB/splunkd/__raw/servicesNS/nobody/system/web-features?output_mode=json^" ^',
  '  -H ^"accept: */*^" ^',
  '  -H ^"content-type: application/x-www-form-urlencoded^" ^',
  '  -b ^"splunkweb_csrf_token_8000=111; session_id_8080=abc; splunkweb_csrf_token_8080=222; token_key=111; splunkd_8080=Aa^^76iB_x^^rnQ-z^^C3QA_^" ^',
  '  -H ^"sec-ch-ua: ^\\^"Not:A-Brand^\\^";v=^\\^"8^\\^", ^\\^"Chromium^\\^";v=^\\^"156^\\^"^" ^',
  '  -H ^"user-agent: Mozilla/5.0 ^(Windows NT 10.0; Win64; x64^) Chrome/156.0.0.0^" ^',
  '  -H ^"x-requested-with: XMLHttpRequest^" ^',
  '  -H ^"x-splunk-form-key: 222^"',
].join("\r\n");

const BASH = `curl 'https://kafka-ui-qc-v2.hasaki.dev/api/clusters' \\
  -H 'accept: application/json' \\
  -b 'SESSION=s3ss10n; _ga=GA1' \\
  -H 'sec-ch-ua: "Chromium";v="156"'`;

test("Windows cmd cURL: caret escapes undone, cookie and headers extracted", () => {
  const c = parseCurl(CMD)!;
  assert.equal(
    c.url,
    "https://siem.hasaki.work/en-GB/splunkd/__raw/servicesNS/nobody/system/web-features?output_mode=json",
  );
  assert.equal(
    c.cookie,
    "splunkweb_csrf_token_8000=111; session_id_8080=abc; splunkweb_csrf_token_8080=222; token_key=111; splunkd_8080=Aa^76iB_x^rnQ-z^C3QA_",
  );
  assert.equal(c.headers["x-splunk-form-key"], "222");
  assert.equal(c.headers["sec-ch-ua"], '"Not:A-Brand";v="8", "Chromium";v="156"');
  assert.equal(
    c.headers["user-agent"],
    "Mozilla/5.0 (Windows NT 10.0; Win64; x64) Chrome/156.0.0.0",
  );
});

test("Splunk: session cookie of port 8080 → CSRF of port 8080, not the stale 8000 one", () => {
  const s = parseSplunkCookie(CMD);
  assert.equal(s.formKey, "222");
  assert.match(s.cookie, /splunkd_8080=Aa\^76iB_x\^rnQ-z\^C3QA_/);
  // without the header, the key still comes from the matching port
  assert.equal(
    parseSplunkCookie(
      "splunkweb_csrf_token_8000=111; splunkd_8080=x; splunkweb_csrf_token_8080=222",
    ).formKey,
    "222",
  );
  assert.throws(
    () => parseSplunkCookie("splunkd_8080=x; splunkweb_csrf_token_8000=111"),
    /csrf_token_8080/,
  );
});

test("bash cURL and plain Cookie header still work; junk gives a clear error", () => {
  assert.equal(parseKafkaCookie(BASH), "SESSION=s3ss10n; _ga=GA1");
  assert.equal(parseKafkaCookie("Cookie: SESSION=s3ss10n"), "SESSION=s3ss10n");
  assert.deepEqual(shellWords(`a 'b c' "d \\"e\\"" $'f'`), ["a", "b c", 'd "e"', "f"]);
  assert.throws(() => cookiePairs("curl 'https://x' -H 'accept: */*'"), /không có cookie/);
  assert.throws(() => cookiePairs("SESSION=a\nb"), /không đọc được cookie/);
});
