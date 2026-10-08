<table>
  <tr>
    <td width="120">
      <img src="src/public/logo.svg" width="96" height="96" alt="Polymer Processing Planner logo" />
    </td>
    <td>
      <h1>Polymer Processing Planner</h1>
      <p>Local-first workspace for polymer processing experiments, qualification, DOE and controlled reports.</p>
      <p><strong>Stack:</strong></p>
      <p>
        <img src="https://img.shields.io/badge/Node.js-20.x-1f6feb?style=flat&logo=node.js&logoColor=white" alt="Node.js" />
        <img src="https://img.shields.io/badge/Express-4.x-111111?style=flat&logo=express&logoColor=white" alt="Express" />
        <img src="https://img.shields.io/badge/SQLite-better--sqlite3-0b5fa5?style=flat&logo=sqlite&logoColor=white" alt="SQLite" />
        <img src="https://img.shields.io/badge/EJS-3.x-8c4b32?style=flat&logo=ejs&logoColor=white" alt="EJS" />
        <img src="https://img.shields.io/badge/Tailwind_CSS-4.x-06b6d4?style=flat&logo=tailwindcss&logoColor=white" alt="Tailwind CSS" />
        <img src="https://img.shields.io/badge/Flowbite-UI_patterns-1c64f2?style=flat" alt="Flowbite UI patterns" />
        <img src="https://img.shields.io/badge/PureCSS-3.x-2f9c74?style=flat&logo=css3&logoColor=white" alt="PureCSS" />
        <img src="https://img.shields.io/badge/ECharts-5.x-c23531?style=flat" alt="ECharts" />
        <img src="https://img.shields.io/badge/jStat-1.x-6a5acd?style=flat" alt="jStat" />
        <img src="https://img.shields.io/badge/TipTap-3.x-2c2f36?style=flat" alt="TipTap" />
        <img src="https://img.shields.io/badge/DOCX-export-2f7d5d?style=flat" alt="DOCX export" />
        <img src="https://img.shields.io/badge/Ketcher-local-167782?style=flat" alt="Local Ketcher chemical editor" />
        <img src="https://img.shields.io/badge/Passport.js-0.6-1d2b3a?style=flat" alt="Passport.js" />
        <img src="https://img.shields.io/badge/bcryptjs-2.x-8b5a2b?style=flat" alt="bcryptjs" />
      </p>
    </td>
  </tr>
</table>

<p>
  <img src="visual/rheo_s.gif" alt="Polymer Processing Planner screenshot" />
  <br />
  <a href="https://youtu.be/0Hs7cjxP4B0" target="_blank" rel="noopener noreferrer">Watch on YouTube</a>
</p>

## Install and Run

Requirements: Node.js 20.x and npm.

```bash
npm install
npm run dev
```
Open `http://localhost:3000`.

### Configuration

Copy `.env.example` to `.env` and set the secrets before starting the server.
The real `.env`, SQLite files, and uploaded files must not be committed.

Important settings:

```dotenv
NODE_ENV=production
PORT=3000
DB_PATH=/app/data/im_doe.sqlite
SESSION_SECRET=<random-secret>
ADMIN_EMAIL=admin@example.com
ADMIN_TEMP_PASSWORD=<temporary-password>
TRUST_PROXY=1
ALLOWED_ORIGINS=https://planner.example.com

# DOE Analysis V2
DOE_ANALYSIS_V2_ENABLED=true
DOE_ANALYTICS_MODE=http
DOE_ANALYTICS_URL=http://analytics-r:8000
DOE_ANALYTICS_TIMEOUT_MS=15000

# Optional DOE AI assistant
DOE_ANALYSIS_LLM_ENABLED=true
LLM_SETTINGS_ENCRYPTION_KEY=<32-byte-base64-key>
```

`DOE_ANALYSIS_V2_ENABLED` controls the new analysis workspace. The R analytics
service is selected with `DOE_ANALYTICS_MODE=http`; `mock` is only for a
contract-only fallback. `LLM_SETTINGS_ENCRYPTION_KEY` is required when an
administrator stores an API key in Admin → AI providers. Generate it with:

```sh
openssl rand -base64 32
```

Keep this encryption key permanently. Changing it makes provider keys already
stored in SQLite unreadable until they are entered again.

## Admin UI modernization

