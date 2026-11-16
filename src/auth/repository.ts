import { pool, q, one, type Db } from "../db/pool.ts";

export interface UserRecord {
  id: number;
  username: string;
  role: string;
  active: boolean;
  password_hash: string;
}

export interface SessionRecord {
  id: number;
  username: string;
  role: string;
  active: boolean;
  csrf_token: string;
  expires_at: string;
  revoked_at: string | null;
}

export const authRepository = {
  findUserById(id: number, db: Db = pool): Promise<UserRecord | undefined> {
    return one<UserRecord>(
      db,
      "SELECT id, username, role, active, password_hash FROM users WHERE id = $1",
      [id],
    );
  },

  findUserByUsername(username: string, db: Db = pool): Promise<UserRecord | undefined> {
    return one<UserRecord>(
      db,
      "SELECT id, username, role, active, password_hash FROM users WHERE username = $1",
      [username],
    );
  },

  listAllUsers(
    db: Db = pool,
  ): Promise<Array<{ id: number; username: string; role: string; active: boolean }>> {
    return q<{ id: number; username: string; role: string; active: boolean }>(
      db,
      "SELECT id, username, role, active FROM users ORDER BY username",
    );
  },

  async insertUser(
    username: string,
    passwordHash: string,
    role: string,
    db: Db = pool,
  ): Promise<{ id: number; username: string; role: string; active: boolean }> {
    const row = await one<{ id: number; username: string; role: string; active: boolean }>(
      db,
      "INSERT INTO users (username, password_hash, role) VALUES ($1, $2, $3) RETURNING id, username, role, active",
      [username, passwordHash, role],
    );
    return row!;
  },

  updateUserPassword(
    userId: number,
    passwordHash: string,
    db: Db = pool,
  ): Promise<{ id: number } | undefined> {
    return one<{ id: number }>(
      db,
      "UPDATE users SET password_hash = $2, updated_at = now() WHERE id = $1 RETURNING id",
      [userId, passwordHash],
    );
  },

  updateUserActive(
    userId: number,
    active: boolean,
    db: Db = pool,
  ): Promise<{ id: number } | undefined> {
    return one<{ id: number }>(
      db,
      "UPDATE users SET active = $2, updated_at = now() WHERE id = $1 RETURNING id",
      [userId, active],
    );
  },

  async insertSession(
    userId: number,
    tokenHash: string,
    csrfToken: string,
    expiresAt: Date,
    db: Db = pool,
  ): Promise<void> {
    await q(
      db,
      "INSERT INTO sessions (user_id, token_hash, csrf_token, expires_at) VALUES ($1, $2, $3, $4)",
      [userId, tokenHash, csrfToken, expiresAt],
    );
  },

  findActiveSessionByHash(tokenHash: string, db: Db = pool): Promise<SessionRecord | undefined> {
    return one<SessionRecord>(
      db,
      `SELECT u.id, u.username, u.role, u.active, s.csrf_token, s.expires_at, s.revoked_at
         FROM sessions s JOIN users u ON u.id = s.user_id
        WHERE s.token_hash = $1`,
      [tokenHash],
    );
  },

  async revokeSessionsByUserId(userId: number, db: Db = pool): Promise<void> {
    await q(
      db,
      "UPDATE sessions SET revoked_at = now() WHERE user_id = $1 AND revoked_at IS NULL",
      [userId],
    );
  },

  async revokeSessionByHash(tokenHash: string, db: Db = pool): Promise<void> {
    await q(
      db,
      "UPDATE sessions SET revoked_at = now() WHERE token_hash = $1 AND revoked_at IS NULL",
      [tokenHash],
    );
  },

  async recordLoginAttempt(
    username: string,
    ip: string,
    success: boolean,
    db: Db = pool,
  ): Promise<void> {
    await q(db, "INSERT INTO login_attempts (username, ip, success) VALUES ($1, $2, $3)", [
      username,
      ip,
      success,
    ]);
  },

  async countFailedAttempts(
    username: string,
    ip: string,
    since: Date,
    db: Db = pool,
  ): Promise<{ byName: number; byIp: number }> {
    const [byName, byIp] = await Promise.all([
      one<{ n: number }>(
        db,
        "SELECT count(*)::int AS n FROM login_attempts WHERE username = $1 AND NOT success AND created_at > $2",
        [username, since],
      ),
      one<{ n: number }>(
        db,
        "SELECT count(*)::int AS n FROM login_attempts WHERE ip = $1 AND NOT success AND created_at > $2",
        [ip, since],
      ),
    ]);
    return {
      byName: byName?.n ?? 0,
      byIp: byIp?.n ?? 0,
    };
  },
};
