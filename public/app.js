// Workflow Platform UI — vanilla JS, hash router, every screen backed by /api/*.
const $ = (s, r = document) => r.querySelector(s);
const $$ = (s, r = document) => [...r.querySelectorAll(s)];
const esc = (s) => String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]);
const time = (t) => (t ? new Date(t).toLocaleString("vi-VN", { hour: "2-digit", minute: "2-digit", day: "2-digit", month: "2-digit" }) : "");
const badge = (s) => `<span class="badge s-${esc(s)}">${esc(s)}</span>`;
const json = (v) => `<pre>${esc(JSON.stringify(v, null, 2))}</pre>`;
const list = (v) => (Array.isArray(v) ? v : String(v || "").split(",").map((x) => x.trim()).filter(Boolean));

async function api(path, body) {
  const r = await fetch(path, body !== undefined ? { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) } : {});
  const j = await r.json().catch(() => ({}));
  if (!r.ok) throw new Error((j.error || r.status) + (j.details ? "\n" + j.details.join("\n") : ""));
  return j;
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
const keep = (id) => `id="${id}" oninput="drafts['${id}']=this.value"`;
const val = (id) => ($("#" + id)?.value ?? "").trim();

let META = null;
let STATE = { route: "", parts: [] };

// ---------------------------------------------------------------- router