The administrative interface is being migrated page by page to a stable,
standardized UI foundation: **Tailwind CSS 4 + Flowbite patterns**. The
application remains Express + TypeScript + EJS; React is not introduced for
this migration. The new admin layer is opt-in, full-width, and isolated so
legacy application pages can continue using their existing styles until they
are migrated.

The migration has introduced:

- shared Flowbite/Tailwind layout primitives for the admin sidebar, header,
  footer, forms, lists, tables, tabs, tooltips, dialogs and toast messages;
- server-rendered active navigation for standalone admin pages and
  no-reload switching for tabs inside `/admin`;
- full-width Parameter Library and Equipment pages with migrated equipment
  cards, custom fields, machine tokens and preserved filters;
- user administration with role/status indicators, avatars, activity details,
  access actions and direct chat links;
- an AI Monitor grouped by user, with expandable per-model token and request
  statistics, plus administrator-managed AI provider profiles;
- Settings sections for security, processes, integrations and entity
  controls;
- a formatted Logs & Audit console with internal scrolling, searchable safe
  fields and complete JSONL export;
- a first System Health page for database, analytics, email configuration and
  DOE background-job status.

### Resend email delivery

Email delivery is configured in **Admin → Settings** through Resend. The
Resend API key is entered there and stored encrypted in SQLite. The only
related environment secret is the master key:

```sh
APP_SETTINGS_ENCRYPTION_KEY="$(openssl rand -base64 32)"
```

Keep this value outside database backups and do not rotate it casually: stored
Resend credentials cannot be decrypted after the master key changes. Sender
profiles can be separated by purpose (`auth`, `notifications`, `reports`, and
`system`), each with its own From address and optional Reply-To address. New
user invitations and password resets use the default `auth` sender. A test
message can be sent from each saved profile in Settings; System Health checks
do not send email. When an invitation or reset is requested, the one-time link
is both sent through Resend and displayed once to the administrator as a
fallback. If delivery is not configured or fails, the same link remains
available for secure manual transfer.

The next planned admin slice is report-template governance with immutable
template versions. Secure media uploads are tracked as a shared future
capability, starting with equipment images.

### Docker deployment

For a server deployment using the published images, use
`docker-compose-ghcr.yml` in Portainer or Docker Compose:

```sh
docker compose -f docker-compose-ghcr.yml pull
docker compose -f docker-compose-ghcr.yml up -d
```

The file starts two services:

- `planner` — the web application on container port `3000`;
- `analytics-r` — the private R analytics service on container port `8000`.

Planner reaches R as `http://analytics-r:8000` through the private Compose
network. The analytics service does not need a host port mapping, and port
`8000` can be occupied on the host. The public reverse proxy should expose only
Planner (normally host port `3000`, or whatever port the proxy maps to it).

The GHCR compose file uses:

```yaml
planner:
  image: ghcr.io/ksider/polymer-planner:latest
analytics-r:
  image: ghcr.io/ksider/polymer-planner-analytics:latest
```

Both images are published by the repository GitHub Actions workflow. Updating
the deployment means pulling the new images and recreating both services; the
named volumes `planner_data` and `planner_uploads` preserve the database and
uploads.

After the first login, configure a provider in **Admin → AI providers**:

| Provider | Profile type | Base URL | API key |
| --- | --- | --- | --- |
| Mistral | OpenAI-compatible | `https://api.mistral.ai/v1` | Mistral API key |
| Gemini | OpenAI-compatible | `https://generativelanguage.googleapis.com/v1beta/openai` | Gemini API key |
| Ollama | Ollama | `http://ollama:11434` or the reachable Ollama URL | not required |

Set one enabled profile as **DOE default**. The URL is the provider base URL;
Planner appends the chat endpoint itself. For a Gemini or Mistral profile,
choose a model supported by that provider and set the maximum output tokens
high enough for the structured interpretation response.

Do not run `npm run analytics:r:setup` inside this production deployment. That
command is only for local development when Docker is not being used. The local
R service can be tested with:

```sh
npm run analytics:r:setup
npm run analytics:r:test
```

