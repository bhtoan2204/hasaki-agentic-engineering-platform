// Workflow Platform UI — vanilla JS, hash router, every screen backed by /api/*.
// Copy comes from the same catalog the React app uses (/api/ui-messages). Locale is hasaki.uiLocale.
const UI_KEY = "hasaki.uiLocale";
let DICT = { vi: {}, en: {} };
let locale = "vi";
function tr(key, params) {
  let lookup = key;
  if (params && params.n != null) {
    const form = Number(params.n) === 1 ? `${key}.one` : `${key}.other`;
    if (DICT.vi?.[form]) lookup = form;
  }
  const raw =
    DICT[locale]?.[lookup] ?? DICT.vi?.[lookup] ?? DICT[locale]?.[key] ?? DICT.vi?.[key] ?? key;
  if (!params) return raw;
  return raw.replace(/\{(\w+)\}/g, (_, name) =>
    params[name] == null ? `{${name}}` : String(params[name]),
  );
}
function setUiLocale(next) {
  locale = next === "en" ? "en" : "vi";
  try {
    localStorage.setItem(UI_KEY, locale);
  } catch {}
  document.documentElement.lang = locale;
  paintChrome();
  if (!ME) {
    $("#view").dataset.login = "";
    void showLogin();
    return;
  }
  if (typeof render === "function")
    Promise.resolve(render(true)).then(() => {
      paintModal();
      paintRank();
      paintPreview();
    });
}
function paintChrome() {
  const summary = document.querySelector("#classic-account summary");
  if (summary && ME) summary.textContent = `${ME.username} · ${tr(`auth.role.${ME.role}`)}`;
  document.querySelectorAll("[data-key]").forEach((el) => {
    const label = tr(el.dataset.key);
    const count = el.querySelector("#qcount");
    el.childNodes.forEach((n) => {
      if (n.nodeType === 3) n.textContent = label;
    });
    if (!el.childNodes.length || ![...el.childNodes].some((n) => n.nodeType === 3))
      el.prepend(document.createTextNode(label));
    if (count) el.append(count);
  });
  document.querySelectorAll("#lang button").forEach((b) => {
    b.style.fontWeight = b.dataset.lang === locale ? "700" : "400";
    b.title = tr(b.dataset.lang === "vi" ? "lang.vi" : "lang.en");
  });
}
window.setUiLocale = setUiLocale;
const $ = (s, r = document) => r.querySelector(s);
const $$ = (s, r = document) => [...r.querySelectorAll(s)];
const esc = (s) =>
  String(s ?? "").replace(
    /[&<>"']/g,
    (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c],
  );
const time = (t) =>
  t
    ? new Date(t).toLocaleString(locale === "vi" ? "vi-VN" : "en-GB", {
        hour: "2-digit",
        minute: "2-digit",
        day: "2-digit",
        month: "2-digit",
      })
    : "";
const badge = (s) => {
  const name = tr("status." + s);
  return `<span class="badge s-${esc(s)}">${esc(name === "status." + s ? s : name)}</span>`;
};
const wiBadge = (s) => {
  const cls =
    s === "in_progress"
      ? "RUNNING"
      : s === "done"
        ? "COMPLETED"
        : s === "archived"
          ? "archived"
          : "open";
  return `<span class="badge s-${cls}">${esc(WI_STATUS[s] ? tr(WI_STATUS[s]) : s)}</span>`;
};
const json = (v) => `<pre>${esc(JSON.stringify(v, null, 2))}</pre>`;
const list = (v) =>
  Array.isArray(v)
    ? v
    : String(v || "")
        .split(",")
        .map((x) => x.trim())
        .filter(Boolean);

let ME = null;
let CSRF = "";
async function api(path, body) {
  const headers = {};
  if (body !== undefined) headers["Content-Type"] = "application/json";
  if (body !== undefined && CSRF) headers["X-CSRF-Token"] = CSRF;
  const r = await fetch(path, {
    method: body !== undefined ? "POST" : "GET",
    headers,
    credentials: "include",
    body: body !== undefined ? JSON.stringify(body) : undefined,
  });
  const j = await r.json().catch(() => ({}));
  if (r.status === 401 && !String(path).startsWith("/api/auth/login")) {
    ME = null;
    CSRF = "";
    for (const k of Object.keys(drafts)) delete drafts[k];
    showLogin();
  }
  if (!r.ok)
    throw new Error((j.error || r.status) + (j.details ? "\n" + j.details.join("\n") : ""));
  return j;
}
async function showLogin() {
  document.getElementById("classic-account")?.remove();
  const view = $("#view");
  if (!view || view.dataset.login === "1") return;
  view.dataset.login = "1";
  view.innerHTML = `<form id="login-form" class="card" style="max-width:420px;margin:8vh auto;display:grid;gap:8px">
    <h1>${esc(tr("auth.login"))}</h1>
    <label>${esc(tr("auth.username"))}<input id="lu" autocomplete="username"></label>
    <label>${esc(tr("auth.password"))}<input id="lp" type="password" autocomplete="current-password"></label>
    <button class="primary" type="submit">${esc(tr("auth.submit"))}</button>
  </form>`;
  try {
    const status = await api("/api/auth/status");
    if (ME || view.dataset.login !== "1") return;
    if (status.bootstrapRequired) {
      view.innerHTML = `<div class="card"><p>${esc(tr("auth.bootstrap"))}</p><code>npm run admin:bootstrap -- --username &lt;username&gt; --claim-legacy</code><p>${esc(tr("auth.bootstrapReload"))}</p></div>`;
      return;
    }
  } catch (e) {
    toast(e.message);
  }
  $("#login-form").onsubmit = async (e) => {
    e.preventDefault();
    try {
      const res = await api("/api/auth/login", {
        username: $("#lu").value,
        password: $("#lp").value,
      });
      ME = res.user;
      CSRF = res.csrf;
      view.dataset.login = "";
      location.reload();
    } catch (err) {
      toast(err.message || tr("auth.invalid"));
    }
  };
}
function toast(msg, info = false) {
  const t = document.createElement("div");
  t.className = "toast" + (info ? " info" : "");
  t.textContent = msg;
  document.body.appendChild(t);
  setTimeout(() => t.remove(), info ? 2500 : 6000);
}
/** Run an action, report errors, re-render. */
async function act(fn, okMsg) {
  try {
    const r = await fn();
    if (okMsg) toast(okMsg, true);
    await render(true);
    return r;
  } catch (e) {
    toast(e.message);
  }
}
const drafts = {}; // survive re-renders while typing
const AGENT_PROVIDERS = ["claude", "cursor", "codex"];
const providerOf = (p) => (AGENT_PROVIDERS.includes(p) ? p : "claude");
const providerSelect = (id) =>
  `<select ${keep(id)}>${AGENT_PROVIDERS.map((p) => `<option value="${p}" ${(drafts[id] || "claude") === p ? "selected" : ""}>${esc(tr("run.agent." + p))}</option>`).join("")}</select>` +
  `<div class="muted small">${esc(tr("run.agentHint"))} ${esc(tr("run.agent.codex"))}: ${esc(tr("run.codex.account"))}</div>`;
const keep = (id) => `id="${id}" oninput="drafts['${id}']=this.value"`;
const routeKey = () => location.hash.slice(1) || "/work-items";
const draftKey = (id) => routeKey() + "\0" + id;
const shown = (id, server) =>
  drafts[draftKey(id)] !== undefined ? drafts[draftKey(id)] : (server ?? "");
const keepHere = (id) =>
  `id="${id}" oninput="drafts[(location.hash.slice(1)||'/work-items')+'\\0'+this.id]=this.value" onchange="drafts[(location.hash.slice(1)||'/work-items')+'\\0'+this.id]=this.value"`;
const val = (id) => ($("#" + id)?.value ?? "").trim();
const WI_STATUS = {
  open: "wi.open",
  in_progress: "wi.doing",
  done: "wi.done",
  archived: "wi.archived",
};
const catLabel = (c) => {
  const k = "kn.cat." + c;
  const s = tr(k);
  return s === k ? c : s;
};
const statusText = (s) => {
  const name = tr("status." + s);
  return name === "status." + s ? s : name;
};
let modalCache = null;
let previewCache = null;
let rankCache = null;

let META = null;
let STATE = { route: "", parts: [] };

// ---------------------------------------------------------------- router

async function render(force = false) {
  if (!ME) {
    showLogin();
    return;
  }
  const hash = location.hash.slice(1) || "/work-items";
  // Legacy links (#TASK-CODE from notifications of the old platform) → the work item.
  if (!hash.startsWith("/")) {
    try {
      const t = await api("/api/tasks/" + encodeURIComponent(hash));
      location.hash = "/work-items/" + t.work_item_id;
    } catch {
      location.hash = "/work-items";
    }
    return;
  }
  const parts = hash.split("/").filter(Boolean);
  if (parts[0] === "account") {
    location.href = "/#" + hash;
    return;
  }
  if (parts[0] === "users") {
    if (ME.role !== "admin") {
      $("#view").innerHTML = `<div class="card">${esc(tr("auth.users"))}</div>`;
      return;
    }
    const users = await api("/api/users");
    $("#view").innerHTML = `<div class="card"><h1>${esc(tr("auth.users"))}</h1>
      <form id="new-user" style="display:flex;gap:8px;flex-wrap:wrap">
        <input id="nu-name" placeholder="${esc(tr("auth.username"))}">
        <input id="nu-pw" type="password" placeholder="${esc(tr("auth.password"))}">
        <select id="nu-role"><option value="member">${esc(tr("auth.role.member"))}</option><option value="admin">${esc(tr("auth.role.admin"))}</option></select>
        <button class="primary" type="submit">${esc(tr("auth.create"))}</button>
      </form>
      <ul>${users
        .map(
          (u) => `<li><b>${esc(u.username)}</b> ${esc(u.role)} ${u.active ? "" : "(off)"}
        <button type="button" data-reset="${u.id}">${esc(tr("auth.reset"))}</button>
        <button type="button" data-active="${u.id}" data-on="${u.active}">${esc(u.active ? tr("auth.deactivate") : tr("auth.activate"))}</button></li>`,
        )
        .join("")}</ul>
    </div>`;
    $("#new-user").onsubmit = async (e) => {
      e.preventDefault();
      await api("/api/users", {
        username: $("#nu-name").value,
        password: $("#nu-pw").value,
        role: $("#nu-role").value,
      });
      await render(true);
    };
    $$("[data-reset]").forEach(
      (b) =>
        (b.onclick = async () => {
          const password = prompt(tr("auth.newPassword"));
          if (password) {
            await api(`/api/users/${b.dataset.reset}/password`, { password });
            toast(tr("auth.reset"), true);
          }
        }),
    );
    $$("[data-active]").forEach(
      (b) =>
        (b.onclick = async () => {
          await api(`/api/users/${b.dataset.active}/active`, { active: b.dataset.on !== "true" });
          await render(true);
        }),
    );
    return;
  }
  const active = document.activeElement;
  const typing =
    active &&
    ["INPUT", "TEXTAREA", "SELECT"].includes(active.tagName) &&
    $("#view").contains(active);
  if (!force && typing && STATE.route === hash) return; // don't clobber typing on poll
  STATE = { route: hash, parts };
  $$("header a").forEach((a) => a.classList.toggle("on", a.dataset.nav === parts[0]));
  const view = VIEWS[parts[0]] ?? VIEWS["work-items"];
  try {
    const html = await view(...parts.slice(1));
    if (STATE.route !== hash) return;
    const openDetails = $$("details[data-k]")
      .filter((d) => d.open)
      .map((d) => d.dataset.k);
    const scroll = window.scrollY;
    const inner = Object.fromEntries(
      $$("[data-scroll]").map((el) => [
        el.dataset.scroll,
        { top: el.scrollTop, bottom: el.scrollHeight - el.scrollTop - el.clientHeight < 40 },
      ]),
    );
    $("#view").innerHTML = html;
    $$("[data-scroll]").forEach((el) => {
      const st = inner[el.dataset.scroll];
      el.scrollTop = !st || st.bottom ? el.scrollHeight : st.top; // follow the live conversation unless the user scrolled up
    });
    openDetails.forEach((k) => {
      const d = $(`details[data-k="${k}"]`);
      if (d) d.open = true;
    });
    window.scrollTo(0, scroll);
    paintPreview();
    paintRank();
  } catch (e) {
    $("#view").innerHTML = `<div class="card err">${esc(e.message)}</div>`;
  }
  refreshCount();
}
async function refreshCount() {
  try {
    const qs = await api("/api/questions");
    $("#qcount").innerHTML = qs.length ? `<span class="count">${qs.length}</span>` : "";
  } catch {}
}
window.addEventListener("hashchange", () => {
  modalCache = null;
  const m = $("#modal");
  if (m) m.innerHTML = "";
  render(true);
});

// ---------------------------------------------------------------- shared pieces

function workflowSelect(id, workflows, selected) {
  return `<select ${keep(id)}>${workflows
    .map(
      (w) =>
        `<option value="${esc(w.key)}" ${(drafts[id] ?? selected) === w.key ? "selected" : ""}>${esc(w.name)} (v${w.latest_version})</option>`,
    )
    .join("")}</select>`;
}
function stepChips(steps) {
  return `<span class="chips">${(steps || []).map((s) => `<span class="chip s-${s.status}" title="${esc(s.key)}: ${esc(statusText(s.status))}"></span>`).join("")}</span>`;
}
function runsTable(runs) {
  if (!runs.length) return `<div class="empty">${esc(tr("runs.emptyTitle"))}</div>`;
  return `<table><tr><th>#</th><th>${esc(tr("ins.col.run"))}</th><th>${esc(tr("common.workflow"))}</th><th>${esc(tr("wi.status"))}</th><th>${esc(tr("wfe.type"))}</th><th>${esc(tr("nav.questions"))}</th><th>${esc(tr("common.created"))}</th></tr>
    ${runs
      .map(
        (
          r,
        ) => `<tr class="click" onclick="location.hash='/runs/${r.id}'"><td>${r.id}</td><td>${esc(r.title)}<div class="muted small mono">${esc(r.branch)}</div></td>
      <td>${esc(r.definition_key)} <span class="muted">v${r.definition_version}</span></td><td>${badge(r.status)}</td><td>${stepChips(r.steps)}</td>
      <td>${r.open_questions ? `<span class="badge s-WAITING_INPUT">${r.open_questions}</span>` : ""}</td><td class="muted">${time(r.updated_at)}</td></tr>`,
      )
      .join("")}</table>`;
}

// ---------------------------------------------------------------- views

const VIEWS = {
  // ------------------------------------------------ Work items
  async "work-items"(id) {
    if (id) return workItemDetail(Number(id));
    const [items, status, inbox] = await Promise.all([
      api("/api/work-items"),
      api("/api/work/status"),
      api("/api/work/inbox"),
    ]);
    const exp = status.expiresAt
      ? ` · ${esc(tr("ig.expires", { time: new Date(status.expiresAt).toLocaleString(locale === "vi" ? "vi-VN" : "en-GB") }))}`
      : "";
    return `
      <h2>${esc(tr("nav.workItems"))}</h2><div class="muted">${esc(tr("wi.subtitle"))}</div>
      <div class="grid3" style="margin-top:14px">
        <div class="card"><h4>${esc(tr("wi.createTitle"))}</h4>
          <input placeholder="${esc(tr("wi.titlePh"))}" ${keep("wi-title")} value="${esc(drafts["wi-title"] || "")}">
          <div class="row"><input placeholder="${esc(tr("wi.projectPh"))}" ${keep("wi-project")} value="${esc(drafts["wi-project"] || "")}"></div>
          <label>${esc(tr("wi.description"))}</label><textarea rows="3" ${keep("wi-desc")}>${esc(drafts["wi-desc"] || "")}</textarea>
          <div class="row"><button onclick="A.createWorkItem()">${esc(tr("wi.create"))}</button></div></div>
        <div class="card"><h4>${esc(tr("kn.import"))}</h4>
          <label>${esc(tr("wi.jsonPh"))}</label><textarea class="code" rows="4" ${keep("wi-json")}>${esc(drafts["wi-json"] || "")}</textarea>
          <div class="row"><button class="ghost" onclick="A.importJson('hasaki_work')">${esc(tr("wi.importHasaki"))}</button><button class="ghost" onclick="A.importJson('jira')">${esc(tr("wi.importJira"))}</button></div>
          ${META?.jiraEnabled ? `<div class="row"><input placeholder="${esc(tr("cl.jiraPh"))}" ${keep("jira-key")} value="${esc(drafts["jira-key"] || "")}"><button class="ghost" onclick="A.importJiraKey()">${esc(tr("wi.fetch"))}</button></div>` : `<div class="muted small" style="margin-top:6px">${esc(tr("wi.jiraOff"))}</div>`}
        </div>
        <div class="card"><h4>${esc(tr("wi.src.hasaki_work"))} ${status.loggedIn ? badge("COMPLETED").replace(/>[^<]*</, `>${esc(tr("wi.loggedIn"))}<`) : badge("FAILED").replace(/>[^<]*</, `>${esc(tr("wi.loggedOut"))}<`)}</h4>
          <div class="muted small">${exp}</div>
          ${
            status.loggedIn
              ? `<div class="row"><button onclick="A.refreshInbox(this)">${esc(tr("wi.fetchTasks"))}</button></div>`
              : `<div class="row">${status.windowOpen ? `<span class="muted">${esc(tr("wi.loginWindow"))}</span>` : status.browserMode === "local" ? `<button onclick="A.openLogin()">${esc(tr("chrome.connect"))}</button>` : `<span>${esc(tr("chrome.hosted"))}</span>`}</div>
                 <div class="row"><input placeholder="${esc(tr("wi.tokenPh"))}" ${keep("tok")} value="${esc(drafts["tok"] || "")}"><button onclick="A.saveToken()">${esc(tr("ig.save"))}</button></div>`
          }
          ${status.loggedIn ? `<div class="row"><input placeholder="${esc(tr("wi.taskId"))}" ${keep("hw-id")} value="${esc(drafts["hw-id"] || "")}"><button class="ghost" onclick="A.importHasakiId()">${esc(tr("kn.import"))}</button></div>` : ""}
          ${
            inbox.length
              ? `<div style="max-height:220px;overflow:auto;margin-top:8px">${inbox
                  .map(
                    (
                      r,
                    ) => `<div class="row small" style="margin:4px 0"><div style="flex:1"><span class="mono muted">${esc(r.code)}</span> ${esc(r.name)}</div>
              ${r.work_item_id ? `<a href="#/work-items/${r.work_item_id}">${r.run_status ? badge(r.run_status) : esc(tr("wi.imported"))}</a>` : `<button class="sm ghost" onclick="A.pick(${r.work_id}, this)">${esc(tr("kn.import"))}</button>`}</div>`,
                  )
                  .join("")}</div>`
              : ""
          }
        </div>
      </div>
      <h3>${esc(tr("wi.all"))}</h3>
      ${
        items.length
          ? `<table><tr><th>${esc(tr("cl.code"))}</th><th>${esc(tr("wi.fieldTitle"))}</th><th>${esc(tr("wi.source"))}</th><th>${esc(tr("common.project"))}</th><th>${esc(tr("wi.status"))}</th><th>${esc(tr("cl.runs"))}</th><th>${esc(tr("cl.lastRun"))}</th><th>${esc(tr("runs.col.updated"))}</th></tr>
        ${items
          .map(
            (
              w,
            ) => `<tr class="click" onclick="location.hash='/work-items/${w.id}'"><td class="mono">${esc(w.code)}</td><td>${esc(w.title)}</td><td>${esc(w.source)}</td>
          <td>${esc(w.project)}</td><td>${wiBadge(w.status)}</td><td>${w.run_count}</td><td>${w.last_run_status ? badge(w.last_run_status) : ""}</td><td class="muted">${time(w.updated_at)}</td></tr>`,
          )
          .join("")}</table>`
          : `<div class="empty">${esc(tr("wi.empty"))}</div>`
      }`;
  },

  // ------------------------------------------------ Runs
  async runs(id) {
    if (id) return runDetail(Number(id));
    const [runs, workflows] = await Promise.all([api("/api/runs"), api("/api/workflows")]);
    return `
      <h2>${esc(tr("runs.title"))}</h2>
      <div class="card"><h4>${esc(tr("runs.openRun"))}</h4>
        <div class="grid3"><div><label>${esc(tr("common.workflow"))}</label>${workflowSelect("nr-wf", workflows, "code-review")}</div>
        <div><label>${esc(tr("cl.reposCsv"))}</label><input ${keep("nr-repos")} value="${esc(drafts["nr-repos"] || "")}" placeholder="${esc(tr("cl.reposPh"))}"></div>
        <div><label>${esc(tr("wi.fieldTitle"))}</label><input ${keep("nr-title")} value="${esc(drafts["nr-title"] || "")}"></div></div>
        <label>${esc(tr("cl.inputsHint"))}</label><textarea class="code" rows="2" ${keep("nr-inputs")}>${esc(drafts["nr-inputs"] || "{}")}</textarea>
        <label>${esc(tr("run.agent"))}</label>${providerSelect("nr-provider")}
        <div class="row"><button onclick="A.newRun(true)">${esc(tr("rv.start"))}</button><button class="ghost" onclick="A.newRun(false)">${esc(tr("wfe.createPending"))}</button></div></div>
      ${runsTable(runs)}`;
  },

  // ------------------------------------------------ Questions inbox
  async questions() {
    const [open, history] = await Promise.all([
      api("/api/questions"),
      api("/api/questions/history"),
    ]);
    const byRun = {};
    for (const q of open) (byRun[q.run_id] ??= []).push(q);
    return `
      <h2>${esc(tr("qx.title"))}</h2><div class="muted">${esc(tr("qx.subtitle"))}</div>
      ${
        open.length
          ? Object.entries(byRun)
              .map(
                ([
                  runId,
                  qs,
                ]) => `<div class="card"><div class="row" style="margin:0"><b><a href="#/runs/${runId}">${esc(tr("ins.col.run"))} #${runId}</a></b> ${esc(qs[0].run_title)} ${badge(qs[0].run_status)}</div>
              ${qs.map(questionForm).join("")}
              <div class="row"><button onclick="A.answer([${qs.map((q) => q.id).join(",")}])">${esc(tr("si.sendContinue"))}</button></div></div>`,
              )
              .join("")
          : `<div class="empty">${esc(tr("qx.emptyTitle"))}</div>`
      }
      <h3>${esc(tr("qx.history"))}</h3>
      ${
        history.length
          ? `<table><tr><th>${esc(tr("ins.col.run"))}</th><th>${esc(tr("cl.step"))}</th><th>${esc(tr("cl.question"))}</th><th>${esc(tr("cl.answer"))}</th><th>${esc(tr("cl.stepNow"))}</th><th>${esc(tr("cl.when"))}</th></tr>${history
              .map(
                (q) =>
                  `<tr><td><a href="#/runs/${q.run_id}">#${q.run_id}</a></td><td>${esc(q.step_name)}</td><td>${esc(q.question)}</td><td>${esc(q.answer)}</td><td>${badge(q.step_status)}</td><td class="muted">${time(q.answered_at)}</td></tr>`,
              )
              .join("")}</table>`
          : `<div class="empty">${esc(tr("qx.emptyBody"))}</div>`
      }`;
  },

  // ------------------------------------------------ Workflow library
  async workflows(key) {
    if (key) return workflowDetail(key);
    const wfs = await api("/api/workflows");
    const sample = JSON.stringify(
      {
        name: "My workflow",
        description: "",
        steps: [
          {
            key: "analyze",
            type: "agent",
            config: { instructions: "…", output_contract: "{ summary }" },
          },
          {
            key: "approve",
            type: "human_approval",
            depends_on: ["analyze"],
            config: { show_outputs: ["analyze"] },
          },
        ],
      },
      null,
      2,
    );
    return `
      <h2>${esc(tr("wfs.title"))}</h2><div class="muted">${esc(tr("wfs.subtitle"))}</div>
      <table style="margin-top:12px"><tr><th>${esc(tr("wfe.key"))}</th><th>${esc(tr("wfe.name"))}</th><th>${esc(tr("cl.latest"))}</th><th>${esc(tr("cl.runs"))}</th><th></th><th>${esc(tr("cl.updated"))}</th></tr>
      ${wfs
        .map(
          (
            w,
          ) => `<tr class="click" onclick="location.hash='/workflows/${w.key}'"><td class="mono">${esc(w.key)}</td><td>${esc(w.name)}<div class="muted small">${esc(w.description)}</div></td>
        <td>v${w.latest_version}${w.has_draft ? ` <span class="badge s-WAITING">${esc(tr("wfe.draft"))}</span>` : ""}</td><td>${w.run_count}</td><td>${w.is_template ? `<span class="badge s-PENDING">${esc(tr("cl.template"))}</span>` : ""}</td><td class="muted">${time(w.updated_at)}</td></tr>`,
        )
        .join("")}</table>
      <div class="card" style="margin-top:14px"><h4>${esc(tr("wfs.new"))}</h4>
        <div class="row"><input placeholder="${esc(tr("cl.keyPh"))}" ${keep("wf-key")} value="${esc(drafts["wf-key"] || "")}"></div>
        <label>${esc(tr("cl.definition", { types: (META?.stepTypes || []).join(", ") }))}</label>
        <textarea class="code" rows="12" ${keep("wf-spec")}>${esc(drafts["wf-spec"] || sample)}</textarea>
        <div class="row"><button class="ghost" onclick="A.validateSpec('wf-spec')">${esc(tr("wfe.validate"))}</button><button onclick="A.createWorkflow()">${esc(tr("cl.publishV1"))}</button></div></div>`;
  },

  // ------------------------------------------------ Knowledge
  async knowledge(key) {
    if (key) return knowledgeDetail(key);
    const items = await api("/api/knowledge");
    const cats = META?.knowledgeCategories || [];
    const scopes = META?.knowledgeScopes || [];
    return `
      <h2>${esc(tr("kn.title"))}</h2><div class="muted">${esc(tr("kn.subtitle"))}</div>
      <table style="margin-top:12px"><tr><th>${esc(tr("kn.key"))}</th><th>${esc(tr("kn.titleField"))}</th><th>${esc(tr("kn.category"))}</th><th>${esc(tr("kn.scope"))}</th><th>${esc(tr("kn.conflictKey"))}</th><th>${esc(tr("cl.version"))}</th><th>${esc(tr("kn.enabled"))}</th></tr>
      ${items
        .map(
          (
            k,
          ) => `<tr class="click" onclick="location.hash='/knowledge/${k.key}'"><td class="mono">${esc(k.key)}</td><td>${esc(k.title)}</td><td>${esc(catLabel(k.category))}</td>
        <td>${esc(k.scope_type)}${k.scope_ref ? `:<b>${esc(k.scope_ref)}</b>` : ""}${k.enforced ? ` <span class="badge s-FAILED">${esc(tr("kn.enforced"))}</span>` : ""}</td><td class="mono">${esc(k.conflict_key || "")}</td>
        <td>v${k.current_version}</td><td>${k.enabled ? "✓" : `<span class="muted">${esc(tr("cl.off"))}</span>`}</td></tr>`,
        )
        .join("")}</table>
      <div class="grid2" style="margin-top:14px">
        <div class="card"><h4>${esc(tr("kn.newTitle"))}</h4>
          <div class="grid2"><div><label>${esc(tr("kn.key"))}</label><input ${keep("k-key")} value="${esc(drafts["k-key"] || "")}"></div><div><label>${esc(tr("kn.titleField"))}</label><input ${keep("k-title")} value="${esc(drafts["k-title"] || "")}"></div>
          <div><label>${esc(tr("kn.category"))}</label><select ${keep("k-cat")}>${cats.map((c) => `<option value="${esc(c)}" ${(drafts["k-cat"] ?? cats[0]) === c ? "selected" : ""}>${esc(catLabel(c))}</option>`).join("")}</select></div>
          <div><label>${esc(tr("kn.scope"))}</label><select ${keep("k-scope")}>${scopes.map((c) => `<option value="${esc(c)}" ${(drafts["k-scope"] ?? scopes[0]) === c ? "selected" : ""}>${esc(c)}</option>`).join("")}</select></div>
          <div><label>${esc(tr("cl.scopeRefLong"))}</label><input ${keep("k-ref")} value="${esc(drafts["k-ref"] || "")}"></div>
          <div><label>${esc(tr("kn.conflictKey"))}</label><input ${keep("k-ck")} value="${esc(drafts["k-ck"] || "")}"></div></div>
          <label>${esc(tr("kn.content"))}</label><textarea rows="4" ${keep("k-content")}>${esc(drafts["k-content"] || "")}</textarea>
          <label>${esc(tr("cl.appHint"))}</label><textarea class="code" rows="2" ${keep("k-app")}>${esc(drafts["k-app"] || "{}")}</textarea>
          <label>${esc(tr("cl.metaHint"))}</label><textarea class="code" rows="2" ${keep("k-meta")}>${esc(drafts["k-meta"] || "{}")}</textarea>
          <div class="row"><label style="margin:0"><input type="checkbox" id="k-enf" style="width:auto" ${drafts["k-enf"] ? "checked" : ""} onchange="drafts['k-enf']=this.checked"> ${esc(tr("cl.enforcedBox"))}</label></div>
          <div class="row"><button onclick="A.createKnowledge()">${esc(tr("kn.create"))}</button></div></div>
        <div class="card"><h4>${esc(tr("cl.previewRes"))}</h4><div class="muted small">${esc(tr("cl.previewHint"))}</div>
          <div class="grid2"><div><label>${esc(tr("cl.wfKey"))}</label><input ${keep("p-wf")} value="${esc(drafts["p-wf"] || "feature-implementation")}"></div><div><label>${esc(tr("cl.stepKey"))}</label><input ${keep("p-step")} value="${esc(drafts["p-step"] || "implement")}"></div>
          <div><label>${esc(tr("cl.stepType"))}</label><input ${keep("p-type")} value="${esc(drafts["p-type"] || "coding_agent")}"></div><div><label>${esc(tr("common.project"))}</label><input ${keep("p-proj")} value="${esc(drafts["p-proj"] || "OMS")}"></div>
          <div><label>${esc(tr("nav.repositories"))}</label><input ${keep("p-repos")} value="${esc(drafts["p-repos"] || "")}"></div><div><label>${esc(tr("cl.requestText"))}</label><input ${keep("p-text")} value="${esc(drafts["p-text"] || "")}"></div></div>
          <div class="row"><button class="ghost" onclick="A.previewKnowledge()">${esc(tr("cl.resolve"))}</button></div><div id="preview"></div></div>
      </div>`;
  },

  // ------------------------------------------------ Repositories
  async repositories(name) {
    const repos = await api("/api/repositories");
    const r = name ? repos.find((x) => x.name === name) : null;
    return `
      <h2>${esc(tr("repo.title"))}</h2><div class="muted">${esc(tr("repo.subtitle"))}</div>
      <table style="margin-top:12px"><tr><th>${esc(tr("wfe.name"))}</th><th>${esc(tr("repo.list.projects"))}</th><th>${esc(tr("repo.list.services"))}</th><th>${esc(tr("repo.list.tags"))}</th><th>${esc(tr("repo.list.allowed_actions"))}</th><th>${esc(tr("kn.enabled"))}</th><th>${esc(tr("wi.description"))}</th></tr>
      ${repos
        .map(
          (
            x,
          ) => `<tr class="click" onclick="location.hash='/repositories/${x.name}'"><td class="mono">${esc(x.name)}</td><td>${esc(x.projects.join(", "))}</td><td>${esc(x.services.join(", "))}</td>
        <td>${esc(x.tags.join(", "))}</td><td>${esc(x.allowed_actions.join(", "))}</td><td>${x.enabled ? "✓" : esc(tr("cl.off"))}</td><td class="small">${esc(x.description)}</td></tr>`,
        )
        .join("")}</table>
      <div class="grid2" style="margin-top:14px">
        <div class="card"><h4>${r ? esc(tr("repo.edit", { name: r.name })) : esc(tr("repo.add"))}</h4>
          <div class="grid2"><div><label>${esc(tr("repo.name"))}</label><input ${keepHere("r-name")} value="${esc(shown("r-name", r?.name || ""))}"></div>
          <div><label>${esc(tr("repo.list.projects"))}</label><input ${keepHere("r-projects")} value="${esc(shown("r-projects", r?.projects.join(", ") || ""))}"></div>
          <div><label>${esc(tr("repo.list.services"))}</label><input ${keepHere("r-services")} value="${esc(shown("r-services", r?.services.join(", ") || ""))}"></div>
          <div><label>${esc(tr("repo.list.tags"))}</label><input ${keepHere("r-tags")} value="${esc(shown("r-tags", r?.tags.join(", ") || ""))}"></div>
          <div><label>${esc(tr("repo.list.owners"))}</label><input ${keepHere("r-owners")} value="${esc(shown("r-owners", r?.owners.join(", ") || ""))}"></div>
          <div><label>${esc(tr("repo.list.dependencies"))}</label><input ${keepHere("r-deps")} value="${esc(shown("r-deps", r?.dependencies.join(", ") || ""))}"></div>
          <div><label>${esc(tr("cl.actionsHint"))}</label><input ${keepHere("r-actions")} value="${esc(shown("r-actions", r?.allowed_actions.join(", ") || "read, write, pull_request"))}"></div>
          <div><label>${esc(tr("kn.enabled"))}</label><select ${keepHere("r-enabled")}><option value="true" ${String(shown("r-enabled", r?.enabled === false ? "false" : "true")) === "true" ? "selected" : ""}>${esc(tr("kn.enabledYes"))}</option><option value="false" ${String(shown("r-enabled", r?.enabled === false ? "false" : "true")) === "false" ? "selected" : ""}>${esc(tr("kn.enabledNo"))}</option></select></div></div>
          <label>${esc(tr("repo.desc"))}</label><textarea ${keepHere("r-desc")} rows="2">${esc(shown("r-desc", r?.description || ""))}</textarea>
          <label>${esc(tr("repo.arch"))}</label><textarea ${keepHere("r-arch")} rows="2">${esc(shown("r-arch", r?.architecture || ""))}</textarea>
          <div class="row"><button onclick="A.saveRepo()">${esc(tr("kn.save"))}</button></div></div>
        <div class="card"><h4>${esc(tr("repo.rankTitle"))}</h4>
          <div class="row"><input placeholder="${esc(tr("cl.requestText"))}" ${keep("rk-text")} value="${esc(drafts["rk-text"] || "")}"><input placeholder="${esc(tr("common.project"))}" ${keep("rk-proj")} value="${esc(drafts["rk-proj"] || "")}" style="max-width:120px"><button class="ghost" onclick="A.rank()">${esc(tr("repo.rank"))}</button></div>
          <div id="rank"></div></div>
      </div>`;
  },
};

// ---------------------------------------------------------------- detail views

async function workItemDetail(id) {
  const [w, workflows] = await Promise.all([api(`/api/work-items/${id}`), api("/api/workflows")]);
  const legacy = w.legacy;
  return `
    <div class="muted small"><a href="#/work-items">${esc(tr("nav.workItems"))}</a> /</div>
    <h2>${esc(w.title)}</h2>
    <div class="muted"><span class="mono">${esc(w.code)}</span> · ${esc(w.source)} · ${esc(w.project || tr("cl.noProject"))} ${wiBadge(w.status)}</div>
    <div class="grid2" style="margin-top:14px">
      <div class="card"><h4>${esc(tr("wi.request"))}</h4><div style="white-space:pre-wrap">${esc(w.description || tr("wi.noDesc"))}</div>
        ${w.payload && Object.keys(w.payload).length ? `<details data-k="payload"><summary>${esc(tr("wi.raw"))}</summary>${json(w.payload)}</details>` : ""}</div>
      <div class="card"><h4>${esc(tr("cl.actions"))}</h4>
        <label>${esc(tr("common.workflow"))}</label>${workflowSelect("wi-wf", workflows, "feature-implementation")}
        <label>${esc(tr("cl.reposOpt"))}</label><input ${keep("wi-repos")} value="${esc(drafts["wi-repos"] || "")}">
        <label>${esc(tr("run.agent"))}</label>${providerSelect("wi-provider")}
        <div class="row"><button onclick="A.startForItem(${w.id}, true)">${esc(tr("cl.startRun"))}</button><button class="ghost" onclick="A.startForItem(${w.id}, false)">${esc(tr("cl.createRun"))}</button>
          <button class="ghost" onclick="A.analyze(${w.id})">${esc(tr("cl.analyzeOnly"))}</button></div>
        <label>${esc(tr("wi.policy"))}</label>
        <div class="muted small">${w.automation_policy ? esc(tr("cl.autoStarts", { workflow: w.automation_policy.workflow })) : esc(tr("cl.nonePolicy"))}</div>
        <div class="row"><button class="ghost sm" onclick="A.setPolicy(${w.id}, true)">${esc(tr("cl.usePolicy"))}</button>${w.automation_policy ? `<button class="ghost sm" onclick="A.setPolicy(${w.id}, false)">${esc(tr("cl.clear"))}</button>` : ""}
          <select style="width:auto" onchange="A.setStatus(${w.id}, this.value)">${["open", "in_progress", "done", "archived"].map((s) => `<option value="${s}" ${s === w.status ? "selected" : ""}>${esc(tr(WI_STATUS[s]))}</option>`).join("")}</select></div>
      </div>
    </div>
    <h3>${esc(tr("wi.history"))}</h3>${runsTable(w.runs)}
    ${w.pull_requests.length ? `<h3>${esc(tr("common.pullRequests"))}</h3>${prTable(w.pull_requests)}` : ""}
    ${
      legacy && (legacy.questions.length || legacy.events.length)
        ? `<h3>${esc(tr("wi.legacy", { questions: legacy.questions.length, events: legacy.events.length }))}</h3><div class="card">
      ${legacy.questions.map((q) => `<div class="q"><b>${esc(q.question)}</b><div class="muted">→ ${esc(q.answer ?? tr("wi.unanswered"))}</div></div>`).join("")}
      <details data-k="legacy-ev"><summary>${esc(tr("cl.events", { n: legacy.events.length }))}</summary>${legacy.events.map((e) => `<div class="ev ${e.kind}"><time class="muted">${time(e.created_at)}</time><span class="s"></span><span class="k muted">${esc(e.kind)}</span><span class="c">${esc(e.content)}</span></div>`).join("")}</details></div>`
        : ""
    }`;
}

function prTable(prs) {
  return `<table><tr><th>${esc(tr("cl.repo"))}</th><th>${esc(tr("cl.pr"))}</th><th>${esc(tr("common.branch"))}</th><th></th><th>${esc(tr("cl.updated"))}</th></tr>${prs
    .map(
      (
        p,
      ) => `<tr><td>${esc(p.repo)}</td><td><a href="${esc(p.url)}" target="_blank" rel="noopener">${esc(p.title)}</a>${p.decisions?.length ? `<details><summary>${esc(tr("cl.decisions", { n: p.decisions.length }))}</summary><ul>${p.decisions.map((d) => `<li><b>${esc(d.title)}</b>: ${esc(d.detail)}</li>`).join("")}</ul></details>` : ""}</td>
      <td class="mono">${esc(p.source_branch)} → ${esc(p.target_branch)}</td><td>${p.draft ? `<span class="badge s-PENDING">${esc(tr("ch.draft"))}</span>` : ""}${p.created ? "" : ` <span class="badge s-WAITING">${esc(tr("ch.linkOnly"))}</span>`}</td><td class="muted">${time(p.updated_at)}</td></tr>`,
    )
    .join("")}</table>`;
}

function questionForm(q) {
  const id = "ans-" + q.id;
  return `<div class="q"><div><b>${esc(q.question)}</b> <span class="muted small">${esc(q.step_name || q.step_key || "")}</span></div>
    ${q.context ? `<div class="muted small" style="white-space:pre-wrap">${esc(q.context)}</div>` : ""}
    <div class="row">${(q.options || []).map((o) => `<button class="ghost sm" onclick="A.pickOption(${q.id}, this.dataset.v)" data-v="${esc(o)}">${esc(o)}</button>`).join("")}</div>
    <textarea rows="2" ${keep(id)} placeholder="${esc(q.suggested_answer ? tr("si.suggestion", { text: q.suggested_answer }) : tr("si.answerPh"))}">${esc(drafts[id] || "")}</textarea></div>`;
}

const RUN_ACTIONS = {
  retry: ["FAILED", "CANCELED"],
  reexecute: ["COMPLETED", "SKIPPED", "WAITING_INPUT", "WAITING_APPROVAL"],
  skip: ["PENDING", "READY", "FAILED", "WAITING_INPUT", "WAITING_APPROVAL"],
};

function approvalPanel(run, s) {
  const req = s.approval?.request;
  const gate = s.approval?.gate && !s.approval?.granted;
  let body = "";
  if (gate) body = `<div class="muted">${esc(tr("cl.gateOnly"))}</div>`;
  if (req) {
    body += req.message ? `<div><b>${esc(req.message)}</b></div>` : "";
    if (req.select_repositories) {
      body += `<div class="muted small">${req.ambiguous ? "⚠️ " + esc(tr("cl.choose")) : esc(tr("cl.recommendation"))}</div>
        ${(req.candidates || [])
          .map((c) => {
            const picked = drafts["repo-" + s.key + "-" + c.repo];
            const on = picked !== undefined ? picked : (req.recommended || []).includes(c.repo);
            return `<label style="display:flex;gap:8px;align-items:flex-start;color:inherit;font-size:13px"><input type="checkbox" style="width:auto" name="repo-${s.key}" value="${esc(c.repo)}" ${on ? "checked" : ""} onchange="drafts['repo-${s.key}-'+this.value]=this.checked">
            <span><b>${esc(c.repo)}</b> <span class="muted">${esc(tr("cl.score", { n: c.score }))}</span><br><span class="muted small">${esc((c.reasons || []).join(" · "))}</span></span></label>`;
          })
          .join("")}
        <div class="muted small">${esc(tr("cl.allowedLabel", { list: (req.allowed || run.allowed_repositories).join(", ") }))}</div>`;
    }
    for (const [k, v] of Object.entries(req.outputs || {}))
      body += `<details data-k="appr-${s.key}-${k}" open><summary>${esc(tr("cl.outputOf", { step: k }))}</summary>${json(v)}</details>`;
  }
  return `<div class="card" style="background:var(--bg)">${body}
    <textarea rows="2" ${keep("cmt-" + s.key)} placeholder="${esc(tr("si.commentPh"))}">${esc(drafts["cmt-" + s.key] || "")}</textarea>
    <div class="row"><button class="ok" onclick="A.approve(${run.id}, '${s.key}')">${esc(tr("si.approve"))}</button>
      <button class="danger" onclick="A.reject(${run.id}, '${s.key}')">${esc(s.config?.on_reject?.reexecute ? tr("cl.redo", { step: s.config.on_reject.reexecute }) : tr("si.reject"))}</button></div></div>`;
}

// ---------------------------------------------------------------- agent conversation

const convSel = {}; // stepKey -> selected attempt id
const AGENT_TYPES = ["agent", "coding_agent"];
const ago = (t) => {
  const s = Math.max(0, Math.round((Date.now() - new Date(t)) / 1000));
  return s < 60
    ? `${s}s`
    : s < 3600
      ? `${Math.floor(s / 60)}m${s % 60}s`
      : `${Math.floor(s / 3600)}h`;
};
const fmtDur = (ms) =>
  ms == null
    ? ""
    : ms < 60000
      ? `${Math.round(ms / 1000)}s`
      : `${Math.floor(ms / 60000)}m${Math.round((ms % 60000) / 1000)}s`;

function toolLabel(name, input = {}) {
  const short = name.replace(/^mcp__platform__/, "platform·");
  const hint =
    input.file_path ??
    input.path ??
    input.pattern ??
    input.command ??
    input.repo ??
    input.description ??
    input.url ??
    input.query ??
    input.step_key ??
    "";
  return `<b>${esc(short)}</b> <span class="mono">${esc(String(hint).split("\n")[0].slice(0, 140))}</span>`;
}

function agentName(provider) {
  return tr("run.agentShort." + providerOf(provider));
}
function renderTranscript(events, live, provider) {
  const name = agentName(provider);
  const results = {};
  for (const e of events)
    if (e.kind === "tool_result" && e.data?.tool_use_id) results[e.data.tool_use_id] = e;
  const out = [];
  for (const e of events) {
    const sub = e.data?.parent ? " sub" : "";
    const when = `<span class="muted small">${time(e.created_at)}</span>`;
    const long = (txt, n = 1800) =>
      txt.length > n
        ? `<details><summary>${esc(txt.slice(0, 200))}… (${esc(tr("cl.chars", { n: txt.length }))})</summary><div class="pre">${esc(txt)}</div></details>`
        : `<div class="pre">${esc(txt)}</div>`;
    switch (e.kind) {
      case "system_prompt":
        out.push(
          `<details class="msg sys"><summary>📋 ${esc(tr("cl.system"))} · ${esc((e.data?.tools || []).join(", "))}${e.data?.knowledge?.length ? " · " + esc(tr("cl.knowledgeWord")) + ": " + esc(e.data.knowledge.join(", ")) : ""}</summary><div class="pre">${esc(e.content)}</div></details>`,
        );
        break;
      case "prompt":
        out.push(
          `<div class="msg user${sub}"><div class="who">➡️ ${esc(tr("cl.platformTo", { name }))} ${e.data?.resume_session ? `<span class="badge s-READY">${esc(tr("cl.resume"))}</span>` : ""} ${when}</div>${long(e.content)}</div>`,
        );
        break;
      case "agent":
        out.push(
          `<div class="msg claude${sub}"><div class="who">🤖 ${esc(name)} ${when}</div><div class="pre">${esc(e.content)}</div></div>`,
        );
        break;
      case "thinking":
        out.push(
          `<details class="msg think${sub}"><summary>💭 ${esc(tr("cl.thinking"))} ${when}</summary><div class="pre">${esc(e.content)}</div></details>`,
        );
        break;
      case "tool": {
        if (!e.data?.name) {
          out.push(`<div class="msg note${sub}">${when} ${esc(e.content)}</div>`);
          break;
        }
        const r = results[e.data.id];
        const flag = r
          ? r.data?.is_error
            ? badge("FAILED")
            : ""
          : live
            ? `<span class="badge s-RUNNING">${esc(tr("cl.running"))}</span>`
            : "";
        const result = r
          ? `<details${r.data?.is_error ? " open" : ""}><summary>${esc(tr("cl.toolResult"))} (${esc(tr("cl.chars", { n: r.content.length }))})</summary><pre${r.data?.is_error ? ' class="err"' : ""}>${esc(r.content)}</pre></details>`
          : "";
        out.push(
          `<div class="msg tool${sub}"><div class="who">🔧 ${toolLabel(e.data.name, e.data.input)} ${when} ${flag}</div><details><summary>${esc(tr("cl.input"))}</summary><pre>${esc(JSON.stringify(e.data.input, null, 2))}</pre></details>${result}</div>`,
        );
        break;
      }
      case "tool_result":
        if (
          !e.data?.tool_use_id ||
          !events.some((x) => x.kind === "tool" && x.data?.id === e.data.tool_use_id)
        )
          out.push(
            `<details class="msg tool${sub}"><summary>↩︎ ${esc(tr("cl.toolResult"))}</summary><pre>${esc(e.content)}</pre></details>`,
          );
        break;
      case "result": {
        const d = e.data || {};
        const turns = d.num_turns == null ? "?" : tr("cl.turns", { n: d.num_turns });
        const usage = d.usage
          ? " · " +
            tr("cl.tokensIn", { inn: d.usage.input_tokens ?? 0, out: d.usage.output_tokens ?? 0 })
          : "";
        const answer = e.content
          ? `<details><summary>${esc(tr("cl.lastAnswer"))}</summary><div class="pre">${esc(e.content)}</div></details>`
          : "";
        out.push(
          `<div class="msg done"><b>${d.is_error ? "❌" : "✅"} ${esc(tr("cl.turnDone"))}</b> · ${esc(turns)} · ${fmtDur(d.duration_ms)}${d.total_cost_usd != null ? ` · $${Number(d.total_cost_usd).toFixed(3)}` : ""}${esc(usage)} ${when}${answer}</div>`,
        );
        break;
      }
      default:
        out.push(`<div class="msg note${sub}">${when} ${esc(e.content)}</div>`);
    }
  }
  if (live) {
    const last = events.at(-1);
    const tail = last ? tr("cl.lastAgo", { ago: ago(last.created_at) }) : tr("cl.starting");
    out.push(`<div class="msg live">⏳ ${esc(tr("cl.working", { name }))} ${esc(tail)}</div>`);
  }
  return out.join("") || `<div class="muted small">${esc(tr("cl.noConvo"))}</div>`;
}

async function conversationPanel(s, atts, provider) {
  if (!AGENT_TYPES.includes(s.type) || !atts.length) return "";
  const k = "conv-" + s.key;
  const running = s.status === "RUNNING";
  const wasOpen = $(`details[data-k="${k}"]`)?.open;
  const open = wasOpen ?? running;
  const selected = Number(convSel[s.key] ?? s.current_attempt_id ?? atts.at(-1).id);
  const att = atts.find((a) => a.id === selected) ?? atts.at(-1);
  const live = running && att.id === s.current_attempt_id;
  const events = open ? await api(`/api/attempts/${att.id}/transcript`) : [];
  return `<details data-k="${k}" ${open ? 'open data-loaded="1"' : ""} ontoggle="if (this.open && !this.dataset.loaded) render(true)">
    <summary>💬 ${esc(tr("cl.convo", { name: agentName(provider) }))} ${live ? `<span class="badge s-RUNNING">${esc(tr("cl.live"))}</span>` : ""}</summary>
    <div class="row" style="margin:4px 0">${
      atts.length > 1
        ? `<select style="width:auto" onchange="A.convAttempt('${s.key}', this.value)">${atts
            .map(
              (a) =>
                `<option value="${a.id}" ${a.id === att.id ? "selected" : ""}>${esc(tr("cl.attemptLine", { n: a.number, gen: a.generation, status: statusText(a.status) }))}</option>`,
            )
            .join("")}</select>`
        : `<span class="muted small">${esc(tr("cl.attemptShort", { n: att.number, status: statusText(att.status) }))}</span>`
    }</div>
    <div class="convo" data-scroll="${k}">${open ? renderTranscript(events, live, provider) : ""}</div></details>`;
}

async function runDetail(id) {
  const [r, events] = await Promise.all([api(`/api/runs/${id}`), api(`/api/runs/${id}/events`)]);
  const attempts = {};
  for (const a of r.attempts) (attempts[a.step_key] ??= []).push(a);
  const questions = {};
  for (const q of r.questions) (questions[q.step_key] ??= []).push(q);
  const artifacts = {};
  for (const a of r.artifacts) (artifacts[a.step_id] ??= []).push(a);
  const active = !["CANCELED"].includes(r.status);
  return `
    <div class="muted small"><a href="#/runs">${esc(tr("nav.runs"))}</a> / ${r.work_item ? `<a href="#/work-items/${r.work_item.id}">${esc(r.work_item.code)}</a>` : esc(tr("cl.noWorkItem"))}</div>
    <h2>${esc(tr("ins.col.run"))} #${r.id} · ${esc(r.title)}</h2>
    <div class="muted">${esc(r.definition_key)} v${r.definition_version} · ${esc(tr("run.agent"))} ${esc(tr("run.agent." + providerOf(r.agent_provider)))} · ${esc(tr("common.branch"))} <span class="mono">${esc(r.branch)}</span> · ${badge(r.status)} ${r.error ? `<span class="err">${esc(r.error)}</span>` : ""}</div>
    <div class="row">
      ${r.status === "PENDING" ? `<button onclick="A.runAction(${r.id}, 'start')">${esc(tr("rv.start"))}</button>` : ""}
      ${["RUNNING", "WAITING"].includes(r.status) ? `<button class="ghost" onclick="A.runAction(${r.id}, 'pause')">${esc(tr("rv.pause"))}</button>` : ""}
      ${r.status === "PAUSED" ? `<button onclick="A.runAction(${r.id}, 'resume')">${esc(tr("rv.resume"))}</button>` : ""}
      ${active && !["COMPLETED"].includes(r.status) ? `<button class="danger" onclick="A.runAction(${r.id}, 'cancel')">${esc(tr("rv.cancel"))}</button>` : ""}
    </div>
    <div class="card" style="margin-top:12px"><b>${esc(tr("nav.repositories"))}</b> · ${esc(tr("cl.selected", { list: r.selected_repositories.join(", ") || tr("cl.noneYet") }))}
      <span class="muted small"> · ${esc(tr("cl.allowed", { list: r.allowed_repositories.join(", ") }))}</span>
      ${["PENDING", "PAUSED"].includes(r.status) ? `<div class="row"><input ${keep("sel-repos")} value="${esc(drafts["sel-repos"] ?? r.selected_repositories.join(", "))}"><button class="ghost" onclick="A.setRepos(${r.id})">${esc(tr("cl.set"))}</button></div>` : ""}
    </div>
    <div class="graph">${r.steps
      .map(
        (s, i) =>
          `${i ? '<span class="arrow">→</span>' : ""}<span class="node s-${s.status}" title="${esc(s.type)} · ${esc(tr("cl.depends", { list: s.depends_on.join(", ") || "-" }))}" onclick="document.getElementById('step-${s.key}').scrollIntoView({behavior:'smooth'})">${esc(s.name)}</span>`,
      )
      .join("")}</div>
    ${(
      await Promise.all(
        r.steps.map(async (s) => {
          const atts = attempts[s.key] || [];
          const convo = await conversationPanel(s, atts, r.agent_provider);
          const qs = questions[s.key] || [];
          const open = qs.filter((q) => q.status === "open");
          const can = (a) => RUN_ACTIONS[a].includes(s.status) && active;
          return `<div class="card step st-${s.status}" id="step-${s.key}">
          <div class="step-head"><b>${esc(s.name)}</b><span class="type">${esc(s.key)} · ${esc(s.type)}</span>${badge(s.status)}
            <span class="muted small">${esc(tr("cl.gen"))} ${s.generation} · ${esc(tr("cl.attempts", { n: atts.length }))}${s.requires_approval ? " · " + esc(tr("si.gate")) : ""}${s.run_if ? ` · run_if ${esc(s.run_if.step)}=${esc(JSON.stringify(s.run_if.equals))}` : ""}</span>
            <span style="flex:1"></span>
            ${can("retry") ? `<button class="sm warn" onclick="A.stepAction(${r.id}, '${s.key}', 'retry')">${esc(tr("si.retry"))}</button>` : ""}
            ${can("reexecute") ? `<button class="sm ghost" onclick="A.stepAction(${r.id}, '${s.key}', 'reexecute')">${esc(tr("cl.reexecuteFrom"))}</button>` : ""}
            ${can("skip") ? `<button class="sm ghost" onclick="A.stepAction(${r.id}, '${s.key}', 'skip')">${esc(tr("si.skip"))}</button>` : ""}
          </div>
          ${s.error ? `<div class="err small">${esc(s.error)}</div>` : ""}
          ${open.length ? open.map((q) => questionForm({ ...q, step_name: "" })).join("") + `<div class="row"><button onclick="A.answer([${open.map((q) => q.id).join(",")}])">${esc(tr("cl.sendAnswers"))}</button></div>` : ""}
          ${s.status === "WAITING_APPROVAL" ? approvalPanel(r, s) : ""}
          ${convo}
          ${s.output != null ? `<details data-k="out-${s.key}"><summary>${esc(tr("cl.output"))}</summary>${json(s.output)}</details>` : ""}
          ${(artifacts[s.id] || []).length ? `<div class="row small">${artifacts[s.id].map((a) => `<button class="ghost sm" onclick="A.artifact(${a.id})">📎 ${esc(a.name)}</button>`).join("")}</div>` : ""}
          ${
            qs.filter((q) => q.status !== "open").length
              ? `<details data-k="qa-${s.key}"><summary>${esc(tr("cl.earlierQ", { n: qs.filter((q) => q.status !== "open").length }))}</summary>${qs
                  .filter((q) => q.status !== "open")
                  .map(
                    (q) =>
                      `<div class="q"><b>${esc(q.question)}</b> ${badge(q.status)}<div class="muted">→ ${esc(q.answer ?? "")}</div></div>`,
                  )
                  .join("")}</details>`
              : ""
          }
          ${
            atts.length
              ? `<details data-k="att-${s.key}"><summary>${esc(tr("cl.attemptHistory"))}</summary><table><tr><th>#</th><th>${esc(tr("cl.gen"))}</th><th>${esc(tr("wi.status"))}</th><th>${esc(tr("si.started"))}</th><th>${esc(tr("si.finished"))}</th><th>${esc(tr("cl.context"))}</th><th>${esc(tr("cl.session"))}</th><th>${esc(tr("common.error"))}</th></tr>${atts
                  .map(
                    (
                      a,
                    ) => `<tr${a.invalidated_at ? ' class="muted"' : ""}><td>${a.number}</td><td>${a.generation}</td><td>${badge(a.status)}${a.invalidated_at ? ` <span class="small">${esc(tr("si.invalidated"))}</span>` : ""}</td><td>${time(a.started_at)}</td><td>${time(a.finished_at)}</td>
              <td>${a.context_snapshot_id ? `<button class="ghost sm" onclick="A.snapshot(${a.context_snapshot_id})">${esc(tr("cl.snapshot"))}</button>` : ""}</td><td class="mono small">${esc((a.agent_session_id || "").slice(0, 8))}</td>
              <td class="err small">${esc(a.error?.message || "")}</td></tr>`,
                  )
                  .join("")}</table></details>`
              : ""
          }
        </div>`;
        }),
      )
    ).join("")}
    ${r.pull_requests.length ? `<h3>${esc(tr("common.pullRequests"))}</h3>${prTable(r.pull_requests)}` : ""}
    ${
      active && (r.graph.feedback_step || r.steps.some((s) => s.type === "coding_agent"))
        ? `<h3>${esc(tr("rv.feedbackTitle"))}</h3>
      <textarea rows="3" ${keep("fb")} placeholder="${esc(tr("rv.feedbackPh"))}">${esc(drafts.fb || "")}</textarea><div class="row"><button onclick="A.feedback(${r.id})">${esc(tr("rv.feedbackTip"))}</button></div>`
        : ""
    }
    <h3>${esc(tr("common.timeline"))}</h3>
    ${events
      .slice()
      .reverse()
      .slice(0, 400)
      .map(
        (e) =>
          `<div class="ev ${e.kind}"><time class="muted">${time(e.created_at)}</time><span class="s mono small muted">${esc(e.step_key || "run")}</span><span class="k muted">${esc(e.kind)}</span><span class="c">${esc(e.content)}</span></div>`,
      )
      .join("")}`;
}

async function workflowDetail(key) {
  const w = await api(`/api/workflows/${key}`);
  const latest = w.versions[0];
  const spec = w.draft_spec ?? latest?.spec;
  const id = "spec-" + key;
  return `
    <div class="muted small"><a href="#/workflows">${esc(tr("nav.workflows"))}</a> /</div>
    <h2>${esc(w.name)}</h2><div class="muted"><span class="mono">${esc(w.key)}</span> · ${esc(tr("cl.latestV", { n: w.latest_version }))}${w.draft_spec ? ` · <span class="badge s-WAITING">${esc(tr("cl.unpublished"))}</span>` : ""}</div>
    <div class="muted">${esc(w.description)}</div>
    ${spec ? `<div class="graph">${spec.steps.map((s, i) => `${i ? '<span class="arrow">→</span>' : ""}<span class="node" title="${esc(s.type)} · ${esc(tr("cl.after", { list: (s.depends_on || []).join(", ") || "-" }))}">${esc(s.name || s.key)} <span class="muted small">${esc(s.type)}</span></span>`).join("")}</div>` : ""}
    <div class="card"><h4>${esc(tr("wfe.addStep"))}</h4><table><tr><th>${esc(tr("wfe.key"))}</th><th>${esc(tr("wfe.type"))}</th><th>${esc(tr("wfe.depends"))}</th><th>${esc(tr("wfe.execution"))}</th></tr>${(
      spec?.steps || []
    )
      .map(
        (s) =>
          `<tr><td class="mono">${esc(s.key)}</td><td>${esc(s.type)}</td><td>${esc((s.depends_on || []).join(", "))}</td><td class="small">${[s.requires_approval ? tr("si.gate") : "", s.max_attempts > 1 ? tr("si.maxAttempts") + " " + s.max_attempts : "", s.run_if ? "run_if" : "", (s.config?.skills || []).length ? tr("cl.skills") + ": " + s.config.skills.join(", ") : ""].filter(Boolean).join(" · ")}</td></tr>`,
      )
      .join("")}</table></div>
    <div class="card"><h4>${esc(tr("cl.editDef"))}</h4><div class="muted small">${esc(tr("cl.editDefHint", { version: w.latest_version + 1 }))}</div>
      <textarea class="code" rows="22" ${keep(id)}>${esc(drafts[id] ?? JSON.stringify(spec, null, 2))}</textarea>
      <div class="row"><button class="ghost" onclick="A.validateSpec('${id}')">${esc(tr("wfe.validate"))}</button><button class="ghost" onclick="A.saveDraft('${key}')">${esc(tr("wfe.saveDraft"))}</button>
        <input placeholder="${esc(tr("wfe.changeNote"))}" ${keep("note-" + key)} value="${esc(drafts["note-" + key] || "")}" style="max-width:260px"><button onclick="A.publish('${key}')">${esc(tr("cl.publishNew"))}</button>
        <button class="ghost" onclick="location.hash='/runs'; drafts['nr-wf']='${key}'">${esc(tr("cl.startRunEllipsis"))}</button></div></div>
    <h3>${esc(tr("wfe.versions"))}</h3><table><tr><th>${esc(tr("wfe.versions"))}</th><th>${esc(tr("wfe.publishedBadge"))}</th><th>${esc(tr("wfe.changeNoteAria"))}</th><th>${esc(tr("cl.hash"))}</th></tr>${w.versions
      .map(
        (v) =>
          "<tr><td>v" +
          v.version +
          "</td><td>" +
          time(v.published_at) +
          "</td><td>" +
          esc(v.change_note) +
          '</td><td class="mono small">' +
          esc(v.spec_hash.slice(0, 12)) +
          "</td></tr>",
      )
      .join("")}</table>`;
}

async function knowledgeDetail(key) {
  const k = await api(`/api/knowledge/${key}`);
  const cur = k.versions[0];
  return `
    <div class="muted small"><a href="#/knowledge">${esc(tr("nav.knowledge"))}</a> /</div>
    <h2>${esc(k.title)}</h2>
    <div class="muted"><span class="mono">${esc(k.key)}</span> · ${esc(catLabel(k.category))} · ${esc(k.scope_type)}${k.scope_ref ? ":" + esc(k.scope_ref) : ""} · v${k.current_version} ${k.enforced ? `<span class="badge s-FAILED">${esc(tr("kn.enforced"))}</span>` : ""} ${k.enabled ? `<span class="badge s-COMPLETED">${esc(tr("cl.enabled"))}</span>` : `<span class="badge s-CANCELED">${esc(tr("cl.disabled"))}</span>`}</div>
    <div class="card" style="margin-top:12px"><h4>${esc(tr("cl.editVersion"))}</h4>
      <div class="grid3"><div><label>${esc(tr("kn.titleField"))}</label><input ${keepHere("ke-title")} value="${esc(shown("ke-title", k.title))}"></div><div><label>${esc(tr("kn.scope"))}</label><select ${keepHere("ke-scope")}>${(META?.knowledgeScopes || []).map((s) => `<option value="${esc(s)}" ${shown("ke-scope", k.scope_type) === s ? "selected" : ""}>${esc(s)}</option>`).join("")}</select></div>
      <div><label>${esc(tr("kn.scopeRef"))}</label><input ${keepHere("ke-ref")} value="${esc(shown("ke-ref", k.scope_ref))}"></div><div><label>${esc(tr("kn.conflictKey"))}</label><input ${keepHere("ke-ck")} value="${esc(shown("ke-ck", k.conflict_key || ""))}"></div><div><label>${esc(tr("kn.priority"))}</label><input ${keepHere("ke-prio")} type="number" value="${esc(shown("ke-prio", k.priority))}"></div>
      <div><label>${esc(tr("kn.enabled"))}</label><select ${keepHere("ke-enabled")}><option value="true" ${String(shown("ke-enabled", k.enabled ? "true" : "false")) === "true" ? "selected" : ""}>${esc(tr("kn.enabledYes"))}</option><option value="false" ${String(shown("ke-enabled", k.enabled ? "true" : "false")) === "false" ? "selected" : ""}>${esc(tr("kn.enabledNo"))}</option></select></div></div>
      <label>${esc(tr("kn.content"))}</label><textarea ${keepHere("ke-content")} rows="6">${esc(shown("ke-content", cur?.content || ""))}</textarea>
      <div class="grid2"><div><label>${esc(tr("kn.applicability"))}</label><textarea ${keepHere("ke-app")} class="code" rows="3">${esc(shown("ke-app", JSON.stringify(cur?.applicability || {}, null, 2)))}</textarea></div>
      <div><label>${esc(tr("kn.metadata"))}</label><textarea ${keepHere("ke-meta")} class="code" rows="3">${esc(shown("ke-meta", JSON.stringify(cur?.metadata || {}, null, 2)))}</textarea></div></div>
      <div class="row"><input ${keepHere("ke-note")} placeholder="${esc(tr("kn.changeNote"))}" value="${esc(shown("ke-note", ""))}"><button onclick="A.updateKnowledge('${k.key}')">${esc(tr("kn.save"))}</button></div></div>
    <h3>${esc(tr("kn.versions"))}</h3>${k.versions.map((v) => `<details data-k="kv-${v.version}"><summary>v${v.version} · ${time(v.created_at)} · ${esc(v.change_note)}</summary><div class="card"><div style="white-space:pre-wrap">${esc(v.content)}</div>${json({ applicability: v.applicability, metadata: v.metadata })}</div></details>`).join("")}
    <h3>${esc(tr("kn.audit"))}</h3>${k.audit.map((a) => `<div class="small"><span class="muted">${time(a.created_at)}</span> <b>${esc(a.action)}</b> <span class="mono">${esc(JSON.stringify(a.detail))}</span></div>`).join("")}`;
}

// ---------------------------------------------------------------- actions

const parseJson = (s, what) => {
  try {
    return JSON.parse(s || "{}");
  } catch {
    throw new Error(tr("cl.badJson", { what }));
  }
};
function closeModal() {
  modalCache = null;
  const host = $("#modal");
  if (host) host.innerHTML = "";
}
function artifactHtml(a) {
  return `<div class="card"><div class="row" style="margin:0"><b>${esc(a.name)}</b><span style="flex:1"></span><button class="ghost sm" onclick="A.closeModal()">${esc(tr("common.close"))}</button></div><pre>${esc(a.content)}</pre>${a.data ? json(a.data) : ""}</div>`;
}
function snapshotHtml(s) {
  const c = s.content;
  const items =
    (c.knowledge || [])
      .map(
        (k) =>
          `<div class="small">• <b>${esc(k.key)}</b> v${k.version} <span class="muted">${esc(catLabel(k.category))} · ${esc(k.reason)}</span></div>`,
      )
      .join("") || `<div class="muted small">${esc(tr("cl.none"))}</div>`;
  const over = (c.overridden || []).length
    ? `<h4 style="margin-top:8px">${esc(tr("cl.overriddenTitle"))}</h4>${c.overridden.map((o) => `<div class="small">• ${esc(o.key)} v${o.version} ${esc(tr("cl.overriddenBy", { by: o.by }))} <span class="muted">(${esc(o.conflict_key)})</span></div>`).join("")}`
    : "";
  return `<div class="card"><div class="row" style="margin:0"><b>${esc(tr("cl.snapTitle", { id: s.id }))}</b> <span class="mono muted small">${esc(s.hash.slice(0, 16))}</span><span style="flex:1"></span><button class="ghost sm" onclick="A.closeModal()">${esc(tr("common.close"))}</button></div>
    <div class="small">${esc(tr("cl.snapLine", { step: c.step?.key || "", gen: c.step?.generation ?? "", project: c.project || "-", repos: (c.repositories || []).join(", ") || "-" }))}</div>
    <h4 style="margin-top:8px">${esc(tr("cl.applied"))}</h4>${items}${over}
    <details><summary>${esc(tr("wi.raw"))}</summary>${json(c)}</details></div>`;
}
function paintModal() {
  const host = $("#modal");
  if (!host || !modalCache) return;
  host.innerHTML =
    modalCache.kind === "artifact" ? artifactHtml(modalCache.data) : snapshotHtml(modalCache.data);
}
function paintPreview() {
  const host = $("#preview");
  if (!host || !previewCache) return;
  const r = previewCache;
  host.innerHTML =
    r.applied
      .map(
        (k) =>
          `<div class="small">✓ <b>${esc(k.key)}</b> v${k.version} <span class="muted">${esc(catLabel(k.category))} · ${esc(k.reason)}</span></div>`,
      )
      .join("") +
    r.overridden
      .map(
        (o) =>
          `<div class="small muted">✗ ${esc(o.key)} ${esc(tr("cl.overriddenBy", { by: o.by }))} (${esc(o.conflict_key)})</div>`,
      )
      .join("");
}
function paintRank() {
  const host = $("#rank");
  if (!host || !rankCache) return;
  host.innerHTML =
    (rankCache.ambiguous
      ? `<div class="small" style="color:var(--warn)">⚠️ ${esc(tr("repo.ambiguous"))}</div>`
      : "") +
    rankCache.ranked
      .map(
        (x) =>
          `<div class="small"><b>${esc(x.repo)}</b> ${x.score} <span class="muted">${esc(x.reasons.join(" · "))}</span></div>`,
      )
      .join("");
}

window.drafts = drafts;
window.A = {
  createWorkItem: () =>
    act(async () => {
      const w = await api("/api/work-items", {
        title: val("wi-title"),
        project: val("wi-project"),
        description: val("wi-desc"),
      });
      ["wi-title", "wi-project", "wi-desc"].forEach((k) => delete drafts[k]);
      location.hash = "/work-items/" + w.id;
    }),
  importJson: (source) =>
    act(async () => {
      const r = await api("/api/work-items/import", {
        source,
        payload: parseJson(val("wi-json"), "payload"),
      });
      delete drafts["wi-json"];
      location.hash = "/work-items/" + (r.item?.id ?? r.work_item_id);
    }, tr("cl.importedIdle")),
  importJiraKey: () =>
    act(async () => {
      const r = await api("/api/work-items/import", { source: "jira", key: val("jira-key") });
      location.hash = "/work-items/" + r.item.id;
    }),
  importHasakiId: () =>
    act(async () => {
      const r = await api("/api/work-items/import", {
        source: "hasaki_work",
        work_id: Number(val("hw-id")),
      });
      delete drafts["hw-id"];
      location.hash = "/work-items/" + r.work_item_id;
    }, tr("cl.importedPick")),
  openLogin: () => act(() => api("/api/work/login-window", {})),
  saveToken: () => act(() => api("/api/work/token", { token: val("tok") })),
  refreshInbox: (btn) => {
    btn.disabled = true;
    btn.textContent = "…";
    return act(async () => {
      const r = await api("/api/work/refresh", {});
      toast(tr("cl.taskCount", { n: r.count }), true);
    });
  },
  pick: (id, btn) => {
    btn.disabled = true;
    return act(async () => {
      const r = await api("/api/work/pick/" + id, {});
      location.hash = "/work-items/" + r.work_item_id;
    }, tr("cl.importedPick"));
  },
  startForItem: (id, start) =>
    act(async () => {
      const repos = list(val("wi-repos"));
      const r = await api(`/api/work-items/${id}/runs`, {
        workflow: val("wi-wf") || "feature-implementation",
        repositories: repos.length ? repos : undefined,
        start,
        agent_provider: val("wi-provider") || "claude",
      });
      location.hash = "/runs/" + r.id;
    }),
  analyze: (id) =>
    act(
      async () =>
        (location.hash =
          "/runs/" +
          (
            await api(`/api/work-items/${id}/analyze`, {
              agent_provider: val("wi-provider") || "claude",
            })
          ).id),
    ),
  setPolicy: (id, on) =>
    act(
      () =>
        api(`/api/work-items/${id}`, { automation_policy: on ? { workflow: val("wi-wf") } : null }),
      tr("wi.saved"),
    ),
  setStatus: (id, status) => act(() => api(`/api/work-items/${id}`, { status })),
  newRun: (start) =>
    act(async () => {
      const repos = list(val("nr-repos"));
      const r = await api("/api/runs", {
        workflow: val("nr-wf"),
        repositories: repos,
        title: val("nr-title") || undefined,
        inputs: {
          ...parseJson(val("nr-inputs"), "inputs"),
          ...(repos.length ? { repositories: repos } : {}),
        },
        start,
        agent_provider: val("nr-provider") || "claude",
      });
      location.hash = "/runs/" + r.id;
    }),
  runAction: (id, action) => {
    if (action === "cancel" && !confirm(tr("rv.cancelConfirm"))) return;
    return act(() => api(`/api/runs/${id}/${action}`, {}));
  },
  setRepos: (id) =>
    act(
      () => api(`/api/runs/${id}/repositories`, { repositories: list(val("sel-repos")) }),
      tr("cl.reposUpdated"),
    ),
  stepAction: (id, key, action) => {
    let body = {};
    if (action === "reexecute") {
      const fb = prompt(tr("cl.reexecPrompt"));
      if (fb === null) return;
      body = fb ? { feedback: fb } : {};
    }
    if (action === "skip" && !confirm(tr("si.skipAsk"))) return;
    return act(() => api(`/api/runs/${id}/steps/${key}/${action}`, body));
  },
  convAttempt: (key, id) => {
    convSel[key] = Number(id);
    render(true);
  },
  pickOption: (id, v) => {
    drafts["ans-" + id] = v;
    $("#ans-" + id).value = v;
  },
  answer: (ids) =>
    act(async () => {
      const answers = {};
      for (const id of ids) {
        const v = ($("#ans-" + id)?.value ?? "").trim();
        if (v) answers[id] = v;
      }
      const r = await api("/api/questions/answers", { answers });
      ids.forEach((id) => delete drafts["ans-" + id]);
      toast(
        r.resumed.length
          ? tr("cl.resumed", { steps: r.resumed.join(", ") })
          : tr("cl.stillOpen", { n: r.stillOpen }),
        true,
      );
    }),
  approve: (id, key) =>
    act(async () => {
      const boxes = $$(`input[name="repo-${key}"]`);
      await api(`/api/runs/${id}/steps/${key}/approve`, {
        comment: val("cmt-" + key),
        repositories: boxes.length ? boxes.filter((b) => b.checked).map((b) => b.value) : undefined,
      });
      delete drafts["cmt-" + key];
    }, tr("cl.approved")),
  reject: (id, key) =>
    act(async () => {
      await api(`/api/runs/${id}/steps/${key}/reject`, { comment: val("cmt-" + key) });
      delete drafts["cmt-" + key];
    }, tr("cl.rejected")),
  feedback: (id) =>
    act(async () => {
      await api(`/api/runs/${id}/feedback`, { message: val("fb") });
      delete drafts.fb;
    }, tr("rv.feedbackSent")),
  closeModal,
  artifact: async (id) => {
    const a = await api(`/api/artifacts/${id}`);
    modalCache = { kind: "artifact", data: a };
    paintModal();
    $("#modal").scrollIntoView({ behavior: "smooth" });
  },
  snapshot: async (id) => {
    const s = await api(`/api/snapshots/${id}`);
    modalCache = { kind: "snapshot", data: s };
    paintModal();
    $("#modal").scrollIntoView({ behavior: "smooth" });
  },
  validateSpec: (id) =>
    act(async () => {
      const r = await api("/api/workflows/validate", { spec: parseJson(val(id), "definition") });
      toast(r.valid ? tr("wfe.valid") + " ✓" : r.errors.join("\n"), r.valid);
    }),
  createWorkflow: () =>
    act(async () => {
      await api("/api/workflows", {
        key: val("wf-key"),
        spec: parseJson(val("wf-spec"), "definition"),
      });
      location.hash = "/workflows/" + val("wf-key");
      delete drafts["wf-key"];
      delete drafts["wf-spec"];
    }, tr("cl.createdV1")),
  saveDraft: (key) =>
    act(
      () =>
        api(`/api/workflows/${key}/draft`, { spec: parseJson(val("spec-" + key), "definition") }),
      tr("wfe.draftSaved"),
    ),
  publish: (key) =>
    act(async () => {
      await api(`/api/workflows/${key}/draft`, {
        spec: parseJson(val("spec-" + key), "definition"),
      });
      const r = await api(`/api/workflows/${key}/publish`, { change_note: val("note-" + key) });
      delete drafts["spec-" + key];
      toast(r.unchanged ? tr("wfe.noChange") : tr("wfe.published", { version: r.version }), true);
    }),
  createKnowledge: () =>
    act(async () => {
      const k = await api("/api/knowledge", {
        key: val("k-key"),
        title: val("k-title"),
        category: val("k-cat") || "business_rule",
        scope_type: val("k-scope") || "GLOBAL",
        scope_ref: val("k-ref"),
        conflict_key: val("k-ck") || null,
        content: val("k-content"),
        applicability: parseJson(val("k-app"), "applicability"),
        metadata: parseJson(val("k-meta"), "metadata"),
        enforced: $("#k-enf").checked,
      });
      ["k-key", "k-title", "k-ref", "k-ck", "k-content", "k-app", "k-meta"].forEach(
        (x) => delete drafts[x],
      );
      location.hash = "/knowledge/" + k.key;
    }),
  updateKnowledge: (key) =>
    act(
      () =>
        api(`/api/knowledge/${key}`, {
          title: val("ke-title"),
          scope_type: val("ke-scope"),
          scope_ref: val("ke-ref"),
          conflict_key: val("ke-ck") || null,
          priority: Number(val("ke-prio") || 0),
          enabled: val("ke-enabled") === "true",
          content: $("#ke-content").value,
          applicability: parseJson(val("ke-app"), "applicability"),
          metadata: parseJson(val("ke-meta"), "metadata"),
          change_note: val("ke-note"),
        }),
      tr("wi.saved"),
    ),
  previewKnowledge: async () => {
    try {
      previewCache = await api("/api/knowledge/preview", {
        workflow: val("p-wf"),
        step: val("p-step"),
        step_type: val("p-type"),
        project: val("p-proj"),
        repositories: list(val("p-repos")),
        text: val("p-text"),
      });
      paintPreview();
    } catch (e) {
      toast(e.message);
    }
  },
  saveRepo: () =>
    act(async () => {
      const name = val("r-name");
      await api(`/api/repositories/${encodeURIComponent(name)}`, {
        projects: list(val("r-projects")),
        services: list(val("r-services")),
        tags: list(val("r-tags")),
        owners: list(val("r-owners")),
        dependencies: list(val("r-deps")),
        allowed_actions: list(val("r-actions")),
        enabled: val("r-enabled") === "true",
        description: val("r-desc"),
        architecture: val("r-arch"),
      });
      location.hash = "/repositories/" + name;
    }, tr("wi.saved")),
  rank: async () => {
    try {
      rankCache = await api("/api/repositories/rank", {
        text: val("rk-text"),
        project: val("rk-proj"),
      });
      paintRank();
    } catch (e) {
      toast(e.message);
    }
  },
};

(async () => {
  try {
    locale = localStorage.getItem(UI_KEY) === "en" ? "en" : "vi";
  } catch {}
  document.documentElement.lang = locale;
  DICT = await api("/api/ui-messages").catch(() => ({ vi: {}, en: {} }));
  paintChrome();
  try {
    const me = await api("/api/auth/me");
    ME = me.user;
    CSRF = me.csrf;
  } catch {
    ME = null;
  }
  if (!ME) {
    showLogin();
    return;
  }
  const account = document.createElement("details");
  account.id = "classic-account";
  account.innerHTML = `<summary>${esc(ME.username)} · ${esc(tr(`auth.role.${ME.role}`))}</summary><nav aria-label="${esc(tr("auth.account"))}">
    <a href="/#/account" data-key="auth.account">${esc(tr("auth.account"))}</a>
    <a href="/#/account/password" data-key="auth.passwordChange">${esc(tr("auth.passwordChange"))}</a>
    ${ME.role === "admin" ? `<a href="/#/users" data-key="auth.users">${esc(tr("auth.users"))}</a>` : ""}
    <button id="logout" data-key="auth.logout" type="button">${esc(tr("auth.logout"))}</button></nav>`;
  $("#lang").before(account);
  $("#logout").onclick = async () => {
    if (!confirm(tr("auth.logoutConfirm", { name: ME.username }))) return;
    try {
      await api("/api/auth/logout", {});
    } catch {
      toast(tr("auth.logoutFailed"));
      return;
    }
    ME = null;
    CSRF = "";
    for (const k of Object.keys(drafts)) delete drafts[k];
    location.reload();
  };
  account.addEventListener("keydown", (e) => {
    if (e.key === "Escape") {
      account.open = false;
      account.querySelector("summary").focus();
    }
  });
  META = await api("/api/meta").catch(() => null);
  await render(true);
  setInterval(() => document.visibilityState === "visible" && render(false), 3000); // classic UI: plain polling, paused while hidden
})();