async function render(force = false) {
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
  const active = document.activeElement;
  const typing = active && ["INPUT", "TEXTAREA", "SELECT"].includes(active.tagName) && $("#view").contains(active);
  if (!force && typing && STATE.route === hash) return; // don't clobber typing on poll
  STATE = { route: hash, parts };
  $$("header a").forEach((a) => a.classList.toggle("on", a.dataset.nav === parts[0]));
  const view = VIEWS[parts[0]] ?? VIEWS["work-items"];
  try {
    const html = await view(...parts.slice(1));
    if (STATE.route !== hash) return;
    const openDetails = $$("details[data-k]").filter((d) => d.open).map((d) => d.dataset.k);
    const scroll = window.scrollY;
    $("#view").innerHTML = html;
    openDetails.forEach((k) => {
      const d = $(`details[data-k="${k}"]`);
      if (d) d.open = true;
    });
    window.scrollTo(0, scroll);
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
window.addEventListener("hashchange", () => render(true));

// ---------------------------------------------------------------- shared pieces

function workflowSelect(id, workflows, selected) {
  return `<select ${keep(id)}>${workflows
    .map((w) => `<option value="${esc(w.key)}" ${(drafts[id] ?? selected) === w.key ? "selected" : ""}>${esc(w.name)} (v${w.latest_version})</option>`)
    .join("")}</select>`;
}
function stepChips(steps) {
  return `<span class="chips">${(steps || []).map((s) => `<span class="chip s-${s.status}" title="${esc(s.key)}: ${s.status}"></span>`).join("")}</span>`;
}
function runsTable(runs) {
  if (!runs.length) return `<div class="empty">No runs yet</div>`;
  return `<table><tr><th>#</th><th>Run</th><th>Workflow</th><th>Status</th><th>Steps</th><th>Questions</th><th>Updated</th></tr>
    ${runs
      .map(
        (r) => `<tr class="click" onclick="location.hash='/runs/${r.id}'"><td>${r.id}</td><td>${esc(r.title)}<div class="muted small mono">${esc(r.branch)}</div></td>
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
    const [items, status, inbox] = await Promise.all([api("/api/work-items"), api("/api/work/status"), api("/api/work/inbox")]);
    const exp = status.expiresAt ? ` · hết hạn ${new Date(status.expiresAt).toLocaleString("vi-VN")}` : "";
    return `
      <h2>Work Items</h2><div class="muted">Engineering requests. Importing never executes anything — choose a workflow explicitly.</div>
      <div class="grid3" style="margin-top:14px">
        <div class="card"><h4>New manual request</h4>
          <input placeholder="Title" ${keep("wi-title")} value="${esc(drafts["wi-title"] || "")}">
          <div class="row"><input placeholder="Project (e.g. OMS)" ${keep("wi-project")} value="${esc(drafts["wi-project"] || "")}"></div>
          <label>Description</label><textarea rows="3" ${keep("wi-desc")}>${esc(drafts["wi-desc"] || "")}</textarea>
          <div class="row"><button onclick="A.createWorkItem()">Create</button></div></div>
        <div class="card"><h4>Import</h4>
          <label>Paste Hasaki task JSON or Jira issue JSON</label><textarea class="code" rows="4" ${keep("wi-json")}>${esc(drafts["wi-json"] || "")}</textarea>
          <div class="row"><button class="ghost" onclick="A.importJson('hasaki_work')">Import Hasaki</button><button class="ghost" onclick="A.importJson('jira')">Import Jira</button></div>
          ${META?.jiraEnabled ? `<div class="row"><input placeholder="JIRA-123" ${keep("jira-key")}><button class="ghost" onclick="A.importJiraKey()">Fetch</button></div>` : `<div class="muted small" style="margin-top:6px">Jira API not configured (jira.baseUrl, JIRA_USER, JIRA_TOKEN) — paste JSON instead.</div>`}
        </div>
        <div class="card"><h4>Hasaki Work ${status.loggedIn ? badge("COMPLETED").replace("COMPLETED", "đã đăng nhập") : badge("FAILED").replace("FAILED", "chưa đăng nhập")}</h4>
          <div class="muted small">${exp}</div>
          ${
            status.loggedIn
              ? `<div class="row"><button onclick="A.refreshInbox(this)">Lấy task</button></div>`
              : `<div class="row">${status.windowOpen ? `<span class="muted">Đăng nhập trong cửa sổ Chromium…</span>` : `<button onclick="A.openLogin()">Mở trình duyệt đăng nhập</button>`}</div>
                 <div class="row"><input placeholder="hoặc dán token (Bearer eyJ…)" ${keep("tok")}><button onclick="A.saveToken()">Lưu</button></div>`
          }
          ${status.loggedIn ? `<div class="row"><input placeholder="Task id (số trong URL, vd 14408473)" ${keep("hw-id")} value="${esc(drafts["hw-id"] || "")}"><button class="ghost" onclick="A.importHasakiId()">Import</button></div>` : ""}
          ${inbox.length ? `<div style="max-height:220px;overflow:auto;margin-top:8px">${inbox
            .map(
              (r) => `<div class="row small" style="margin:4px 0"><div style="flex:1"><span class="mono muted">${esc(r.code)}</span> ${esc(r.name)}</div>
              ${r.work_item_id ? `<a href="#/work-items/${r.work_item_id}">${r.run_status ? badge(r.run_status) : "imported"}</a>` : `<button class="sm ghost" onclick="A.pick(${r.work_id}, this)">Import</button>`}</div>`,
            )
            .join("")}</div>` : ""}
        </div>
      </div>
      <h3>All work items</h3>
      ${items.length ? `<table><tr><th>Code</th><th>Title</th><th>Source</th><th>Project</th><th>Status</th><th>Runs</th><th>Last run</th><th>Updated</th></tr>
        ${items
          .map(
            (w) => `<tr class="click" onclick="location.hash='/work-items/${w.id}'"><td class="mono">${esc(w.code)}</td><td>${esc(w.title)}</td><td>${esc(w.source)}</td>
          <td>${esc(w.project)}</td><td>${badge(w.status)}</td><td>${w.run_count}</td><td>${w.last_run_status ? badge(w.last_run_status) : ""}</td><td class="muted">${time(w.updated_at)}</td></tr>`,
          )
          .join("")}</table>` : `<div class="empty">No work items</div>`}`;
  },

  // ------------------------------------------------ Runs
  async runs(id) {
    if (id) return runDetail(Number(id));
    const [runs, workflows] = await Promise.all([api("/api/runs"), api("/api/workflows")]);
    return `
      <h2>Workflow Runs</h2>
      <div class="card"><h4>Start a workflow without a work item</h4>
        <div class="grid3"><div><label>Workflow</label>${workflowSelect("nr-wf", workflows, "code-review")}</div>
        <div><label>Repositories (comma separated)</label><input ${keep("nr-repos")} value="${esc(drafts["nr-repos"] || "")}" placeholder="oms-api"></div>
        <div><label>Title</label><input ${keep("nr-title")} value="${esc(drafts["nr-title"] || "")}"></div></div>
        <label>Inputs (JSON, e.g. {"branch":"TASK-1","focus":"refund flow","project":"OMS"})</label><textarea class="code" rows="2" ${keep("nr-inputs")}>${esc(drafts["nr-inputs"] || "{}")}</textarea>
        <div class="row"><button onclick="A.newRun(true)">Start</button><button class="ghost" onclick="A.newRun(false)">Create (configure first)</button></div></div>
      ${runsTable(runs)}`;
  },

  // ------------------------------------------------ Questions inbox
  async questions() {
    const [open, history] = await Promise.all([api("/api/questions"), api("/api/questions/history")]);
    const byRun = {};
    for (const q of open) (byRun[q.run_id] ??= []).push(q);
    return `
      <h2>Questions Inbox</h2><div class="muted">Questions raised by workflow steps. Answering resumes the blocked step from its checkpoint.</div>
      ${
        open.length
          ? Object.entries(byRun)
              .map(
                ([runId, qs]) => `<div class="card"><div class="row" style="margin:0"><b><a href="#/runs/${runId}">Run #${runId}</a></b> ${esc(qs[0].run_title)} ${badge(qs[0].run_status)}</div>
              ${qs.map(questionForm).join("")}
              <div class="row"><button onclick="A.answer([${qs.map((q) => q.id).join(",")}])">Send answers & resume</button></div></div>`,
              )
              .join("")
          : `<div class="empty">No open questions 🎉</div>`
      }
      <h3>Answer history</h3>
      ${history.length ? `<table><tr><th>Run</th><th>Step</th><th>Question</th><th>Answer</th><th>Step now</th><th>When</th></tr>${history
        .map(
          (q) => `<tr><td><a href="#/runs/${q.run_id}">#${q.run_id}</a></td><td>${esc(q.step_name)}</td><td>${esc(q.question)}</td><td>${esc(q.answer)}</td><td>${badge(q.step_status)}</td><td class="muted">${time(q.answered_at)}</td></tr>`,
        )
        .join("")}</table>` : `<div class="empty">Nothing answered yet</div>`}`;
  },

  // ------------------------------------------------ Workflow library
  async workflows(key) {
    if (key) return workflowDetail(key);
    const wfs = await api("/api/workflows");
    const sample = JSON.stringify(
      { name: "My workflow", description: "", steps: [{ key: "analyze", type: "agent", config: { instructions: "…", output_contract: "{ summary }" } }, { key: "approve", type: "human_approval", depends_on: ["analyze"], config: { show_outputs: ["analyze"] } }] },
      null,
      2,
    );
    return `
      <h2>Workflow Library</h2><div class="muted">Reusable, versioned definitions. Runs are pinned to the version they started with.</div>
      <table style="margin-top:12px"><tr><th>Key</th><th>Name</th><th>Latest</th><th>Runs</th><th></th><th>Updated</th></tr>
      ${wfs
        .map(
          (w) => `<tr class="click" onclick="location.hash='/workflows/${w.key}'"><td class="mono">${esc(w.key)}</td><td>${esc(w.name)}<div class="muted small">${esc(w.description)}</div></td>
        <td>v${w.latest_version}${w.has_draft ? ' <span class="badge s-WAITING">draft</span>' : ""}</td><td>${w.run_count}</td><td>${w.is_template ? '<span class="badge s-PENDING">template</span>' : ""}</td><td class="muted">${time(w.updated_at)}</td></tr>`,
        )
        .join("")}</table>
      <div class="card" style="margin-top:14px"><h4>New workflow</h4>
        <div class="row"><input placeholder="key (lowercase-with-dashes)" ${keep("wf-key")} value="${esc(drafts["wf-key"] || "")}"></div>
        <label>Definition (JSON). Step types: ${esc((META?.stepTypes || []).join(", "))}</label>
        <textarea class="code" rows="12" ${keep("wf-spec")}>${esc(drafts["wf-spec"] || sample)}</textarea>
        <div class="row"><button class="ghost" onclick="A.validateSpec('wf-spec')">Validate</button><button onclick="A.createWorkflow()">Create & publish v1</button></div></div>`;
  },

  // ------------------------------------------------ Knowledge
  async knowledge(key) {
    if (key) return knowledgeDetail(key);
    const items = await api("/api/knowledge");
    const cats = META?.knowledgeCategories || [];
    const scopes = META?.knowledgeScopes || [];
    return `
      <h2>Knowledge</h2><div class="muted">Business rules, architecture guidelines, standards, security policies and agent skills. Resolved per step by scope precedence: ${esc(scopes.join(" < "))}.</div>
      <table style="margin-top:12px"><tr><th>Key</th><th>Title</th><th>Category</th><th>Scope</th><th>Conflict key</th><th>Version</th><th>Enabled</th></tr>
      ${items
        .map(
          (k) => `<tr class="click" onclick="location.hash='/knowledge/${k.key}'"><td class="mono">${esc(k.key)}</td><td>${esc(k.title)}</td><td>${esc(k.category)}</td>
        <td>${esc(k.scope_type)}${k.scope_ref ? `:<b>${esc(k.scope_ref)}</b>` : ""}${k.enforced ? ' <span class="badge s-FAILED">enforced</span>' : ""}</td><td class="mono">${esc(k.conflict_key || "")}</td>
        <td>v${k.current_version}</td><td>${k.enabled ? "✓" : '<span class="muted">off</span>'}</td></tr>`,
        )
        .join("")}</table>
      <div class="grid2" style="margin-top:14px">
        <div class="card"><h4>New knowledge item</h4>
          <div class="grid2"><div><label>Key</label><input ${keep("k-key")} value="${esc(drafts["k-key"] || "")}"></div><div><label>Title</label><input ${keep("k-title")} value="${esc(drafts["k-title"] || "")}"></div>
          <div><label>Category</label><select ${keep("k-cat")}>${cats.map((c) => `<option ${drafts["k-cat"] === c ? "selected" : ""}>${c}</option>`).join("")}</select></div>
          <div><label>Scope</label><select ${keep("k-scope")}>${scopes.map((c) => `<option ${drafts["k-scope"] === c ? "selected" : ""}>${c}</option>`).join("")}</select></div>
          <div><label>Scope ref (org / project / repo / workflow / workflow:step)</label><input ${keep("k-ref")} value="${esc(drafts["k-ref"] || "")}"></div>
          <div><label>Conflict key</label><input ${keep("k-ck")} value="${esc(drafts["k-ck"] || "")}"></div></div>
          <label>Content</label><textarea rows="4" ${keep("k-content")}>${esc(drafts["k-content"] || "")}</textarea>
          <label>Applicability (JSON: step_types, step_keys, repos, projects, workflows, keywords)</label><textarea class="code" rows="2" ${keep("k-app")}>${esc(drafts["k-app"] || "{}")}</textarea>
          <label>Metadata (skills: required_tools, output_contract)</label><textarea class="code" rows="2" ${keep("k-meta")}>${esc(drafts["k-meta"] || "{}")}</textarea>
          <div class="row"><label style="margin:0"><input type="checkbox" id="k-enf" style="width:auto"> enforced (cannot be overridden by narrower scopes)</label></div>
          <div class="row"><button onclick="A.createKnowledge()">Create</button></div></div>
        <div class="card"><h4>Preview resolution</h4><div class="muted small">Which items would a step receive?</div>
          <div class="grid2"><div><label>Workflow key</label><input ${keep("p-wf")} value="${esc(drafts["p-wf"] || "feature-implementation")}"></div><div><label>Step key</label><input ${keep("p-step")} value="${esc(drafts["p-step"] || "implement")}"></div>
          <div><label>Step type</label><input ${keep("p-type")} value="${esc(drafts["p-type"] || "coding_agent")}"></div><div><label>Project</label><input ${keep("p-proj")} value="${esc(drafts["p-proj"] || "OMS")}"></div>
          <div><label>Repositories</label><input ${keep("p-repos")} value="${esc(drafts["p-repos"] || "")}"></div><div><label>Request text</label><input ${keep("p-text")} value="${esc(drafts["p-text"] || "")}"></div></div>
          <div class="row"><button class="ghost" onclick="A.previewKnowledge()">Resolve</button></div><div id="preview"></div></div>
      </div>`;
  },

  // ------------------------------------------------ Repositories
  async repositories(name) {
    const repos = await api("/api/repositories");
    const r = name ? repos.find((x) => x.name === name) : null;
    return `
      <h2>Repositories</h2><div class="muted">Registry used for discovery and the deterministic allowed set. Agents never modify repositories outside a run's allowed set.</div>
      <table style="margin-top:12px"><tr><th>Name</th><th>Projects</th><th>Services</th><th>Tags</th><th>Allowed actions</th><th>Enabled</th><th>Description</th></tr>
      ${repos
        .map(
          (x) => `<tr class="click" onclick="location.hash='/repositories/${x.name}'"><td class="mono">${esc(x.name)}</td><td>${esc(x.projects.join(", "))}</td><td>${esc(x.services.join(", "))}</td>
        <td>${esc(x.tags.join(", "))}</td><td>${esc(x.allowed_actions.join(", "))}</td><td>${x.enabled ? "✓" : "off"}</td><td class="small">${esc(x.description)}</td></tr>`,
        )
        .join("")}</table>
      <div class="grid2" style="margin-top:14px">
        <div class="card"><h4>${r ? `Edit ${esc(r.name)}` : "Add / edit repository"}</h4>
          <div class="grid2"><div><label>Name (directory under reposRoot)</label><input id="r-name" value="${esc(r?.name || "")}"></div>
          <div><label>Projects</label><input id="r-projects" value="${esc(r?.projects.join(", ") || "")}"></div>
          <div><label>Services</label><input id="r-services" value="${esc(r?.services.join(", ") || "")}"></div>
          <div><label>Tags</label><input id="r-tags" value="${esc(r?.tags.join(", ") || "")}"></div>
          <div><label>Owners</label><input id="r-owners" value="${esc(r?.owners.join(", ") || "")}"></div>
          <div><label>Dependencies</label><input id="r-deps" value="${esc(r?.dependencies.join(", ") || "")}"></div>
          <div><label>Allowed actions (read, write, pull_request)</label><input id="r-actions" value="${esc(r?.allowed_actions.join(", ") || "read, write, pull_request")}"></div>
          <div><label>Enabled</label><select id="r-enabled"><option value="true" ${r?.enabled !== false ? "selected" : ""}>yes</option><option value="false" ${r?.enabled === false ? "selected" : ""}>no</option></select></div></div>
          <label>Description</label><textarea id="r-desc" rows="2">${esc(r?.description || "")}</textarea>
          <label>Architecture notes</label><textarea id="r-arch" rows="2">${esc(r?.architecture || "")}</textarea>
          <div class="row"><button onclick="A.saveRepo()">Save</button></div></div>
        <div class="card"><h4>Ranking preview</h4>
          <div class="row"><input placeholder="request text" ${keep("rk-text")} value="${esc(drafts["rk-text"] || "")}"><input placeholder="project" ${keep("rk-proj")} value="${esc(drafts["rk-proj"] || "")}" style="max-width:120px"><button class="ghost" onclick="A.rank()">Rank</button></div>
          <div id="rank"></div></div>
      </div>`;
  },
};

// ---------------------------------------------------------------- detail views

async function workItemDetail(id) {
  const [w, workflows] = await Promise.all([api(`/api/work-items/${id}`), api("/api/workflows")]);
  const legacy = w.legacy;
  return `
    <div class="muted small"><a href="#/work-items">Work items</a> /</div>
    <h2>${esc(w.title)}</h2>
    <div class="muted"><span class="mono">${esc(w.code)}</span> · ${esc(w.source)} · ${esc(w.project || "no project")} ${badge(w.status)}</div>
    <div class="grid2" style="margin-top:14px">
      <div class="card"><h4>Request</h4><div style="white-space:pre-wrap">${esc(w.description || "(no description)")}</div>
        ${w.payload && Object.keys(w.payload).length ? `<details data-k="payload"><summary>raw payload</summary>${json(w.payload)}</details>` : ""}</div>
      <div class="card"><h4>Actions</h4>
        <label>Workflow</label>${workflowSelect("wi-wf", workflows, "feature-implementation")}
        <label>Repositories (optional; otherwise discovered)</label><input ${keep("wi-repos")} value="${esc(drafts["wi-repos"] || "")}">
        <div class="row"><button onclick="A.startForItem(${w.id}, true)">Start run</button><button class="ghost" onclick="A.startForItem(${w.id}, false)">Create run (configure first)</button>
          <button class="ghost" onclick="A.analyze(${w.id})">Analyze only</button></div>
        <label>Automation policy</label>
        <div class="muted small">${w.automation_policy ? `Auto-starts <b>${esc(w.automation_policy.workflow)}</b> when imported by the poller.` : "None — nothing runs without an explicit action."}</div>
        <div class="row"><button class="ghost sm" onclick="A.setPolicy(${w.id}, true)">Use selected workflow as policy</button>${w.automation_policy ? `<button class="ghost sm" onclick="A.setPolicy(${w.id}, false)">Clear</button>` : ""}
          <select style="width:auto" onchange="A.setStatus(${w.id}, this.value)">${["open", "in_progress", "done", "archived"].map((s) => `<option ${s === w.status ? "selected" : ""}>${s}</option>`).join("")}</select></div>
      </div>
    </div>
    <h3>Execution history</h3>${runsTable(w.runs)}
    ${w.pull_requests.length ? `<h3>Pull requests</h3>${prTable(w.pull_requests)}` : ""}
    ${
      legacy && (legacy.questions.length || legacy.events.length)
        ? `<h3>Legacy history (before workflows)</h3><div class="card">
      ${legacy.questions.map((q) => `<div class="q"><b>${esc(q.question)}</b><div class="muted">→ ${esc(q.answer ?? "(unanswered)")}</div></div>`).join("")}
      <details data-k="legacy-ev"><summary>${legacy.events.length} events</summary>${legacy.events.map((e) => `<div class="ev ${e.kind}"><time class="muted">${time(e.created_at)}</time><span class="s"></span><span class="k muted">${esc(e.kind)}</span><span class="c">${esc(e.content)}</span></div>`).join("")}</details></div>`
        : ""
    }`;
}

function prTable(prs) {
  return `<table><tr><th>Repo</th><th>PR</th><th>Branch</th><th></th><th>Updated</th></tr>${prs
    .map(
      (p) => `<tr><td>${esc(p.repo)}</td><td><a href="${esc(p.url)}" target="_blank" rel="noopener">${esc(p.title)}</a>${p.decisions?.length ? `<details><summary>${p.decisions.length} decisions</summary><ul>${p.decisions.map((d) => `<li><b>${esc(d.title)}</b>: ${esc(d.detail)}</li>`).join("")}</ul></details>` : ""}</td>
      <td class="mono">${esc(p.source_branch)} → ${esc(p.target_branch)}</td><td>${p.draft ? '<span class="badge s-PENDING">draft</span>' : ""}${p.created ? "" : ' <span class="badge s-WAITING">link only</span>'}</td><td class="muted">${time(p.updated_at)}</td></tr>`,
    )
    .join("")}</table>`;
}

function questionForm(q) {
  const id = "ans-" + q.id;
  return `<div class="q"><div><b>${esc(q.question)}</b> <span class="muted small">${esc(q.step_name || q.step_key || "")}</span></div>
    ${q.context ? `<div class="muted small" style="white-space:pre-wrap">${esc(q.context)}</div>` : ""}
    <div class="row">${(q.options || []).map((o) => `<button class="ghost sm" onclick="A.pickOption(${q.id}, this.dataset.v)" data-v="${esc(o)}">${esc(o)}</button>`).join("")}</div>
    <textarea rows="2" ${keep(id)} placeholder="${esc(q.suggested_answer ? "Suggested: " + q.suggested_answer : "Answer…")}">${esc(drafts[id] || "")}</textarea></div>`;
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
  if (gate) body = `<div class="muted">Approval gate: this step will run only after approval.</div>`;
  if (req) {
    body += req.message ? `<div><b>${esc(req.message)}</b></div>` : "";
    if (req.select_repositories) {
      body += `<div class="muted small">${req.ambiguous ? "⚠️ Ambiguous recommendation — please choose." : "Recommendation:"}</div>
        ${(req.candidates || [])
          .map(
            (c) => `<label style="display:flex;gap:8px;align-items:flex-start;color:inherit;font-size:13px"><input type="checkbox" style="width:auto" name="repo-${s.key}" value="${esc(c.repo)}" ${(req.recommended || []).includes(c.repo) ? "checked" : ""}>
            <span><b>${esc(c.repo)}</b> <span class="muted">score ${c.score}</span><br><span class="muted small">${esc((c.reasons || []).join(" · "))}</span></span></label>`,
          )
          .join("")}
        <div class="muted small">Allowed: ${esc((req.allowed || run.allowed_repositories).join(", "))}</div>`;
    }
    for (const [k, v] of Object.entries(req.outputs || {})) body += `<details data-k="appr-${s.key}-${k}" open><summary>output of ${esc(k)}</summary>${json(v)}</details>`;
  }
  return `<div class="card" style="background:var(--bg)">${body}
    <textarea rows="2" ${keep("cmt-" + s.key)} placeholder="Comment / feedback">${esc(drafts["cmt-" + s.key] || "")}</textarea>
    <div class="row"><button class="ok" onclick="A.approve(${run.id}, '${s.key}')">Approve</button>
      <button class="danger" onclick="A.reject(${run.id}, '${s.key}')">Reject${s.config?.on_reject?.reexecute ? ` → redo ${esc(s.config.on_reject.reexecute)}` : ""}</button></div></div>`;
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
    <div class="muted small"><a href="#/runs">Runs</a> / ${r.work_item ? `<a href="#/work-items/${r.work_item.id}">${esc(r.work_item.code)}</a>` : "no work item"}</div>
    <h2>Run #${r.id} · ${esc(r.title)}</h2>
    <div class="muted">${esc(r.definition_key)} v${r.definition_version} · branch <span class="mono">${esc(r.branch)}</span> · ${badge(r.status)} ${r.error ? `<span class="err">${esc(r.error)}</span>` : ""}</div>
    <div class="row">
      ${r.status === "PENDING" ? `<button onclick="A.runAction(${r.id}, 'start')">Start</button>` : ""}
      ${["RUNNING", "WAITING"].includes(r.status) ? `<button class="ghost" onclick="A.runAction(${r.id}, 'pause')">Pause</button>` : ""}
      ${r.status === "PAUSED" ? `<button onclick="A.runAction(${r.id}, 'resume')">Resume</button>` : ""}
      ${active && !["COMPLETED"].includes(r.status) ? `<button class="danger" onclick="A.runAction(${r.id}, 'cancel')">Cancel</button>` : ""}
    </div>
    <div class="card" style="margin-top:12px"><b>Repositories</b> · selected: <b>${esc(r.selected_repositories.join(", ") || "(none yet)")}</b>
      <span class="muted small"> · allowed: ${esc(r.allowed_repositories.join(", "))}</span>
      ${["PENDING", "PAUSED"].includes(r.status) ? `<div class="row"><input ${keep("sel-repos")} value="${esc(drafts["sel-repos"] ?? r.selected_repositories.join(", "))}"><button class="ghost" onclick="A.setRepos(${r.id})">Set</button></div>` : ""}
    </div>
    <div class="graph">${r.steps
      .map((s, i) => `${i ? '<span class="arrow">→</span>' : ""}<span class="node s-${s.status}" title="${esc(s.type)} · depends on ${esc(s.depends_on.join(", ") || "-")}" onclick="document.getElementById('step-${s.key}').scrollIntoView({behavior:'smooth'})">${esc(s.name)}</span>`)
      .join("")}</div>
    ${r.steps
      .map((s) => {
        const atts = attempts[s.key] || [];
        const qs = questions[s.key] || [];
        const open = qs.filter((q) => q.status === "open");
        const can = (a) => RUN_ACTIONS[a].includes(s.status) && active;
        return `<div class="card step st-${s.status}" id="step-${s.key}">
          <div class="step-head"><b>${esc(s.name)}</b><span class="type">${esc(s.key)} · ${esc(s.type)}</span>${badge(s.status)}
            <span class="muted small">gen ${s.generation} · ${atts.length} attempt(s)${s.requires_approval ? " · approval gate" : ""}${s.run_if ? ` · run_if ${esc(s.run_if.step)}=${esc(JSON.stringify(s.run_if.equals))}` : ""}</span>
            <span style="flex:1"></span>
            ${can("retry") ? `<button class="sm warn" onclick="A.stepAction(${r.id}, '${s.key}', 'retry')">Retry</button>` : ""}
            ${can("reexecute") ? `<button class="sm ghost" onclick="A.stepAction(${r.id}, '${s.key}', 'reexecute')">Re-execute from here</button>` : ""}
            ${can("skip") ? `<button class="sm ghost" onclick="A.stepAction(${r.id}, '${s.key}', 'skip')">Skip</button>` : ""}
          </div>
          ${s.error ? `<div class="err small">${esc(s.error)}</div>` : ""}
          ${open.length ? open.map((q) => questionForm({ ...q, step_name: "" })).join("") + `<div class="row"><button onclick="A.answer([${open.map((q) => q.id).join(",")}])">Send answers & resume</button></div>` : ""}
          ${s.status === "WAITING_APPROVAL" ? approvalPanel(r, s) : ""}
          ${s.output != null ? `<details data-k="out-${s.key}"><summary>output</summary>${json(s.output)}</details>` : ""}
          ${(artifacts[s.id] || []).length ? `<div class="row small">${artifacts[s.id].map((a) => `<button class="ghost sm" onclick="A.artifact(${a.id})">📎 ${esc(a.name)}</button>`).join("")}</div>` : ""}
          ${qs.filter((q) => q.status !== "open").length ? `<details data-k="qa-${s.key}"><summary>${qs.filter((q) => q.status !== "open").length} earlier question(s)</summary>${qs.filter((q) => q.status !== "open").map((q) => `<div class="q"><b>${esc(q.question)}</b> ${badge(q.status)}<div class="muted">→ ${esc(q.answer ?? "")}</div></div>`).join("")}</details>` : ""}
          ${atts.length ? `<details data-k="att-${s.key}"><summary>attempt history</summary><table><tr><th>#</th><th>Gen</th><th>Status</th><th>Started</th><th>Finished</th><th>Context</th><th>Session</th><th>Error</th></tr>${atts
            .map(
              (a) => `<tr${a.invalidated_at ? ' class="muted"' : ""}><td>${a.number}</td><td>${a.generation}</td><td>${badge(a.status)}${a.invalidated_at ? ' <span class="small">invalidated</span>' : ""}</td><td>${time(a.started_at)}</td><td>${time(a.finished_at)}</td>
              <td>${a.context_snapshot_id ? `<button class="ghost sm" onclick="A.snapshot(${a.context_snapshot_id})">snapshot</button>` : ""}</td><td class="mono small">${esc((a.agent_session_id || "").slice(0, 8))}</td>
              <td class="err small">${esc(a.error?.message || "")}</td></tr>`,
            )
            .join("")}</table></details>` : ""}
        </div>`;
      })
      .join("")}
    <div id="modal"></div>
    ${r.pull_requests.length ? `<h3>Pull requests</h3>${prTable(r.pull_requests)}` : ""}
    ${active && (r.graph.feedback_step || r.steps.some((s) => s.type === "coding_agent")) ? `<h3>Feedback for the agent (re-runs the feedback step; tests and PR follow)</h3>
      <textarea rows="3" ${keep("fb")}>${esc(drafts.fb || "")}</textarea><div class="row"><button onclick="A.feedback(${r.id})">Send feedback</button></div>` : ""}
    <h3>Timeline</h3>
    ${events
      .slice()
      .reverse()
      .slice(0, 400)
      .map((e) => `<div class="ev ${e.kind}"><time class="muted">${time(e.created_at)}</time><span class="s mono small muted">${esc(e.step_key || "run")}</span><span class="k muted">${esc(e.kind)}</span><span class="c">${esc(e.content)}</span></div>`)
      .join("")}`;
}

async function workflowDetail(key) {
  const w = await api(`/api/workflows/${key}`);
  const latest = w.versions[0];
  const spec = w.draft_spec ?? latest?.spec;
  const id = "spec-" + key;
  return `
    <div class="muted small"><a href="#/workflows">Workflows</a> /</div>
    <h2>${esc(w.name)}</h2><div class="muted"><span class="mono">${esc(w.key)}</span> · latest v${w.latest_version}${w.draft_spec ? ' · <span class="badge s-WAITING">unpublished draft</span>' : ""}</div>
    <div class="muted">${esc(w.description)}</div>
    ${spec ? `<div class="graph">${spec.steps.map((s, i) => `${i ? '<span class="arrow">→</span>' : ""}<span class="node" title="${esc(s.type)} · after ${esc((s.depends_on || []).join(", ") || "-")}">${esc(s.name || s.key)} <span class="muted small">${esc(s.type)}</span></span>`).join("")}</div>` : ""}
    <div class="card"><h4>Steps</h4><table><tr><th>Key</th><th>Type</th><th>Depends on</th><th>Options</th></tr>${(spec?.steps || [])
      .map((s) => `<tr><td class="mono">${esc(s.key)}</td><td>${esc(s.type)}</td><td>${esc((s.depends_on || []).join(", "))}</td><td class="small">${[s.requires_approval ? "approval gate" : "", s.max_attempts > 1 ? `max ${s.max_attempts} attempts` : "", s.run_if ? "run_if" : "", (s.config?.skills || []).length ? "skills: " + s.config.skills.join(", ") : ""].filter(Boolean).join(" · ")}</td></tr>`)
      .join("")}</table></div>
    <div class="card"><h4>Edit definition</h4><div class="muted small">Saving creates a draft; running runs are unaffected. Publishing freezes it as v${w.latest_version + 1}.</div>
      <textarea class="code" rows="22" ${keep(id)}>${esc(drafts[id] ?? JSON.stringify(spec, null, 2))}</textarea>
      <div class="row"><button class="ghost" onclick="A.validateSpec('${id}')">Validate</button><button class="ghost" onclick="A.saveDraft('${key}')">Save draft</button>
        <input placeholder="change note" ${keep("note-" + key)} style="max-width:260px"><button onclick="A.publish('${key}')">Publish new version</button>
        <button class="ghost" onclick="location.hash='/runs'; drafts['nr-wf']='${key}'">Start a run…</button></div></div>
    <h3>Versions</h3><table><tr><th>Version</th><th>Published</th><th>Note</th><th>Hash</th></tr>${w.versions
      .map((v) => `<tr><td>v${v.version}</td><td>${time(v.published_at)}</td><td>${esc(v.change_note)}</td><td class="mono small">${esc(v.spec_hash.slice(0, 12))}</td></tr>`)
      .join("")}</table>`;
}

async function knowledgeDetail(key) {
  const k = await api(`/api/knowledge/${key}`);
  const cur = k.versions[0];
  return `
    <div class="muted small"><a href="#/knowledge">Knowledge</a> /</div>
    <h2>${esc(k.title)}</h2>
    <div class="muted"><span class="mono">${esc(k.key)}</span> · ${esc(k.category)} · ${esc(k.scope_type)}${k.scope_ref ? ":" + esc(k.scope_ref) : ""} · v${k.current_version} ${k.enforced ? '<span class="badge s-FAILED">enforced</span>' : ""} ${k.enabled ? badge("COMPLETED").replace("COMPLETED", "enabled") : badge("CANCELED").replace("CANCELED", "disabled")}</div>
    <div class="card" style="margin-top:12px"><h4>Edit (content changes create a new version)</h4>
      <div class="grid3"><div><label>Title</label><input id="ke-title" value="${esc(k.title)}"></div><div><label>Scope</label><select id="ke-scope">${(META?.knowledgeScopes || []).map((s) => `<option ${s === k.scope_type ? "selected" : ""}>${s}</option>`).join("")}</select></div>
      <div><label>Scope ref</label><input id="ke-ref" value="${esc(k.scope_ref)}"></div><div><label>Conflict key</label><input id="ke-ck" value="${esc(k.conflict_key || "")}"></div><div><label>Priority</label><input id="ke-prio" type="number" value="${k.priority}"></div>
      <div><label>Enabled</label><select id="ke-enabled"><option value="true" ${k.enabled ? "selected" : ""}>yes</option><option value="false" ${!k.enabled ? "selected" : ""}>no</option></select></div></div>
      <label>Content</label><textarea id="ke-content" rows="6">${esc(cur?.content || "")}</textarea>
      <div class="grid2"><div><label>Applicability</label><textarea id="ke-app" class="code" rows="3">${esc(JSON.stringify(cur?.applicability || {}, null, 2))}</textarea></div>
      <div><label>Metadata</label><textarea id="ke-meta" class="code" rows="3">${esc(JSON.stringify(cur?.metadata || {}, null, 2))}</textarea></div></div>
      <div class="row"><input id="ke-note" placeholder="change note"><button onclick="A.updateKnowledge('${k.key}')">Save</button></div></div>
    <h3>Versions</h3>${k.versions.map((v) => `<details data-k="kv-${v.version}"><summary>v${v.version} · ${time(v.created_at)} · ${esc(v.change_note)}</summary><div class="card"><div style="white-space:pre-wrap">${esc(v.content)}</div>${json({ applicability: v.applicability, metadata: v.metadata })}</div></details>`).join("")}
    <h3>Audit</h3>${k.audit.map((a) => `<div class="small"><span class="muted">${time(a.created_at)}</span> <b>${esc(a.action)}</b> <span class="mono">${esc(JSON.stringify(a.detail))}</span></div>`).join("")}`;
}

// ---------------------------------------------------------------- actions

const parseJson = (s, what) => {
  try {
    return JSON.parse(s || "{}");
  } catch {
    throw new Error(`${what}: invalid JSON`);
  }
};

window.drafts = drafts;
window.A = {
  createWorkItem: () =>
    act(async () => {
      const w = await api("/api/work-items", { title: val("wi-title"), project: val("wi-project"), description: val("wi-desc") });
      ["wi-title", "wi-project", "wi-desc"].forEach((k) => delete drafts[k]);
      location.hash = "/work-items/" + w.id;
    }),
  importJson: (source) =>
    act(async () => {
      const r = await api("/api/work-items/import", { source, payload: parseJson(val("wi-json"), "payload") });
      delete drafts["wi-json"];
      location.hash = "/work-items/" + (r.item?.id ?? r.work_item_id);
    }, "Imported — nothing was executed"),
  importJiraKey: () => act(async () => {
    const r = await api("/api/work-items/import", { source: "jira", key: val("jira-key") });
    location.hash = "/work-items/" + r.item.id;
  }),
  importHasakiId: () =>
    act(async () => {
      const r = await api("/api/work-items/import", { source: "hasaki_work", work_id: Number(val("hw-id")) });
      delete drafts["hw-id"];
      location.hash = "/work-items/" + r.work_item_id;
    }, "Imported — chọn workflow để chạy"),
  openLogin: () => act(() => api("/api/work/login-window", {})),
  saveToken: () => act(() => api("/api/work/token", { token: val("tok") })),
  refreshInbox: (btn) => {
    btn.disabled = true;
    btn.textContent = "…";
    return act(async () => {
      const r = await api("/api/work/refresh", {});
      toast(r.count + " task", true);
    });
  },
  pick: (id, btn) => {
    btn.disabled = true;
    return act(async () => {
      const r = await api("/api/work/pick/" + id, {});
      location.hash = "/work-items/" + r.work_item_id;
    }, "Imported — choose a workflow to run");
  },
  startForItem: (id, start) =>
    act(async () => {
      const repos = list(val("wi-repos"));
      const r = await api(`/api/work-items/${id}/runs`, { workflow: val("wi-wf") || "feature-implementation", repositories: repos.length ? repos : undefined, start });
      location.hash = "/runs/" + r.id;
    }),
  analyze: (id) => act(async () => (location.hash = "/runs/" + (await api(`/api/work-items/${id}/analyze`, {})).id)),
  setPolicy: (id, on) => act(() => api(`/api/work-items/${id}`, { automation_policy: on ? { workflow: val("wi-wf") } : null }), "Saved"),
  setStatus: (id, status) => act(() => api(`/api/work-items/${id}`, { status })),
  newRun: (start) =>
    act(async () => {
      const repos = list(val("nr-repos"));
      const r = await api("/api/runs", { workflow: val("nr-wf"), repositories: repos, title: val("nr-title") || undefined, inputs: { ...parseJson(val("nr-inputs"), "inputs"), ...(repos.length ? { repositories: repos } : {}) }, start });
      location.hash = "/runs/" + r.id;
    }),
  runAction: (id, action) => {
    if (action === "cancel" && !confirm("Cancel this run? Running steps are stopped.")) return;
    return act(() => api(`/api/runs/${id}/${action}`, {}));
  },
  setRepos: (id) => act(() => api(`/api/runs/${id}/repositories`, { repositories: list(val("sel-repos")) }), "Repositories updated"),
  stepAction: (id, key, action) => {
    let body = {};
    if (action === "reexecute") {
      const fb = prompt("Re-execute this step and invalidate everything downstream.\nOptional feedback for the step:");
      if (fb === null) return;
      body = fb ? { feedback: fb } : {};
    }
    if (action === "skip" && !confirm("Skip this step?")) return;
    return act(() => api(`/api/runs/${id}/steps/${key}/${action}`, body));
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
      toast(r.resumed.length ? `Resumed: ${r.resumed.join(", ")}` : `${r.stillOpen} question(s) still open`, true);
    }),
  approve: (id, key) =>
    act(async () => {
      const boxes = $$(`input[name="repo-${key}"]`);
      await api(`/api/runs/${id}/steps/${key}/approve`, { comment: val("cmt-" + key), repositories: boxes.length ? boxes.filter((b) => b.checked).map((b) => b.value) : undefined });
      delete drafts["cmt-" + key];
    }, "Approved"),
  reject: (id, key) =>
    act(async () => {
      await api(`/api/runs/${id}/steps/${key}/reject`, { comment: val("cmt-" + key) });
      delete drafts["cmt-" + key];
    }, "Rejected"),
  feedback: (id) =>
    act(async () => {
      await api(`/api/runs/${id}/feedback`, { message: val("fb") });
      delete drafts.fb;
    }, "Feedback sent"),
  artifact: async (id) => {
    const a = await api(`/api/artifacts/${id}`);
    $("#modal").innerHTML = `<div class="card"><div class="row" style="margin:0"><b>${esc(a.name)}</b><span style="flex:1"></span><button class="ghost sm" onclick="this.closest('.card').remove()">Close</button></div><pre>${esc(a.content)}</pre>${a.data ? json(a.data) : ""}</div>`;
    $("#modal").scrollIntoView({ behavior: "smooth" });
  },
  snapshot: async (id) => {
    const s = await api(`/api/snapshots/${id}`);
    const c = s.content;
    $("#modal").innerHTML = `<div class="card"><div class="row" style="margin:0"><b>Context snapshot #${s.id}</b> <span class="mono muted small">${esc(s.hash.slice(0, 16))}</span><span style="flex:1"></span><button class="ghost sm" onclick="this.closest('.card').remove()">Close</button></div>
      <div class="small">Step ${esc(c.step.key)} gen ${c.step.generation} · project ${esc(c.project || "-")} · repos ${esc(c.repositories.join(", ") || "-")}</div>
      <h4 style="margin-top:8px">Applied knowledge</h4>${c.knowledge.map((k) => `<div class="small">• <b>${esc(k.key)}</b> v${k.version} <span class="muted">${esc(k.category)} · ${esc(k.reason)}</span></div>`).join("") || '<div class="muted small">none</div>'}
      ${c.overridden.length ? `<h4 style="margin-top:8px">Overridden</h4>${c.overridden.map((o) => `<div class="small">• ${esc(o.key)} v${o.version} by ${esc(o.by)} <span class="muted">(${esc(o.conflict_key)})</span></div>`).join("")}` : ""}
      <details><summary>raw</summary>${json(c)}</details></div>`;
    $("#modal").scrollIntoView({ behavior: "smooth" });
  },
  validateSpec: (id) =>
    act(async () => {
      const r = await api("/api/workflows/validate", { spec: parseJson(val(id), "definition") });
      toast(r.valid ? "Valid ✓" : r.errors.join("\n"), r.valid);
    }),
  createWorkflow: () =>
    act(async () => {
      await api("/api/workflows", { key: val("wf-key"), spec: parseJson(val("wf-spec"), "definition") });
      location.hash = "/workflows/" + val("wf-key");
      delete drafts["wf-key"];
      delete drafts["wf-spec"];
    }, "Created v1"),
  saveDraft: (key) => act(() => api(`/api/workflows/${key}/draft`, { spec: parseJson(val("spec-" + key), "definition") }), "Draft saved"),
  publish: (key) =>
    act(async () => {
      await api(`/api/workflows/${key}/draft`, { spec: parseJson(val("spec-" + key), "definition") });
      const r = await api(`/api/workflows/${key}/publish`, { change_note: val("note-" + key) });
      delete drafts["spec-" + key];
      toast(r.unchanged ? "No changes since the latest version" : `Published v${r.version}`, true);
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
      ["k-key", "k-title", "k-ref", "k-ck", "k-content", "k-app", "k-meta"].forEach((x) => delete drafts[x]);
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
      "Saved",
    ),
  previewKnowledge: async () => {
    try {
      const r = await api("/api/knowledge/preview", { workflow: val("p-wf"), step: val("p-step"), step_type: val("p-type"), project: val("p-proj"), repositories: list(val("p-repos")), text: val("p-text") });
      $("#preview").innerHTML =
        r.applied.map((k) => `<div class="small">✓ <b>${esc(k.key)}</b> v${k.version} <span class="muted">${esc(k.category)} · ${esc(k.reason)}</span></div>`).join("") +
        r.overridden.map((o) => `<div class="small muted">✗ ${esc(o.key)} overridden by ${esc(o.by)} (${esc(o.conflict_key)})</div>`).join("");
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
    }, "Saved"),
  rank: async () => {
    try {
      const r = await api("/api/repositories/rank", { text: val("rk-text"), project: val("rk-proj") });
      $("#rank").innerHTML =
        (r.ambiguous ? `<div class="small" style="color:var(--warn)">⚠️ ambiguous</div>` : "") +
        r.ranked.map((x) => `<div class="small"><b>${esc(x.repo)}</b> ${x.score} <span class="muted">${esc(x.reasons.join(" · "))}</span></div>`).join("");
    } catch (e) {
      toast(e.message);
    }
  },
};

(async () => {
  META = await api("/api/meta").catch(() => null);
  await render(true);
  setInterval(() => render(false), 3000);
})();
