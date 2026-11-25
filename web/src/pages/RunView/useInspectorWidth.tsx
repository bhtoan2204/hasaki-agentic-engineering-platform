import { useRef, useState } from "react";
import { PANE_KEY, PANE_MIN, paneMax } from "./shared.tsx";

/** Width of the step inspector, set by dragging its left edge (or the arrow keys); remembered per browser. */
export function useInspectorWidth() {
  const [width, setWidth] = useState<number | null>(() => {
    try {
      const v = Number(localStorage.getItem(PANE_KEY));
      return v >= PANE_MIN ? v : null;
    } catch {
      return null;
    }
  });
  const latest = useRef(width);
  latest.current = width;
  const save = (w: number | null) => {
    try {
      if (w == null) localStorage.removeItem(PANE_KEY);
      else localStorage.setItem(PANE_KEY, String(Math.round(w)));
    } catch {
      /* ignore: storage unavailable */
    }
  };
  const clamp = (w: number) => Math.min(paneMax(), Math.max(PANE_MIN, w));
  const onPointerDown = (e: React.PointerEvent<HTMLDivElement>) => {
    const pane = e.currentTarget.nextElementSibling as HTMLElement | null;
    if (!pane) return;
    e.preventDefault();
    const startX = e.clientX,
      startW = pane.getBoundingClientRect().width;
    document.body.classList.add("rv-resizing");
    const move = (ev: PointerEvent) => setWidth(clamp(startW + (startX - ev.clientX)));
    const up = () => {
      window.removeEventListener("pointermove", move);
      window.removeEventListener("pointerup", up);
      document.body.classList.remove("rv-resizing");
      save(latest.current);
    };
    window.addEventListener("pointermove", move);
    window.addEventListener("pointerup", up);
  };
  const onKeyDown = (e: React.KeyboardEvent<HTMLDivElement>) => {
    if (e.key !== "ArrowLeft" && e.key !== "ArrowRight") return;
    e.preventDefault();
    const pane = e.currentTarget.nextElementSibling as HTMLElement | null;
    const w = clamp(
      (latest.current ?? pane?.getBoundingClientRect().width ?? 560) +
        (e.key === "ArrowLeft" ? 40 : -40),
    );
    setWidth(w);
    save(w);
  };
  const reset = () => (setWidth(null), save(null));
  return { width, onPointerDown, onKeyDown, reset };
}
