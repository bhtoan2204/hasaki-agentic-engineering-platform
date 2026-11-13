import { remediateKnowledgeAudit } from "../knowledge/auditRemediation.ts";
import { mkdir, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import { loadKnowledgeAuditData } from "../knowledge/auditLoader.ts";
import { auditMarkdown } from "../knowledge/audit.ts";
import { pool } from "../db/pool.ts";

const offline = process.argv.includes("--offline");
const days = process.argv.find((a) => a.startsWith("--days="))?.slice(7);
try {
  const { input, report } = await loadKnowledgeAuditData({
    offline,
    windowDays: days ? Number(days) : 7,
  });
  if (process.argv.includes("--remediate")) {
    if (offline) throw new Error("Remediation requires database evidence");
    console.log(
      JSON.stringify(
        await remediateKnowledgeAudit(input, { autoApply: process.argv.includes("--auto-apply") }),
        null,
        2,
      ),
    );
  }
  const root = resolve("docs/audits");
  await mkdir(root, { recursive: true });
  const file = resolve(root, `${report.generatedAt.slice(0, 10)}-knowledge-audit`);
  await writeFile(
    `${file}.md`,
    auditMarkdown(report) +
      `\nSources: ${JSON.stringify(report.sources)}\n\nPrivate aggregates: ${JSON.stringify(report.privateAggregates)}\n`,
  );
  await writeFile(`${file}.json`, JSON.stringify(report, null, 2) + "\n");
  console.log(JSON.stringify(report, null, 2));
} finally {
  await pool.end();
}
