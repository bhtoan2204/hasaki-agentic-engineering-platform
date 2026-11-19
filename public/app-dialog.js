/**
 * Lightweight Promise-based dialogs for the classic (non-React) UI.
 * Mirrors the React dialog API used by the Vite app — no native alert/confirm/prompt.
 */
(function (global) {
  "use strict";

  const queue = [];
  let current = null;
  let root = null;

  function ensureRoot() {
    if (root) return root;
    root = document.createElement("div");
    root.id = "app-dialog-root";
    document.body.appendChild(root);
    return root;
  }

  function settle(value) {
    const req = current;
    current = null;
    if (root) root.innerHTML = "";
    if (req) req.resolve(value);
    if (queue.length) show(queue.shift());
  }

  function show(req) {
    current = req;
    const host = ensureRoot();
    const dlg = document.createElement("dialog");
    dlg.className = "ui-dialog app-dialog app-dialog-" + (req.variant || "default");
    dlg.setAttribute("role", req.variant === "destructive" || req.kind === "alert" ? "alertdialog" : "dialog");
    dlg.setAttribute("aria-labelledby", "app-dlg-title");
    if (req.description) dlg.setAttribute("aria-describedby", "app-dlg-desc");

    const title = document.createElement("h2");
    title.id = "app-dlg-title";
    title.className = "app-dialog-title";
    title.textContent = req.title;

    const body = document.createElement("form");
    body.className = "app-dialog-body";
    body.appendChild(title);

    if (req.description) {
      const p = document.createElement("p");
      p.id = "app-dlg-desc";
      p.className = "app-dialog-desc";
      p.textContent = req.description;
      body.appendChild(p);
    }

    let input = null;
    if (req.kind === "prompt") {
      const label = document.createElement("label");
      label.className = "app-dialog-field";
      if (req.label) {
        const span = document.createElement("span");
        span.textContent = req.label;
        label.appendChild(span);
      }
      input = document.createElement("input");
      input.className = "app-dialog-input";
      input.value = req.defaultValue || "";
      input.placeholder = req.placeholder || "";
      input.autocomplete = "off";
      label.appendChild(input);
      body.appendChild(label);
    }

    const actions = document.createElement("div");
    actions.className = "app-dialog-actions";
    if (req.kind !== "alert") {
      const cancel = document.createElement("button");
      cancel.type = "button";
      cancel.className = "quiet app-dialog-cancel";
      cancel.textContent =
        req.cancelLabel || (global.tr ? global.tr("common.cancel") : "Cancel");
      cancel.onclick = () => settle(req.kind === "prompt" ? null : false);
      actions.appendChild(cancel);
    }
    const confirmBtn = document.createElement("button");
    confirmBtn.type = "submit";
    confirmBtn.className =
      "app-dialog-confirm" + (req.variant === "destructive" ? " danger" : "");
    confirmBtn.textContent =
      req.confirmLabel ||
      (req.kind === "alert"
        ? (global.tr ? global.tr("common.ok") : "OK")
        : (global.tr ? global.tr("common.confirm") : "Confirm"));
    actions.appendChild(confirmBtn);
    body.appendChild(actions);

    body.onsubmit = (e) => {
      e.preventDefault();
      if (req.kind === "prompt") {
        const value = input ? input.value : "";
        if (req.required !== false && !String(value).trim()) {
          input?.focus();
          return;
        }
        settle(value);
      } else if (req.kind === "confirm") settle(true);
      else settle(undefined);
    };

    dlg.appendChild(body);
    host.appendChild(dlg);
    dlg.addEventListener("cancel", (e) => {
      e.preventDefault();
      settle(req.kind === "prompt" ? null : req.kind === "confirm" ? false : undefined);
    });
    dlg.showModal();
    const preferCancel = req.variant === "destructive" && req.kind === "confirm";
    const focusEl = req.kind === "prompt" ? input : preferCancel ? body.querySelector(".app-dialog-cancel") : confirmBtn;
    (focusEl || dlg).focus();
  }

  function enqueue(req) {
    return new Promise((resolve) => {
      const item = { ...req, resolve };
      if (!current) show(item);
      else queue.push(item);
    });
  }

  global.appDialog = {
    confirm(opts) {
      return enqueue({ kind: "confirm", ...opts });
    },
    alert(opts) {
      return enqueue({ kind: "alert", ...opts });
    },
    prompt(opts) {
      return enqueue({ kind: "prompt", required: false, ...opts });
    },
  };

  // Minimal styles when React CSS is not loaded (classic shell).
  const style = document.createElement("style");
  style.textContent = `
#app-dialog-root dialog.app-dialog {
  border: 1px solid #d4d4d8; border-radius: 12px; padding: 0;
  width: min(440px, calc(100vw - 32px)); max-width: calc(100vw - 32px);
  color: inherit; background: #fff; box-shadow: 0 12px 40px rgba(0,0,0,.18);
}
#app-dialog-root dialog.app-dialog::backdrop { background: rgba(0,0,0,.45); }
#app-dialog-root .app-dialog-body { display:flex; flex-direction:column; gap:14px; padding:20px; }
#app-dialog-root .app-dialog-title { margin:0; font-size:1.05rem; font-weight:650; }
#app-dialog-root .app-dialog-desc { margin:0; color:#71717a; white-space:pre-wrap; overflow-wrap:anywhere; }
#app-dialog-root .app-dialog-field { display:flex; flex-direction:column; gap:6px; }
#app-dialog-root .app-dialog-actions { display:flex; justify-content:flex-end; gap:8px; flex-wrap:wrap; }
#app-dialog-root .app-dialog-confirm.danger { background:#dc2626; border-color:#dc2626; color:#fff; }
@media (prefers-color-scheme: dark) {
  #app-dialog-root dialog.app-dialog { background:#18181b; border-color:#3f3f46; color:#fafafa; }
  #app-dialog-root .app-dialog-desc { color:#a1a1aa; }
}
`;
  document.head.appendChild(style);
})(typeof window !== "undefined" ? window : globalThis);
