# DOE Analysis V2 — product and implementation plan

Status: draft for implementation planning.

Implementation status:

Current product priority — analysis workspace first. Report integration is
intentionally paused after its read-only saved-revision source was established.
The next implementation work belongs inside Analysis V2: single-response
optimization, then multi-response desirability, transformations, blocks, and
model comparison. Reports must consume these saved artifacts later, but do not
drive their interaction design.

- Phase 0 — in progress. Product terminology, the TypeScript dataset/analytics
  contracts, and cross-service JSON schemas are defined. Initial R numerical
  fixtures exist; review and approval of the golden values remain.
- Phase 1 — in progress. The isolated module skeleton, canonical dataset
  builder, raw/coded factors, response provenance, deterministic revision,
  read-only legacy audit command, access-scoped dataset endpoint, and foundation
  tests are implemented. Export/report adoption and review of an audit against
  the server database remain.
- Phase 2 — in progress. A switchable mock/HTTP client, validation and error
  contract, protected calculation endpoint, initial stateless R service,
  factorial/BBD model core, R numerical tests, private Compose service, and
  two-image CI/build configuration are implemented. Dependency locking, Docker
  verification on the server, richer DOE-specific outputs, and reviewed golden
  values remain.
- Phase 3 — in progress. A feature-flagged workspace shell now provides the
  analysis navigator placeholder, dataset overview, provenance warning,
  worksheet, basic model inspector, engine status, and semantic result tables.
  Saved navigation, richer completeness/design warnings, linked selection, and
  responsive drawer behavior remain.
- Measured-response schema management now belongs to DOE Design rather than the
  legacy analysis screen. Responses can be configured before run generation or
  added later without regenerating runs; adding a response changes the dataset
  revision so saved analyses can report their stale state.
- Phase 4 — complete. Named analysis definitions, immutable successful and
  failed calculation revisions, last-success preservation, revision history,
  dataset-revision stale detection, creation, recalculation, rename, duplicate,
  archive, restore, hierarchical model term selection with row-count feedback,
  an immutable per-analysis activity log, and persistent asynchronous
  calculation jobs with queued/running/completed/failed states are implemented.
- Phase 5 — in progress. Summary metrics, ANOVA, coefficients, run diagnostics,
  a Pareto-style standardized-effect chart, residuals-versus-fitted chart, and
  residual-point navigation to the source run are implemented. Model-based main
  effects, interaction plots, Q-Q diagnostics, run-order residuals, and a BBD
  response contour grid are also implemented. Interaction and response-surface
  factor pairs can be changed without recalculating; measured runs are overlaid
  on contours and link back to their source runs; every chart exports to PNG or
  SVG. Model quality now includes predicted R-squared and overall model
  significance; replicated settings split residual error into pure error and
  lack of fit, with an explicit warning when that test is not estimable. A 3D
  surface can be switched on for the selected factor pair. Run-bearing charts
  and measured surface points now share one selection with the worksheet, plus
  explicit actions to reveal or open the source run. Charts now name the
  selected response, its unit, and their factor coordinate system; selecting a
  standardized-effect bar links it to the corresponding ANOVA and coefficient
  rows. Remaining work is visual review with production DOE data.
- Phase 6 — in progress. The Analysis V2 workspace now exports an
  analysis-ready CSV of real numeric factors and measured numeric responses,
  suitable for direct import into external DOE software. The report catalogue
  now exposes saved successful Analysis V2 revisions through a read-only
  endpoint; report-editor insertion and snapshot metadata remain.
- Phase 7 — not started.
- Phase 8 — in progress. The first single-response optimizer is available in
  the analysis specification: minimize, maximize, or hit a target inside
  explicit physical factor bounds. It returns a bounded grid-search
  recommendation and a confirmation-run warning as part of the saved result.
  Multi-response desirability, transformations, blocks, comparison, and
  confirmation-run creation remain.

Implementation checkpoint — 2026-10-01:

