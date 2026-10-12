import type { Db } from "../db.js";
import { createUser, findUserByEmail, type UserRow } from "../repos/users_repo.js";

const DEFAULT_DEMO_EMAIL = "demo@demo.local";

export function isDemoModeEnabled() {
  return String(process.env.DEMO_MODE_ENABLED ?? "").trim().toLowerCase() === "true";
}

export function getDemoEmail() {
  const configured = String(process.env.DEMO_USER_EMAIL ?? "").trim().toLowerCase();
  return configured || DEFAULT_DEMO_EMAIL;
}

export function isDemoUser(
  user: {
    email?: string | null;
    name?: string | null;
    role?: string | null;
    password_hash?: string | null;
    google_sub?: string | null;
  } | undefined
) {
  const email = user?.email?.trim().toLowerCase();
  return (
    email === getDemoEmail() &&
    user?.name === "Demo user" &&
    user?.role === "viewer" &&
    user?.password_hash == null &&
    user?.google_sub == null
  );
}

/**
 * The account deliberately has no password and is created only when demo mode
 * is enabled. An existing account is never changed, which prevents an email
 * configuration mistake from turning a real account into a public demo one.
 */
export function ensureDemoUser(db: Db): UserRow | null {
  if (!isDemoModeEnabled()) return null;

  const email = getDemoEmail();
  const existing = findUserByEmail(db, email);
  if (existing) {
    return isDemoUser(existing) && existing.status === "ACTIVE" ? existing : null;
  }

  createUser(db, {
    email,
    name: "Demo user",
    passwordHash: null,
    role: "viewer",
    status: "ACTIVE",
    tempPassword: 0
  });
  return findUserByEmail(db, email) ?? null;
}
