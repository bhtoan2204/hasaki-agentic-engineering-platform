import { useEffect, useState } from "react";
import { BookOpen, Building2, ClipboardList, FolderGit2, Inbox, LayoutDashboard, LineChart, Menu, Moon, PlayCircle, PlugZap, Sun, Workflow, type LucideIcon } from "lucide-react";
import { api, useLive, type LiveState } from "./api.ts";
import { BRAND } from "./brand/brand.ts";
import { BrandLogo } from "./brand/BrandLogo.tsx";
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
import { OverviewPage } from "./pages/Overview.tsx";
import { IntegrationsPage } from "./pages/Integrations.tsx";

function useHash() {
  const [hash, setHash] = useState(location.hash.slice(1) || "/overview");
  useEffect(() => {
    const on = () => setHash(location.hash.slice(1) || "/overview");
    window.addEventListener("hashchange", on);
    return () => window.removeEventListener("hashchange", on);
  }, []);
  return hash;
}

type Theme = "light" | "dark";
function useTheme(): [Theme, (t: Theme) => void] {
  const [theme, setTheme] = useState<Theme>(() => {
    try {
      return (localStorage.getItem("hasaki.theme") as Theme) || "light";
    } catch {
      return "light";
    }
  });
  useEffect(() => {
    document.documentElement.dataset.theme = theme;
    try {
      localStorage.setItem("hasaki.theme", theme);
    } catch {}
  }, [theme]);
  return [theme, setTheme];
}

/** Navigation: route key → label + icon. Routes are unchanged so deep links keep working. */
const NAV: Array<{ group: string; items: Array<{ key: string; label: string; icon: LucideIcon }> }> = [
  { group: "Workspace", items: [
    { key: "overview", label: "Overview", icon: LayoutDashboard },
    { key: "office", label: "Agent Office", icon: Building2 },
  ] },
  { group: "Engineering", items: [
    { key: "work-items", label: "Work Items", icon: ClipboardList },
    { key: "runs", label: "Workflow Runs", icon: PlayCircle },
    { key: "workflows", label: "Workflow Studio", icon: Workflow },
    { key: "questions", label: "Questions & Approvals", icon: Inbox },
  ] },
  { group: "Library", items: [
    { key: "knowledge", label: "Knowledge", icon: BookOpen },
    { key: "repositories", label: "Repositories", icon: FolderGit2 },
    { key: "integrations", label: "Integrations", icon: PlugZap },
    { key: "insights", label: "Insights", icon: LineChart },
  ] },
];
const LABEL = Object.fromEntries(NAV.flatMap((g) => g.items.map((i) => [i.key, i])));

export function App() {
  const hash = useHash();
  const parts = hash.split("/").filter(Boolean);
  const [theme, setTheme] = useTheme();
  const [navOpen, setNavOpen] = useState(false);
  const [openQuestions, setOpenQuestions] = useState(0);
  const refreshCount = () => api<any[]>("/api/questions").then((q) => setOpenQuestions(q.length)).catch(() => {});
  useEffect(() => void refreshCount(), []);
  useEffect(() => setNavOpen(false), [hash]);
  const live: LiveState = useLive(null, (p) => {
    if (!p || p.kind === "status" || p.kind === "system") void refreshCount();
  });

  // Legacy links from notifications of the old UI: #TASK-CODE → work item.
  useEffect(() => {
    if (!hash.startsWith("/"))
      api(`/api/tasks/${encodeURIComponent(hash)}`)
        .then((t) => (location.hash = `/work-items/${t.work_item_id}`))
        .catch(() => (location.hash = "/overview"));
  }, [hash]);

  let page;
  let full = false;
  const section = parts[0] ?? "overview";
  switch (section) {
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
    case "integrations":
      page = <IntegrationsPage />;
      break;
    case "insights":
      page = <InsightsPage />;
      break;
    case "office":
      page = <AgentOfficePage param={parts[1]} />;
      full = true;
      break;
    default:
      page = <OverviewPage />;
  }
  const current = LABEL[section] ?? LABEL.overview;
  const CurrentIcon = current.icon;

  return (
    <div className={`app${navOpen ? " nav-open" : ""}`}>
      <aside className="sidebar" aria-label="Điều hướng chính">
        <a className="sb-brand" href="#/overview" aria-label={`${BRAND.product} — Overview`}>
          <BrandLogo size={40} withName />
        </a>
        <nav className="sb-nav">
          {NAV.map((g) => (
            <div key={g.group}>
              <div className="sb-group">{g.group}</div>
              {g.items.map(({ key, label, icon: I }) => (
                <a key={key} href={`#/${key}`} className={`sb-link${section === key || (key === "overview" && !LABEL[section]) ? " on" : ""}`} aria-current={section === key ? "page" : undefined}>
                  <I size={18} strokeWidth={1.9} />
                  <span>{label}</span>
                  {key === "questions" && openQuestions > 0 && <span className="count" aria-label={`${openQuestions} câu hỏi đang chờ`}>{openQuestions}</span>}
                </a>
              ))}
            </div>
          ))}
        </nav>
        <div className="sb-foot">
          <span className="sb-avatar" aria-hidden>H</span>
          <span className="sb-ws"><b>Hasaki Engineering</b><span>Local workspace</span></span>
        </div>
      </aside>
      {navOpen && <div className="scrim" style={{ zIndex: 55 }} onClick={() => setNavOpen(false)} />}

      <div className="main">
        <header className="topbar">
          <button className="quiet icon menu-btn" onClick={() => setNavOpen(true)} aria-label="Mở menu"><Menu size={20} /></button>
          <div className="tb-title"><CurrentIcon size={17} color="var(--brand)" /><span>{current.label}</span></div>
          <div className="tb-right">
            <span className={`live-pill is-${live}`} title="Cập nhật trực tiếp qua Server-Sent Events từ PostgreSQL LISTEN/NOTIFY">
              <i /> <b>{live === "sse" ? "Live" : live === "polling" ? "Polling" : "Đang kết nối"}</b>
            </span>
            <a className="btn ghost icon inbox-btn" href="#/questions" aria-label={`Questions & Approvals: ${openQuestions} đang chờ`} data-tip="Cần bạn xử lý">
              <Inbox size={17} />
              {openQuestions > 0 && <span className="count">{openQuestions}</span>}
            </a>
            <button className="ghost icon" onClick={() => setTheme(theme === "light" ? "dark" : "light")} aria-label={theme === "light" ? "Chuyển sang giao diện tối" : "Chuyển sang giao diện sáng"} data-tip={theme === "light" ? "Giao diện tối" : "Giao diện sáng"}>
              {theme === "light" ? <Moon size={17} /> : <Sun size={17} />}
            </button>
          </div>
        </header>
        <main className={full ? "page full" : "page"} key={parts.slice(0, 2).join("/")}>
          {page}
        </main>
      </div>
    </div>
  );
}
