import crypto from "node:crypto";

const CIPHER_VERSION = "v1";
const IV_BYTES = 12;
const AUTH_TAG_BYTES = 16;

export class AppSettingsEncryptionError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "AppSettingsEncryptionError";
  }
}

function encryptionKey(env: NodeJS.ProcessEnv = process.env): Buffer {
  const raw = env.APP_SETTINGS_ENCRYPTION_KEY?.trim();
  if (!raw) throw new AppSettingsEncryptionError("APP_SETTINGS_ENCRYPTION_KEY is required before storing email credentials.");
  if (/^[a-f0-9]{64}$/i.test(raw)) return Buffer.from(raw, "hex");
  if (/^[A-Za-z0-9+/]+={0,2}$/.test(raw)) {
    const decoded = Buffer.from(raw, "base64");
    if (decoded.length === 32) return decoded;
  }
  throw new AppSettingsEncryptionError("APP_SETTINGS_ENCRYPTION_KEY must be 32 bytes encoded as base64 or 64 hexadecimal characters.");
}

export function hasAppSettingsEncryptionKey(env: NodeJS.ProcessEnv = process.env): boolean {
  try { encryptionKey(env); return true; } catch { return false; }
}

export function encryptAppSetting(secret: string, env: NodeJS.ProcessEnv = process.env): string {
  const iv = crypto.randomBytes(IV_BYTES);
  const cipher = crypto.createCipheriv("aes-256-gcm", encryptionKey(env), iv);
  const encrypted = Buffer.concat([cipher.update(secret, "utf8"), cipher.final()]);
  return [CIPHER_VERSION, iv.toString("base64"), cipher.getAuthTag().toString("base64"), encrypted.toString("base64")].join(":");
}

export function decryptAppSetting(value: string, env: NodeJS.ProcessEnv = process.env): string {
  const [version, ivText, tagText, encryptedText, ...rest] = value.split(":");
  if (version !== CIPHER_VERSION || !ivText || !tagText || !encryptedText || rest.length) throw new AppSettingsEncryptionError("Stored email credential has an unsupported format.");
  try {
    const iv = Buffer.from(ivText, "base64");
    const tag = Buffer.from(tagText, "base64");
    const encrypted = Buffer.from(encryptedText, "base64");
    if (iv.length !== IV_BYTES || tag.length !== AUTH_TAG_BYTES || encrypted.length === 0) throw new Error("Invalid cipher payload");
    const decipher = crypto.createDecipheriv("aes-256-gcm", encryptionKey(env), iv);
    decipher.setAuthTag(tag);
    return Buffer.concat([decipher.update(encrypted), decipher.final()]).toString("utf8");
  } catch (error) {
    if (error instanceof AppSettingsEncryptionError) throw error;
    throw new AppSettingsEncryptionError("Stored email credential cannot be decrypted. Check APP_SETTINGS_ENCRYPTION_KEY.");
  }
}
