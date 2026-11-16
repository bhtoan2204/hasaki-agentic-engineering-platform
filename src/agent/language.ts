/**
 * Two locales, kept separate:
 *   UI locale     — which language the React app renders (browser localStorage).
 *   Output locale — which language a run's agents and platform questions use.
 * A run stores its output locale. Changing the UI never rewrites that column or stored agent text.
 * Rows created before this column exist have output_locale NULL. New generation for those runs
 * falls back to Vietnamese; the UI must not present that fallback as a recorded choice.
 */

export const OUTPUT_LOCALES = ["vi", "en"] as const;
export type OutputLocale = (typeof OUTPUT_LOCALES)[number];

export function parseOutputLocale(v: unknown): OutputLocale | null {
  return v === "vi" || v === "en" ? v : null;
}

/**
 * Locale for a new run. Omitted means Vietnamese (API clients that predate the field).
 * Any other value is rejected — there is no silent coercion of "fr" or "english".
 */
export function resolveOutputLocale(v: unknown): OutputLocale {
  if (v === undefined || v === null || v === "") return "vi";
  const loc = parseOutputLocale(v);
  if (!loc) throw new Error("output_locale must be vi or en");
  return loc;
}

/** Locale to generate with. NULL (legacy) falls back to Vietnamese and stays NULL in the database. */
export function outputLocale(
  run: { output_locale?: string | null } | null | undefined,
): OutputLocale {
  return parseOutputLocale(run?.output_locale) ?? "vi";
}

const NAME: Record<OutputLocale, string> = { vi: "Vietnamese", en: "English" };

/**
 * One policy block for every model call that produces text a person reads.
 * The model is asked to write that language directly — there is no follow-up translation step.
 */
export function languagePolicy(locale: OutputLocale): string {
  const name = NAME[locale];
  return [
    "## Output language (mandatory)",
    `Write every user-facing natural-language value in ${name}.`,
    "This includes summaries, analysis, plans, explanations, findings, blocked reasons, questions, suggested answers, progress notes, reports, and repository-ranking reasons.",
    `Natural-language fields inside submit_result.output and any other JSON must also be in ${name}.`,
    "The task description, upstream step output, logs, and earlier messages may be in any language. Their language does not change this rule.",
    "Keep JSON property names, enums (including PASS, FAIL, BLOCKED, high, medium, low), IDs, file paths, commands, source code, URLs, and verbatim log or error evidence unchanged.",
    "Code, commit messages, and pull-request titles and descriptions stay in English (TECH-HD-001). Those are not the summaries shown inside this platform.",
    "Technical terms such as API, Kafka, Redis, and workflow may stay in English when that is the natural term.",
  ].join("\n");
}

/** Repeated on resume, retry, and repair turns, because a resumed Claude session does not receive the system prompt again. */
export function languageReminder(locale: OutputLocale): string {
  return `Continue in ${NAME[locale]}. Do not switch language to match the task, the logs, or earlier messages. JSON keys, enums, paths, commands, and code stay as specified in the output-language rules.`;
}
