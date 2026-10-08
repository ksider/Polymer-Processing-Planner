import type { Db } from "../db.js";

export type EmailPurpose = "auth" | "notifications" | "reports" | "system";
export const EMAIL_PURPOSES: EmailPurpose[] = ["auth", "notifications", "reports", "system"];

export type EmailProviderProfile = {
  id: number;
  name: string;
  provider_kind: "resend";
  enabled: number;
  hasApiKey: boolean;
  created_at: string;
  updated_at: string;
};

export type EmailSenderProfile = {
  id: number;
  provider_profile_id: number;
  provider_name: string;
  purpose: EmailPurpose;
  name: string;
  from_name: string | null;
  from_email: string;
  reply_to: string | null;
  enabled: number;
  is_default: number;
};

export type EmailSenderForDelivery = EmailSenderProfile & { api_key_ciphertext: string };

export function listEmailProviderProfiles(db: Db): EmailProviderProfile[] {
  return db.prepare(
    `SELECT id, name, provider_kind, enabled, 1 as hasApiKey, created_at, updated_at
     FROM email_provider_profiles ORDER BY id DESC`
  ).all() as EmailProviderProfile[];
}

export function createResendProviderProfile(db: Db, input: { name: string; apiKeyCiphertext: string; actorUserId: number | null }): number {
  const now = new Date().toISOString();
  const result = db.prepare(
    `INSERT INTO email_provider_profiles (name, provider_kind, api_key_ciphertext, enabled, created_at, updated_at, updated_by)
     VALUES (?, 'resend', ?, 1, ?, ?, ?)`
  ).run(input.name, input.apiKeyCiphertext, now, now, input.actorUserId);
  return Number(result.lastInsertRowid);
}

export function deleteEmailProviderProfile(db: Db, id: number): void {
  db.prepare("DELETE FROM email_provider_profiles WHERE id = ?").run(id);
}

export function listEmailSenderProfiles(db: Db): EmailSenderProfile[] {
  return db.prepare(
    `SELECT s.id, s.provider_profile_id, p.name as provider_name, s.purpose, s.name, s.from_name,
            s.from_email, s.reply_to, s.enabled, s.is_default
     FROM email_sender_profiles s
     JOIN email_provider_profiles p ON p.id = s.provider_profile_id
     ORDER BY s.purpose, s.is_default DESC, s.id DESC`
  ).all() as EmailSenderProfile[];
}

export function createEmailSenderProfile(db: Db, input: Omit<EmailSenderProfile, "id" | "provider_name" | "enabled" | "is_default"> & { makeDefault: boolean; actorUserId: number | null }): number {
  const now = new Date().toISOString();
  const existing = db.prepare("SELECT COUNT(*) as count FROM email_sender_profiles WHERE purpose = ?").get(input.purpose) as { count: number };
  const isDefault = input.makeDefault || Number(existing.count) === 0 ? 1 : 0;
  const transaction = db.transaction(() => {
    if (isDefault) db.prepare("UPDATE email_sender_profiles SET is_default = 0 WHERE purpose = ?").run(input.purpose);
    const result = db.prepare(
      `INSERT INTO email_sender_profiles (provider_profile_id, purpose, name, from_name, from_email, reply_to, enabled, is_default, created_at, updated_at, updated_by)
       VALUES (?, ?, ?, ?, ?, ?, 1, ?, ?, ?, ?)`
    ).run(input.provider_profile_id, input.purpose, input.name, input.from_name || null, input.from_email, input.reply_to || null, isDefault, now, now, input.actorUserId);
    return Number(result.lastInsertRowid);
  });
  return transaction();
}

export function deleteEmailSenderProfile(db: Db, id: number): void {
  db.prepare("DELETE FROM email_sender_profiles WHERE id = ?").run(id);
}

export function getDefaultSenderForDelivery(db: Db, purpose: EmailPurpose): EmailSenderForDelivery | null {
  const row = db.prepare(
    `SELECT s.id, s.provider_profile_id, p.name as provider_name, s.purpose, s.name, s.from_name,
            s.from_email, s.reply_to, s.enabled, s.is_default, p.api_key_ciphertext
     FROM email_sender_profiles s
     JOIN email_provider_profiles p ON p.id = s.provider_profile_id
     WHERE s.purpose = ? AND s.enabled = 1 AND p.enabled = 1
     ORDER BY s.is_default DESC, s.id DESC LIMIT 1`
  ).get(purpose) as EmailSenderForDelivery | undefined;
  return row ?? null;
}

export function getSenderForDelivery(db: Db, id: number): EmailSenderForDelivery | null {
  const row = db.prepare(
    `SELECT s.id, s.provider_profile_id, p.name as provider_name, s.purpose, s.name, s.from_name,
            s.from_email, s.reply_to, s.enabled, s.is_default, p.api_key_ciphertext
     FROM email_sender_profiles s JOIN email_provider_profiles p ON p.id = s.provider_profile_id
     WHERE s.id = ? AND s.enabled = 1 AND p.enabled = 1`
  ).get(id) as EmailSenderForDelivery | undefined;
  return row ?? null;
}
