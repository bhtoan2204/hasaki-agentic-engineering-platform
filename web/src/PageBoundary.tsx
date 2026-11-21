import { Component, type ReactNode } from "react";
import { useI18n } from "./i18n/index.tsx";
import { isChunkLoadError, reloadOnce } from "./pageRecovery.ts";

const storage = () => {
  try {
    return window.sessionStorage;
  } catch {
    return null;
  }
};
const reload = () => window.location.reload();

/** Reload once for a page chunk of a replaced build; otherwise keep the shell and say what happened. */
export function recoverFromChunkError(error: unknown) {
  const s = storage();
  if (isChunkLoadError(error) && s && reloadOnce(s)) {
    reload();
    return true;
  }
  return false;
}

function PageFailed({ error }: { error: unknown }) {
  const { t } = useI18n();
  const stale = isChunkLoadError(error);
  return (
    <div className="panel page-failed" role="alert">
      <h2>{t(stale ? "page.failed.staleTitle" : "page.failed.title")}</h2>
      <p className="muted">{t(stale ? "page.failed.staleBody" : "page.failed.body")}</p>
      <button className="primary" onClick={reload}>
        {t("page.failed.reload")}
      </button>
    </div>
  );
}

/**
 * Error boundary around the routed page (one per route, keyed by the path): a failed lazy chunk or a render error no
 * longer unmounts the whole application into a blank screen.
 */
export class PageBoundary extends Component<{ children: ReactNode }, { error: unknown }> {
  state: { error: unknown } = { error: null };
  static getDerivedStateFromError(error: unknown) {
    return { error };
  }
  componentDidCatch(error: unknown) {
    if (!recoverFromChunkError(error)) console.error("page failed:", error);
  }
  render() {
    return this.state.error ? <PageFailed error={this.state.error} /> : this.props.children;
  }
}
