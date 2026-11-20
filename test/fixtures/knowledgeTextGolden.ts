/**
 * Regenerates go/internal/knowledge/testdata/text-golden.json: the importer's text rules (slug, frontmatter,
 * firstHeading, firstParagraph, looksSecret, sliceUnits) on edge cases, as JavaScript computes them. The Go port is
 * tested against this file (go test ./internal/knowledge/).
 *
 *   node --disable-warning=ExperimentalWarning --import ./test/env.ts test/fixtures/knowledgeTextGolden.ts
 */
import { writeFileSync } from "node:fs";
import {
  firstHeading,
  firstParagraph,
  frontmatter,
  looksSecret,
  sliceUnits,
  slug,
} from "../../src/knowledge/importer.ts";

const texts = [
  "",
  "plain",
  "# Title\n\nFirst paragraph\nwraps.\n\nSecond.",
  "#\n\n  Heading after blank lines\nbody",
  "intro\n# Late heading  \n",
  "#   \n",
  "# \t",
  "# x",
  "x # after LS\nz",
  "x\r# after CR",
  "##Not a heading\n# Real",
  "---\nname: a\ndescription: >-\n  folded line one\n  line two\n---\n# Body\n\ntext",
  "---\r\nname: crlf\r\ndescription: |\r\n  literal\r\n  kept\r\n---\r\nbody",
  "---\nname: 'quoted'\nother: \"x\"\nlone: \"\nsingle: '\nempty:\n  continued\n\n  more\n---\nB",
  "---\nkey with space: v\n9bad: x\n_ok-key :  spaced value  \nk:v w\n---body",
  "---\n---\nno header",
  "---\nname: x\n---",
  "---\nname: x\n----more\n",
  "---\nfront: 1\n---\n\nThis file provides guidance to Claude Code.\n\nReal paragraph.",
  "```\ncode\n```\n\n- list item\n \n\nAfter nbsp",
  "a\n \t\n \nb\n\n\nc",
  "a\n \nb",
  "﻿  BOM paragraph  ﻿",
  "x".repeat(299) + "😀tail",
  "y".repeat(298) + "😀tail",
  "word\u0085next",
  "THIS FILE PROVIDES GUIDANCE TO CLAUDE\n\nkept",
  "thiſ file provides guidance to claude\n\nkept?",
];
const secrets = [
  "password=hunter2-secret-value",
  'password = "abcdefghijklmnop"',
  "DB_PASSWORD=Sup3rS3cretValue123",
  "secret = payment_client.ecom_global.secret",
  "token: ${TOKEN_FROM_ENV_VAR}",
  "api_key: <your-api-key-here>",
  "apiKey = YOUR_API_KEY_123456",
  "client-secret: example-value-123456",
  "token=xxxxxxxxxxxxxxxxxxxxxxxx",
  "the token is short=abc",
  "https://www.paypal.com/checkoutnow?token=EC-5Y366741JN879735H",
  "https://www.PAYPAL.com/checkoutnow?token=EC-5Y366741JN879735H then password=realsecretvalue1",
  "eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxMjM0NTY3ODkwIn0.dozjgNryP4J3jVmNHl0w5N_XgL0n3I9PlFUP0THsR8U",
  "-----BEGIN RSA PRIVATE KEY-----",
  "AKIAIOSFODNN7EXAMPLE",
  "sk_live_abcdefghijklmnop1234",
  "my-token-name: '...elided...'",
  "passwordless login: enabled-by-default-for-all",
  "pass word=abcdefghijklmnop",
  "token = abcdefghijklmnopq",
  "x-password:= abcdefghijklmnop",
  "tokenizer=configuration.value.path",
  "token = \"'abcdefghijklmnop'\"",
  "TOKEN=AbCdEfGhIjKlMnOp",
  "paſsword=abcdefghijklmnop",
  "--password=abcdefghijklmnop",
  "x-token: abcdefghijklmnopq",
  "my_password_hash = 'zzzzzzzzzzzzzzzz'",
  "token=short token2=abcdefghijklmnop",
  "secret = a.b.c.d.e.f.g secret=realvalue12345",
  "secret = config.value.path then secret=another.path.value",
  'pre-ApiKey-suf\t=\t"abcdefghijklmnop"',
  "tokens:\n  - token=${A}\n  - token=Abcdefghijklmnop9",
  "9token=abcdefghijklmnop",
  "_token=abcdefghijklmnop",
  "é-token=abcdefghijklmnop",
];
const slugs = [
  "Repo.CLAUDE",
  "skill.İstanbul",
  "skill.Kelvin",
  "--Leading--",
  "a-$b",
  "x..y__z",
  "trailing---",
  "ünïcödé",
  "skill.name.repo/sub dir",
  "😀emoji",
];
writeFileSync(
  new URL("../../go/internal/knowledge/testdata/text-golden.json", import.meta.url),
  JSON.stringify(
    {
      texts: texts.map((t) => ({
        text: t,
        frontmatter: frontmatter(t),
        heading: firstHeading(t) ?? null,
        paragraph: firstParagraph(t),
      })),
      secrets: secrets.map((t) => ({ text: t, secret: looksSecret(t) })),
      slugs: slugs.map((s) => ({ in: s, out: slug(s) })),
      slices: [
        ["ab😀cd", 3],
        ["ab😀cd", 4],
        ["ab😀cd", 2],
        ["abc", 10],
      ].map(([s, n]) => ({ in: s, n, out: sliceUnits(s as string, n as number) })),
    },
    null,
    2,
  ) + "\n",
);
