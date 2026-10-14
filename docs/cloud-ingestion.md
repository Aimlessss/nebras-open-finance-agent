# Manual cloud ingestion

Both workflows run only on main and share the `nebras-ingestion-state` concurrency group. No schedule is enabled yet. Never run a local writer against this collection while a cloud job is running.

## Configure GitHub

Repository Settings → Secrets and variables → Actions.

Secrets:
- `GEMINI_API_KEY`: embedding provider key from your working local upload configuration.
- `QDRANT_URL`: the URL of the Qdrant instance holding the baseline.
- `QDRANT_API_KEY`: its write-capable API key.

Variables (copy exactly from your original successful baseline upload):
- `EMBEDDING_MODEL`
- `EMBEDDING_DIMENSIONS`
- `EMBEDDING_TASK_TYPE` (leave absent/empty only if the original upload used no task type).

The target collection is fixed to `nebras_community_docs_v2`. The engine verifies model, dimensions, task type, normalization and baseline payloads before making changes. A mismatch stops execution; do not bypass it.

## First update

1. Run **Ingestion preview (S3)** on main again. Older previews without `baseline-fingerprint.txt` cannot be executed.
2. Review its counts and the `deletions.json` inside the preview archive in S3. The job log summarizes deletion reasons. Excluded drafts should explain the initial large cleanup; investigate other removals.
3. Run **Apply reviewed ingestion preview** on main. Enter the preview's `RUN_ID-ATTEMPT`, e.g. `123456789-1`, and the exact deletion count you reviewed.
4. This is a live update: it embeds new/changed text, updates metadata, removes obsolete points, and verifies the result.

S3 `state/current.json` records the current baseline archive and any pending transaction. A running checkpoint is saved before Qdrant mutations. Only after verification does the pointer advance to the applied preview archive. Future previews restore that baseline.

If interrupted, rerun the execution using the SAME preview ID and deletion count. The pending checkpoint pins that preview and permits recovery of partially applied changes. Do not manually clear pending state or start a different preview. If validation stops before any mutations, diagnose the configuration/baseline mismatch before retrying.

Embedding cache files are local to the runner. An abrupt shutdown can require repeating an embedding request whose vector never reached Qdrant; persisted checkpoint plus remote payload verification protects reconciliation correctness. Vector caches are not stored in S3 by this workflow.

Keep baseline and pending preview archives in S3. Do not configure expiry for archives referenced by `state/current.json`. The original baseline remains available as an archive, but restoring it alone does not roll Qdrant back.
