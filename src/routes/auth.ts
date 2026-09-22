import express from "express";
import rateLimit from "express-rate-limit";
import passport from "passport";
import bcrypt from "bcryptjs";
import type { Db } from "../db.js";
import { consumePasswordSetupToken, deleteOtherSessionsByUser, isPasswordSetupTokenValid, requestPasswordReset, updateUserPassword } from "../repos/users_repo.js";
import { PASSWORD_CHANGE_LIMITER, PASSWORD_SETUP_LIMITER } from "../middleware/rate_limit.js";

export function createAuthRouter(_db: Db) {
  const router = express.Router();
  const loginLimiter = rateLimit({
    windowMs: 15 * 60 * 1000,
    max: 10,
    standardHeaders: true,
    legacyHeaders: false,
    message: "Too many login attempts. Try again later."
  });
  const resetLimiter = rateLimit({
    windowMs: 15 * 60 * 1000,
    max: 5,
    standardHeaders: true,
    legacyHeaders: false,
    message: "Too many reset requests. Try again later."
  });

  router.get("/login", (req, res) => {
    if (req.isAuthenticated && req.isAuthenticated()) {
      return res.redirect("/");
    }
    const error = req.query.error ? "Invalid email or password." : null;
    return res.render("login", { title: "Sign in", error });
  });

  router.post(
    "/login",
    loginLimiter,
    passport.authenticate("local", {
      successRedirect: "/",
      failureRedirect: "/auth/login?error=1"
    })
  );

  router.get("/change-password", (req, res) => {
    if (!req.isAuthenticated || !req.isAuthenticated()) {
      return res.redirect("/auth/login");
    }
    return res.render("change_password", { title: "Change password", error: null });
  });

  router.post("/change-password", PASSWORD_CHANGE_LIMITER, (req, res) => {
    if (!req.isAuthenticated || !req.isAuthenticated() || !req.user) {
      return res.redirect("/auth/login");
    }

    const password = String(req.body?.password ?? "");
    const confirm = String(req.body?.confirm ?? "");
    if (password.length < 12) {
      return res.render("change_password", {
        title: "Change password",
        error: "Password must be at least 12 characters."
      });
    }
    if (password !== confirm) {
      return res.render("change_password", {
        title: "Change password",
        error: "Passwords do not match."
      });
    }

    const hash = bcrypt.hashSync(password, 12);
    updateUserPassword(_db, req.user.id, hash);
    if (req.sessionID) deleteOtherSessionsByUser(_db, req.user.id, req.sessionID);
    return res.redirect("/");
  });

  router.get("/set-password/:token", (req, res) => {
    const token = String(req.params.token ?? "");
    if (!isPasswordSetupTokenValid(_db, token)) {
      return res.status(400).render("set_password", { title: "Set password", token: null, error: "This link is invalid or has expired." });
    }
    return res.render("set_password", { title: "Set password", token, error: null });
  });

  router.post("/set-password/:token", PASSWORD_SETUP_LIMITER, (req, res) => {
    const token = String(req.params.token ?? "");
    const password = String(req.body?.password ?? "");
    const confirm = String(req.body?.confirm ?? "");
    if (password.length < 12) {
      return res.status(400).render("set_password", { title: "Set password", token, error: "Password must be at least 12 characters." });
    }
    if (password !== confirm) {
      return res.status(400).render("set_password", { title: "Set password", token, error: "Passwords do not match." });
    }
    const userId = consumePasswordSetupToken(_db, token, bcrypt.hashSync(password, 12));
    if (!userId) {
      return res.status(400).render("set_password", { title: "Set password", token: null, error: "This link is invalid or has expired." });
    }
    return res.redirect("/auth/login?notice=password-set");
  });

  router.get("/request-reset", (_req, res) => {
    return res.render("reset_request", { title: "Reset password", notice: null });
  });

  router.post("/request-reset", resetLimiter, (req, res) => {
    const email = String(req.body?.email ?? "").trim().toLowerCase();
    if (email) {
      requestPasswordReset(_db, email);
    }
    return res.render("reset_request", {
      title: "Reset password",
      notice: "If the account exists, an admin will review the request."
    });
  });

  router.post("/logout", (req, res, next) => {
    req.logout((err) => {
      if (err) return next(err);
      req.session?.destroy(() => {
        res.redirect("/auth/login");
      });
    });
  });

  return router;
}
