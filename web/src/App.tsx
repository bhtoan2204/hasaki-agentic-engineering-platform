import { useEffect, useLayoutEffect, useRef, useState } from "react";
import {
  PanelLeftClose,
  PanelLeftOpen,
  ShieldCheck,
  UserRound,
  Users,
  X,
  BookOpen,
  Building2,
  ClipboardList,
  FileSearch,
  FolderGit2,
  Inbox,
  LayoutDashboard,
  LineChart,
  Menu,
  Moon,
  PlayCircle,
  PlugZap,
  Siren,
  Sun,
  Workflow,
  type LucideIcon,
} from "lucide-react";
import {
  api,
  isStateChange,
  setAuthed,
  setCsrf,
  setSupportView,
  useLive,
  type LiveState,
} from "./api.ts";
import { AccountMenu, AccountPage } from "./pages/Account.tsx";
import { Loading } from "./ui.tsx";
import "./shell-account.css";
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
import { GlobalChibiCompanion } from "./office/GlobalChibiCompanion.tsx";
import { OverviewPage } from "./pages/Overview.tsx";
import { InvestigationsPage } from "./pages/Investigations.tsx";
import { IntegrationsPage } from "./pages/Integrations.tsx";
import { ProductionErrorsPage } from "./pages/prodErrors/ProductionErrorsPage.tsx";
import { legacyProductionRoute } from "./pages/prodErrors/routes.ts";
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
const NAV: Array<{
  group: string;
  items: Array<{ key: string; labelKey: string; icon: LucideIcon }>;
}> = [
  {
    group: "workspace",
    items: [
      { key: "overview", labelKey: "nav.overview", icon: LayoutDashboard },
      { key: "office", labelKey: "nav.office", icon: Building2 },
    ],
  },
  {
    group: "engineering",
    items: [
      { key: "work-items", labelKey: "nav.workItems", icon: ClipboardList },
      { key: "runs", labelKey: "nav.runs", icon: PlayCircle },
      { key: "workflows", labelKey: "nav.workflows", icon: Workflow },
      { key: "questions", labelKey: "nav.questions", icon: Inbox },
      { key: "prod-errors", labelKey: "nav.prodErrors", icon: Siren },
      { key: "investigations", labelKey: "nav.investigations", icon: FileSearch },
    ],
  },
  {
    group: "library",
    items: [
      { key: "knowledge", labelKey: "nav.knowledge", icon: BookOpen },
      { key: "repositories", labelKey: "nav.repositories", icon: FolderGit2 },
      { key: "integrations", labelKey: "nav.integrations", icon: PlugZap },
      { key: "insights", labelKey: "nav.insights", icon: LineChart },
    ],
  },
];
const LABEL = {
  ...Object.fromEntries(NAV.flatMap((g) => g.items.map((i) => [i.key, i]))),
  users: { labelKey: "auth.users", icon: Users },
  account: { labelKey: "auth.account", icon: UserRound },
} as Record<string, { labelKey: string; icon: LucideIcon }>;

