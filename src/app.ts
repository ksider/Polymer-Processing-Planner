import "dotenv/config";
import express from "express";
import path from "path";
import crypto from "crypto";
import helmet from "helmet";
import { openDb } from "./db.js";
import { ensureSeedParams } from "./services/seed.js";
import { ensureAdminUser } from "./services/admin_seed.js";
import { configureAuth } from "./services/auth_setup.js";
import { createAuthRouter } from "./routes/auth.js";
import { ensureAuthenticated, ensureAdmin } from "./middleware/auth.js";
import { createAdminRouter } from "./routes/admin.js";
import { createHttpsRedirect } from "./middleware/https.js";
import { csrfTokenMiddleware, requireCsrf } from "./middleware/csrf.js";
import { xssProtectionMiddleware, escapeHtml } from "./middleware/xss.js";
import { configureCors } from "./middleware/cors.js";
import { createAuditRouter } from "./routes/audit.js";
import { createProfileRouter } from "./routes/profile.js";
import { createTasksRouter } from "./routes/tasks.js";
import { createMessagesRouter } from "./routes/messages.js";
import { createHomeRouter } from "./routes/home.js";
import { createRecipesRouter } from "./routes/recipes.js";
import { createExperimentsRouter } from "./routes/experiments.js";
import { createRunsRouter } from "./routes/runs.js";
import { createQualificationRouter } from "./routes/qualification.js";
import { createMachinesRouter } from "./routes/machines.js";
import { createReportRouter } from "./routes/report.js";
import { createUsersRouter } from "./routes/users.js";
import { createNotesRouter } from "./routes/notes.js";
import { createCalendarRouter } from "./routes/calendar.js";
import { buildBreadcrumbs } from "./services/breadcrumbs.js";
import { countUnreadMessageBoxes } from "./repos/messages_repo.js";
import { getProcessById, getProcessRouteCode } from "./repos/processes_repo.js";
import { getExperiment } from "./repos/experiments_repo.js";