- `npm run build` and all 18 Node tests pass;
- `Rscript analytics-r/tests/run_tests.R` passes without external R web
  dependencies;
- local Planner development auto-selects a project-local `Rscript` client when
  R and `analytics-r/library/jsonlite` are available, otherwise it falls back
  to the contract mock; Docker is not required for local calculations;
- the end-to-end local R path was checked against the filled 27-run FFA in the
  working database and returned 7 coefficients, 7 ANOVA rows, and R-squared of
  approximately 0.9923;
- production defaults to the private `analytics-r` HTTP service and fails only
  the requested calculation when that service is unavailable;
- a read-only audit of the current local working database found 10 DOE studies,
  162 measurement-only values, 192 legacy-only values, no conflicts or
  ambiguous duplicates, and 2003 missing run/response cells. Missing cells are
  inventory information, not automatically migration errors;
- the old DOE analysis UI and calculations are still unchanged and remain the
  comparison implementation during the V2 rollout.

## 1. Purpose

Replace the current fixed DOE analysis page with a flexible, reproducible
analysis workspace comparable in workflow to Minitab or Origin, while keeping
DOE design, run generation, execution, permissions, reports, and audit inside
Planner.

The core product change is:

- from one transient page with a fixed response, X, Y, and four charts;
- to a collection of named, saved analyses bound to a known revision of the
  DOE dataset.

The analysis implementation becomes a separate feature module. Planner remains
the owner of users, access control, SQLite data, runs, reports, and UI. A small
internal R service performs statistical calculations and returns structured
results. It does not own the database and does not render application pages.

## 2. Decisions already made

1. DOE Analysis V2 is a separate vertical module, not more logic added to
   `routes/experiments.ts` or `views/doe_detail.ejs`.
2. Statistical calculations run server-side.
3. The statistical engine is an internal R service, initially based on base R,
   `rsm`, `FrF2`, `DoE.base`, `emmeans`, `broom`, and `jsonlite`.
4. R receives a validated dataset and analysis specification from Planner and
   returns semantic JSON. R does not read or write Planner SQLite directly.
5. Planner renders result tables and interactive charts using the existing web
   stack and ECharts.
6. R must not return HTML fragments or make UI decisions.
7. Perspective is not required for the first release. It may later be evaluated
   for an advanced data-exploration worksheet only.
8. The Planner and R service stay in the same Git repository and are built as
   two Docker images by GitHub Actions.
9. Local development must remain possible without Docker and without R by using
   a contract-compatible mock analytics client.
10. Old analysis code is removed after functional parity and migration. It is
    not kept as a permanent second analysis implementation.

## 3. Product model

### 3.1 First-class entities

A DOE study contains runs and measurements as it does today. In addition, it
contains named analyses.

Each analysis has:

- name and description;
- response or responses;
- selected dataset scope and filters;
- model terms and statistical options;
- author and timestamps;
- source dataset revision;
- one or more calculation revisions;
- result tables, warnings, predictions, and chart configurations;
- current state: draft, calculated, stale, failed, or archived.

Changing a selector must not silently replace a previous analysis. The user can
update the current analysis, duplicate it, or create another analysis.

### 3.2 Workspace layout

The Analysis tab becomes a workspace with four primary areas:

1. Analysis navigator
   - named saved analyses;
   - status and response;
   - create, duplicate, rename, archive, and compare actions.
2. Main result canvas
   - overview, model, effects, diagnostics, surface, optimizer, and data views;
   - one selected analysis at a time.
3. Configuration inspector
   - dataset scope, response, terms, blocks, transformations, and chart options;
   - basic and advanced modes.
4. Data worksheet
   - one row per run;
   - available as a main subview or expandable lower panel;
   - linked selection with charts.

On a narrow screen, the navigator and inspector become drawers. The result
canvas remains the primary surface.

### 3.3 Workspace sections

#### Overview

Overview answers whether the DOE data is ready for analysis. It shows:

