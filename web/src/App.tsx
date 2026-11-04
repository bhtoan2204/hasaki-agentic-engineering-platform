import { useEffect, useState } from "react";
import { api, useLive, type LiveState } from "./api.ts";
import { WorkItemsPage, WorkItemDetail } from "./pages/WorkItems.tsx";
import { RunsPage } from "./pages/Runs.tsx";
import { RunView } from "./pages/RunView.tsx";
import { QuestionsPage } from "./pages/Questions.tsx";
import { WorkflowsPage } from "./pages/Workflows.tsx";
import { WorkflowEditor } from "./pages/WorkflowEditor.tsx";
import { KnowledgePage } from "./pages/Knowledge.tsx";
import { RepositoriesPage } from "./pages/Repositories.tsx";
import { InsightsPage } from "./pages/Insights.tsx";
import { AgentOfficePage } from "./office/AgentOfficePage.tsx";

function useHash() {
  const [hash, setHash] = useState(location.hash.slice(1) || "/runs");
  useEffect(() => {
    const on = () => setHash(location.hash.slice(1) || "/runs");
    window.addEventListener("hashchange", on);
    return () => window.removeEventListener("hashchange", on);
  }, []);
  return hash;
}

const NAV: Array<[string, string]> = [
  ["runs", "Runs"],
  ["office", "Agent Office"],
  ["work-items", "Work Items"],
  ["questions", "Questions"],
  ["workflows", "Workflows"],
  ["knowledge", "Knowledge"],
  ["repositories", "Repositories"],
  ["insights", "Insights"],
];

export function App() {
  const hash = useHash();
  const parts = hash.split("/").filter(Boolean);
  const [openQuestions, setOpenQuestions] = useState(0);
  const refreshCount = () => api<any[]>("/api/questions").then((q) => setOpenQuestions(q.length)).catch(() => {});
  useEffect(() => void refreshCount(), []);
  const live: LiveState = useLive(null, (p) => {
    if (!p || p.kind === "status" || p.kind === "system") void refreshCount();
  });

  // Legacy links from notifications of the old UI: #TASK-CODE → work item.
  useEffect(() => {
    if (!hash.startsWith("/"))
      api(`/api/tasks/${encodeURIComponent(hash)}`)
        .then((t) => (location.hash = `/work-items/${t.work_item_id}`))
        .catch(() => (location.hash = "/runs"));
  }, [hash]);

  let page;
  let full = false;
  switch (parts[0]) {
    case "runs":
      if (parts[1]) {
        page = <RunView id={Number(parts[1])} stepKey={parts[2]} />;
        full = true;
      } else page = <RunsPage />;
      break;
    case "work-items":
      page = parts[1] ? <WorkItemDetail id={Number(parts[1])} /> : <WorkItemsPage />;
      break;
    case "questions":
      page = <QuestionsPage />;
      break;
    case "workflows":
      if (parts[1]) {
        page = <WorkflowEditor wfKey={parts[1]} />;
        full = true;
      } else page = <WorkflowsPage />;
      break;
    case "knowledge":
      page = <KnowledgePage itemKey={parts[1]} />;
      break;
    case "repositories":
      page = <RepositoriesPage name={parts[1]} />;
      break;
    case "insights":
      page = <InsightsPage />;
      break;
    case "office":
      page = <AgentOfficePage param={parts[1]} />;
      full = true;
      break;
    default:
      page = <RunsPage />;
  }

  return (
    <div className="app">
      <nav className="topbar">
        <span className="brand">⚙︎ Workflow Platform</span>
        {NAV.map(([k, label]) => (
          <a key={k} href={`#/${k}`} className={parts[0] === k ? "on" : ""}>
            {label}
            {k === "questions" && openQuestions > 0 && <span className="count">{openQuestions}</span>}
          </a>
        ))}
        <span className="live" title="Live updates via Server-Sent Events from PostgreSQL LISTEN/NOTIFY">
          {live === "sse" ? "● live" : live === "polling" ? "◌ polling" : "… connecting"}
        </span>
      </nav>
      <main className={full ? "page full" : "page"} key={parts.slice(0, 2).join("/")}>
        {page}
      </main>
    </div>
  );
}
