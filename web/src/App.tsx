import { useEffect, useState } from "react";
import { BookOpen, Building2, ClipboardList, FolderGit2, Inbox, LayoutDashboard, LineChart, Menu, Moon, PlayCircle, PlugZap, Siren, Sun, Workflow, type LucideIcon } from "lucide-react";
import { api, setAuthed, setCsrf, setSupportView, useLive, type LiveState } from "./api.ts";
import { Login, UsersPage, type SessionUser } from "./pages/Login.tsx";
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
import { ProdErrorsPage } from "./pages/ProdErrors.tsx";
import { useI18n } from "./i18n/index.tsx";
import type { UiLocale } from "./i18n/messages.ts";

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
const NAV: Array<{ group: string; items: Array<{ key: string; labelKey: string; icon: LucideIcon }> }> = [
  { group: "workspace", items: [
    { key: "overview", labelKey: "nav.overview", icon: LayoutDashboard },
    { key: "office", labelKey: "nav.office", icon: Building2 },
  ] },
  { group: "engineering", items: [
    { key: "work-items", labelKey: "nav.workItems", icon: ClipboardList },
    { key: "runs", labelKey: "nav.runs", icon: PlayCircle },
    { key: "workflows", labelKey: "nav.workflows", icon: Workflow },
    { key: "questions", labelKey: "nav.questions", icon: Inbox },
    { key: "prod-errors", labelKey: "nav.prodErrors", icon: Siren },
  ] },
  { group: "library", items: [
    { key: "knowledge", labelKey: "nav.knowledge", icon: BookOpen },
    { key: "repositories", labelKey: "nav.repositories", icon: FolderGit2 },
    { key: "integrations", labelKey: "nav.integrations", icon: PlugZap },
    { key: "insights", labelKey: "nav.insights", icon: LineChart },
  ] },
];
const LABEL = Object.fromEntries(NAV.flatMap((g) => g.items.map((i) => [i.key, i])));