- total, complete, incomplete, included, and excluded runs;
- response completeness and missing values;
- replicates and center points;
- active factors, ranges, levels, and units;
- recipes and blocks;
- design type and estimability warnings;
- aliasing or confounding warnings when applicable;
- last data change and last analysis calculation.

#### Data

The worksheet shows:

- run ID, code, order, state, and exclusion state;
- recipe/block and replicate metadata;
- raw factor values;
- coded factor values where supported;
- measured responses;
- tags and boolean quality fields;
- predicted values and residuals after a model is calculated.

Column headers identify the role and unit of each column. Users can filter,
sort, hide columns, switch between raw and coded factors, and navigate to the
original run. Data filters are saved with the analysis.

Filtering a calculated analysis must not silently mutate its result. Planner
offers to update the analysis or create a copy.

#### Model

Basic mode asks for:

- response;
- included run scope;
- recipe or block treatment;
- model type suggested from the design.

Suggested defaults:

- screening design: main effects;
- two-level full or fractional factorial: estimable main effects and selected
  interactions;
- BBD: second-order response-surface model;
- boolean response: binary model when supported;
- tag response: frequency or derived binary response when supported;
- SIM or arbitrary run matrix: descriptive or explicitly selected regression,
  without claiming design-specific inference.

Advanced mode additionally exposes:

- individual model terms;
- interactions;
- quadratic terms;
- categorical factors and blocks;
- response and factor transformations;
- confidence level;
- missing-data policy;
- weighting and robust options when supported.

The UI must prevent obviously invalid term selections and must explain terms
that cannot be estimated from the current design.

#### Summary

The top of a calculated analysis shows:

- response and model name;
- dataset revision and number of used/excluded rows;
- R-squared, adjusted R-squared, and predicted R-squared where available;
- overall model significance;
- lack-of-fit and pure error where estimable;
- the most influential effects;
- warnings and interpretation hints.

The summary must distinguish descriptive evidence from inferential results and
must not convert p-values into an automatic process decision.

#### Effects

Effects contains:

- ANOVA table;
- coefficients and confidence intervals;
- standardized effects;
- Pareto chart;
- normal or half-normal effect plot;
- main-effects plots;
- interaction plots;
- alias/confounding information;
- cube plot where appropriate.

Selecting an effect in a table highlights its corresponding chart and opens the
relevant plot when possible.

#### Diagnostics

Diagnostics initially provides:

- residuals versus fitted values;
- normal Q-Q plot;
- residuals versus run order;
- leverage and influence;
- an explicit list of runs associated with unusual observations.

Selecting a point highlights the same run in every linked chart and in the
worksheet. A user can navigate to the run, but exclusion remains an explicit
run-level action with a reason; clicking a diagnostic point must not silently
exclude it.

#### Surface

For supported response-surface models:

- fitted contour plot;
- fitted 3D surface;
- two selectable axis factors;
- controls to hold other factors at chosen values;
- actual experimental points overlaid on the fitted surface;
- interpolation domain and extrapolation warning;
- predicted response at the selected factor combination;
- confidence or prediction interval where available.

The current color-coded scatter must not be labelled as a response surface.

#### Optimizer

Multi-response optimization is a later delivery stage but is part of the target
product. For each response, the user can choose minimize, maximize, target, or
range and specify importance. The result shows:

- recommended factor settings;
- predicted responses and intervals;
- individual and combined desirability;
- alternative solutions;
- whether the solution is inside the studied domain;
- an action to create confirmation runs.

#### Free graph builder

The target workspace also supports graphs not tied to one statistical model.
Users can assign columns to X, Y, color, facet, size, or label and choose:

- raw values or aggregation;
- mean, SD, confidence interval, or prediction interval;
- grouping and faceting;
- fitted model overlay;
- axis scale and limits;
- labels, annotations, and run codes.

This is scheduled after the guided DOE result experience. The first release
uses curated DOE graphs with limited configuration.

### 3.4 Saved results and reproducibility

An analysis calculation is a versioned snapshot. It stores:

