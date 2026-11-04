import { useEffect, useState } from "react";
import { api, useApi } from "../api.ts";
import { AlertTriangle, ExternalLink, FileCode2, FileDiff, FolderGit2, GitBranch, GitCommitHorizontal, GitPullRequest, Hand, ListChecks, ShieldCheck, X } from "lucide-react";
import { act, Badge, Copy, Empty, ErrorBox, Loading, Markdown, navigate } from "../ui.tsx";
import { OutputView } from "./StepInspector.tsx";
import "./RunView.css";

function Diff({ text }: { text: string }) {
  if (!text.trim()) return <div className="muted small" style={{ padding: "8px 0" }}>(không có diff)</div>;
  return (
    <div className="diff">
      {text.split("\n").map((l, i) => {
        const cls = l.startsWith("diff --git") ? "file" : l.startsWith("@@") ? "hunk" : l.startsWith("+") && !l.startsWith("+++") ? "add" : l.startsWith("-") && !l.startsWith("---") ? "del" : "";
        return <div key={i} className={cls}>{l || " "}</div>;
      })}
    </div>
  );
}

/** Split a unified diff into per-file chunks so a file can be shown on its own. */
function fileDiff(diff: string, path: string) {
  const parts = diff.split(/^(?=diff --git )/m);
  return parts.find((p) => p.startsWith("diff --git") && (p.includes(` b/${path}\n`) || p.includes(` b/${path}`))) ?? "";
}