## Project Structure
```text
.
├─ src/
│  ├─ app.ts                  # Express app bootstrap
│  ├─ db.ts                   # SQLite connection + migrations
│  ├─ routes/                 # HTTP routes (auth, experiments, reports, notes, etc.)
│  ├─ services/               # Business logic (auth/report/tasks/qualification/markdown)
│  ├─ repos/                  # Data access layer (SQLite queries)
│  ├─ middleware/             # Auth/access/permission middlewares
│  ├─ domain/                 # Domain math/helpers (DOE imports/stats/designs)
│  ├─ views/                  # EJS pages + partials
│  ├─ public/                 # Frontend assets, including the local Ketcher build
│  │  ├─ chemical_structure_editor.js  # Shared chemical-editor adapter
│  │  └─ ketcher/             # Self-hosted Ketcher standalone application
│  └─ tests/                  # Integration tests
├─ analytics-r/               # Stateless R DOE analytics service
├─ contracts/                 # Cross-service data contracts
├─ docker-compose-ghcr.yml    # Production stack using GHCR images
├─ docker-compose.yml         # Local Docker build of both services
├─ dist/                      # Compiled output (`npm run build`)
├─ data/im_doe.sqlite         # Runtime SQLite database (never commit it)
└─ README.md
```

## Auth Env (Stage 0 Prep)
Create a `.env` file based on `.env.example` and set:
- `SESSION_SECRET`
- `ADMIN_EMAIL`
- `ADMIN_TEMP_PASSWORD`
- `GOOGLE_CLIENT_ID`
- `GOOGLE_CLIENT_SECRET`
- `DB_PATH=/app/data/im_doe.sqlite` (production container)
- `TRUST_PROXY=1` (one trusted local reverse proxy)
- `APP_ORIGIN=https://planner.example.com` (required for password-setup email links)
- `APP_SETTINGS_ENCRYPTION_KEY=<openssl rand -base64 32>` (required before saving a Resend API key in Admin → Settings)

## Authentication
- The first admin account is created on startup using `ADMIN_EMAIL` + `ADMIN_TEMP_PASSWORD`.
- `ADMIN_TEMP_PASSWORD` is used only for initial seeding. Changing it later does not update an existing admin password.
- After first login with the temp password, the admin must set a new password.
- New-user invitations and administrator password resets use a one-time, 30-minute password-setup link. Configure a default `auth` sender under Admin → Settings to deliver it through Resend; otherwise the administrator copies the link once and sends it through a secure channel.
- Passwords are stored as bcrypt hashes (not in plain text).
- Roles: `admin`, `manager`, `engineer`, `operator`, `viewer`.
- Access:
  - `admin` / `manager` see all experiments and processes.
  - `Process Owner` can access and manage experiments in their process.
  - `Experiment Owner` can manage their experiment and sign/unsign report.
  - entity assignees get access to assigned experiment entities.

## Core Flows
1) Open process list on `/`.
2) Open a specific process at `/<process_route_code>` (e.g. `/injection`).
3) Create an experiment in this process with recipes and machine assignment.
4) Run the 6‑step Scientific Molding qualification (each step has its own setup + runs).
5) Create multiple Detailed Optimization (DOE) studies under the same experiment.
6) Configure factors, generate runlists, and enter run data.
7) Review analysis (charts + heatmap + 3D when possible).
8) Create a report setup, assign its author and responsible signer, then open the text editor.
9) Insert qualification results, DOE analyses, run references, charts, tables and images into the report.
10) Save/export DOCX, send the completed report for signature, and sign it.
11) Track Tasks on a kanban board inside each experiment.
12) Use the internal messenger for direct chats, group chats, entity links, and system notifications.

## Routing Model
- Process list: `/`
- Process page: `/<process_route_code>` (configured in Process settings, admin-only)
- Experiment canonical URL: `/<process_route_code>/<experiment_id>`
- Legacy routes like `/experiments/:id` are still accepted and redirected/rewritten for compatibility.
- Process settings are available on the process page (`Process settings` dialog), not on the process cards.

## Task Manager
- Tasks live inside each experiment and are shown as a 4-column kanban (Init / In progress / Done / Failed).
- Create a task with title, description, due date, and owner (defaults to the experiment owner).
- Link tasks to entities:
  - Qualification steps (1–6)
  - DOE studies
  - Reports (signature required)
- Task progress is calculated from linked entities; tasks without entities are driven by manual status moves.
- Report tasks move with the report workflow: the author owns the drafting task; after submission, the responsible signer owns the signature task.
- Each task has calendar actions: download .ics or open a Google Calendar link.

## Entity Responsibility + Notifications
- Experiment owner (and admin/manager) can assign responsible users to:
  - Qualification steps
  - DOE studies
