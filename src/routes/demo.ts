import express from "express";
import type { Db } from "../db.js";
import { ensureDemoUser, isDemoModeEnabled } from "../services/demo_mode.js";

export function createDemoRouter(db: Db) {
  const router = express.Router();

  router.get("/demo", (req, res, next) => {
    if (!isDemoModeEnabled()) return res.status(404).send("Not found");

    const demoUser = ensureDemoUser(db);
    if (!demoUser) {
      return res.status(503).send("Demo account is unavailable. Check DEMO_USER_EMAIL configuration.");
    }

    return req.login(demoUser, (error) => {
      if (error) return next(error);
      res.setHeader("Cache-Control", "no-store");
      return res.redirect("/");
    });
  });

  return router;
}