- normalized analysis specification;
- source dataset revision;
- engine and package versions;
- result payload;
- calculation time and user;
- warnings and failures;
- persisted chart configurations.

When source data changes, the analysis becomes stale but the previous result
remains viewable. The user can recalculate it or duplicate it. Reports use an
explicit snapshot and never change automatically after signing.

### 3.5 Linked interactions

Where meaningful, the following selections are linked:

- worksheet row and chart point;
- residual and original run;
- ANOVA or coefficient term and its effects/interaction plot;
- selected surface point and predicted response;
- report source item and saved analysis revision.

## 4. Module boundaries

### 4.1 Planner module

Create a vertical feature module under `src/modules/doe_analysis/`. It owns:

- analysis routes and controllers;
- DTO and contract validation;
- canonical DOE dataset construction;
- dataset revision calculation;
- analysis specification validation;
- persistence of analyses and revisions;
- R analytics client and mock client;
- result normalization for the UI;
- permissions and audit integration;
- report-source integration.

New views belong under `src/views/doe_analysis/`. Module-specific browser code
and styles should be isolated from the large existing DOE page as far as the
current asset pipeline allows.

The module must not depend on helpers embedded inside `routes/experiments.ts`.
Shared run and parameter access should go through repositories or dedicated
read services.

### 4.2 R analytics service

Create `analytics-r/` in the same repository. It owns:

- health and engine-information endpoints;
- request validation at the service boundary;
- conversion of the canonical dataset to R structures;
- factorial and response-surface analyses;
- diagnostics, predictions, and optimization calculations;
- stable serialization of results;
- statistical unit tests and golden fixtures.

It does not own:

- authentication or browser sessions;
- experiment access rules;
- Planner database access;
- HTML templates;
- report documents;
- business decisions based on statistical output.

The R service is stateless. It can be restarted or scaled without migrating
application state.

### 4.3 Communication and failure behavior

Planner calls the R service on the private Docker network. Calls require:

- request timeout;
- payload size limit;
- contract version;
- correlation/request ID;
- engine version in every successful response;
- structured validation and calculation errors;
- no automatic infinite retry.

If R is unavailable, run entry, DOE design, and historical analysis viewing
remain available. New calculations show an actionable service-unavailable
state. A failed calculation must not replace the last successful result.

## 5. Canonical DOE dataset

### 5.1 Purpose

All analysis, export, reports, and future notebook integration must read through
one canonical dataset builder. This removes duplicated assembly logic and hides
legacy storage differences.

### 5.2 Dataset content

The dataset contains:

- schema and contract version;
- DOE and experiment identifiers;
- design type and metadata;
- column definitions with stable keys, labels, units, types, and roles;
- factor coding and levels;
- run rows;
- inclusion/exclusion state and reason;
- recipe/block and replicate metadata;
- raw and coded factor values;
- response values;
- tags and boolean quality values;
- data provenance for each response column;
- deterministic dataset revision/hash.

### 5.3 Dataset rules

1. One row represents one run.
2. Only columns relevant to the DOE are exposed by default; inactive global
   parameters full of nulls are not emitted as ordinary factors.
3. Missing is distinct from zero, false, empty text, and an empty tag list.
4. Categorical and numeric roles are explicit, not inferred only from current
   values.
5. Recipe is represented as a categorical block when configured as a block.
6. Replicate identity is preserved.
7. Coded levels are matched to stable run identity, not only array position.
8. Excluded and unfinished runs remain visible in the dataset, with inclusion
   controlled by the analysis specification.
9. The dataset builder records whether a response came from the canonical
   measurement table or a legacy fallback.

### 5.4 Dataset revision

The revision changes when any analysis-relevant state changes, including:

- factor or response value;
- run exclusion or inclusion-relevant completion state;
- recipe/block or replicate assignment;
- factor configuration or coding;
- response definition used by the analysis.

Labels and purely visual preferences should not invalidate a statistical result
unless they change the meaning or identity of a column.

## 6. Persistence model

Final table names are decided during schema design, but the model must support:

