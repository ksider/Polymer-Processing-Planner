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

export async function sendTempPasswordEmail(to: string, tempPassword: string) {
  const config = getEmailConfig();
  if (!config) return false;

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
      subject: "Your temporary password",
      text: `Temporary password: ${tempPassword}\nPlease change it after first login.`
    });
    return true;
  } catch (error) {
    // Don't log the tempPassword in case of error
    console.error("Failed to send temp password email:", error);
    return false;
  }
}
