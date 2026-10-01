# IM Planner analytics service

Stateless internal R service for DOE Analysis V2. It receives a canonical
dataset from Planner and never opens the Planner database.

Endpoints:

- `GET /health`
- `POST /v1/analyze`

Run the dependency-free statistical core tests from this directory:

```sh
Rscript tests/run_tests.R
```

The HTTP service requires the `plumber` and `jsonlite` packages and is normally
built and run through the repository Compose configuration.

For real local calculations without Docker, install the small project-local R
dependency once and restart Planner:

```sh
npm run analytics:r:setup
```

Development then selects the `rscript` client automatically. Set
`DOE_ANALYTICS_MODE=mock` to force the contract-only fallback.