export function App() {
  const { t, locale, setLocale } = useI18n();
  const hash = useHash();
  const parts = hash.split("/").filter(Boolean);
  const [theme, setTheme] = useTheme();
  const [navOpen, setNavOpen] = useState(false);
  const [openQuestions, setOpenQuestions] = useState(0);
  const [me, setMe] = useState<SessionUser | null | undefined>(undefined);
  const [support, setSupport] = useState(false);
  const refreshCount = () => api<any[]>("/api/questions").then((q) => setOpenQuestions(q.length)).catch(() => {});
  useEffect(() => {
    api<{ user: SessionUser; csrf: string }>("/api/auth/me")
      .then((r) => { setCsrf(r.csrf); setAuthed(true); setMe(r.user); })
      .catch(() => { setAuthed(false); setMe(null); });
  }, []);
  useEffect(() => {
    const lost = () => setMe(null);
    window.addEventListener("auth:lost", lost);
    return () => window.removeEventListener("auth:lost", lost);
  }, []);
  useEffect(() => { if (me) void refreshCount(); }, [me]);
  useEffect(() => setNavOpen(false), [hash]);
  const live: LiveState = useLive(null, (p) => {
    if (!p || p.kind === "status" || p.kind === "system") void refreshCount();
  }, !!me);

  useEffect(() => {
    if (!me || hash.startsWith("/")) return;
    api(`/api/tasks/${encodeURIComponent(hash)}`)
      .then((t) => (location.hash = `/work-items/${t.work_item_id}`))
      .catch(() => (location.hash = "/overview"));
  }, [hash, me]);

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
    case "prod-errors":
      page = <ProdErrorsPage focus={parts[1]} />;
      break;
    case "integrations":
      page = <IntegrationsPage />;
      break;
    case "insights":
      page = <InsightsPage tab={parts[1]} />;
      break;
    case "users":
      page = me?.role === "admin" ? <UsersPage /> : <OverviewPage />;
      break;
    case "office":
      page = <AgentOfficePage param={parts[1]} />;
      full = true;
      break;
    default:
      page = <OverviewPage />;
  }
  if (me === undefined) return <main className="page"><p>{t("auth.loading")}</p></main>;
  if (!me) return <Login onIn={setMe} />;
  const current = LABEL[section] ?? LABEL.overview;
  const CurrentIcon = current.icon;

  return (
    <div className={`app${navOpen ? " nav-open" : ""}`}>
      <aside className="sidebar" aria-label={t("nav.aria")}>
        <a className="sb-brand" href="#/overview" aria-label={`${BRAND.product} — Overview`}>
          <BrandLogo size={40} withName />
        </a>
        <nav className="sb-nav">
          {NAV.map((g) => (
            <div key={g.group}>
              <div className="sb-group">{t(`nav.group.${g.group}`)}</div>
              {g.items.map(({ key, labelKey, icon: I }) => (
                <a key={key} href={`#/${key}`} className={`sb-link${section === key || (key === "overview" && !LABEL[section]) ? " on" : ""}`} aria-current={section === key ? "page" : undefined}>
                  <I size={18} strokeWidth={1.9} />
                  <span>{t(labelKey)}</span>
                  {key === "questions" && openQuestions > 0 && <span className="count" aria-label={t("nav.questionsWaiting", { n: openQuestions })}>{openQuestions}</span>}
                </a>
              ))}
            </div>
          ))}
        </nav>
        <div className="sb-foot">
          <span className="sb-avatar" aria-hidden>{me.username.slice(0, 1).toUpperCase()}</span>
          <span className="sb-ws">
            <b>{me.username}</b>
            <span>{me.role === "admin" ? t("auth.role.admin") : t("auth.role.member")} · {support ? t("auth.support") : t("auth.my")}</span>
          </span>
        </div>
      </aside>
      {navOpen && <div className="scrim" style={{ zIndex: 55 }} onClick={() => setNavOpen(false)} />}

      <div className="main">
        <header className="topbar">
          <button className="quiet icon menu-btn" onClick={() => setNavOpen(true)} aria-label={t("nav.menu")}><Menu size={20} /></button>
          <div className="tb-title"><CurrentIcon size={17} color="var(--brand)" /><span>{t(current.labelKey)}</span></div>
          <div className="tb-right">
            <span className={`live-pill is-${live}`} tabIndex={0} data-tip={t("live.tip")}>
              <i /> <b>{live === "sse" ? t("live.sse") : live === "polling" ? t("live.polling") : t("live.connecting")}</b>
            </span>
            <div className="lang-switch" role="group" aria-label={t("lang.switch")}>
              {(["vi", "en"] as UiLocale[]).map((code) => (
                <button key={code} type="button" className={locale === code ? "sm" : "sm ghost"} aria-pressed={locale === code} data-tip={t(code === "vi" ? "lang.vi" : "lang.en")} onClick={() => setLocale(code)}>{code.toUpperCase()}</button>
              ))}
            </div>
            <a className="btn ghost icon inbox-btn" href="#/questions" aria-label={t("inbox.label", { n: openQuestions })} data-tip={t("inbox.tip")}>
              <Inbox size={17} />
              {openQuestions > 0 && <span className="count">{openQuestions}</span>}
            </a>
            {me.role === "admin" && <a className="btn ghost sm" href="#/users">{t("auth.users")}</a>}
            {me.role === "admin" && (
              <label className="sm" style={{ display: "flex", gap: 6, alignItems: "center" }}>
                <input type="checkbox" checked={support} onChange={(e) => { setSupport(e.target.checked); setSupportView(e.target.checked); }} />
                {t("auth.support")}
              </label>
            )}
            <button className="ghost sm" onClick={async () => {
              const password = prompt(t("auth.newPassword"));
              if (!password) return;
              await api("/api/auth/password", { password });
              setAuthed(false);
              setMe(null);
            }}>{t("auth.passwordChange")}</button>
            <button className="ghost sm" onClick={async () => { await api("/api/auth/logout", {}); setAuthed(false); setMe(null); }}>{t("auth.logout")}</button>
            <button className="ghost icon" onClick={() => setTheme(theme === "light" ? "dark" : "light")} aria-label={theme === "light" ? t("theme.toDark") : t("theme.toLight")} data-tip={theme === "light" ? t("theme.dark") : t("theme.light")}>
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
