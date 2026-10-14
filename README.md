# Nebras documentation ingestion

Prepare documentation from `Nebras-Open-Finance/community-standards`, then embed a validated baseline into a new Qdrant collection. Node.js 22 or later is recommended.

## Prepare

```sh
npm install
npm test
# In the Community Standards checkout: prepare the same assets as the website.
(cd ../community-standards && node scripts/fetch-openapi-specs.mjs)
npm run prepare:docs -- --source-root ../community-standards --output ./runs/baseline-new
```

Use a clean Community Standards checkout at the agreed revision. The output directory must be new. Every run writes `parsed-output/`, `chunk-output/` and `manifest.json` inside it. Never combine the older root-level outputs with a new run.

Default scope is public technical docs (`src/pages/tech`) and knowledge-base pages. It excludes internal material, developer examples, interactive submission forms and dynamic placeholders. The API endpoint catch-all is separately expanded from the website's own endpoint registry. Other dynamic placeholders (release notes, errata and changelog registries) are recorded under `excluded` and need dedicated expansion before claiming complete coverage. Generated listing pages are not currently expanded; endpoint pages are.

This is an initial source selection, not an approved pilot policy. Both v2.1 and v2.2-rc2 are prepared with version metadata; the latter is draft content. Confirm permitted versions before connecting the collection to the pilot.

For selected-file runs, pass a JSON array of repository-relative source paths:

```json
["src/pages/tech/tpp-standards/production/testing-certification/optional/overview.vue"]
```

```sh
npm run prepare:docs -- --source-root ../community-standards --output ./runs/selected --files ./files.json
```

Selected-file mode handles authored Vue/Markdown pages. It does not yet expand the API catch-all on a selected-file change; the later incremental engine must use the registry to identify affected endpoint documents. `--scope all` is available for corpus auditing, not for an unfiltered pilot upload.

## Extraction

- Static Vue prose, lists, tables, code and navigation.
- Requirements imported from `src/data/requirements`: prose, rules, validation responsibility, tables and nested sections.
- Field-map resource JSON: field paths, types, transforms, permissions and verification labels; actual backing version and asset hashes are retained.
- Certification configurations and the shared multi-payment explainer; static landing cards.
- Static RedocWrapper endpoint/schema selections, reachable definitions, literal server overrides and statically resolved schema patches.
- Generated API endpoints via `src/data/endpoints`, including the registry's version cloning and canonical URL function.
- Public Markdown documentation.

Source data modules are transpiled in an isolated context with only local `src/data` imports. They must be trusted, reviewed repository code; this is not a security sandbox for arbitrary code. Static-expression resolution never executes arbitrary Vue component scripts. Unsupported dynamic expressions and missing assets fail preparation. Other imported components can still omit content: review extraction warnings and representative answers.

Page URLs come from ordinary file routes or the API registry. They have not all been checked against the live deployment. The root `index` maps to `/`. Section anchors remain separate and need validation before use.

Long texts are split into parts of at most 6,000 JavaScript characters, repeating the breadcrumb. This bounds request size; it is not an exact provider token count. Schema parts may contain JSON fragments. Tune limits and evaluate retrieval before rollout.

## Embed and upload

Copy `.env.example` to `.env` and supply your own credentials. Select the model and dimensions that the query embedding provider will use. The script does not load `.env` automatically; Node's `--env-file` loads it explicitly.

```sh
# Validate locally; no API calls.
node --env-file=.env src/scripts/embed-upload.js --manifest runs/baseline-new/manifest.json
# Generate embeddings and upload to a NEW collection.
node --env-file=.env src/scripts/embed-upload.js --manifest runs/baseline-new/manifest.json --execute
```

A failed or empty manifest, mismatched chunk count/hash, missing URL or source-commit mismatch is rejected. The uploader preserves UUIDs and all chunk fields in Qdrant payload, adds the actual embedding configuration, uses Cosine distance, and indexes document/source filter fields. It caches embeddings immediately, retries transient HTTP failures, waits for upserts and checks the final point count. A retry re-upserts deterministic IDs without calling the embedding provider again for cached text. Lock/state/cache files stay local and must not be committed.

It refuses an existing collection unless there is a matching local resume state. Use a new collection for each initial baseline. It never deletes collections, deletes points or switches the live agent. After verifying representative queries, explicitly configure the agent's collection/model/dimensions.

