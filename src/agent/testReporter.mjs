// Worker-owned Node reporter. Test stdout cannot supply evidence; only completed runner events count.
export default async function* report(events) {
  const files = new Map();
  for await (const event of events) {
    if (event.type !== "test:pass" && event.type !== "test:fail") continue;
    const { file, skip, todo, details } = event.data;
    if (!file) continue;
    const counts = files.get(file) ?? { passed: 0, failed: 0, skipped: 0 };
    if (skip || todo) counts.skipped++;
    else if (event.type === "test:fail") counts.failed++;
    else if (details?.type !== "suite") counts.passed++;
    files.set(file, counts);
  }
  // Emit only after the stream completes, so partial/truncated output cannot imply a whole-file pass.
  for (const [file, counts] of files) {
    yield JSON.stringify({ type: "platform:test-summary", file, complete: true, ...counts }) + "\n";
  }
}
