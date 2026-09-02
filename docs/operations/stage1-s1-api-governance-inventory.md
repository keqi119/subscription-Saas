# Stage 1 S1 API governance runtime inventory

Status: migration baseline for S1 Tasks 16–26  
Owner: release engineering

## Scope

The inventory records both sides of the current API runtime governance surface:

- every governance file copied into the API image and the commands that depend on it;
- every executable command, its complete copied-file dependency closure, and its package, CI,
  Compose, Runbook, external automation, and manual callers.

The checked baseline contains 25 copied files and 11 executable entrypoints. The generated
inventory is [api-runtime-governance-inventory.v1.json](../../release/contracts/api-runtime-governance-inventory.v1.json).
`generate-api-governance-inventory.mjs --check` fails when either view is incomplete or stale.

## Disposition rules

- `application-runtime`: a production request path genuinely requires the asset. No inventoried
  governance script currently has this disposition.
- `runner-only`: source remains available to a registered Runner adapter, but must leave the API
  image.
- `source-test-only`: source can be imported by tests but has no Release or Staging execution
  entrypoint.
- `retire-after-caller-migration`: an existing CLI entrypoint remains transitional until every
  caller uses its fixed Runner `commandId@version`.

Assets that become source-test-only must not retain a Release/Staging package script, CI,
Compose, Runbook, external automation, or manual execution path. During migration an old and new
implementation may coexist in source or packaging, but only the registered Runner command may
receive an active capability credential and approval.

## Caller and equivalence evidence

Package scripts, protected workflows, Compose files, and Runbooks are discovered from tracked
repository files. Manual and external callers require an owner attestation before cutover. Startup
logs alone never prove caller retirement.

Each command cutover must run the old entrypoint and Runner adapter against two independent
databases created from the same baseline. The normalized comparison covers target sets, per-table
effects, transaction and lock behavior, deterministic plan, postconditions, business audit facts,
exit/error classifications, timeout/cancellation/fault injection, and replay without duplicate
side effects.

## Target API runtime boundary

The target allowlist is [api-runtime-allowlist.v1.json](../../release/contracts/api-runtime-allowlist.v1.json).
Task 26 must prove that the final API image:

- does not contain `/app/scripts`;
- cannot execute Prisma CLI or `psql`;
- exposes no supported arbitrary shell or `node scripts/` governance entrypoint;
- retains the application server, Prisma Client runtime, approved media processing binaries, and
  required static assets.

The negative gate checks capabilities and an allowlist, not only legacy filenames. Script source
deletion remains S4 work; S1 only removes formal governance execution from the API runtime.

## Rollback boundary

Before database mutation, a failed command terminates safely. A committed or uncertain command is
reconciled or replayed using its idempotency key and proof chain. Rolling back application images
requires evidence that the previous API remains compatible with the current Schema. Database
restore is a last resort requiring stopped writes, a declared loss window, verified restore
capability, and independent human approval. Applied migrations are never rewritten.