### Analysis definition

- DOE ID;
- name and optional description;
- normalized specification JSON;
- state and archived timestamp;
- owner/creator and audit timestamps;
- pointer to the latest successful revision.

### Analysis calculation revision

- analysis ID;
- dataset revision;
- request/contract version;
- engine and package versions;
- result JSON;
- status, warnings, and structured failure;
- calculated by and calculated at.

### Saved graph/view

- analysis or DOE scope;
- graph type;
- semantic source reference;
- visualization configuration;
- title and order;
- creator and timestamps.

Large result payloads should remain bounded. The schema design must define
whether surface grids and row-level diagnostics stay in result JSON or move to
separate storage if real datasets prove them too large.

## 7. Statistical scope

### 7.1 First supported analyses

1. Descriptive data summary and completeness.
2. Two-level factorial/screening analysis:
   - main effects;
   - supported interactions;
   - ANOVA and coefficients;
   - alias information;
   - Pareto and half-normal effects;
   - main-effects and interaction plots;
   - residual diagnostics.
3. BBD/response-surface analysis:
   - first- and second-order models;
   - ANOVA;
   - pure error and lack-of-fit when estimable;
   - stationary point and canonical analysis;
   - contour and fitted surface grids;
   - residual diagnostics.
4. Ordinary regression for explicitly selected arbitrary run matrices, clearly
   labelled as regression rather than design-specific inference.

### 7.2 Later analyses

- binary response models;
- tag-to-binary response derivation;
- multi-response desirability optimization;
- weighted and robust regression;
- transformation suggestions;
- confirmation-run workflow;
- sequential DOE recommendations;
- model comparison;
- user-defined derived columns;
- reusable analysis templates by process type.

### 7.3 Statistical safeguards

The engine and UI must surface, not hide:

- insufficient degrees of freedom;
- singular or rank-deficient models;
- aliased terms;
- missing pure-error estimate;
- invalid lack-of-fit request;
- extrapolation outside the design domain;
- insufficient data for diagnostics;
- excessive missingness;
- unsupported mixture of design and model terms.

Planner must not label a model as valid based only on R-squared.

## 8. Result and visualization contract

R returns semantic result objects rather than presentation HTML or images.
Planner renders them using controlled components.

Result families include:

- metrics;
- ANOVA rows;
- coefficient/effect rows;
- alias groups;
- warnings;
- fitted and residual row data keyed by run ID;
- main-effect series;
- interaction series;
- Q-Q points;
- leverage/influence points;
- contour/surface grids;
- stationary-point and optimizer results.

Charts persist configuration separately from calculation data. This allows a
user to change an axis, grouping, error interval, annotation, or style without
rerunning the statistical model when the underlying result already contains
the required data.

Every chart supports, where meaningful:

- interactive tooltip;
- run selection and navigation;
- accessible table alternative;
- export as SVG or PNG;
- insertion into a report as a snapshot;
- source analysis and revision metadata.

## 9. Report integration

The report source catalogue must stop recomputing the legacy DOE analysis.
Instead it lists saved analyses and their successful revisions.

An author can insert:

- analysis summary;
- ANOVA table;
- coefficients/effects table;
- selected saved chart;
- optimizer recommendation;
- a complete controlled analysis section.

Inserted report content is a snapshot containing non-visual source metadata:

- DOE and analysis IDs;
- analysis revision;
- dataset revision;
- engine version;
- captured time.

Before signing, the existing source-update check can report that an analysis is
stale or has a newer revision. Signed reports remain immutable.

## 10. Permissions and audit

Initial permission model:

- users who can view the DOE can view saved analyses;
- users who can manage the experiment or are responsible for the DOE can create,
  edit, duplicate, recalculate, and archive analyses;
- viewers cannot cause R calculations unless explicitly allowed later;
- report permissions remain governed by the report workflow.

Audit events should cover:

- analysis created, renamed, duplicated, or archived;
- specification changed;
- calculation started, completed, or failed;
- stale analysis recalculated;
- run excluded or restored from a diagnostic workflow;
- analysis result or chart inserted into a report.

