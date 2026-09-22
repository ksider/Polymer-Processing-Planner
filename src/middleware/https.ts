import type { Request, Response, NextFunction } from "express";
import type { Db } from "../db.js";
import { getAdminSettings } from "../repos/admin_settings_repo.js";

export function createHttpsRedirect(db: Db) {
  return (req: Request, res: Response, next: NextFunction) => {
    const settings = getAdminSettings(db);
    
    // Only explicitly local development and test environments may serve HTTP.
    // Treat a missing NODE_ENV as a secure deployment configuration.
    const isLocalRuntime = ["development", "test"].includes(process.env.NODE_ENV ?? "");
    const requireHttps = !isLocalRuntime || settings.require_https === 1;
    
    if (!requireHttps) return next();
    
    // Check if already HTTPS
    if (req.secure) return next();
    
    // Validate host header to prevent injection
    const host = req.headers.host;
    if (!host || typeof host !== "string") return next();
    
    // Basic host validation - reject invalid characters
    // Host should be a valid hostname: domain.tld or domain.tld:port
    if (!/^[a-zA-Z0-9.-]+(:\d+)?$/.test(host)) {
      return next();
    }
    
    return res.redirect(301, `https://${host}${req.originalUrl}`);
  };
}
