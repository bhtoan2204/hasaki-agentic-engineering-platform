import { assertQuestionsAccessible } from "../../authz/access.ts";
import {
  answeredQuestions,
  answerQuestions,
  openQuestions,
  openApprovals,
} from "../../workflow/engine.ts";
import type { Route } from "./types.ts";
import { mine, support } from "./shared.ts";

export const questionsRoutes: Route[] = [
  // ------------------------------------------------------------ questions inbox
  ["GET", /^\/api\/questions$/, (c) => openQuestions(undefined, mine(c))],
  // Approval steps waiting for a decision (the inbox lists them next to open questions).
  ["GET", /^\/api\/approvals$/, (c) => openApprovals(undefined, mine(c))],
  ["GET", /^\/api\/questions\/history$/, (c) => answeredQuestions(100, undefined, mine(c))],
  [
    "POST",
    /^\/api\/questions\/answers$/,
    async (c) => (
      await assertQuestionsAccessible(c.actor, support(c), c.body.answers ?? {}),
      answerQuestions(c.body.answers ?? {}, c.actor.username)
    ),
  ],
];
