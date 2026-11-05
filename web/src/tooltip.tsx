import { useEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";

const GAP = 6;
const MARGIN = 8;

/**
 * One tooltip for every `[data-tip]`. The old `::after` sat above the control, so a header
 * button flush with the viewport top was clipped. This layer is portaled to `document.body`
 * and prefers the side that fits, below when the anchor is near the top.
 */
export function TipLayer() {
  const hover = useRef<HTMLElement | null>(null);
  const focus = useRef<HTMLElement | null>(null);
  const [anchor, setAnchor] = useState<HTMLElement | null>(null);
  const [text, setText] = useState("");
  const [box, setBox] = useState<{ top: number; left: number } | null>(null);
  const tipRef = useRef<HTMLDivElement | null>(null);

  useEffect(() => {
    const described = { el: null as HTMLElement | null, prev: null as string | null };
    const shown = { el: null as HTMLElement | null };
    const clearDescribed = () => {
      if (described.el) {
        if (described.prev == null) described.el.removeAttribute("aria-describedby");
        else described.el.setAttribute("aria-describedby", described.prev);
      }
      described.el = null;
      described.prev = null;
    };
    const pick = () => {
      const el = hover.current?.isConnected ? hover.current : focus.current?.isConnected ? focus.current : null;
      const value = el?.getAttribute("data-tip")?.trim() ?? "";
      const next = el && value ? el : null;
      if (next === shown.el) return;
      shown.el = next;
      if (!next || !value) {
        clearDescribed();
        setAnchor(null);
        setText("");
        setBox(null);
        return;
      }
      if (described.el !== next) {
        clearDescribed();
        described.el = next;
        described.prev = next.getAttribute("aria-describedby");
        next.setAttribute("aria-describedby", [described.prev, "app-tip"].filter(Boolean).join(" "));
      }
      setAnchor(next);
      setText(value);
      setBox(null);
    };
    const fromEvent = (target: EventTarget | null) => (target instanceof Element ? target.closest<HTMLElement>("[data-tip]") : null);
    const onOver = (e: MouseEvent) => {
      hover.current = fromEvent(e.target);
      pick();
    };
    const onOut = (e: MouseEvent) => {
      if (!hover.current) return;
      const next = fromEvent(e.relatedTarget);
      if (next === hover.current) return;
      hover.current = null;
      pick();
    };
    const onFocus = (e: FocusEvent) => {
      focus.current = fromEvent(e.target);
      pick();
    };
    const onBlur = (e: FocusEvent) => {
      if (!focus.current) return;
      const next = fromEvent(e.relatedTarget);
      if (next === focus.current) return;
      focus.current = null;
      pick();
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== "Escape") return;
      hover.current = null;
      focus.current = null;
      pick();
    };
    document.addEventListener("mouseover", onOver);
    document.addEventListener("mouseout", onOut);
    document.addEventListener("focusin", onFocus);
    document.addEventListener("focusout", onBlur);
    document.addEventListener("keydown", onKey);
    return () => {
      clearDescribed();
      document.removeEventListener("mouseover", onOver);
      document.removeEventListener("mouseout", onOut);
      document.removeEventListener("focusin", onFocus);
      document.removeEventListener("focusout", onBlur);
      document.removeEventListener("keydown", onKey);
    };
  }, []);

  useEffect(() => {
    const el = anchor;
    const tip = tipRef.current;
    if (!el || !tip || !text) return;
    const place = () => {
      if (!el.isConnected) {
        setAnchor(null);
        setText("");
        setBox(null);
        return;
      }
      const next = el.getAttribute("data-tip")?.trim() ?? "";
      if (next !== text) {
        setText(next);
        setBox(null);
        return;
      }
      const a = el.getBoundingClientRect();
      const t = tip.getBoundingClientRect();
      const vw = document.documentElement.clientWidth;
      const vh = document.documentElement.clientHeight;
      const above = a.top - GAP - t.height;
      const below = a.bottom + GAP;
      const fitsAbove = above >= MARGIN;
      const fitsBelow = below + t.height <= vh - MARGIN;
      let top = !fitsAbove || a.top < t.height + GAP + MARGIN ? below : above;
      if (!fitsBelow && fitsAbove) top = above;
      if (top < MARGIN) top = MARGIN;
      if (top + t.height > vh - MARGIN) top = Math.max(MARGIN, vh - MARGIN - t.height);
      const coversAnchor = top < a.bottom && top + t.height > a.top;
      if (coversAnchor && below + t.height <= vh - MARGIN) top = below;
      let left = a.left + a.width / 2 - t.width / 2;
      left = Math.max(MARGIN, Math.min(left, vw - MARGIN - t.width));
      setBox({ top, left });
    };
    place();
    const frame = requestAnimationFrame(place);
    const obs = new MutationObserver(place);
    const resize = new ResizeObserver(place);
    resize.observe(el);
    resize.observe(tip);
    obs.observe(el, { attributes: true, attributeFilter: ["data-tip"] });
    window.addEventListener("resize", place);
    window.addEventListener("scroll", place, true);
    return () => {
      cancelAnimationFrame(frame);
      obs.disconnect();
      resize.disconnect();
      window.removeEventListener("resize", place);
      window.removeEventListener("scroll", place, true);
    };
  }, [anchor, text]);

  if (!text) return null;
  return createPortal(
    <div id="app-tip" ref={tipRef} className="app-tip" role="tooltip" style={{ top: box?.top ?? 0, left: box?.left ?? 0, visibility: box ? "visible" : "hidden" }}>
      {text}
    </div>,
    document.body,
  );
}
