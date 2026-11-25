// Worker-owned Node reporter. Test stdout cannot supply evidence; only completed runner events count.
export default async function* report(events) {
  const files = new Map();
  for await (const event of events) {
    if (event.type !== "test:pass" && event.type !== "test:fail") continue;
    const { file, skip, todo, details, name, nesting } = event.data;
    if (!file) continue;
    const counts = files.get(file) ?? { passed: 0, failed: 0, skipped: 0, errored: 0 };
    const cause = details?.error?.cause;
    // A file that fails to load or exits abnormally is reported as one failing pseudo-test named after the file, with
    // no error object as cause. That is not a test failure (no assertion ran): counted apart, never as "failed".
    const fileLevel =
      event.type === "test:fail" &&
      nesting === 0 &&
      typeof name === "string" &&
      file.endsWith(name.replace(/^\.\//, "")) &&
      !(cause && typeof cause === "object" && "name" in cause);
    if (skip || todo) counts.skipped++;
    else if (fileLevel) counts.errored++;
    else if (event.type === "test:fail") counts.failed++;
    else if (details?.type !== "suite") counts.passed++;
    files.set(file, counts);
  }
  // Emit only after the stream completes, so partial/truncated output cannot imply a whole-file pass.
  for (const [file, counts] of files) {
    yield JSON.stringify({ type: "platform:test-summary", file, complete: true, ...counts }) + "\n";
  }
}
