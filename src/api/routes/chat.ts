import { positiveId as num, queryInteger } from "../../http/params.ts";
import { chat } from "../../chat/service.ts";
import type { Route } from "./types.ts";

export const chatRoutes: Route[] = [
  // ------------------------------------------------------------------ Interactive Agent Chat
  [
    "GET",
    /^\/api\/chat\/conversations$/,
    (c) =>
      chat.list(c.actor, {
        search: c.url.searchParams.get("q") ?? undefined,
        archived: c.url.searchParams.get("archived") === "1",
        limit: queryInteger(c.url.searchParams, "limit") || 100,
      }),
  ],
  ["POST", /^\/api\/chat\/conversations$/, (c) => chat.create(c.actor, c.body)],
  ["GET", /^\/api\/chat\/conversations\/(\d+)$/, (c) => chat.get(c.actor, num(c.p[0]))],
  ["POST", /^\/api\/chat\/conversations\/(\d+)$/, (c) => chat.update(c.actor, num(c.p[0]), c.body)],
  ["POST", /^\/api\/chat\/conversations\/(\d+)\/delete$/, (c) => chat.remove(c.actor, num(c.p[0]))],
  [
    "POST",
    /^\/api\/chat\/conversations\/(\d+)\/messages$/,
    (c) => chat.postMessage(c.actor, num(c.p[0]), c.body),
  ],
  [
    "POST",
    /^\/api\/chat\/conversations\/(\d+)\/title\/regenerate$/,
    (c) => chat.regenerateTitle(c.actor, num(c.p[0])),
  ],
  [
    "GET",
    /^\/api\/chat\/conversations\/(\d+)\/events$/,
    async (c) => {
      const after = queryInteger(c.url.searchParams, "after") ?? 0;
      return chat.events(c.actor, num(c.p[0]), after);
    },
  ],
  [
    "GET",
    /^\/api\/chat\/conversations\/(\d+)\/delegations$/,
    (c) => chat.delegations(c.actor, num(c.p[0])),
  ],
  [
    "POST",
    /^\/api\/chat\/conversations\/(\d+)\/delegation\/preview$/,
    (c) => chat.delegationPreview(c.actor, num(c.p[0]), c.body),
  ],
  [
    "POST",
    /^\/api\/chat\/conversations\/(\d+)\/delegation\/execute$/,
    (c) => chat.delegationExecute(c.actor, num(c.p[0]), c.body),
  ],
  ["POST", /^\/api\/chat\/turns\/(\d+)\/cancel$/, (c) => chat.cancelTurn(c.actor, num(c.p[0]))],
  [
    "POST",
    /^\/api\/chat\/operations\/(\d+)\/(confirm|reject)$/,
    (c) => chat.decideOperation(c.actor, num(c.p[0]), c.p[1] as "confirm" | "reject"),
  ],
  ["GET", /^\/api\/chat\/memory$/, (c) => chat.memories(c.actor)],
  ["POST", /^\/api\/chat\/turns\/(\d+)\/regenerate$/, (c) => chat.regenerate(c.actor, num(c.p[0]))],
];
