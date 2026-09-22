import nodemailer from "nodemailer";

type EmailConfig = {
  host: string;
  port: number;
  user: string;
  pass: string;
  from: string;
};

function getEmailConfig(): EmailConfig | null {
  const host = process.env.SMTP_HOST;
  const port = Number(process.env.SMTP_PORT || 0);
  const user = process.env.SMTP_USER;
  const pass = process.env.SMTP_PASS;
  const from = process.env.SMTP_FROM;
  if (!host || !port || !user || !pass || !from) return null;
  return { host, port, user, pass, from };
}

export function isEmailConfigured(): boolean {
  return getEmailConfig() !== null;
}

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

export async function sendPasswordSetupEmail(to: string, path: string) {
  const config = getEmailConfig();
  const url = setupUrl(path);
  if (!config || !url) return false;

  const transporter = nodemailer.createTransport({
    host: config.host,
    port: config.port,
    secure: config.port === 465,
    requireTLS: config.port !== 465,
    auth: {
      user: config.user,
      pass: config.pass
    }
  });

  try {
    await transporter.sendMail({
      from: config.from,
      to,
      subject: "Set your IM Planner password",
      text: `Use this one-time link within 30 minutes to set your password:\n${url}`
    });
    return true;
  } catch (error) {
    // Never log the setup link: it grants password-setting access.
    console.error("Failed to send password setup email:", error);
    return false;
  }
}
