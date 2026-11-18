import { createRoot } from "react-dom/client";
import "@xyflow/react/dist/style.css";
import "./styles.css";
import { App } from "./App.tsx";
import { DialogHost, setDialogOpenChange } from "./dialog/index.ts";
import { I18nProvider } from "./i18n/index.tsx";
import { TipLayer } from "./tooltip.tsx";
import { setActDialogOpen } from "./ui.tsx";

setDialogOpenChange(setActDialogOpen);

createRoot(document.getElementById("root")!).render(
  <I18nProvider>
    <App />
    <DialogHost />
    <TipLayer />
  </I18nProvider>,
);