## 11. Legacy data and cleanup strategy

### 11.1 What is legacy calculation/UI code

The following is replaced by Analysis V2:

- analysis assembly inside `routes/experiments.ts`;
- fixed mean-by-factor, heatmap, scatter, and color-scatter calculations;
- regression limited to the first three active factors;
- analysis controls and inline ECharts code inside `views/doe_detail.ejs`;
- report-source analysis that independently repeats the same calculations;
- duplicate run/wide export assembly paths;
- direct feature code depending on `buildAnalysisValueMapWithFallback`.

### 11.2 What is not removed immediately

`analysis_fields` and `analysis_run_values` currently represent measurement
definitions and entered response values. They are not merely old chart state.
They remain the canonical response-entry storage during the first V2 stages.

The initial migration does not rename these tables. Renaming them to response-
or measurement-oriented names can be considered only after all call sites use
the new module and a separate migration benefit is demonstrated.

### 11.3 Resolve the dual response storage

Current response data may exist in either:

- `analysis_run_values`; or
- legacy OUTPUT rows in `run_values`, matched by code.

Migration sequence:

1. The canonical dataset builder reproduces the current precedence rule and
   records provenance.
2. Add a migration audit that reports, per DOE and response:
   - values only in measurement storage;
   - values only in legacy `run_values`;
   - equal values in both;
   - conflicting values in both.
3. Define explicit conflict handling. Never overwrite a non-null measurement
   silently.
4. Copy non-conflicting legacy outputs into the matching DOE response fields.
5. Verify row counts, values, tags, text, booleans, and missing semantics.
6. Stop creating empty OUTPUT placeholders in `run_values` for new runs.
7. Keep read fallback for one controlled compatibility window.
8. Re-run the migration audit and require zero unresolved legacy-only values.
9. Remove fallback and legacy OUTPUT reads.
10. Only then consider removing migrated OUTPUT rows or retaining them as
    historical storage according to the backup/retention policy.

Every production migration requires a SQLite backup and a dry-run report before
mutation.

### 11.4 Cutover sequence

1. Introduce the canonical dataset builder without changing the existing UI.
2. Make legacy export and analysis read through that builder where practical.
3. Add Analysis V2 behind a feature flag and keep legacy analysis read-only.
4. Validate representative SCREEN, FFA, BBD, compounding, and coating datasets.
5. Make Analysis V2 the default and provide a temporary link to legacy analysis
   for authorized comparison.
6. Move report sources to saved Analysis V2 results.
7. Complete data migration and fallback audit.
8. Remove legacy UI, routes, calculations, inline scripts, and report analysis.
9. Remove `jstat` if no remaining module uses it.
10. Remove the feature flag and compatibility link.

The legacy analysis must have a defined removal release. “Keep it just in case”
is not an acceptable final state.

## 12. Repository and deployment layout

The repository remains a monorepo:

- Planner application at the repository root;
- R analytics service in `analytics-r/`;
- shared JSON contract/schema and fixtures in `contracts/` or an equivalent
  neutral directory;
- two Dockerfiles and two GHCR images;
- one production Docker Compose deployment.

Only Planner exposes a host port. The R service uses the private Compose network
and has a health check. R receives no SQLite volume and no application secrets
other than the minimum internal-service configuration if later required.

GitHub Actions builds:

- the Planner image from the repository root;
- the analytics image from `analytics-r/`;
- Node tests;
- R statistical and contract tests;
- an integration test that calls R through Planner or a test client.

Local development without Docker uses the mock analytics client. Developers who
install R locally may run the real service directly, but it is optional.

## 13. Implementation roadmap

### Phase 0 — specification and fixtures

Deliverables:

- freeze product terminology: response, factor, block, replicate, analysis,
  revision, stale;
- define supported behavior for SCREEN, FFA, BBD, and SIM;
- select representative anonymized fixtures from current process types;
- define request/response contract and error model;
- define expected numerical results for golden tests;
- define the removal release/condition for legacy analysis.

