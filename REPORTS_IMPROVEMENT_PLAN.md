# Report workspace improvement plan

## Goal

Make the report editor a full-width document workspace where users can browse
research data, inspect an entity, and insert a selected value, table, section,
or figure into the document.

## Current state

- `report_configs` stores the selected report scope and metadata.
- `report_documents` stores the separately edited TipTap document.
- `buildReport` creates the current aggregated research-data view and the seed
  document only; it is not a browsable source catalogue.
- The reader view and editable document are currently separate experiences.

## Target experience

The editor becomes a full-width workspace:

```text
Header: Back | report name | saved state | export | sign

Sources (left rail)                 Document (all remaining width)
  Search                            Sticky formatting toolbar
  Experiment                        Editable TipTap document
  Machine
  Recipes
  Qualification
    Step -> summary -> runs
  DOE studies
    factors -> runs -> outputs
  Figures
```

- Do not use the ordinary 1200px site container or an outer card.
- The source rail is about 300px wide, sticky, collapsible, and a drawer on
  smaller screens.
- Desktop supports drag-and-drop to the document cursor. Every drag action has
  a keyboard/mobile equivalent: an Insert button.
- Clicking a tree item opens a native dialog with a structured preview and
  explicit actions: insert value, label and value, table, section, or figure.

## Data catalogue

Create a dedicated report-context service and access-scoped endpoints instead
of serializing all research data into the page.

Initial source groups:

1. Experiment, process, and description.
2. Machine, settings, and machine parameters.
3. Recipes and component tables.
4. Qualification steps, summaries, fields, runs, and generated charts.
5. DOE studies, factors, run matrix, outputs, and analyses.
6. Reusable figures, starting with rheology and process-window charts.

Load large collections lazily and paginate runs. Notes and tasks stay out of
the first release because they are unstructured collaboration content rather
than controlled research results.

The report configuration should control automatic seed sections, not prevent a
user with valid experiment access from manually inserting another permitted
research item.

## Document semantics

Inserted content is a snapshot, not a live value: a signed report must not
change when the experiment changes. Store non-visual source metadata in TipTap
nodes or marks:

- experiment ID;
- entity type and ID;
- field path;
- captured value and time.

Before signing, provide a manual “check source updates” action. It compares
the stored snapshot with current research data and lets the author choose
which values to refresh. Signed documents remain read-only.

Make the document the primary report reader. Keep the existing calculated
research-data view as a Data tab or supporting view.

## Security and integrity requirements

- Every context endpoint checks report access and verifies that the requested
  entity belongs to the report's experiment.
- Use a fixed entity/field registry and repository methods; never build SQL
  from entity type or field names supplied by the browser.
- Insert source content through TipTap text/JSON nodes or DOM `textContent`,
  never untrusted HTML.
- Escape server-rendered JSON safely and avoid embedding large/raw datasets in
  the initial HTML response.
- All state-changing calls must include the session CSRF token.
- Signing must only lock a successfully saved document snapshot.

## Delivery sequence

1. Repair report CSRF coverage and define the document reader/signing flow.
2. Build the full-width workspace shell and responsive source rail.
3. Add the access-scoped source catalogue API and entity-preview dialog.
4. Add value, table, section, and figure insertion with click and drag flows.
5. Add source metadata, update checks, and final signing rules.
6. Test permissions, CSRF, signed-document immutability, XSS payloads,
   pagination, and large report documents.