export function createApp() {
  const app = express();
  app.disable("x-powered-by");
  const db = openDb();
  ensureSeedParams(db);
  ensureAdminUser(db);
  configureAuth(app, db);
  configureCors(app);

app.locals.formatNumber = (value: unknown, maxDecimals = 3) => {
  const num = typeof value === "number" ? value : Number(value);
  if (!Number.isFinite(num)) return "-";
  const abs = Math.abs(num);
  if (abs >= 1e6) {
    const exp = Math.floor(Math.log10(abs));
    const mant = num / Math.pow(10, exp);
    const mantText = mant.toFixed(2).replace(/\.?0+$/, "");
    return `${mantText}×10^${exp}`;
  }
  if (abs >= 10000) {
    const k = num / 1000;
    const kText = k.toFixed(2).replace(/\.?0+$/, "");
    return `${kText}k`;
  }
  const factor = Math.pow(10, maxDecimals);
  const rounded = Math.round(num * factor) / factor;
  const fixed = rounded.toFixed(maxDecimals);
  return fixed.replace(/\.?0+$/, "");
};

// Using xss middleware functions for consistent HTML escaping
// escapeHtml, escapeHtmlAttribute, etc. are available via res.locals

app.locals.formatInline = (value: unknown) => {
  const escaped = escapeHtml(value);
  // Allow only a safe subset of inline tags (no attributes) after escaping.
  const withTags = escaped
    .replace(/&lt;(\/?)(sup|sub|b|strong|i|em|u|s|strike|small|mark|code)&gt;/gi, "<$1$2>")
    .replace(/&amp;lt;(\/?)(sup|sub|b|strong|i|em|u|s|strike|small|mark|code)&amp;gt;/gi, "<$1$2>")
    .replace(/&lt;br\s*\/?&gt;/gi, "<br>")
    .replace(/&amp;lt;br\s*\/?&amp;gt;/gi, "<br>");
  return withTags
    .replace(/\s+(?=<(sup|sub)>)/gi, "")
    .replace(/<(sup|sub)>\s+/gi, "<$1>")
    .replace(/\s+<\/(sup|sub)>/gi, "</$1>");
};

app.locals.experimentPath = (value: unknown) => {
  if (typeof value === "number" || typeof value === "string") {
    const experimentId = Number(value);
    if (!Number.isFinite(experimentId)) return "/experiments/new";
    const experiment = getExperiment(db, experimentId);
    if (!experiment) return `/experiments/${experimentId}`;
    const process = experiment.process_id ? getProcessById(db, Number(experiment.process_id)) : null;
    const processCode = getProcessRouteCode(process);
    return processCode ? `/${processCode}/${experimentId}` : `/experiments/${experimentId}`;
  }
  const row = value as {
    id?: number | string;
    process_route_code?: string | null;
    process_type_code?: string | null;
    process_id?: number | null;
  } | null;
  const experimentId = Number(row?.id);
  if (!Number.isFinite(experimentId)) return "/experiments/new";
  let processCode = getProcessRouteCode({
    route_code: row?.process_route_code ?? null,
    process_type_code: row?.process_type_code ?? null
  } as { route_code: string | null; process_type_code?: string });
  if (!processCode && Number.isFinite(Number(row?.process_id || 0))) {
    const process = getProcessById(db, Number(row?.process_id));
    processCode = getProcessRouteCode(process);
  }
  return processCode ? `/${processCode}/${experimentId}` : `/experiments/${experimentId}`;
};

app.locals.processPath = (value: unknown) => {
  const processId = Number(value);
  if (!Number.isFinite(processId)) return "/";
  const process = getProcessById(db, processId);
  const processCode = getProcessRouteCode(process);
  return processCode ? `/${processCode}` : `/?process_id=${processId}`;
};

app.locals.avatarUrl = (userId: unknown) => {
  const id = Number(userId);
  return Number.isFinite(id) && id > 0 ? `/avatars/${id}.svg` : "";
};

app.locals.jsonForScript = (value: unknown) =>
  JSON.stringify(value ?? null)
    .replace(/</g, "\\u003c")
    .replace(/>/g, "\\u003e")
    .replace(/&/g, "\\u0026")
    .replace(/\u2028/g, "\\u2028")
    .replace(/\u2029/g, "\\u2029");

const viewsPath = path.resolve(process.cwd(), "src", "views");
const publicPath = path.resolve(process.cwd(), "src", "public");

app.set("view engine", "ejs");
app.set("views", viewsPath);
// Trust only the explicitly configured number of reverse-proxy hops.
// Never trust forwarded headers by default when the app is internet-facing.
const configuredTrustProxy = String(process.env.TRUST_PROXY ?? "").trim().toLowerCase();
const trustProxy = configuredTrustProxy === "true"
  ? 1
  : configuredTrustProxy === "false" || configuredTrustProxy === ""
    ? false
    : Number.isInteger(Number(configuredTrustProxy)) && Number(configuredTrustProxy) >= 0
      ? Number(configuredTrustProxy)
      : false;
app.set("trust proxy", trustProxy);

app.use((_req, res, next) => {
  res.locals.cspNonce = crypto.randomBytes(16).toString("base64");
  next();
});

app.use(
  helmet({
    contentSecurityPolicy: {
      directives: {
        defaultSrc: ["'self'"],
        scriptSrc: [
          "'self'",
          (_req, res) => `'nonce-${(res as express.Response).locals.cspNonce}'`,
          "'strict-dynamic'",
          "https://cdn.jsdelivr.net",
          "https://esm.sh",
          "https://unpkg.com"
        ],
        styleSrc: ["'self'", "'unsafe-inline'", "https://fonts.googleapis.com", "https://cdn.jsdelivr.net"],
        imgSrc: ["'self'", "data:", "https://api.dicebear.com", "https://fonts.googleapis.com"],
        fontSrc: ["'self'", "https://fonts.gstatic.com"],
        connectSrc: ["'self'"],
        frameSrc: ["'none'"],
        objectSrc: ["'none'"],
        baseUri: ["'self'"],
        formAction: ["'self'"],
        frameAncestors: ["'none'"]
      }
    },
    crossOriginEmbedderPolicy: false,
    hsts: {
      maxAge: 31536000, // 1 year
      includeSubDomains: true,
      preload: true
    },
    xFrameOptions: { action: "deny" },
    xContentTypeOptions: true,
    referrerPolicy: { policy: "strict-origin-when-cross-origin" }
  })
);

// Additional security headers
app.use((_req, res, next) => {
  // Expect-CT header for Certificate Transparency
  res.setHeader("Expect-CT", 'max-age=86400, enforce');
  
  // Additional security headers
  res.setHeader("X-Powered-By", "");
  res.setHeader("Server", "");
  
  next();
});

// Only the report editor needs a larger request body for locally embedded
// charts. Keep every other endpoint on a much smaller, DoS-resistant limit.
app.use("/reports/:reportId/editor", express.urlencoded({ extended: true, limit: "15mb", parameterLimit: 10 }));
app.use(express.json({ limit: "1mb" }));
app.use(express.urlencoded({ extended: true, limit: "1mb", parameterLimit: 1000 }));
app.use(express.static(publicPath));
app.use("/vendor", express.static(path.resolve(process.cwd(), "node_modules")));

app.use(createHttpsRedirect(db));
app.use(csrfTokenMiddleware);
app.use(xssProtectionMiddleware);
app.use((req, res, next) => {
  res.locals.currentUser = req.user ?? null;
  const wantsHtml = req.accepts(["html", "json"]) === "html";
  res.locals.breadcrumbs = wantsHtml ? buildBreadcrumbs(db, req) : [];
  res.locals.unreadNotifications = wantsHtml && req.user?.id
    ? countUnreadMessageBoxes(db, req.user.id)
    : 0;
  next();
});

app.use(requireCsrf);
app.use("/auth", createAuthRouter(db));

app.use((req, res, next) => {
  if (req.user?.temp_password) {
    const path = req.path;
    if (
      path !== "/auth/change-password" &&
      path !== "/auth/logout" &&
      !path.startsWith("/auth/login")
    ) {
      return res.redirect("/auth/change-password");
    }
  }
  return next();
});

app.use(ensureAuthenticated);
app.use("/admin", ensureAdmin, createAdminRouter(db));
app.use("/audit", createAuditRouter(db));
app.use(createProfileRouter(db));
app.use(createCalendarRouter(db));
app.use(createTasksRouter(db));
app.use(createMessagesRouter(db));
app.use(createHomeRouter(db));
app.use(createRecipesRouter(db));
app.use(createExperimentsRouter(db));
app.use(createRunsRouter(db));
app.use(createQualificationRouter(db));
app.use(createMachinesRouter(db));
app.use(createReportRouter(db));
app.use(createUsersRouter(db));
app.use(createNotesRouter(db));

  app.use((_req, res) => {
    res.status(404).send("Not found");
  });

  return app;
}