Exit criteria:

- Node and R can share one unambiguous contract;
- every current design type has a declared supported analysis path or an
  explicit limitation;
- migration conflict rules are approved.

### Phase 1 — canonical dataset module

Deliverables:

- isolated DOE Analysis V2 module skeleton;
- canonical dataset builder;
- stable column roles and identifiers;
- raw and coded factor representation;
- recipe/block and replicate metadata;
- source provenance and dataset revision;
- dataset preview/debug endpoint restricted by existing DOE access;
- tests against existing injection, compounding, and coating data;
- migration audit in read-only mode.

Exit criteria:

- one dataset is used consistently by fixtures, export, mock analysis, and the
  future R client;
- no statistical calculation is duplicated in a route;
- legacy-only and conflicting response data are measurable.

### Phase 2 — R service foundation

Deliverables:

- `analytics-r/` service with health and engine metadata;
- dependency lock and reproducible image build;
- contract validation;
- factorial and BBD baseline analyses;
- structured errors and warnings;
- golden numerical tests;
- GHCR build and CI integration;
- mock analytics client with the same response contract.

Exit criteria:

- representative FFA and BBD fixtures return stable, reviewed results;
- Node can switch between mock and HTTP clients without UI changes;
- R failures do not affect other Planner functions.

### Phase 3 — Analysis Workspace shell and Overview

Deliverables:

- new workspace route/view owned by the module;
- analysis navigator;
- Overview and Data sections;
- completeness, inclusion, block, replicate, and design warnings;
- run navigation and linked row selection foundation;
- responsive navigator and inspector behavior;
- feature flag for controlled rollout.

Exit criteria:

- users can inspect exactly which dataset will be analyzed;
- no legacy chart is required to understand completeness and scope;
- access rules match the DOE and experiment ACL.

### Phase 4 — saved analyses and guided model builder

Deliverables:

- analysis and calculation-revision persistence;
- create, edit, duplicate, recalculate, and archive flows;
- guided defaults by design type;
- advanced term selection with estimability feedback;
- stale detection;
- calculation progress/failure states;
- audit events.

Exit criteria:

- two alternative models can coexist for the same response;
- changing source data marks prior results stale without deleting them;
- the last successful result survives a failed recalculation.

### Phase 5 — core results and interactive charts

Deliverables:

- Summary;
- ANOVA and coefficients/effects tables;
- Pareto and normal/half-normal effect plots;
- main-effects and interaction plots;
- residual diagnostics;
- fitted contour and 3D surface for supported models;
- linked run selection;
- chart SVG/PNG export;
- accessible table alternatives.

Exit criteria:

- FFA and BBD result workflows no longer depend on the legacy analysis page;
- every chart identifies its response, factors, model revision, and data scope;
- diagnostics navigate back to source runs.

### Phase 6 — reports and exports

Deliverables:

- saved analyses in the report source catalogue;
- insert summary, tables, charts, and controlled analysis sections;
- snapshot metadata and stale/newer-revision check;
- canonical wide export with column metadata;
- removal of duplicated run/wide export logic.

Exit criteria:

- report generation no longer imports the legacy analysis functions;
- signed reports remain immutable;
- an inserted result can be traced to analysis and dataset revisions.

### Phase 7 — response data migration and legacy removal

Deliverables:

- reviewed migration dry-run report;
- production backup procedure;
- non-conflicting legacy OUTPUT migration;
- conflict resolution workflow or documented manual resolution;
- generator no longer inserts unused output placeholders into `run_values`;
- Analysis V2 default enabled;
- old analysis made read-only, then deleted;
- unused services, routes, view blocks, scripts, styles, and dependencies removed;
- architecture and README updated.

Exit criteria:

- zero unresolved legacy-only response values;
- reports, exports, and UI use the new module;
- no route contains embedded DOE statistical logic;
- no legacy analysis selector or fixed chart grid remains;
- full regression suite passes after deleting old code.