- Assignment creates/updates an automatic task for the assignee.
- Assignees get in-app notifications (with unread badge in top navigation).
- Profile page includes:
  - assigned entities list (entity + experiment links)
  - notifications feed with mark-read actions
- Report setup roles are explicit:
  - `author` writes the report and sends it for signature;
  - `responsible signer` signs after submission;
  - `admin` / `manager` can assign these roles and change controlled setup fields.

## Messenger (Current UX)
- Main page: `/messages`
- Room model:
  - direct chats
  - group chats
  - system notifications (shown separately in the right rail)
- Current thread features:
  - search in chat
  - unread separator (`New messages`)
  - per-room drafts
  - reply to message with jump to referenced message
  - pin/unpin messages
  - edit own messages with edit history
  - entity attachments in messages (`experiment`, `qualification_step`, `doe`, `report`)
  - reactions (`1 user -> 1 reaction per message`)
- Group chat management:
  - create group chats
  - add/remove participants
  - mentions for participants
- Notifications model:
  - system notifications do not mix into ordinary chat rooms
  - notifications live in a dedicated right-side column in Messenger
  - opening a notification marks it read and follows its entity link
  - the navigation bell opens Messenger rather than a duplicate notification feed
- Debug data:
  - use `npm run seed:messages -- --reset` to recreate demo chats/messages

## Calendar (Current UX)
- Two calendar surfaces are available:
  - `My Calendar` on `/me`
  - `Process Calendar` on `/<process_route_code>` (collapsible panel)
- Calendar events include:
  - tasks (`task`)
  - DOE runs (`run`)
  - qualification runs (`qual_run`)
- Date updates:
  - drag one event to move one entity
  - move a selected group by dragging one selected event
  - bulk move selected events with `Move selected` + date input
- Selection model:
  - `Shift/Cmd/Ctrl + click` toggles entity selection
  - lasso selection (mouse rectangle) selects intersecting events
  - click empty calendar area or `Clear selection` to drop selection
- Event click opens a details popup with:
  - event type/status/date/owner
  - link to run/task
  - link to parent entity/experiment
- Process calendar remembers panel open/closed state in browser `localStorage`.

## Process Model (Current)
- New DB entities:
  - `process_types`
  - `processes` (with `owner_user_id`, `route_code`, `status`)
  - `experiments.process_id`
- Startup migration ensures:
  - default type `Injection`
  - default type `Compounding (Twin-Screw Extrusion)`
  - default type `Coating`
  - default process `Injection Default Process`
  - default process `Compounding Default Process`
  - default process `Coating Default Process`
  - existing experiments are attached to default process

## Notes & Lab Journal
- Notes are available in a bottom drawer on:
  - Experiment page
  - Qualification step page
  - DOE page
  - Run page
  - Report page
- Full note feed is available at `/experiments/:id/journal`.
- Notes are entity-linked (`experiment`, `qualification_step`, `doe`, `run`, `report`, `task`).
- Daily mode:
  - `Ctrl/Cmd + Enter` appends to your current daily note in the same entity context.
  - `Ctrl/Cmd + Shift + Enter` forces a new note.
- Filters:
  - text search
  - date filter
  - entity-only toggle (in entity drawers)
- Soft-delete is enabled for `admin` / `manager`.
- The note editor supports formatted text, tables, links and resizable images. The shared chemical-editor adapter is loaded globally so the same structure workflow can be added to notes without a second integration.

## Qualification Packs (by Process Type)
Qualification is process-specific (6-step pack is selected by `process_type`):

- `Injection` (Scientific Molding):
1) Rheology / Viscosity curve  
2) Cavity balance  
3) Pressure drop  
4) Cosmetic process window  
5) Gate seal study  
6) Cooling time optimization

- `Compounding` (Twin-Screw Extrusion):
1) RTD / Residence Time Stability  
2) SME Map / Energy Window  
3) Melt Temperature / Thermal History Map  
4) Feeding / Side-Feeder Qualification  
5) Degassing / Moisture Control  
6) Dispersion / Mixing Quality Check

- `Coating` (Water/Solvent/Extrusion Coatings):
1) Rheology Window  
2) Wetting / Surface Energy Check  
3) Coat Weight Calibration  
4) Drying / Curing Window  
5) Adhesion Qualification  
6) Barrier / Functional Check

Implementation notes:
- Qualification step UI is process-specific:
  - `Injection` keeps Scientific Molding step-specific screens.
  - `Compounding` and `Coating` use an independent generic step editor (runs + fields), without cavity/rheology/gate-seal injection UI.
