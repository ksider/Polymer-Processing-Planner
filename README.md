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
├─ dist/                      # Compiled output (`npm run build`)
├─ data/im_doe.sqlite         # Runtime SQLite database (never commit it)
├─ plan.md                    # Product/feature roadmap
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
- `APP_ORIGIN=https://planner.example.com` (only when SMTP email is enabled)

## Authentication
- The first admin account is created on startup using `ADMIN_EMAIL` + `ADMIN_TEMP_PASSWORD`.
- `ADMIN_TEMP_PASSWORD` is used only for initial seeding. Changing it later does not update an existing admin password.
- After first login with the temp password, the admin must set a new password.
- New-user invitations and administrator password resets use a one-time, 30-minute password-setup link. With no SMTP configured, the administrator copies this link once and sends it via a secure channel.
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
- DOE generation/analysis uses one shared module across process types.
- Defaults are process-specific:
  - active factors by `process_type`,
  - active measured outputs by `process_type`.
- Analysis reads `analysis_run_values` first, and falls back to `run_values` by field code when needed (useful for migration/demo data).

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
