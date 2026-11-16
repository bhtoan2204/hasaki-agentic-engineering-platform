import { appendFileSync, existsSync } from "node:fs";
import { join } from "node:path";

// Transport fixtures still exercise real attempt progress: an inherited branch diff is never enough.
export function implementTransportFixture() {
  for (const path of JSON.parse(process.env.FAKE_TRANSPORT_WORKSPACES || "[]")) {
    const file = join(path, "implementation-evidence.txt");
    if (existsSync(file)) appendFileSync(file, "Implementation performed during this provider turn\n");
  }
}
