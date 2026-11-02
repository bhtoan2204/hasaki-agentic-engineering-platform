import { config } from "../config.ts";
import { workItems } from "../workitems/service.ts";

/** Flatten Atlassian Document Format (Jira Cloud v3 description) into plain text. */
export function adfToText(node: any): string {
  if (!node) return "";
  if (typeof node === "string") return node;
  if (node.type === "text") return node.text ?? "";
  const inner = (node.content ?? []).map(adfToText).join(node.type === "bulletList" || node.type === "orderedList" ? "\n" : "");
  if (["paragraph", "heading", "codeBlock", "blockquote"].includes(node.type)) return inner + "\n";
  if (node.type === "listItem") return "- " + inner.trim();
  if (node.type === "hardBreak") return "\n";
  return inner;
}

export function normalizeJiraIssue(issue: any) {
  if (!issue?.key || !issue?.fields) throw new Error("not a Jira issue payload (need key and fields)");
  const f = issue.fields;
  return {
    code: String(issue.key),
    externalId: String(issue.id ?? ""),
    title: String(f.summary ?? issue.key),
    description: typeof f.description === "string" ? f.description : adfToText(f.description).trim(),
    project: String(f.project?.name ?? f.project?.key ?? ""),
    payload: { key: issue.key, status: f.status?.name, issuetype: f.issuetype?.name, priority: f.priority?.name, labels: f.labels ?? [], url: config.jira.baseUrl ? `${config.jira.baseUrl}/browse/${issue.key}` : "" },
  };
}

/** Fetch an issue from Jira Cloud REST v3 and import it as a work item (no execution). */
export async function importJiraIssue(key: string) {
  if (!config.jira.baseUrl || !config.jira.user || !config.jira.token) throw new Error("Jira is not configured (jira.baseUrl, JIRA_USER, JIRA_TOKEN)");
  if (!/^[A-Z][A-Z0-9_]+-\d+$/.test(key)) throw new Error(`invalid Jira key "${key}"`);
  const res = await fetch(`${config.jira.baseUrl.replace(/\/$/, "")}/rest/api/3/issue/${encodeURIComponent(key)}?fields=summary,description,project,status,issuetype,priority,labels`, {
    headers: { Authorization: "Basic " + Buffer.from(`${config.jira.user}:${config.jira.token}`).toString("base64"), Accept: "application/json" },
  });
  if (!res.ok) throw new Error(`Jira ${res.status}: ${(await res.text()).slice(0, 300)}`);
  const n = normalizeJiraIssue(await res.json());
  return workItems.upsertImported({ source: "jira", ...n });
}

/** Import from a pasted issue JSON (no credentials needed). */
export function importJiraPayload(issue: unknown) {
  return workItems.upsertImported({ source: "jira", ...normalizeJiraIssue(issue) });
}
