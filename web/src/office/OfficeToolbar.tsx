import { Maximize2, Minimize2, Pause, Play, Shrink, Sparkles, Expand } from "lucide-react";
import type { LiveState } from "../api.ts";

export function OfficeToolbar({
  runs, activeIds, runId, onRun, preview, onPreview, animate, onAnimate, compact, onCompact, onFullscreen, fullscreen, live,
}: {
  runs: any[];
  activeIds: Set<number>;
  runId: number | null;
  onRun: (id: number | null) => void;
  preview: boolean;
  onPreview: (on: boolean) => void;
  animate: boolean;
  onAnimate: (on: boolean) => void;
  compact: boolean;
  onCompact: (on: boolean) => void;
  onFullscreen: () => void;
  fullscreen: boolean;
  live: LiveState | null;
}) {
  const active = runs.filter((r) => activeIds.has(r.id));
  const recent = runs.filter((r) => !activeIds.has(r.id)).slice(0, 30);
  return (
    <div className="office-toolbar" role="toolbar" aria-label="Điều khiển Agent Office">
      <label className="office-runpick">
        <span className="sr-only">Chọn run</span>
        <select value={preview ? "preview" : runId ?? ""} onChange={(e) => (e.target.value === "preview" ? onPreview(true) : (onPreview(false), onRun(e.target.value ? Number(e.target.value) : null)))}>
          <option value="">{active.length ? "Tự chọn run đang chạy" : "Không có run nào đang chạy"}</option>
          {active.length > 0 && (
            <optgroup label="Đang chạy / chờ">
              {active.map((r) => <option key={r.id} value={r.id}>#{r.id} · {r.status} · {r.title}</option>)}
            </optgroup>
          )}
          {recent.length > 0 && (
            <optgroup label="Lịch sử">
              {recent.map((r) => <option key={r.id} value={r.id}>#{r.id} · {r.status} · {r.title}</option>)}
            </optgroup>
          )}
          <optgroup label="Mô phỏng">
            <option value="preview">Preview Office (dữ liệu mẫu)</option>
          </optgroup>
        </select>
      </label>
      {!preview && runId && <a className="small" href={`#/runs/${runId}`}>Graph của run #{runId}</a>}
      <span className="grow" />
      {!preview && live && <span className={`office-live is-${live}`} title="Cập nhật từ PostgreSQL LISTEN/NOTIFY qua SSE">{live === "sse" ? "● live" : live === "polling" ? "◌ polling" : "… đang kết nối"}</span>}
      <button className={`ghost sm${preview ? " is-on" : ""}`} aria-pressed={preview} onClick={() => onPreview(!preview)} title="Mô phỏng mọi animation bằng dữ liệu mẫu — không tạo task, không chạy Claude">
        <Sparkles size={15} /> Preview
      </button>
      <button className={`ghost sm${animate ? " is-on" : ""}`} aria-pressed={animate} onClick={() => onAnimate(!animate)}>
        {animate ? <><Pause size={15} /> Animation</> : <><Play size={15} /> Animation</>}
      </button>
      <button className={`ghost sm${compact ? " is-on" : ""}`} aria-pressed={compact} onClick={() => onCompact(!compact)}>
        {compact ? <><Expand size={15} /> Rộng</> : <><Shrink size={15} /> Gọn</>}
      </button>
      <button className="ghost sm" aria-pressed={fullscreen} onClick={onFullscreen}>{fullscreen ? <><Minimize2 size={15} /> Thoát toàn màn hình</> : <><Maximize2 size={15} /> Toàn màn hình</>}</button>
    </div>
  );
}