- Each qualification step is edited independently (`/experiments/:id/qualification/:step`): runs, values, assignee, and step fields are isolated per step.

## DOE (Shared Engine, Process-Specific Defaults)
- DOE generation and analysis use one shared module across process types.
- Defaults are process-specific: active factors, measured responses, and model
  templates are selected by process type.
- Measured responses are configured on the DOE Design page before runs are
  generated and can also be added later without regenerating runs.
- Analysis V2 stores named analyses and immutable calculation revisions bound to
  a dataset snapshot. It includes:
  - overview of completeness, factors, responses, blocks, and provenance;
  - hierarchical model terms, transforms, categorical blocks, and derived
    responses;
  - ANOVA, coefficients, model quality, lack-of-fit/pure-error diagnostics,
    residual diagnostics, Q-Q and run-order plots;
  - main effects, interaction, mean-with-confidence-interval, contour, and 3D
    response-surface views;
  - single- and multi-response optimization with confirmation-run warnings;
  - saved graph views, copyable tables, and analysis-ready CSV export for other
    DOE software;
  - deterministic p-value significance labels in ANOVA and coefficient tables.
- Analysis reads `analysis_run_values` first and falls back to `run_values` by
  field code when needed for migration/demo data.

### DOE AI assistant

The optional AI assistant is read-only with respect to the statistical model.
It can interpret only a saved analysis with a successful calculation revision;
it cannot change runs, factors, responses, model terms, or calculated results.

- Open it with the sparkle button beside **Calculation result**.
- Opening the dialog does not call a provider. A request is sent only after
  **Generate interpretation** is pressed.
- The provider receives compact calculated evidence, the experiment description
  when present, and the user's optional question — not the worksheet or API
  secrets.
- Results must pass the structured DOE response contract and evidence IDs are
  linked back to the existing result tables and charts.
- **Save interpretation** creates an immutable artifact tied to the exact
  analysis revision. Artifacts become visibly stale after recalculation.
- Provider API keys are configured by an administrator in **Admin → AI
  providers** and encrypted in SQLite. Supported profile types are
  OpenAI-compatible and Ollama.
- Gemini OpenAI-compatible profiles use
  `https://generativelanguage.googleapis.com/v1beta/openai` as the base URL;
  Planner appends `/chat/completions` automatically. Mistral and Gemini use a
  strict JSON schema response format.
- Personal token usage is available at `/me`; administrators see aggregate and
  per-user/provider/model usage in `/admin`. The views support 7-day, 30-day,
  90-day, and all-time periods.

## Roadmap

The current product direction is to keep experiment design and execution in
Planner while making DOE analysis a reproducible, saved workspace comparable to
Minitab or Origin.

### Completed

- Process-aware experiments, qualification packs, runs, assignments, calendar,
  messenger, notes, controlled reports, and audit/access controls.
- Analysis V2 with named analyses, immutable calculation revisions, dataset
  snapshots, ANOVA, coefficients, diagnostics, response surfaces, 2D/3D plots,
  saved graphs, optimizers, derived responses, templates, and analysis-ready
  CSV export.
- Separate R analytics service with a local contract-compatible fallback for
  development without Docker or R.
- Optional DOE AI assistant that interprets only saved successful revisions.
  Requests are explicit, responses can be saved as immutable interpretations,
  stale results are labelled, and token usage is visible to users and admins.

### In progress

- Continue the page-by-page admin UI migration and finish the remaining
  standardized Flowbite/Tailwind states and accessibility checks.
- Validate the R and AI provider paths with production-shaped DOE data.
- Validate Gemini, Mistral, Ollama, and other OpenAI-compatible profiles through
  the same structured response contract.
- Improve provider-failure diagnostics, accessibility, retention controls, and
  operational deployment checks.

### Next

- Extend multi-response desirability to calculated and binary responses.
- Add bounded derived-column expressions and before/after model diagnostics.
- Improve process-type template governance and advanced DOE diagnostics only
  where real workflows require them.
- Resume report insertion of saved analysis and AI artifacts after the analysis
  contract is stable.
- Remove the legacy DOE analysis only after parity, migration, and production
  verification.

The detailed implementation plans are intentionally kept as local working
documents and are excluded from version control; this README is the public
roadmap.

Reference book (Amazon search):
- Robust Process Development and Scientific Molding (Suhas Kulkarni): https://a.co/d/aDv52KL

