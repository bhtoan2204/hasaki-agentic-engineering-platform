import { inbox } from "../../db.ts";
import { authStatus, closeLoginWindow, openLoginWindow, setToken } from "../../hasakiAuth.ts";
import { myTimesheet, setDayKind } from "../../timesheet.ts";
import { fetchTaskList, pickTask } from "../../work.ts";
import { parseBody } from "../../http/validate.ts";
import { TokenBody } from "../../http/schemas.ts";
import type { Route } from "./types.ts";

export const hasakiWorkRoutes: Route[] = [
  // ------------------------------------------------------------ Hasaki Work (unchanged endpoints; pick = import only)
  ["GET", /^\/api\/work\/status$/, ({ actor }) => authStatus(actor.id)],
  [
    "GET",
    /^\/api\/timesheet$/,
    ({ actor, url }) =>
      myTimesheet(
        actor.id,
        Number(url.searchParams.get("year")),
        Number(url.searchParams.get("month")),
      ),
  ],
  [
    "POST",
    /^\/api\/timesheet\/day-kind$/,
    ({ actor, body }) => setDayKind(actor.id, body.date, body.kind),
  ],
  [
    "POST",
    /^\/api\/work\/login-window$/,
    async ({ actor }) => openLoginWindow(actor.id, actor.username),
  ],
  [
    "POST",
    /^\/api\/work\/login-window\/close$/,
    async ({ actor }) => (await closeLoginWindow(actor.id), authStatus(actor.id)),
  ],
  [
    "POST",
    /^\/api\/work\/token$/,
    async ({ body, actor }) => (
      await setToken(parseBody(TokenBody, body).token, actor.id),
      authStatus(actor.id)
    ),
  ],
  [
    "POST",
    /^\/api\/work\/refresh$/,
    async ({ actor }) => ({
      count: (await fetchTaskList(actor.id)).length,
      inbox: await inbox.list(actor.id),
    }),
  ],
  ["GET", /^\/api\/work\/inbox$/, ({ actor }) => inbox.list(actor.id)],
  ["POST", /^\/api\/work\/pick\/(\d+)$/, ({ p, actor }) => pickTask(Number(p[0]), null, actor.id)],
];