### Phase 8 — advanced analysis

Deliverables:

- multi-response optimizer and desirability;
- confirmation-run creation;
- free graph builder and saved DOE-level views;
- derived columns and transformations;
- binary/tag response support;
- analysis comparison;
- reusable model templates by process type;
- optional evaluation of an advanced embedded worksheet.

Immediate analysis sequence:

1. Single-response optimizer: maximize, minimize, or hit a target within
   explicit factor bounds; return predicted response, factor settings, and a
   clear warning that the recommendation is model-based.
2. Multi-response desirability: combine per-response goals only from saved,
   compatible analysis revisions; show each response prediction alongside the
   overall desirability rather than hiding the trade-off.
3. Transformations and blocks: make them visible, reproducible model settings
   with before/after diagnostics, never an implicit preprocessing step.
4. Analysis comparison and confirmation runs: compare two saved revisions and
   turn a selected recommendation into a traceable follow-up run.

Exit criteria:

- advanced features use the same dataset, persistence, permission, report, and
  revision infrastructure; no parallel analytics path is introduced.

## 14. Testing strategy

### Dataset and migration tests

- canonical row and column assembly;
- raw/coded value alignment;
- recipes, blocks, center points, and replicates;
- missing versus zero/false/empty tags;
- exclusion and completion rules;
- legacy fallback precedence;
- conflict detection and migration idempotency;
- dataset revision stability and invalidation.

### Statistical tests

- reviewed golden fixtures for factorial and BBD models;
- coefficient, ANOVA, lack-of-fit, prediction, and residual tolerances;
- singular/aliased model behavior;
- insufficient-data errors;
- surface prediction at known points;
- package/engine version reporting.

### Application tests

- ACL for viewing and changing analyses;
- create, duplicate, archive, recalculate, and stale flows;
- failed R request preserves the last result;
- CSRF and payload validation;
- linked run navigation;
- report snapshot and signed immutability;
- feature-flag cutover;
- legacy removal regression tests.

### Operational tests

- R health check and startup time;
- Planner behavior when R is unavailable or slow;
- maximum accepted dataset/result size;
- two-image GHCR build;
- server Compose upgrade and rollback;
- backup and restore around response migration.

## 15. Observability and support

Planner logs calculation request ID, DOE ID, analysis ID, revision ID, duration,
status, and engine version without logging confidential full datasets.

R logs request ID, analysis family, row/column counts, duration, warnings, and
structured failure class. Health checks distinguish process availability from
successful package loading.

The UI exposes a support detail view containing contract version, engine
version, dataset revision, and calculation request ID.

## 16. Definition of done

Analysis V2 is complete when:

1. Users create and retain multiple analyses per DOE.
2. Dataset scope and model specification are visible and reproducible.
3. Factorial and BBD analyses provide reviewed statistical results, effects,
   diagnostics, and fitted surfaces.
4. Graphs are interactive, configurable, exportable, and linked to runs.
5. Data changes mark analyses stale without destroying historical results.
6. Reports insert versioned analysis snapshots.
7. Planner operates safely when the R service is unavailable.
8. Legacy response values are migrated or explicitly resolved.
9. Old DOE calculation, UI, and report-analysis code is removed.
10. The implementation is isolated in the DOE Analysis module and does not
    recreate analysis logic in experiment routes or templates.

## 17. First implementation slice

The first implementation slice should prove the architecture without building
the final UI all at once:

1. Canonical dataset for one existing FFA and one existing BBD.
2. Read-only migration/provenance audit.
3. Shared request/response contract and mock result.
4. R calculation of ANOVA, coefficients, effects, diagnostics, and BBD fitted
   surface data for the fixtures.
5. Minimal Analysis V2 workspace showing Data, Summary, ANOVA, one effects plot,
   one residual plot, and one contour plot.
6. Saved analysis definition and one immutable calculation revision.
7. Comparison against the current page, followed by an explicit go/no-go review
   before expanding the UI or migrating production values.
