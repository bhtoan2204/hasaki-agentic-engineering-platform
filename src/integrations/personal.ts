import { currentUserId } from "../auth/execution.ts";
import { getUserSecret, putUserSecret, deleteUserSecret } from "../auth/secrets.ts";

/** Memory sessions are isolated by authenticated actor (or persisted run owner), never process-global logins. */
export class PersonalSession<T> {
  private sessions = new Map<number, T>();
  get current(): T | null { return this.sessions.get(currentUserId() ?? 0) ?? null; }
  set current(value: T | null) {
    const id = currentUserId() ?? 0;
    if (!id && process.env.PLATFORM_TEST !== "1") throw new Error("Personal integration requires an authenticated execution owner");
    if (value === null) this.sessions.delete(id); else this.sessions.set(id, value);
  }
}

/** The authenticated actor (run owner inside a worker); the test owner under PLATFORM_TEST. */
export async function actorId() {
  const id = currentUserId();
  if (id) return id;
  if (process.env.PLATFORM_TEST === "1") return (await import("../auth/testOwner.ts")).ensureTestOwner();
  throw new Error("Personal integration requires an authenticated execution owner");
}

/** Old plaintext settings have no verifiable owner; retain them for admin review but never load them as a login. */
export const personalSettings = {
  async get(kind: string) {
    if (!currentUserId() && process.env.PLATFORM_TEST !== "1") return null;
    return getUserSecret(await actorId(), kind);
  },
  async set(kind: string, value: string) {
    const id = await actorId();
    if (value) await putUserSecret(id, kind, value); else await deleteUserSecret(id, kind);
  },
};
