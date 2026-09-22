import type { Request, Response, NextFunction } from "express";
import type { Session } from "express-session";
import crypto from "crypto";

type CsrfSession = Session & {
  csrfToken?: string;
  csrfTokenGeneratedAt?: number;
};

const CSRF_TOKEN_LENGTH = 32;
const CSRF_TOKEN_NAME = "_csrf";

/**
 * Generate a new CSRF token and store it in the session
 */
export function generateCsrfToken(req: Request): string {
  if (!req.session) {
    throw new Error("CSRF protection requires session middleware to be enabled");
  }
  
  const session = req.session as CsrfSession;
  const token = crypto.randomBytes(CSRF_TOKEN_LENGTH).toString("hex");
  session.csrfToken = token;
  session.csrfTokenGeneratedAt = Date.now();
  return token;
}

/**
 * Get the current CSRF token from the session, generating one if needed
 */
export function getCsrfToken(req: Request): string {
  if (!req.session) {
    throw new Error("CSRF protection requires session middleware to be enabled");
  }
  
  const session = req.session as CsrfSession;
  if (!session.csrfToken) {
    return generateCsrfToken(req);
  }
  
  return session.csrfToken;
}

/**
 * Validate CSRF token from request body, query, or headers
 * Uses timing-safe comparison
 */
export function validateCsrfToken(req: Request): boolean {
  if (!req.session) {
    return false;
  }
  
  const session = req.session as CsrfSession;
  const sessionToken = session.csrfToken;
  
  if (!sessionToken) {
    return false;
  }
  
  // Try to get token from various sources
  let requestToken: string | undefined;
  
  // Check body first (forms)
  if (req.body && typeof req.body === "object" && CSRF_TOKEN_NAME in req.body) {
    requestToken = String((req.body as Record<string, unknown>)[CSRF_TOKEN_NAME]);
  }
  
  // Check query string (for GET requests that shouldn't have state changes, but included for completeness)
  if (!requestToken && req.query && typeof req.query === "object" && CSRF_TOKEN_NAME in req.query) {
    requestToken = String(req.query[CSRF_TOKEN_NAME]);
  }
  
  // Check headers (AJAX requests)
  if (!requestToken) {
    const headerToken = req.headers["x-csrf-token"] || req.headers["x-xsrf-token"] || req.headers["X-CSRF-Token"];
    if (headerToken && typeof headerToken === "string") {
      requestToken = headerToken;
    }
  }
  
  if (!requestToken) {
    return false;
  }

  const sessionBuffer = Buffer.from(sessionToken, "utf8");
  const requestBuffer = Buffer.from(requestToken, "utf8");
  if (sessionBuffer.length !== requestBuffer.length) {
    return false;
  }

  // Timing-safe comparison
  return crypto.timingSafeEqual(sessionBuffer, requestBuffer);
}

/**
 * Middleware to add CSRF token to response locals for views
 */
export function csrfTokenMiddleware(req: Request, res: Response, next: NextFunction) {
  try {
    const token = getCsrfToken(req);
    res.locals.csrfToken = token;
    res.locals.csrfTokenName = CSRF_TOKEN_NAME;
  } catch {
    // Session not available, but we don't want to break the app
    res.locals.csrfToken = "";
    res.locals.csrfTokenName = CSRF_TOKEN_NAME;
  }
  next();
}

/**
 * Middleware to validate CSRF token for state-changing requests
 * Skip validation for GET, HEAD, OPTIONS requests
 */
export function csrfProtectionMiddleware(req: Request, res: Response, next: NextFunction) {
  // Skip CSRF check for safe methods
  if (["GET", "HEAD", "OPTIONS"].includes(req.method)) {
    return next();
  }
  
  // Skip if not authenticated (will be handled by auth middleware)
  if (!req.isAuthenticated || !req.isAuthenticated()) {
    return next();
  }
  
  try {
    if (!validateCsrfToken(req)) {
      const wantsHtml = req.accepts("html");
      if (wantsHtml) {
        return res.status(403).render("error", {
          title: "Forbidden",
          message: "CSRF token validation failed. Please try again."
        });
      }
      return res.status(403).json({ error: "CSRF token validation failed" });
    }
  } catch {
    // If session is not available, we can't validate CSRF
    // This could happen in API-only contexts
    return next();
  }
  
  next();
}

/**
 * Create a CSRF validation middleware that can be applied selectively
 */
export function requireCsrf(req: Request, res: Response, next: NextFunction) {
  if (["GET", "HEAD", "OPTIONS"].includes(req.method)) {
    return next();
  }
  
  try {
    if (!validateCsrfToken(req)) {
      const wantsHtml = req.accepts("html");
      if (wantsHtml) {
        return res.status(403).render("error", {
          title: "Forbidden",
          message: "CSRF token validation failed."
        });
      }
      return res.status(403).json({ error: "CSRF token validation failed" });
    }
  } catch {
    return res.status(403).json({ error: "CSRF token validation failed" });
  }
  
  next();
}
