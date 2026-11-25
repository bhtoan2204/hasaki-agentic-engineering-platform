import {
  agentConfigurationView,
  patchAgentProvider,
  previewAgentConfiguration,
} from "../agentConfiguration.ts";
import { saveDefaultProvider } from "../../agent/configurationStore.ts";
import { clearKafkaCookie, kafkaStatus, setKafkaCookie } from "../../integrations/kafka.ts";
import { clearVaultToken, setVaultToken, vaultStatus } from "../../integrations/vault.ts";
import { HttpError } from "../../http/error.ts";
import { positiveId as num } from "../../http/params.ts";
import {
  clearOperatorSettings,
  operatorView,
  saveOperatorSettings,
} from "../../platform/operatorSettings.ts";
import { audit, requireAdmin } from "../../authz/access.ts";
import { listUsers, createUser, setActive, setPassword } from "../../auth/users.ts";
import { parseBody } from "../../http/validate.ts";
import {
  CookieBody,
  CreateUserBody,
  PasswordBody,
  SetActiveBody,
  TokenBody,
} from "../../http/schemas.ts";
import type { Route } from "./types.ts";

export const adminRoutes: Route[] = [
  // Vault (QC): pasted token; agents see key names and presence, never values
  [
    "GET",
    /^\/api\/integrations\/vault$/,
    ({ url }) => vaultStatus(url.searchParams.get("check") === "1"),
  ],
  [
    "POST",
    /^\/api\/integrations\/vault\/token$/,
    ({ body }) => setVaultToken(parseBody(TokenBody, body).token),
  ],
  ["POST", /^\/api\/integrations\/vault\/logout$/, () => clearVaultToken()],
  // Kafka UI (QC): pasted session cookie, GET-only client
  [
    "GET",
    /^\/api\/integrations\/kafka$/,
    ({ url }) => kafkaStatus(url.searchParams.get("check") === "1"),
  ],
  [
    "POST",
    /^\/api\/integrations\/kafka\/cookie$/,
    ({ body }) => setKafkaCookie(parseBody(CookieBody, body).cookie),
  ],
  ["POST", /^\/api\/integrations\/kafka\/logout$/, () => clearKafkaCookie()],

  ["GET", /^\/api\/users$/, ({ actor }) => (requireAdmin(actor), listUsers())],
  [
    "POST",
    /^\/api\/users$/,
    async ({ body, actor }) => (requireAdmin(actor), createUser(parseBody(CreateUserBody, body))),
  ],
  [
    "POST",
    /^\/api\/users\/(\d+)\/password$/,
    async ({ p, body, actor }) => (
      requireAdmin(actor),
      await setPassword(num(p[0]), parseBody(PasswordBody, body).password),
      { ok: true }
    ),
  ],
  ["GET", /^\/api\/settings\/operator$/, ({ actor }) => (requireAdmin(actor), operatorView())],
  [
    "GET",
    /^\/api\/settings\/agents$/,
    ({ actor }) => (requireAdmin(actor), agentConfigurationView()),
  ],
  [
    "POST",
    /^\/api\/settings\/agents\/provider$/,
    ({ actor, body }) => (requireAdmin(actor), patchAgentProvider(body)),
  ],
  [
    "PATCH",
    /^\/api\/settings\/agents\/provider$/,
    ({ actor, body }) => (requireAdmin(actor), patchAgentProvider(body)),
  ],
  [
    "POST",
    /^\/api\/settings\/agents\/default$/,
    async ({ actor, body }) => {
      requireAdmin(actor);
      await saveDefaultProvider(body);
      return agentConfigurationView();
    },
  ],
  [
    "POST",
    /^\/api\/settings\/agents\/preview$/,
    ({ actor, body }) => (requireAdmin(actor), previewAgentConfiguration(body)),
  ],
  [
    "POST",
    /^\/api\/settings\/operator$/,
    async ({ body, actor }) => {
      requireAdmin(actor);
      const view = await saveOperatorSettings(body ?? {});
      await audit(actor.id, "settings.operator.update", "settings", "operator", body ?? {});
      return view;
    },
  ],
  [
    "POST",
    /^\/api\/settings\/operator\/clear$/,
    async ({ actor }) => {
      requireAdmin(actor);
      const view = await clearOperatorSettings();
      await audit(actor.id, "settings.operator.clear", "settings", "operator");
      return view;
    },
  ],
  [
    "POST",
    /^\/api\/users\/(\d+)\/active$/,
    async ({ p, body, actor }) => {
      requireAdmin(actor);
      const { active } = parseBody(SetActiveBody, body);
      if (num(p[0]) === actor.id && !active)
        throw new HttpError(400, "you cannot deactivate yourself");
      await setActive(num(p[0]), active);
      return { ok: true };
    },
  ],
];