/** Review a run's git changes and the exact PR content before the PR step runs. */
export function Changes({ run, tick, onChanged }: { run: any; tick: number; onChanged: () => void }) {
  const { data, error, loading, reload } = useApi<any>(`/api/runs/${run.id}/changes`);
  const [file, setFile] = useState<Record<string, string | null>>({});
  useEffect(() => void reload(), [tick]); // eslint-disable-line react-hooks/exhaustive-deps
  if (loading && !data) return <Loading />;
  if (error) return <ErrorBox error={error} onRetry={reload} />;
  const prWaiting = data.pr_step?.status === "WAITING_APPROVAL";
  return (
    <div>
      <div className="si-top">
        <span className="si-icon"><FileDiff size={20} /></span>
        <div className="si-title">
          <h2>Changes & PR preview</h2>
          <div className="si-meta">
            <span style={{ display: "inline-flex", gap: 4, alignItems: "center" }}><GitBranch size={12} /><span className="mono">{data.branch}</span></span>
            {data.pr_step && <span style={{ display: "inline-flex", gap: 6, alignItems: "center" }}>PR step <b className="mono">{data.pr_step.key}</b> (mode {data.pr_step.mode}) <Badge s={data.pr_step.status} label /></span>}
          </div>
        </div>
        <button className="quiet icon" aria-label="Đóng" title="Đóng" onClick={() => navigate(`/runs/${run.id}`)}><X size={18} /></button>
      </div>
      {prWaiting && (
        <section className="rv-attn" aria-label="PR chờ duyệt">
          <div className="rv-attn-head">
            <span className="rv-attn-icon"><Hand size={20} /></span>
            <div style={{ flex: 1, minWidth: 0 }}>
              <h4>PR step đang chờ duyệt</h4>
              <div className="rv-attn-sub">Xem thay đổi bên dưới rồi duyệt để push và mở/cập nhật PR trên Bitbucket.</div>
            </div>
          </div>
          <div className="rv-attn-actions">
            <button className="ok big" onClick={async () => (await act(() => api(`/api/runs/${run.id}/steps/${data.pr_step.key}/approve`, {}), "PR step approved")) && (onChanged(), reload())}><ShieldCheck size={16} /> Approve & create PR</button>
            <button className="ghost" onClick={() => navigate(`/runs/${run.id}/${data.pr_step.key}`)}>Mở bước PR</button>
          </div>
        </section>
      )}
      {!data.repos.length && <Empty>Run này chưa có workspace nào (chưa có bước code nào chạy).</Empty>}
      {data.repos.map((r: any) => (
        <div key={r.repo} className="rv-card" style={{ marginTop: 14 }}>
          <div className="ch-repo-head">
            <h4><FolderGit2 size={16} color="var(--brand)" /> {r.repo}</h4>
            <span className="ch-branch"><GitBranch size={11} />{r.branch} → {r.pr_preview?.target}</span>
          </div>
          {!r.exists ? (
            <div className="err small" style={{ marginTop: 6 }}>Worktree không còn tồn tại: {r.path}</div>
          ) : (
            <>
              <div className="muted small mono" style={{ marginTop: 4, overflowWrap: "anywhere" }}>{r.path}</div>
              {r.status && (
                <div className="errorbox small">
                  <AlertTriangle size={13} style={{ verticalAlign: -2, color: "var(--st-err)" }} /> <b>Có thay đổi chưa commit</b> — PR step sẽ từ chối push:
                  <pre>{r.status}</pre>
                  <details><summary>uncommitted diff</summary><Diff text={r.uncommitted_diff} /></details>
                </div>
              )}
              <div className="rv-sec-title" style={{ marginTop: 16 }}><GitCommitHorizontal size={14} /> Commits ({r.commits.length})</div>
              {r.commits.length ? r.commits.map((c: any) => (
                <div key={c.hash} className="ch-commit"><span className="mono">{c.hash}</span> <span className="grow" style={{ minWidth: 0, overflowWrap: "anywhere" }}>{c.subject} <span className="muted">— {c.author}, {c.when}</span></span></div>
              )) : <div className="muted small">Chưa có commit nào so với {r.base}.</div>}
              <div className="rv-sec-title" style={{ marginTop: 16 }}><FileCode2 size={14} /> Files ({r.files.length})</div>
              <div className="table-wrap">
                <table className="ch-files">
                  <tbody>
                    {r.files.map((f: any) => (
                      <tr key={f.path} className={"click" + (file[r.repo] === f.path ? " on" : "")} onClick={() => setFile({ ...file, [r.repo]: file[r.repo] === f.path ? null : f.path })}>
                        <td className="mono" style={{ overflowWrap: "anywhere" }}>{f.path}</td>
                        <td className="ch-stat-add small" style={{ width: 60 }}>+{f.additions ?? "bin"}</td>
                        <td className="ch-stat-del small" style={{ width: 60 }}>-{f.deletions ?? "bin"}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
              <div className="rv-sec-title" style={{ marginTop: 16 }}>
                <FileDiff size={14} /> Diff {file[r.repo] ? `— ${file[r.repo]}` : "(tất cả)"}
                {file[r.repo] && <button className="quiet xs" style={{ marginLeft: "auto", textTransform: "none", letterSpacing: 0 }} onClick={() => setFile({ ...file, [r.repo]: null })}>Xem tất cả</button>}
              </div>
              <Diff text={file[r.repo] ? fileDiff(r.diff, file[r.repo]!) : r.diff} />
              <div className="rv-sec-title" style={{ marginTop: 16, flexWrap: "wrap" }}>
                <GitPullRequest size={14} /> PR preview
                <span style={{ textTransform: "none", letterSpacing: 0 }}>{r.pr_preview.will_open ? <Badge s="COMPLETED">sẽ được mở</Badge> : <Badge s="SKIPPED">sẽ không mở (chưa có commit / chưa chọn repo / còn thay đổi chưa commit)</Badge>}</span>
              </div>
              <div className="ch-pr">
                <div className="row tight"><b className="grow">{r.pr_preview.title}</b><Copy text={r.pr_preview.title} label="Copy title" /></div>
                <div className="row tight"><span className="grow" /><Copy text={r.pr_preview.description} label="Copy description" /></div>
                <Markdown text={r.pr_preview.description} />
              </div>
            </>
          )}
        </div>
      ))}
      {data.validation.length > 0 && (
        <>
          <div className="rv-sec-title" style={{ marginTop: 18 }}><ListChecks size={14} /> Validation</div>
          {data.validation.map((v: any) => (
            <details key={v.key} className="rv-card" style={{ padding: "8px 12px", margin: "6px 0" }} open={v.status === "FAILED"}>
              <summary style={{ color: "var(--ink)", display: "flex", gap: 6, alignItems: "center", flexWrap: "wrap" }}><b>{v.key}</b> <span className="muted">{v.type}</span> <Badge s={v.status} />{v.output?.passed === false && <Badge s="FAILED">tests failed</Badge>}{v.output?.approved === false && <Badge s="FAILED">review: changes requested</Badge>}</summary>
              <OutputView value={v.output} />
            </details>
          ))}
        </>
      )}
      {data.pull_requests.length > 0 && (
        <>
          <div className="rv-sec-title" style={{ marginTop: 18 }}><GitPullRequest size={14} /> Pull requests</div>
          {data.pull_requests.map((p: any) => (
            <div key={p.id} className="rp-file">
              <GitPullRequest size={14} color="var(--brand)" />
              <b>{p.repo}</b> <a href={p.url} target="_blank" rel="noopener" className="grow" style={{ minWidth: 0, overflowWrap: "anywhere" }}>{p.title} <ExternalLink size={11} style={{ verticalAlign: -1 }} /></a> {p.draft && <Badge s="PENDING">draft</Badge>} {!p.created && <Badge s="WAITING">link only</Badge>}
            </div>
          ))}
        </>
      )}
    </div>
  );
}
