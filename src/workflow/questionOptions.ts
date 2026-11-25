import type { QuestionInput } from "./types.ts";

/**
 * Question options are the answers a developer can pick: each one must be a decision or an instruction the step can act
 * on, never a restatement of the question or a request addressed to the developer. This is the single place that
 * decides what an option is, what is suggested, and what a submitted answer must contain.
 *
 * Contract (no schema change; options stay plain strings):
 *  - an option that ends with ":" is an instruction that needs the developer's details typed after the colon. It is
 *    never suggested and is not an answer by itself;
 *  - every other option is complete and can be sent as it is;
 *  - the suggested answer is the first complete option (an explicit suggestion wins when it is itself acceptable).
 */

export const needsDetails = (option: string) => /:\s*$/.test(option.trim());

const norm = (s: string) =>
  s
    .toLowerCase()
    .replace(/[^\p{L}\p{N}]+/gu, " ")
    .trim();

/** Wording that asks the developer to supply something instead of choosing something. */
const ADDRESSED_TO_USER =
  /\b(in|with|using) your (answer|reply|response)\b|^(please )?(provide|supply|give|send|tell|specify|clarify|enter)\b[^:]*\b(information|details|input|answer|missing)\b|(trong|bằng) câu trả lời của bạn/i;

/**
 * The options worth showing: trimmed, distinct, not a restatement of the question and not a request addressed to the
 * developer. Options that ask for details (ending with ":") are kept: they are the honest way to ask for input.
 */
export function cleanOptions(question: string, options: readonly unknown[] | undefined): string[] {
  const asked = norm(question);
  const seen = new Set<string>();
  const out: string[] = [];
  for (const raw of options ?? []) {
    const option = String(raw ?? "").trim();
    const key = norm(option);
    if (!key || seen.has(key)) continue;
    seen.add(key);
    if (!needsDetails(option)) {
      if (key === asked || (key.length >= 12 && asked.includes(key))) continue;
      if (ADDRESSED_TO_USER.test(option)) continue;
    }
    out.push(option);
  }
  return out;
}

/** What is stored for a question: the cleaned options and the answer the UI may pre-fill (null when none qualifies). */
export function questionRow(x: Pick<QuestionInput, "question" | "options" | "suggested_answer">): {
  options: string[];
  suggested: string | null;
} {
  const options = cleanOptions(x.question, x.options);
  const given = x.suggested_answer?.trim();
  const acceptable =
    given && !needsDetails(given) && cleanOptions(x.question, [given]).length ? given : null;
  return { options, suggested: acceptable ?? options.find((o) => !needsDetails(o)) ?? null };
}

/** Why an answer cannot be accepted (null = fine): an option that asks for details, sent without any. */
export function answerProblem(options: unknown, answer: string): string | null {
  const given = answer.trim().toLowerCase();
  const bare = (Array.isArray(options) ? options : []).find(
    (o) => typeof o === "string" && needsDetails(o) && o.trim().toLowerCase() === given,
  );
  return bare
    ? "This option needs your details: type them after the colon (" +
        String(bare).trim() +
        ") before sending."
    : null;
}