`EMBEDDING_TASK_TYPE` defaults to omitted, matching the current query provider. If using `RETRIEVAL_DOCUMENT` with a supporting model, also update query embedding to `RETRIEVAL_QUERY`. Embeddings are normalized to unit length; cache identity includes model, dimensions, task type and configuration. `.env.example` is an example, not confirmation of your deployed model.

The manifest describes prepared content. `upload-state.json` tracks the initial upload; `incremental-state.json` tracks later reconciliation. The baseline uploader itself does not delete points.

## Incremental ingestion (manual CLI)

Keep the last successfully ingested full manifest and its chunk files. Prepare a fresh run using it:

```sh
npm run prepare:docs -- --source-root ../community-standards --output runs/update-001 --previous runs/baseline-new/manifest.json
# Offline plan; no Qdrant or embedding calls.
npm run sync:docs -- --previous runs/baseline-new/manifest.json --next runs/update-001/manifest.json
# Apply only after reviewing the plan and configuring the same embedding model/collection.
node --env-file=.env src/scripts/incremental.js --previous runs/baseline-new/manifest.json --next runs/update-001/manifest.json --state-dir ./ingestion-state --execute
```

For the next update, use `runs/update-001/manifest.json` as `--previous`. Keep one durable state directory per collection and source/scope. Do not run concurrent writers using different state directories. The local lock prevents overlapping processes sharing a directory; it is not a distributed lock. After a hard crash, remove a stale lock only after confirming the process is no longer running. Persist manifests, checkpoints and caches outside ephemeral Actions runners.

Preparation reuses authored chunks when source and every recorded dependency asset hash match and parser/chunker versions match. Missing/unresolved dependency hashes force a rebuild. Deleted pages disappear from the new full manifest. Generated API endpoints are rebuilt from the registry on every preparation run, including version/schema changes; unchanged text is not re-embedded. Reused pages produce chunk files and manifest entries, without copying their old parsed-output files. This rechecks source hashes, not embedding vectors, and makes no embedding-provider calls.

Reconciliation supports:

| Change | Qdrant operation |
|---|---|
| New document/chunk | Embed and upsert new IDs |
| Changed text | Embed changed text and overwrite the same ID |
| Deleted document | Delete its old chunk IDs |
| Removed section | Delete obsolete IDs; re-embed remaining chunks whose text changed |
| Metadata/URL/provenance change | Replace payload while retaining the existing vector |
| Unchanged chunk | No write or embedding |

A partial text deletion can change chunk boundaries, so remaining affected parts may need new embeddings. Identity is based on section/occurrence/part position, not semantic matching. Metadata includes source commit, so a new commit may require payload updates even when text is unchanged.

Only complete, nonempty **full manifests of the same repository and scope** can authorize deletions. Failed, selected-file or scope-changing runs are rejected. For an intentional completely empty corpus, use a separate reviewed removal procedure. The first execution verifies that every baseline ID/payload is present in Qdrant with the exact model/dimensions/task type/normalization before adopting it. Legacy collections without the new contract need the baseline upload to a new collection first. Unrelated point IDs are never deleted.

The engine verifies remote payloads, writes a pending checkpoint, caches normalized embeddings before uploading, applies upserts before deletions and advances the checkpoint only after verifying all desired/removed IDs. A failed execution resumes with the same previous/next manifests and state directory. Retries retain already-updated points and cached vectors. Updates are not a collection-wide transaction: retrieval can see mixed revisions while synchronization is running. Serialize runs; versioned collections are a separate option if atomic cutover is required.

Dry-run counts compare local manifests; execution additionally checks remote state and refuses payload drift/configuration mismatch. `--execute` permits provider calls and Qdrant writes/deletes. Keep the query model, dimensions and task-type pairing compatible. No ingestion endpoint, scheduler, website deployment hook or GitHub Actions workflow is added here.

## Later GitHub Actions connection

The later automatic flow belongs after a successful website deployment: pass the deployed source commit to the incremental engine, compute changes since the engine's last successful checkpoint, then update affected documents. A push or PR alone is not proof that those pages were published. Persist checkpoints and embedding caches outside ephemeral Actions runners.

For that later flow, configure a scoped ingestion-service credential in **Settings → Secrets and variables → Actions**. Prefer keeping Gemini/Qdrant credentials in the ingestion service; the website workflow only needs permission to request a sync. If the workflow directly runs the uploader instead, it needs `GEMINI_API_KEY`, `QDRANT_URL`, `QDRANT_API_KEY`, plus model/dimension/collection variables. Repository-secret management requires write access for organization repositories; environment/organization secrets and policy changes can require a maintainer/admin/owner.

`injection.js` remains an unused legacy parser.
