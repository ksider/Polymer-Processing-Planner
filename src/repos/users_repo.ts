import type { Db } from "../db.js";

export type UserRow = {
  id: number;
  name: string | null;
  email: string;
  password_hash: string | null;
  google_sub: string | null;
  role: string | null;
  avatar_style_json: string | null;
  status: string;
  temp_password: number;
  reset_requested_at: string | null;
  created_at: string;
  last_login_at: string | null;
};

export type UserListRow = Omit<UserRow, "password_hash">;

export function findUserByEmail(db: Db, email: string): UserRow | undefined {
  return db.prepare("SELECT * FROM users WHERE email = ?").get(email) as UserRow | undefined;
}

export function findUserById(db: Db, id: number): UserRow | undefined {
  return db.prepare("SELECT * FROM users WHERE id = ?").get(id) as UserRow | undefined;
}

export function getUserPasswordHash(db: Db, id: number): string | null {
  const row = db.prepare("SELECT password_hash FROM users WHERE id = ?").get(id) as
    | { password_hash: string | null }
    | undefined;
  return row?.password_hash ?? null;
}

export function touchLastLogin(db: Db, id: number) {
  db.prepare("UPDATE users SET last_login_at = ? WHERE id = ?").run(new Date().toISOString(), id);
}

export function updateUserPassword(db: Db, id: number, passwordHash: string) {
  db.prepare("UPDATE users SET password_hash = ?, temp_password = 0 WHERE id = ?").run(passwordHash, id);
}

export function updateUserName(db: Db, id: number, name: string | null) {
  db.prepare("UPDATE users SET name = ? WHERE id = ?").run(name, id);
}

export function updateUserAvatarStyle(db: Db, id: number, avatarStyleJson: string | null) {
  db.prepare("UPDATE users SET avatar_style_json = ? WHERE id = ?").run(avatarStyleJson, id);
}

export function listUsers(db: Db): UserListRow[] {
  return db.prepare("SELECT id, name, email, google_sub, role, avatar_style_json, status, temp_password, reset_requested_at, created_at, last_login_at FROM users ORDER BY created_at DESC")
    .all() as UserListRow[];
}

export function requestPasswordReset(db: Db, email: string) {
  db.prepare("UPDATE users SET reset_requested_at = ? WHERE email = ?").run(new Date().toISOString(), email);
}

export function setTempPassword(db: Db, id: number, passwordHash: string) {
  db.prepare(
    "UPDATE users SET password_hash = ?, temp_password = 1, reset_requested_at = NULL WHERE id = ?"
  ).run(passwordHash, id);
}

export function createUser(
  db: Db,
  {
    email,
    name,
    passwordHash,
    role,
    status,
    tempPassword
  }: { email: string; name: string | null; passwordHash: string; role: string | null; status: string; tempPassword: number }
) {
  const createdAt = new Date().toISOString();
  const result = db.prepare(
    `INSERT INTO users (name, email, password_hash, role, avatar_style_json, status, temp_password, created_at)
     VALUES (?, ?, ?, ?, NULL, ?, ?, ?)`
  ).run(name, email, passwordHash, role, status, tempPassword, createdAt);
  return Number(result.lastInsertRowid);
}

export function updateUser(
  db: Db,
  id: number,
  { name, email, role, status }: { name: string | null; email: string; role: string | null; status: string }
) {
  db.prepare("UPDATE users SET name = ?, email = ?, role = ?, status = ? WHERE id = ?")
    .run(name, email, role, status, id);
}

export function setUserStatus(db: Db, id: number, status: string) {
  db.prepare("UPDATE users SET status = ? WHERE id = ?").run(status, id);
}

export function deleteUser(db: Db, id: number) {
  db.prepare("DELETE FROM users WHERE id = ?").run(id);
}

export function deleteSessionsByUser(db: Db, id: number) {
  db.prepare("DELETE FROM sessions WHERE user_id = ?").run(id);
}
