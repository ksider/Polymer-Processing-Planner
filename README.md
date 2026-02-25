<table>
  <tr>
    <td width="120">
      <img src="src/public/logo.svg" width="96" height="96" alt="Polymer Processing Planner logo" />
    </td>
    <td>
      <h1>Polymer Processing Planner</h1>
      <p>Local, offline planner for polymer processing.</p>
      <p><strong>Stack:</strong></p>
      <p>
        <img src="https://img.shields.io/badge/Node.js-20.x-1f6feb?style=flat&logo=node.js&logoColor=white" alt="Node.js" />
        <img src="https://img.shields.io/badge/Express-4.x-111111?style=flat&logo=express&logoColor=white" alt="Express" />
        <img src="https://img.shields.io/badge/SQLite-better--sqlite3-0b5fa5?style=flat&logo=sqlite&logoColor=white" alt="SQLite" />
        <img src="https://img.shields.io/badge/EJS-3.x-8c4b32?style=flat&logo=ejs&logoColor=white" alt="EJS" />
        <img src="https://img.shields.io/badge/PureCSS-3.x-2f9c74?style=flat&logo=css3&logoColor=white" alt="PureCSS" />
        <img src="https://img.shields.io/badge/ECharts-5.x-c23531?style=flat" alt="ECharts" />
        <img src="https://img.shields.io/badge/jStat-1.x-6a5acd?style=flat" alt="jStat" />
        <img src="https://img.shields.io/badge/Editor.js-2.x-2c2f36?style=flat" alt="Editor.js" />
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

## Install + Run
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
│  ├─ public/                 # Frontend assets (app.css, app.js, illustrations)
│  └─ tests/                  # Integration tests
├─ dist/                      # Compiled output (`npm run build`)
├─ im_doe.sqlite              # Local SQLite database
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

## Authentication
- The first admin account is created on startup using `ADMIN_EMAIL` + `ADMIN_TEMP_PASSWORD`.
- `ADMIN_TEMP_PASSWORD` is used only for initial seeding. Changing it later does not update an existing admin password.
- After first login with the temp password, the admin must set a new password.
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
8) Generate and edit reports (multiple reports per experiment).
9) Track Tasks on a kanban board inside each experiment.

Planned: export data to CSV.

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
- Reports can be signed inside the task popup (manager/engineer/admin).
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
- Report signature is restricted to the experiment owner.

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

## Report Plan (Next Work)
The current report plan lives at `report_plan` in the project root.

## Recent Changes (for handoff)
- Machine library now supports parameter tokens in the format `%machineId:paramId%`.
  These tokens can be used inside qualification setup inputs and custom fields.
- UI shows live previews for tokenized values; inputs keep the token, summaries display the resolved value.
- Step calculations resolve tokens at runtime (server + client), so values survive reloads.
- Machine edit page shows a small read-only token field next to each parameter for quick copy.
- Report generator now saves report configs per experiment (multiple reports per experiment).
- Report list lives inside the experiment, right after Detailed Optimization.
- Report editor (Editor.js) with seeded structure and embedded charts (rheology + process window).
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
- The SQLite database is `im_doe.sqlite` in this folder.
- Custom input/output fields are stored in the flexible `param_definitions` and `run_values` tables.
- SCREEN design is a sampled factorial (labeled in-app). For higher rigor, add a dedicated generator.

## Scripts
- `npm run dev` - start with hot reload
- `npm run build` - compile to `dist/`
- `npm run start` - run compiled output
