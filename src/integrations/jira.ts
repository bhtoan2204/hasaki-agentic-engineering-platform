import { config } from "../config.ts";
import { getUserSecret } from "../auth/secrets.ts";
import { workItems } from "../workitems/service.ts";

async function jiraCreds(ownerId?: number) {
  if (ownerId) {
    const user = await getUserSecret(ownerId, "jira_user");
    const token = await getUserSecret(ownerId, "jira_token");
    if (user && token) return { user, token };
    if (user || token) throw new Error("This account's Jira credentials are incomplete");
  }
  if (config.jira.user && config.jira.token)
    return { user: config.jira.user, token: config.jira.token };
  return null;
}

/** Flatten Atlassian Document Format (Jira Cloud v3 description) into plain text. */
export function adfToText(node: unknown): string {
  if (!node) return "";
  if (typeof node === "string") return node;
  if (typeof node !== "object") return "";
  const n: { type?: unknown; text?: unknown; content?: unknown } = node;
  if (n.type === "text") return String(n.text ?? "");
  const inner = (Array.isArray(n.content) ? n.content : [])
    .map(adfToText)
    .join(n.type === "bulletList" || n.type === "orderedList" ? "\n" : "");
  if (
    typeof n.type === "string" &&
    ["paragraph", "heading", "codeBlock", "blockquote"].includes(n.type)
  )
    return inner + "\n";
  if (n.type === "listItem") return "- " + inner.trim();
  if (n.type === "hardBreak") return "\n";
  return inner;
}

type JiraIssue = {
  key: string;
  id?: string | number;
  fields: {
    summary?: string;
    description?: unknown;
    project?: { name?: string; key?: string };
    status?: { name?: string };
    issuetype?: { name?: string };
    priority?: { name?: string };
    labels?: string[];
  };
};

function isJiraIssue(v: unknown): v is JiraIssue {
  return (
    typeof v === "object" && v !== null && "key" in v && !!v.key && "fields" in v && !!v.fields
  );
}

export function normalizeJiraIssue(issue: unknown) {
  if (!isJiraIssue(issue)) throw new Error("not a Jira issue payload (need key and fields)");
  const f = issue.fields;
  return {
    code: String(issue.key),
    externalId: String(issue.id ?? ""),
    title: String(f.summary ?? issue.key),
    description:
      typeof f.description === "string" ? f.description : adfToText(f.description).trim(),
    project: String(f.project?.name ?? f.project?.key ?? ""),
    payload: {
      key: issue.key,
      status: f.status?.name,
      issuetype: f.issuetype?.name,
      priority: f.priority?.name,
      labels: f.labels ?? [],
      url: config.jira.baseUrl ? `${config.jira.baseUrl}/browse/${issue.key}` : "",
    },
  };
}

/** Fetch an issue from Jira Cloud REST v3 and import it as a work item (no execution). */
export async function importJiraIssue(key: string, ownerId?: number) {
  const creds = await jiraCreds(ownerId);
  if (!config.jira.baseUrl || !creds) throw new Error("Jira is not configured for this account");
  if (!/^[A-Z][A-Z0-9_]+-\d+$/.test(key)) throw new Error(`invalid Jira key "${key}"`);
  const res = await fetch(
    `${config.jira.baseUrl.replace(/\/$/, "")}/rest/api/3/issue/${encodeURIComponent(key)}?fields=summary,description,project,status,issuetype,priority,labels`,
    {
      headers: {
        Authorization: "Basic " + Buffer.from(`${creds.user}:${creds.token}`).toString("base64"),
        Accept: "application/json",
      },
    },
  );
  if (!res.ok) throw new Error(`Jira ${res.status}: ${(await res.text()).slice(0, 300)}`);
  const n = normalizeJiraIssue(await res.json());
  return workItems.upsertImported({ source: "jira", ...n, ownerId });
}

/** Import from a pasted issue JSON (no credentials needed). */
export function importJiraPayload(issue: unknown, ownerId?: number) {
  return workItems.upsertImported({ source: "jira", ...normalizeJiraIssue(issue), ownerId });
}
