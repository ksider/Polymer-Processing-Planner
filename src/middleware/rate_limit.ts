import rateLimit from "express-rate-limit";
import type { Request, Response, NextFunction } from "express";

// Rate limiting configurations
const STRICT_LIMITER = rateLimit({
  windowMs: 15 * 60 * 1000, // 15 minutes
  max: 5, // limit each IP to 5 requests per windowMs
  standardHeaders: true,
  legacyHeaders: false,
  message: "Too many requests, please try again later.",
  skip: (req: Request) => {
    // Skip if not authenticated (will be handled by auth middleware)
    return !req.isAuthenticated || !req.isAuthenticated();
  }
});

const MODERATE_LIMITER = rateLimit({
  windowMs: 15 * 60 * 1000, // 15 minutes
  max: 20, // limit each IP to 20 requests per windowMs
  standardHeaders: true,
  legacyHeaders: false,
  message: "Too many requests, please try again later.",
  skip: (req: Request) => {
    return !req.isAuthenticated || !req.isAuthenticated();
  }
});

const GLOBAL_LIMITER = rateLimit({
  windowMs: 60 * 60 * 1000, // 1 hour
  max: 100, // limit each IP to 100 requests per windowMs
  standardHeaders: true,
  legacyHeaders: false,
  message: "Too many requests, please try again later.",
  skip: (req: Request) => {
    // Skip safe methods
    return ["GET", "HEAD", "OPTIONS"].includes(req.method);
  }
});

// Password change limiter - very strict
const PASSWORD_CHANGE_LIMITER = rateLimit({
  windowMs: 15 * 60 * 1000, // 15 minutes
  max: 3, // limit each IP to 3 password change attempts per windowMs
  standardHeaders: true,
  legacyHeaders: false,
  message: "Too many password change attempts. Please try again later.",
  skip: (req: Request) => {
    return !req.isAuthenticated || !req.isAuthenticated();
  }
});

const PASSWORD_SETUP_LIMITER = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 5,
  standardHeaders: true,
  legacyHeaders: false,
  message: "Too many password setup attempts. Please try again later."
});

// Admin action limiter - strict
const ADMIN_ACTION_LIMITER = rateLimit({
  windowMs: 15 * 60 * 1000, // 15 minutes
  max: 10, // limit each IP to 10 admin actions per windowMs
  standardHeaders: true,
  legacyHeaders: false,
  message: "Too many admin actions. Please try again later.",
  skip: (req: Request) => {
    // Only apply to admin users
    const user = req.user as { role?: string } | undefined;
    return !user || user.role !== "admin";
  }
});

// File upload limiter
const FILE_UPLOAD_LIMITER = rateLimit({
  windowMs: 60 * 60 * 1000, // 1 hour
  max: 10, // limit each IP to 10 file uploads per hour
  standardHeaders: true,
  legacyHeaders: false,
  message: "Too many file uploads. Please try again later.",
  skip: (req: Request) => {
    return !req.isAuthenticated || !req.isAuthenticated();
  }
});

// Export limiters
export {
  STRICT_LIMITER,
  MODERATE_LIMITER,
  GLOBAL_LIMITER,
  PASSWORD_CHANGE_LIMITER,
  PASSWORD_SETUP_LIMITER,
  ADMIN_ACTION_LIMITER,
  FILE_UPLOAD_LIMITER
};

// Create custom rate limiter with options
export function createRateLimiter(options: {
  windowMs?: number;
  max?: number;
  message?: string;
  skip?: (req: Request) => boolean;
} = {}) {
  return rateLimit({
    windowMs: options.windowMs ?? 15 * 60 * 1000,
    max: options.max ?? 10,
    standardHeaders: true,
    legacyHeaders: false,
    message: options.message ?? "Too many requests, please try again later.",
    skip: options.skip
  });
}
