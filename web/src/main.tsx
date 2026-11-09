import { createRoot } from "react-dom/client";
import "@xyflow/react/dist/style.css";
import "./styles.css";
import { App } from "./App.tsx";
import { I18nProvider } from "./i18n/index.tsx";
import { TipLayer } from "./tooltip.tsx";

createRoot(document.getElementById("root")!).render(
  <I18nProvider>
    <App />
    <TipLayer />
  </I18nProvider>,
);
