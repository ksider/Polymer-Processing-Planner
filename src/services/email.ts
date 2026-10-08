import type { Db } from "../db.js";
import {
  getDefaultSenderForDelivery,
  getSenderForDelivery,
  type EmailPurpose,
  type EmailSenderForDelivery
} from "../repos/email_profiles_repo.js";
import { decryptAppSetting } from "./settings_crypto.js";

function setupUrl(path: string): string | null {
  const configuredOrigin = process.env.APP_ORIGIN?.trim();
  if (!configuredOrigin) return null;
  try {
    const origin = new URL(configuredOrigin);
    if (origin.protocol !== "https:" && process.env.NODE_ENV === "production") return null;
    return new URL(path, origin.origin).toString();
  } catch {
    return null;
  }
}

function fromAddress(sender: EmailSenderForDelivery): string {
  return sender.from_name ? `${sender.from_name} <${sender.from_email}>` : sender.from_email;
}

export function isEmailConfigured(db: Db, purpose: EmailPurpose = "auth"): boolean {
  const sender = getDefaultSenderForDelivery(db, purpose);
  if (!sender) return false;
  // Authentication messages contain an absolute one-time URL. A sender can
  // still be tested without APP_ORIGIN, but a password link must not be sent
  // with a missing or unsafe public origin.
  return purpose !== "auth" || Boolean(setupUrl("/auth/set-password/check"));
}

export function isPasswordSetupOriginConfigured(): boolean {
  return Boolean(setupUrl("/auth/set-password/check"));
}

export function isAuthSenderConfigured(db: Db): boolean {
  return Boolean(getDefaultSenderForDelivery(db, "auth"));
}

export async function sendWithResend(sender: EmailSenderForDelivery, input: { to: string; subject: string; text: string; html?: string }): Promise<boolean> {
  let apiKey: string;
  try {
    apiKey = decryptAppSetting(sender.api_key_ciphertext);
  } catch {
    return false;
  }
  try {
    const response = await fetch("https://api.resend.com/emails", {
      method: "POST",
      headers: { Authorization: `Bearer ${apiKey}`, "Content-Type": "application/json" },
      body: JSON.stringify({
        from: fromAddress(sender),
        to: [input.to],
        ...(sender.reply_to ? { reply_to: sender.reply_to } : {}),
        subject: input.subject,
        text: input.text,
        ...(input.html ? { html: input.html } : {})
      }),
      signal: AbortSignal.timeout(10_000)
    });
    return response.ok;
  } catch {
    return false;
  }
}

export async function sendTestEmail(db: Db, senderId: number, recipient: string): Promise<boolean> {
  const sender = getSenderForDelivery(db, senderId);
  if (!sender) return false;
  return sendWithResend(sender, {
    to: recipient,
    subject: "IM Planner email delivery test",
    text: "This is a test email from IM Planner. If you received it, the selected Resend sender profile is configured correctly."
  });
}

export async function sendPasswordSetupEmail(db: Db, to: string, path: string) {
  const sender = getDefaultSenderForDelivery(db, "auth");
  const url = setupUrl(path);
  if (!sender || !url) return false;
  return sendWithResend(sender, {
    to,
    subject: "Set your IM Planner password",
    text: `Use this one-time link within 30 minutes to set your password:\n${url}`
  });
}
