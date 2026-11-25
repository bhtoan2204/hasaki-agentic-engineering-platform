import {
  createBinding,
  disconnect as disconnectTelegram,
  savePreferences,
} from "../../telegram/store.ts";
import {
  listChatPolicies,
  ownerAutonomySummary,
  revokeChatPolicy,
  saveChatPolicy,
  type ChatPolicyInput,
} from "../../chat/autonomy.ts";
import {
  bitbucketStatus,
  clearBitbucket,
  clearGithub,
  clearGitlab,
  clearTelegram,
  githubStatus,
  gitlabStatus,
  setGitlab,
  setGitlabSshKey,
  testGitlab,
  setBitbucket,
  setGithub,
  setTelegram,
  setTelegramMode,
  setTelegramDestination,
  telegramChats,
  telegramStatus,
  testTelegram,
} from "../../integrations/accounts.ts";
import { addGitlabInstance, removeGitlabInstance } from "../../platform/operatorSettings.ts";
import { audit, requireAdmin } from "../../authz/access.ts";
import {
  backgroundGitStatus,
  setBackgroundGit,
  workspaceRepositories,
} from "../../repos/backgroundGit.ts";
import { parseBody } from "../../http/validate.ts";
import { BitbucketBody, GithubBody, GitlabBody, GitlabSshKeyBody } from "../../http/schemas.ts";
import type { Route } from "./types.ts";

export const integrationsRoutes: Route[] = [
  // Telegram + Bitbucket credentials (saved in the platform instead of .env; secrets never returned)
  [
    "GET",
    /^\/api\/integrations\/telegram$/,
    ({ actor }) => telegramStatus(actor.id, actor.role === "admin"),
  ],
  [
    "POST",
    /^\/api\/integrations\/telegram$/,
    ({ body, actor }) => (requireAdmin(actor), setTelegram(body)),
  ],
  [
    "POST",
    /^\/api\/integrations\/telegram\/mode$/,
    ({ body, actor }) => (requireAdmin(actor), setTelegramMode(body.mode)),
  ],
  ["POST", /^\/api\/integrations\/telegram\/connect$/, ({ actor }) => createBinding(actor.id)],
  [
    "POST",
    /^\/api\/integrations\/telegram\/disconnect$/,
    ({ actor }) => disconnectTelegram(actor.id),
  ],
  [
    "POST",
    /^\/api\/integrations\/telegram\/preferences$/,
    ({ actor, body }) => savePreferences(actor.id, body),
  ],
  [
    "POST",
    /^\/api\/integrations\/telegram\/destination$/,
    ({ body, actor }) =>
      setTelegramDestination(actor.id, String(body.chatId ?? body.chat_id ?? "")),
  ],
  [
    "POST",
    /^\/api\/integrations\/telegram\/chats$/,
    ({ body, actor }) => (requireAdmin(actor), telegramChats(body)),
  ],
  [
    "POST",
    /^\/api\/integrations\/telegram\/test$/,
    ({ actor }) => testTelegram(actor.id, actor.role === "admin"),
  ],
  [
    "POST",
    /^\/api\/integrations\/telegram\/clear$/,
    ({ actor }) => (requireAdmin(actor), clearTelegram()),
  ],
  // Chat autonomy policies (chat/autonomy.ts): administrators manage global/repository/workflow scopes, every user
  // only their own owner scope. Revocation and pause are immediate.
  [
    "GET",
    /^\/api\/chat\/autonomy\/policies$/,
    async ({ actor }) => ({
      policies: await listChatPolicies(actor),
      summary: await ownerAutonomySummary(actor.id),
    }),
  ],
  [
    "POST",
    /^\/api\/chat\/autonomy\/policies$/,
    ({ actor, body }) => saveChatPolicy(body as unknown as ChatPolicyInput, actor),
  ],
  [
    "POST",
    /^\/api\/chat\/autonomy\/policies\/(\d+)\/revoke$/,
    ({ actor, p }) => revokeChatPolicy(Number(p[0]), actor),
  ],
  // Background Git sync by consent (repos/backgroundGit.ts): the caller's own switch, stored with the caller's secrets.
  ["GET", /^\/api\/integrations\/background-git$/, ({ actor }) => backgroundGitStatus(actor.id)],
  [
    "POST",
    /^\/api\/integrations\/background-git$/,
    ({ actor, body }) => setBackgroundGit(actor.id, body.enabled === true),
  ],
  // The platform workspace on this instance: readable repositories, their checkout state and latest index.
  ["GET", /^\/api\/workspace\/repositories$/, ({ actor }) => workspaceRepositories(actor.id)],
  ["GET", /^\/api\/integrations\/bitbucket$/, ({ actor }) => bitbucketStatus(actor.id)],
  [
    "POST",
    /^\/api\/integrations\/bitbucket$/,
    ({ body, actor }) => setBitbucket(parseBody(BitbucketBody, body), actor.id),
  ],
  ["POST", /^\/api\/integrations\/bitbucket\/clear$/, ({ actor }) => clearBitbucket(actor.id)],
  ["GET", /^\/api\/integrations\/github$/, ({ actor }) => githubStatus(actor.id)],
  [
    "POST",
    /^\/api\/integrations\/github$/,
    ({ body, actor }) => setGithub(parseBody(GithubBody, body), actor.id),
  ],
  ["POST", /^\/api\/integrations\/github\/clear$/, ({ actor }) => clearGithub(actor.id)],
  [
    "GET",
    /^\/api\/integrations\/gitlab$/,
    async ({ actor }) => ({
      ...(await gitlabStatus(actor.id)),
      can_manage: actor.role === "admin",
    }),
  ],
  [
    "POST",
    /^\/api\/integrations\/gitlab\/instances$/,
    async ({ body, actor }) => (
      requireAdmin(actor),
      await addGitlabInstance(body?.host),
      await audit(actor.id, "settings.gitlab.instance.add", "settings", "operator", {
        host: body?.host,
      }),
      gitlabStatus(actor.id)
    ),
  ],
  [
    "POST",
    /^\/api\/integrations\/gitlab\/instances\/remove$/,
    async ({ body, actor }) => (
      requireAdmin(actor),
      await removeGitlabInstance(body?.host),
      await audit(actor.id, "settings.gitlab.instance.remove", "settings", "operator", {
        host: body?.host,
      }),
      gitlabStatus(actor.id)
    ),
  ],
  [
    "POST",
    /^\/api\/integrations\/gitlab$/,
    ({ body, actor }) => setGitlab(parseBody(GitlabBody, body), actor.id),
  ],
  ["POST", /^\/api\/integrations\/gitlab\/test$/, ({ body, actor }) => testGitlab(body, actor.id)],
  [
    "POST",
    /^\/api\/integrations\/gitlab\/ssh-key$/,
    ({ body, actor }) => setGitlabSshKey(parseBody(GitlabSshKeyBody, body), actor.id),
  ],
  [
    "POST",
    /^\/api\/integrations\/gitlab\/clear$/,
    ({ body, actor }) => clearGitlab(body ?? {}, actor.id),
  ],
];
