import { createRoot } from "react-dom/client";
import "@xyflow/react/dist/style.css";
import "./styles.css";
import { App } from "./App.tsx";
import { DialogHost, setDialogOpenChange } from "./dialog/index.ts";
import { I18nProvider } from "./i18n/index.tsx";
import { TipLayer } from "./tooltip.tsx";
import { setActDialogOpen } from "./ui.tsx";
import { recoverFromChunkError } from "./PageBoundary.tsx";

setDialogOpenChange(setActDialogOpen);
// Vite reports a failed preload of a lazy page (a chunk of a replaced build) here, before React sees the import fail.
window.addEventListener("vite:preloadError", (event) => {
  if (recoverFromChunkError((event as Event & { payload?: unknown }).payload))
    event.preventDefault();
});

createRoot(document.getElementById("root")!).render(
  <I18nProvider>
    <App />
    <DialogHost />
    <TipLayer />
  </I18nProvider>,
);