export function App() {
  const { t, locale, setLocale } = useI18n();
  const hash = useHash();
  const split = hash.indexOf("?");
  const originalPath = split < 0 ? hash : hash.slice(0, split);
  const originalQuery = split < 0 ? "" : hash.slice(split + 1);
  const redirect = legacyProductionRoute(originalPath, originalQuery);
  useEffect(() => {
    if (redirect) location.replace(`#${redirect}`);
  }, [redirect]);
  const effective = redirect ?? hash;
  const boundary = effective.indexOf("?");
  const pathPart = boundary < 0 ? effective : effective.slice(0, boundary);
  const queryPart = boundary < 0 ? "" : effective.slice(boundary + 1);
  const parts = pathPart.split("/").filter(Boolean);
  const [theme, setTheme] = useTheme();
  const [navOpen, setNavOpen] = useState(false);
  const [collapsed, setCollapsed] = useState(false);
  const [notice, setNotice] = useState("");
  const sidebar = useRef<HTMLElement>(null);
  const mobileTrigger = useRef<HTMLButtonElement>(null);
  const pageRef = useRef<HTMLElement>(null);
  const scrollPositions = useRef(new Map<string, number>());
  const [openQuestions, setOpenQuestions] = useState(0);
  const [me, setMe] = useState<SessionUser | null | undefined>(undefined);
  const [support, setSupport] = useState(false);
  const signedOut = (message = "") => {
    setAuthed(false);
    setMe(null);
    setSupport(false);
    setOpenQuestions(0);
    setNavOpen(false);
    setNotice(message);
  };
  const refreshCount = () =>
    api<any[]>("/api/questions")
      .then((q) => setOpenQuestions(q.length))
      .catch(() => {});
  useEffect(() => {
    api<{ user: SessionUser; csrf: string }>("/api/auth/me")
      .then((r) => {
        setCsrf(r.csrf);
        setAuthed(true);
        setMe(r.user);
      })
      .catch(() => {
        setAuthed(false);
        setMe(null);
      });
  }, []);
  useEffect(() => {
    const lost = () => signedOut(me ? "auth.sessionExpired" : "");
    window.addEventListener("auth:lost", lost);
    return () => window.removeEventListener("auth:lost", lost);
  }, [me]);
  useEffect(() => {
    if (me) void refreshCount();
  }, [me]);
  useEffect(() => {
    if (me?.role === "member" && hash.startsWith("/users"))
      location.hash = "/overview";
  }, [me, hash]);
  useEffect(() => {
    setNavOpen(false);
  }, [hash]);
  useEffect(() => {
    const previous = history.scrollRestoration;
    history.scrollRestoration = "manual";
    return () => {
      history.scrollRestoration = previous;
    };
  }, []);
  // Each route owns its page scroll; query/filter edits retain position and input focus.
  useLayoutEffect(() => {
    const page = pageRef.current;
    if (!page) return;
    page.scrollTop = scrollPositions.current.get(pathPart) ?? 0;
    page.focus({ preventScroll: true });
  }, [pathPart, me?.id, support]);
  useEffect(() => {
    const desktop = window.matchMedia("(min-width: 901px)");
    const resize = () => {
      if (desktop.matches) setNavOpen(false);
    };
    desktop.addEventListener("change", resize);
    return () => desktop.removeEventListener("change", resize);
  }, []);
  useEffect(() => {
    if (!navOpen) return;
    sidebar.current?.querySelector<HTMLElement>("button, a")?.focus();
    const key = (e: KeyboardEvent) => {
      if (document.querySelector("dialog[open]")) return;
      if (e.key === "Escape") {
        e.preventDefault();
        setNavOpen(false);
        requestAnimationFrame(() => mobileTrigger.current?.focus());
      }
      if (e.key !== "Tab" || document.getElementById("account-menu")) return;
      const items = [
        ...(sidebar.current?.querySelectorAll<HTMLElement>(
          "a, button:not(:disabled)",
        ) ?? []),
      ].filter((el) => el.getClientRects().length > 0);
      const first = items[0],
        last = items[items.length - 1];
      if (e.shiftKey && document.activeElement === first) {
        e.preventDefault();
        last?.focus();
      }
      if (!e.shiftKey && document.activeElement === last) {
        e.preventDefault();
        first?.focus();
      }
    };
    document.addEventListener("keydown", key);
    return () => document.removeEventListener("keydown", key);
  }, [navOpen]);
  const live: LiveState = useLive(
    null,
    (p) => {
      if (isStateChange(p)) void refreshCount();
    },
    !!me,
  );

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
      page = parts[1] ? (
        <WorkItemDetail id={Number(parts[1])} />
      ) : (
        <WorkItemsPage query={queryPart} />
      );
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
      page = <KnowledgePage itemKey={parts[1]} subKey={parts[2]} />;
      break;
    case "repositories":
      page = <RepositoriesPage name={parts[1]} query={queryPart} me={me} />;
      break;
    case "prod-errors":
      page = (
        <ProductionErrorsPage
          route={parts[1]}
          fingerprint={parts[2]}
          query={queryPart}
        />
      );
      break;
    case "investigations":
      page = <InvestigationsPage id={parts[1] ? Number(parts[1]) : undefined} />;
      break;
    case "integrations":
      page = <IntegrationsPage me={me} />;
      break;
    case "insights":
      page = <InsightsPage tab={parts[1]} />;
      break;
    case "users":
      page =
        me?.role === "admin" ? (
          <UsersPage me={me} onSignedOut={signedOut} />
        ) : (
          <OverviewPage />
        );
      break;
    case "account":
      page = me && (
        <AccountPage
          me={me}
          passwordMode={parts[1] === "password"}
          onSignedOut={signedOut}
        />
      );
      break;
    case "office":
      page = <AgentOfficePage param={parts[1]} />;
      full = true;
      break;
    default:
      page = <OverviewPage />;
  }
  if (me === undefined) return <Loading label={t("auth.loading")} />;
  if (!me)
    return (
      <Login
        notice={notice}
        theme={theme}
        onTheme={() => setTheme(theme === "light" ? "dark" : "light")}
        onIn={(user) => {
          setNotice("");
          setSupport(false);
          setMe(user);
        }}
      />
    );
  const current = LABEL[section] ?? LABEL.overview;
  const CurrentIcon = current.icon;

  return (
    <div
      className={`app${navOpen ? " nav-open" : ""}${collapsed ? " sidebar-collapsed" : ""}`}
    >
      <GlobalChibiCompanion section={section} />
      <aside
        ref={sidebar}
        id="main-sidebar"
        role={navOpen ? "dialog" : undefined}
        aria-modal={navOpen || undefined}
        className="sidebar"
        aria-label={t("nav.aria")}
      >
        <button
          className="quiet icon sb-close"
          onClick={() => {
            setNavOpen(false);
            requestAnimationFrame(() => mobileTrigger.current?.focus());
          }}
          aria-label={t("common.close")}
        >
          <X size={18} />
        </button>
        <a
          className="sb-brand"
          href="#/overview"
          aria-label={`${BRAND.product} — Overview`}
        >
          <BrandLogo size={40} withName />
        </a>
        <button
          className="sb-link sb-toggle"
          onClick={() => setCollapsed(!collapsed)}
          aria-label={t(
            collapsed ? "auth.expandSidebar" : "auth.collapseSidebar",
          )}
          data-tip={t(
            collapsed ? "auth.expandSidebar" : "auth.collapseSidebar",
          )}
        >
          {collapsed ? (
            <PanelLeftOpen size={18} />
          ) : (
            <PanelLeftClose size={18} />
          )}
          <span>{t("auth.collapseSidebar")}</span>
        </button>
        <nav className="sb-nav">
          {NAV.map((g) => (
            <div key={g.group}>
              <div className="sb-group">{t(`nav.group.${g.group}`)}</div>
              {g.items.map(({ key, labelKey, icon: I }) => (
                <a
                  key={key}
                  href={`#/${key}`}
                  className={`sb-link${section === key || (key === "overview" && !LABEL[section]) ? " on" : ""}`}
                  aria-label={t(labelKey)}
                  data-tip={collapsed ? t(labelKey) : undefined}
                  aria-current={section === key ? "page" : undefined}
                >
                  <I size={18} strokeWidth={1.9} />
                  <span>{t(labelKey)}</span>
                  {key === "questions" && openQuestions > 0 && (
                    <span
                      className="count"
                      aria-label={t("nav.questionsWaiting", {
                        n: openQuestions,
                      })}
                    >
                      {openQuestions}
                    </span>
                  )}
                </a>
              ))}
            </div>
          ))}
          {me.role === "admin" && (
            <div>
              <div className="sb-group">{t("auth.administration")}</div>
              <a
                href="#/users"
                className={`sb-link${section === "users" ? " on" : ""}`}
                aria-current={section === "users" ? "page" : undefined}
                aria-label={t("auth.users")}
                data-tip={collapsed ? t("auth.users") : undefined}
              >
                <Users size={18} />
                <span>{t("auth.users")}</span>
              </a>
              <button
                className={`sb-link sb-support${support ? " on" : ""}`}
                aria-pressed={support}
                aria-label={`${t("auth.support")}: ${t(support ? "auth.scopeOn" : "auth.scopeOff")}`}
                data-tip={
                  collapsed
                    ? `${t("auth.support")} · ${t(support ? "auth.scopeOn" : "auth.scopeOff")}`
                    : undefined
                }
                onClick={() => {
                  setSupportView(!support);
                  setSupport(!support);
                }}
              >
                <ShieldCheck size={18} />
                <span>
                  {t("auth.support")}
                  <small>{t(support ? "auth.scopeOn" : "auth.scopeOff")}</small>
                </span>
              </button>
            </div>
          )}
        </nav>
        <div className="sb-foot">
          <AccountMenu
            me={me}
            active={section === "account"}
            onSignedOut={signedOut}
            onNavigate={() => {
              setNavOpen(false);
              requestAnimationFrame(() => pageRef.current?.focus());
            }}
          />
        </div>
      </aside>
      {navOpen && (
        <div
          className="scrim"
          style={{ zIndex: 55 }}
          onClick={() => setNavOpen(false)}
        />
      )}

      <div className="main" inert={navOpen || undefined}>
        <header className="topbar">
          <button
            ref={mobileTrigger}
            aria-expanded={navOpen}
            aria-controls="main-sidebar"
            className="quiet icon menu-btn"
            onClick={() => setNavOpen(true)}
            aria-label={t("nav.menu")}
          >
            <Menu size={20} />
          </button>
          <div className="tb-title">
            <CurrentIcon size={17} color="var(--brand)" />
            <span>
              {t(
                section === "account" && parts[1] === "password"
                  ? "auth.passwordChange"
                  : current.labelKey,
              )}
            </span>
          </div>
          <div className="tb-right">
            <span
              className={`live-pill is-${live}`}
              tabIndex={0}
              data-tip={t("live.tip")}
            >
              <i />{" "}
              <b>
                {live === "sse"
                  ? t("live.sse")
                  : live === "polling"
                    ? t("live.polling")
                    : t("live.connecting")}
              </b>
            </span>
            <div
              className="lang-switch"
              role="group"
              aria-label={t("lang.switch")}
            >
              {(["vi", "en"] as UiLocale[]).map((code) => (
                <button
                  key={code}
                  type="button"
                  className={locale === code ? "sm" : "sm ghost"}
                  aria-pressed={locale === code}
                  data-tip={t(code === "vi" ? "lang.vi" : "lang.en")}
                  onClick={() => setLocale(code)}
                >
                  {code.toUpperCase()}
                </button>
              ))}
            </div>
            <a
              className="btn ghost icon inbox-btn"
              href="#/questions"
              aria-label={t("inbox.label", { n: openQuestions })}
              data-tip={t("inbox.tip")}
            >
              <Inbox size={17} />
              {openQuestions > 0 && (
                <span className="count">{openQuestions}</span>
              )}
            </a>
            <button
              className="ghost icon"
              onClick={() => setTheme(theme === "light" ? "dark" : "light")}
              aria-label={
                theme === "light" ? t("theme.toDark") : t("theme.toLight")
              }
              data-tip={theme === "light" ? t("theme.dark") : t("theme.light")}
            >
              {theme === "light" ? <Moon size={17} /> : <Sun size={17} />}
            </button>
          </div>
        </header>
        <main
          ref={pageRef}
          onScroll={(e) =>
            scrollPositions.current.set(pathPart, e.currentTarget.scrollTop)
          }
          tabIndex={-1}
          className={full ? "page full" : "page"}
          key={`${me.id}:${support}`}
        >
          {page}
        </main>
      </div>
    </div>
  );
}
