import type { AgentProvider } from "../provider.ts";
import { claudeAgentTurn, codexEnvironmentNotes } from "../claude.ts";
import { cursorAgentTurn } from "../cursor/run.ts";
import { codexAgentTurn } from "../codex/run.ts";
import { copilotAgentTurn } from "../copilot/run.ts";
import { antigravityAgentTurn } from "../antigravity/run.ts";
import type { LifecycleState, TurnResult } from "./state.ts";

export type { TurnResult };

export interface TurnRequest {
  state: LifecycleState;
  prompt: string;
  resumeId?: string;
  systemAppend: string;
  sessionKey: string;
  persistSession: (error?: unknown) => Promise<void>;
}

export type AgentTurn = (req: TurnRequest) => Promise<TurnResult>;

const cliInput = (req: TurnRequest, prompt: string) => {
  const s = req.state;
  return {
    ctx: s.ctx,
    mode: s.mode,
    policy: s.policy,
    cwd: s.cwd,
    prompt,
    metrics: s.metrics,
    invocationId: req.sessionKey,
    onTelemetry: req.persistSession,
    model: s.routed.model || undefined,
    resumeId: req.resumeId,
  };
};

const withEffort = (req: TurnRequest, prompt: string) => ({
  ...cliInput(req, prompt),
  effort: req.state.routed.effort || undefined,
});

const keepSubmitted = <R extends TurnResult & { submitted?: Record<string, unknown> }>(
  req: TurnRequest,
  result: R,
): TurnResult => {
  if (result.submitted) req.state.submitted = result.submitted;
  return {
    isError: result.isError,
    text: result.text,
    assistantTurns: result.assistantTurns,
    failure: result.failure,
  };
};

/** One adapter per provider; the lifecycle never branches on the provider to run a turn. */
export const TURN_ADAPTERS: Record<AgentProvider, AgentTurn> = {
  cursor: async (req) =>
    keepSubmitted(
      req,
      await cursorAgentTurn(cliInput(req, `${req.systemAppend}\n\n${req.prompt}`)),
    ),
  // A resumed thread already holds the system instructions; a fresh one gets them in front of the prompt.
  codex: async (req) =>
    keepSubmitted(
      req,
      await codexAgentTurn(
        withEffort(
          req,
          req.resumeId
            ? req.prompt
            : `${req.systemAppend}\n\n${codexEnvironmentNotes(req.state.mode)}\n\n${req.prompt}`,
        ),
      ),
    ),
  copilot: async (req) =>
    keepSubmitted(
      req,
      await copilotAgentTurn(
        withEffort(req, req.resumeId ? req.prompt : `${req.systemAppend}\n\n${req.prompt}`),
      ),
    ),
  antigravity: async (req) =>
    keepSubmitted(
      req,
      await antigravityAgentTurn(
        withEffort(req, req.resumeId ? req.prompt : `${req.systemAppend}\n\n${req.prompt}`),
      ),
    ),
  claude: async (req) => {
    const s = req.state;
    return claudeAgentTurn({
      ctx: s.ctx,
      prompt: req.prompt,
      resumeId: req.resumeId,
      cwd: s.cwd,
      mode: s.mode,
      policy: s.policy,
      metrics: s.metrics,
      effective: s.effective,
      routed: s.routed,
      systemAppend: req.systemAppend,
      settingSources: s.settingSources,
      nativeTools: s.nativeTools,
      agents: s.agents,
      live: s.live,
      onSubmit: (o) => (s.submitted = o),
      isSubmitted: () => !!s.submitted,
      persistSession: req.persistSession,
    });
  },
};
