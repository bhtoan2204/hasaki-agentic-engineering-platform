import "./Integrations.css";
import { useState } from "react";
import { PlugZap } from "lucide-react";
import { PageHeader } from "../ui.tsx";
import { useI18n } from "../i18n/index.tsx";
import { ArgoCd } from "./Integrations/ArgoCd.tsx";
import { Bitbucket } from "./Integrations/Bitbucket.tsx";
import { GitHubAccount } from "./Integrations/GitHubAccount.tsx";
import { GitLabAccount } from "./Integrations/GitLabAccount.tsx";
import { Kafka } from "./Integrations/Kafka.tsx";
import { ProjectDatabases } from "./Integrations/ProjectDatabases.tsx";
import { SigNoz } from "./Integrations/SigNoz.tsx";
import { Splunk } from "./Integrations/Splunk.tsx";
import { Telegram } from "./Integrations/Telegram.tsx";
import { Vault } from "./Integrations/Vault.tsx";
import { AgentAccounts, BackgroundGit } from "./Integrations/shared.tsx";

export function IntegrationsPage({ me }: { me?: { role?: string } | null } = {}) {
  const { t } = useI18n();
  const [open, setOpen] = useState<string | null>(null);
  const row = (id: string) => ({
    open: open === id,
    onToggle: (x: string) => setOpen(open === x ? null : x),
  });
  return (
    <>
      <PageHeader icon={PlugZap} title={t("ig.title")} subtitle={t("ig.subtitle")} />
      <AgentAccounts />
      <section className="ig-group">
        <h3 className="ig-group-title">
          {t("ig.sources")} <span className="muted small">· {t("ig.sourcesHint")}</span>
        </h3>
        <div className="ig-list">
          <ArgoCd {...row("argocd")} />
          <Kafka {...row("kafka")} />
          <Vault {...row("vault")} />
          <Splunk {...row("splunk")} />
          <SigNoz {...row("signoz")} />
          <ProjectDatabases {...row("databases")} isAdmin={me?.role === "admin"} />
        </div>
      </section>
      <section className="ig-group">
        <h3 className="ig-group-title">{t("ig.accounts")}</h3>
        <div className="ig-list">
          <Bitbucket {...row("bitbucket")} />
          <GitHubAccount {...row("github")} />
          <GitLabAccount {...row("gitlab")} />
          <BackgroundGit {...row("background-git")} />
          <Telegram {...row("telegram")} />
        </div>
      </section>
    </>
  );
}
