// Node test reporter for CI: one GitHub `::error` annotation per failing test (name, file, line, first lines of the
// error). Annotations are readable on the run page and through the public API, unlike the job log.
const data = (s) => String(s).replace(/%/g, "%25").replace(/\r/g, "%0D").replace(/\n/g, "%0A");
const prop = (s) => data(s).replace(/:/g, "%3A").replace(/,/g, "%2C");

export default async function* githubAnnotations(source) {
  for await (const event of source) {
    if (event.type !== "test:fail") continue;
    const { name, file, line, details } = event.data;
    const error = details?.error;
    // A suite that fails only because a subtest failed adds nothing: the subtest has its own annotation.
    if (error?.failureType === "subtestsFailed") continue;
    const cause = error?.cause ?? error;
    const message = String(cause?.message ?? cause ?? "failed").split("\n").slice(0, 12).join("\n");
    const where = file ? `file=${prop(file.replace(`${process.cwd()}/`, ""))},line=${line ?? 1},` : "";
    yield `::error ${where}title=${prop(name).slice(0, 200)}::${data(message).slice(0, 2000)}\n`;
  }
}