## Reports

Each experiment can have multiple reports. A report has its own editable name and description; its initial description may be seeded from the experiment without changing the experiment itself.

### Setup and permissions

- `admin` and `manager` can select the author, responsible signer, report type, number, target date and signature SLA.
- The author can update only the report name and description while the report is still a draft.
- The report number is initially generated from the draft creation date and can be adjusted by a manager or administrator.
- Available standard templates: `Qualification`, `DOE`, and `Combined`.
- Draft editing belongs to the author. Once sent for signature, editing moves to the responsible signer. A signed report is read-only.

### Document editor

- The editor is TipTap-based and starts with a report outline rather than an empty page.
- Its source rail provides hierarchical experiment data, qualification results, DOE analyses, runs and their charts.
- The Insert tab can add tables, links, images, charts, source references and chemical structures.
- Image controls appear only when an image is selected and support width and alignment changes.
- The report document is stored as TipTap JSON plus an HTML snapshot and a Markdown representation.

### Chemical structures

- Ketcher is bundled locally under `src/public/ketcher`; no chemical structure is sent to an external editor service.
- In a report, choose **Insert → Chemical structure**, draw a molecule or reaction, then choose **Insert structure**.
- The visible result is a PNG for DOCX compatibility. The same image node preserves KET, MOL V3000 and SMILES so it can be reopened and edited later.
- Select a chemical-structure image to reveal its edit-structure action in the image toolbar.

### Signature and export

1. The author finishes the document and uses **Send for signature**.
2. The application records the submission timestamp, calculates the signature due date from the SLA, reassigns the report task and notifies the responsible signer.
3. The responsible signer signs or the author/manager recalls the report for revision.
4. DOCX export includes the configured report metadata, generated title information, document contents and signature information. Embedded PNG/JPEG/GIF/BMP images are supported.

## Recent Changes (for handoff)
- Admin UI migration started on a reusable Tailwind CSS + Flowbite foundation;
  the migrated admin pages use full-width layouts and keep the legacy
  application UI isolated.
- Admin Settings now supports encrypted Resend connections, multiple sender
  profiles by purpose, optional Reply-To addresses and explicit test sends.
- New-user invitations and administrator password resets use the configured
  Resend `auth` sender when one is available, with a secure manual-link
  fallback otherwise.
- System Health and background-job overview added as a separate admin page;
  health checks remain read-only and do not send email or retry jobs.
- Internal messenger added and expanded:
  - direct/group chats
  - separate system notifications rail
  - drafts, reply, pins, edit history
  - entity attachments
  - reactions with tooltip of reacting users
  - generated avatars with per-user avatar settings
- Machine library now supports parameter tokens in the format `%machineId:paramId%`.
  These tokens can be used inside qualification setup inputs and custom fields.
- UI shows live previews for tokenized values; inputs keep the token, summaries display the resolved value.
- Step calculations resolve tokens at runtime (server + client), so values survive reloads.
- Machine edit page shows a small read-only token field next to each parameter for quick copy.
- Report setup, drafting, signature routing and DOCX export are implemented per report.
- Report list lives inside the experiment, after Detailed Optimization.
- The report editor uses TipTap with seeded headings, source insertion and embedded qualification/DOE charts.
- Editable report documents are stored in `report_documents` and opened via `/reports/:id/editor`.

## Supported Recipe Import Formats
The importer accepts two common formats:

### 1) Matrix format
```
Component,Recipe A,Recipe B
Resin 1,50,60
Resin 2,50,40
Additive,3,2
```
- Column 0: component name
- Other columns: recipe name with PHR values

### 2) Two-row header (BPACKs style)
```
,Recipe A,,Recipe B,
,phr,,phr,
Resin 1,50,,60,
Resin 2,50,,40,
Additive,3,,2,
```
- Row 1 contains recipe names
- Row 2 contains `phr` under recipe columns
- Subsequent rows are components

## Notes
- The SQLite database is runtime data and must be stored outside the image, for example `data/im_doe.sqlite`.
- Custom input/output fields are stored in the flexible `param_definitions` and `run_values` tables.
- SCREEN design is a sampled factorial (labeled in-app). For higher rigor, add a dedicated generator.

## Scripts
- `npm run dev` - start with hot reload
- `npm run build` - compile to `dist/`
- `npm run start` - run compiled output
- `npm test` - run integration and regression tests
