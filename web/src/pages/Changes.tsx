import { useEffect, useState } from "react";
import { api, useApi } from "../api.ts";
import { act, Badge, Copy, Empty, ErrorBox, Loading, Markdown, navigate } from "../ui.tsx";
import { OutputView } from "./StepInspector.tsx";

function Diff({ text }: { text: string }) {
  if (!text.trim()) return <div className="muted small">(không có diff)</div>;
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
      <div className="row tight">
        <h2 className="grow" style={{ margin: 0 }}>🔍 Changes & PR preview</h2>
        <button className="ghost xs" onClick={() => navigate(`/runs/${run.id}`)}>✕</button>
      </div>
      <div className="muted small">
        Branch <span className="mono">{data.branch}</span>
        {data.pr_step && <> · PR step <b>{data.pr_step.key}</b> (mode {data.pr_step.mode}) <Badge s={data.pr_step.status} /></>}
      </div>
      {prWaiting && (
        <div className="card" style={{ borderColor: "var(--warn)", marginTop: 10 }}>
          <b>PR step đang chờ duyệt.</b> Xem thay đổi bên dưới rồi duyệt để push và mở/cập nhật PR trên Bitbucket.
          <div className="row">
            <button className="ok" onClick={async () => (await act(() => api(`/api/runs/${run.id}/steps/${data.pr_step.key}/approve`, {}), "PR step approved")) && (onChanged(), reload())}>Approve & create PR</button>
            <button className="ghost" onClick={() => navigate(`/runs/${run.id}/${data.pr_step.key}`)}>Mở bước PR</button>
          </div>
        </div>
      )}
      {!data.repos.length && <Empty>Run này chưa có workspace nào (chưa có bước code nào chạy).</Empty>}
      {data.repos.map((r: any) => (
        <div key={r.repo} className="card">
          <h4>📦 {r.repo} <span className="mono muted small">{r.branch} → {r.pr_preview?.target}</span></h4>
          {!r.exists ? (
            <div className="err small">Worktree không còn tồn tại: {r.path}</div>
          ) : (
            <>
              <div className="muted small mono">{r.path}</div>
              {r.status && (
                <div className="errorbox small">
                  <b>Có thay đổi chưa commit</b> — PR step sẽ từ chối push:
                  <pre>{r.status}</pre>
                  <details><summary>uncommitted diff</summary><Diff text={r.uncommitted_diff} /></details>
                </div>
              )}
              <h3>Commits ({r.commits.length})</h3>
              {r.commits.length ? r.commits.map((c: any) => (
                <div key={c.hash} className="small"><span className="mono">{c.hash}</span> {c.subject} <span className="muted">— {c.author}, {c.when}</span></div>
              )) : <div className="muted small">Chưa có commit nào so với {r.base}.</div>}
              <h3>Files ({r.files.length})</h3>
              <table>
                <tbody>
                  {r.files.map((f: any) => (
                    <tr key={f.path} className="click" onClick={() => setFile({ ...file, [r.repo]: file[r.repo] === f.path ? null : f.path })}>
                      <td className="mono">{f.path}</td>
                      <td className="okc small" style={{ width: 60 }}>+{f.additions ?? "bin"}</td>
                      <td className="err small" style={{ width: 60 }}>-{f.deletions ?? "bin"}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
              <h3>Diff {file[r.repo] ? `— ${file[r.repo]}` : "(tất cả)"}</h3>
              <Diff text={file[r.repo] ? fileDiff(r.diff, file[r.repo]!) : r.diff} />
              <h3>PR preview {r.pr_preview.will_open ? <Badge s="COMPLETED">sẽ được mở</Badge> : <Badge s="SKIPPED">sẽ không mở (chưa có commit / chưa chọn repo / còn thay đổi chưa commit)</Badge>}</h3>
              <div className="card" style={{ background: "var(--panel2)" }}>
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
          <h3>Validation</h3>
          {data.validation.map((v: any) => (
            <details key={v.key} className="card" style={{ padding: "6px 10px" }} open={v.status === "FAILED"}>
              <summary style={{ color: "var(--text)" }}><b>{v.key}</b> <span className="muted">{v.type}</span> <Badge s={v.status} />{v.output?.passed === false && <Badge s="FAILED">tests failed</Badge>}{v.output?.approved === false && <Badge s="FAILED">review: changes requested</Badge>}</summary>
              <OutputView value={v.output} />
            </details>
          ))}
        </>
      )}
      {data.pull_requests.length > 0 && (
        <>
          <h3>Pull requests</h3>
          {data.pull_requests.map((p: any) => (
            <div key={p.id} className="small">
              <b>{p.repo}</b> · <a href={p.url} target="_blank" rel="noopener">{p.title}</a> {p.draft && <Badge s="PENDING">draft</Badge>} {!p.created && <Badge s="WAITING">link only</Badge>}
            </div>
          ))}
        </>
      )}
    </div>
  );
}
