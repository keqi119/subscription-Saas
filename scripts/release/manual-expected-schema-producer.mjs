import { spawn } from "node:child_process";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { fileURLToPath } from "node:url";
import { TextDecoder } from "node:util";
import { computeMigrationCatalog, computeRepositoryContract, encodeManualJson, sha256Bytes, sha256Canonical, validateContract } from "../../packages/release-foundation/src/index.mjs";
import { assertBuildIdentity } from "./verify-build-proof.mjs";

const LIMIT = 1048576;
const SCHEMA = "apps/api/prisma/schema.prisma", CONFIG = "apps/api/prisma.config.ts", PRODUCER = "scripts/release/manual-expected-schema-producer.mjs";
const PRISMA = "/app/apps/release-runner/node_modules/.bin/prisma";
const NODE_BASE = "node:22-bookworm-slim@sha256:6c74791e557ce11fc957704f6d4fe134a7bc8d6f5ca4403205b2966bd488f6b3";
const PG_BASE = "postgres:17.11-bookworm@sha256:051f7b7b3abdd564d5d1bd1e8c4b9c1b6e77087d1dd22020ede611c096a272e0";
const PG_DIGEST = PG_BASE.split("@")[1], OUTPUT = "/tmp/manual-expected-schema-output";
const ENVELOPE_KEYS = ["sourceSha", "migrationCatalogDigest", "sourceSchemaDigest", "configDigest", "lockDigest", "producerDigest", "pnpmVersion"];
const IDENTITY_KEYS = ["sourceSha", "repository", "workflowPath", "sourceRef", "runId", "runAttempt", "protectedEnvironment"];
const PROCESS_KEYS = ["stdout", "stderr", "exitCode", "signal", "pid", "preparedAt", "spawnedAt", "closedAt"];
const CALL_KEYS = ["tool", "argv", "stdout", "stderr", "pid", "preparedAt", "spawnedAt", "closedAt", "exitCode", "signal"];
const DB_KEYS = ["databaseName", "databaseOid", "systemIdentifier", "serverVersion", "schemaOwner", "ownerInventory", "extensions", "listenAddresses", "socketDirectory", "dataDirectory", "configuredPort"];
const ROLE = "expected_schema_owner", DATABASE = "expected_schema_reference";
const CREATION_TOOLS = ["node-version", "psql-version", "initdb", "pg-start", "database-create", "identity-before"];
const READBACK_TOOLS = ["identity-after", "migration-readback", "pg-stop"];
const PRISMA_TOOLS = ["prisma-version", "prisma-deploy", "prisma-diff", "prisma-script"];
const CONTAINER_FORMAT = '{"id":{{json .Id}},"imageId":{{json .Image}},"imageRef":{{json .Config.Image}},"user":{{json .Config.User}},"network":{{json .HostConfig.NetworkMode}},"binds":{{json .HostConfig.Binds}},"mounts":[{{range $i,$m := .Mounts}}{{if $i}},{{end}}{"type":{{json $m.Type}},"source":{{json $m.Source}},"destination":{{json $m.Destination}}}{{end}}],"tmpfs":{{json .HostConfig.Tmpfs}},"readonly":{{json .HostConfig.ReadonlyRootfs}},"status":{{json .State.Status}},"running":{{json .State.Running}},"exitCode":{{json .State.ExitCode}}}';
const IMAGE_FORMAT = '{"id":{{json .Id}},"repoDigests":{{json .RepoDigests}},"sourceRevision":{{json (index .Config.Labels "org.opencontainers.image.revision")}}}';
const IDENTITY_SQL = `SELECT json_build_object(
 'databaseName', current_database(),
 'databaseOid', (SELECT oid::text FROM pg_database WHERE datname=current_database()),
 'systemIdentifier', (SELECT system_identifier::text FROM pg_control_system()),
 'serverVersion', current_setting('server_version'),
 'schemaOwner', (SELECT nspowner::regrole::text FROM pg_namespace WHERE nspname='public'),
 'ownerInventory', (SELECT coalesce(json_agg(i ORDER BY i."objectClass",i."objectName"),'[]'::json) FROM (
   SELECT 'schema'::text AS "objectClass", nspname::text AS "objectName", nspowner::regrole::text AS owner FROM pg_namespace WHERE nspname='public'
   UNION ALL SELECT CASE c.relkind WHEN 'S' THEN 'sequence' ELSE 'relation' END,c.relname::text,c.relowner::regrole::text FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace WHERE n.nspname='public' AND c.relkind IN ('r','p','v','m','S')
 ) i),
 'extensions', (SELECT coalesce(json_agg(extname ORDER BY extname),'[]'::json) FROM pg_extension),
 'listenAddresses', current_setting('listen_addresses'),
 'socketDirectory', current_setting('unix_socket_directories'),
 'dataDirectory', current_setting('data_directory'),
 'configuredPort', current_setting('port')::integer)::text`;
const MIGRATIONS_SQL = `SELECT coalesce(json_agg(m ORDER BY m.name),'[]'::json)::text FROM (
 SELECT migration_name::text AS name,checksum::text AS checksum,finished_at IS NOT NULL AS finished,
 rolled_back_at IS NOT NULL AS "rolledBack",applied_steps_count AS "appliedSteps" FROM public._prisma_migrations
) m`;

function fail(code, details) { throw Object.assign(new Error(code), { code, details }); }
function exact(v, keys) { return v && typeof v === "object" && !Array.isArray(v) && [Object.prototype, null].includes(Object.getPrototypeOf(v)) && Reflect.ownKeys(v).length === keys.length && keys.every((k) => { const d = Object.getOwnPropertyDescriptor(v, k); return d?.enumerable && "value" in d; }); }
function bytes(v) { if (!(v instanceof Uint8Array) || v.byteLength > LIMIT) fail("MANUAL_EXPECTED_SCHEMA_RAW_INVALID"); return Buffer.from(v); }
function text(v) { try { return new TextDecoder("utf-8", { fatal: true }).decode(bytes(v)); } catch { fail("MANUAL_EXPECTED_SCHEMA_RAW_INVALID"); } }
function json(v) { try { return JSON.parse(text(v)); } catch { fail("MANUAL_EXPECTED_SCHEMA_JSON_INVALID"); } }
function encode(v) { return bytes(encodeManualJson(v)); }
function canonical(v) { const raw = bytes(v), value = json(raw); if (!encode(value).equals(raw)) fail("MANUAL_EXPECTED_SCHEMA_JSON_INVALID"); return value; }
function timestamp(now) { const d = now(); if (!(d instanceof Date) || !Number.isFinite(d.getTime())) fail("MANUAL_EXPECTED_SCHEMA_CLOCK_INVALID"); return d.toISOString(); }
function validTime(v) { return typeof v === "string" && Number.isFinite(Date.parse(v)) && new Date(v).toISOString() === v; }
function ordered(times) { return times.every(validTime) && times.every((v, i) => i === 0 || Date.parse(times[i - 1]) <= Date.parse(v)); }
function digest(v) { return typeof v === "string" && /^sha256:[0-9a-f]{64}$/u.test(v); }
function uuid(v) { return typeof v === "string" && /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u.test(v); }
function processResult(v) {
  if (!exact(v, PROCESS_KEYS) || !Number.isSafeInteger(v.pid) || v.pid < 1 || !ordered([v.preparedAt, v.spawnedAt, v.closedAt]) || !Number.isInteger(v.exitCode) || (v.signal !== null && typeof v.signal !== "string")) fail("MANUAL_EXPECTED_SCHEMA_PROCESS_INVALID");
  const stdout = bytes(v.stdout), stderr = bytes(v.stderr); text(stdout); text(stderr);
  if (v.exitCode !== 0 || v.signal !== null) fail("MANUAL_EXPECTED_SCHEMA_PROCESS_FAILED", { exitCode: v.exitCode, signal: v.signal });
  return { ...v, stdout, stderr };
}
function addRaw(raws, v) { const raw = bytes(v), ref = { digest: sha256Bytes(raw), bytes: raw.length }; if (raws.has(ref.digest) && !raws.get(ref.digest).equals(raw)) fail("MANUAL_EXPECTED_SCHEMA_RAW_INVALID"); raws.set(ref.digest, raw); return ref; }
function rawAt(raws, ref) {
  if (!exact(ref, ["digest", "bytes"]) || !digest(ref.digest) || !Number.isSafeInteger(ref.bytes) || ref.bytes < 0 || ref.bytes > LIMIT) fail("MANUAL_EXPECTED_SCHEMA_RAW_INVALID");
  const raw = raws.get(ref.digest); if (!raw || raw.length !== ref.bytes || sha256Bytes(raw) !== ref.digest) fail("MANUAL_EXPECTED_SCHEMA_RAW_INVALID"); return raw;
}
function capture(tool, command, argv, result, raws) {
  const r = processResult(result);
  return { tool, argv: addRaw(raws, encode([command, ...argv])), stdout: addRaw(raws, r.stdout), stderr: addRaw(raws, r.stderr), pid: r.pid, preparedAt: r.preparedAt, spawnedAt: r.spawnedAt, closedAt: r.closedAt, exitCode: 0, signal: null };
}
function prismaArgs(tool) {
  if (tool === "prisma-version") return ["--version"];
  if (tool === "prisma-deploy") return ["migrate", "deploy", "--schema", "/app/" + SCHEMA, "--config", "/app/" + CONFIG];
  if (tool === "prisma-diff") return ["migrate", "diff", "--from-config-datasource", "--to-schema", "/app/" + SCHEMA, "--exit-code", "--config", "/app/" + CONFIG];
  if (tool === "prisma-script") return ["migrate", "diff", "--from-empty", "--to-config-datasource", "--script", "--config", "/app/" + CONFIG];
  fail("MANUAL_EXPECTED_SCHEMA_PROCESS_INVALID");
}

// The one manifest callback controls only this fixed output lifecycle. All
// metadata comes from actual spawn/close events; no caller success facts exist.
function spawnRaw(command, argv, { environment, cwd, stdin, timeoutMs = 300000, now = () => new Date(), onManifest }) {
  return new Promise((resolve, reject) => {
    const preparedAt = timestamp(now), child = spawn(command, argv, { env: environment, cwd, shell: false, windowsHide: true, stdio: ["pipe", "pipe", "pipe"] });
    const out = [], err = []; let outSize = 0, errSize = 0, failure, spawnedAt, pid, manifestSeen = false, handoffComplete = false, killTimer, closeTimer;
    function finish(error, value) { clearTimeout(timer); clearTimeout(killTimer); clearTimeout(closeTimer); if (error) reject(error); else resolve(value); }
    function abort(reason) {
      if (failure) return;
      failure = reason instanceof Error ? reason : Object.assign(new Error(reason), { code: reason }); child.kill("SIGTERM");
      killTimer = setTimeout(() => child.kill("SIGKILL"), 2000); closeTimer = setTimeout(() => finish(failure), 5000);
    }
    const timer = setTimeout(() => abort("MANUAL_EXPECTED_SCHEMA_PROCESS_TIMEOUT"), timeoutMs);
    child.once("spawn", () => { pid = child.pid; spawnedAt = timestamp(now); });
    child.stdout.on("data", (chunk) => {
      outSize += chunk.length;
      if (outSize > LIMIT || (onManifest && manifestSeen)) { abort("MANUAL_EXPECTED_SCHEMA_RAW_INVALID"); return; }
      out.push(chunk);
      if (onManifest) {
        const aggregate = Buffer.concat(out), end = aggregate.indexOf(10);
        if (end !== -1) {
          if (end !== aggregate.length - 1) { abort("MANUAL_EXPECTED_SCHEMA_HANDOFF_INVALID"); return; }
          manifestSeen = true;
          Promise.resolve().then(() => onManifest(aggregate.subarray(0, end))).then(() => { handoffComplete = true; if (!failure) child.stdin.end(Buffer.from("RELEASE\n")); }).catch(abort);
        }
      }
    });
    child.stderr.on("data", (chunk) => { errSize += chunk.length; if (errSize > LIMIT) abort("MANUAL_EXPECTED_SCHEMA_RAW_INVALID"); else err.push(chunk); });
    child.once("error", (error) => finish(error)); child.stdin.on("error", (error) => { if (error.code !== "EPIPE") abort(error); });
    child.once("close", (exitCode, signal) => {
      if (onManifest && (!manifestSeen || !handoffComplete) && !failure) failure = Object.assign(new Error("MANUAL_EXPECTED_SCHEMA_HANDOFF_INVALID"), { code: "MANUAL_EXPECTED_SCHEMA_HANDOFF_INVALID" });
      finish(failure, { exitCode: exitCode ?? 1, signal: signal ?? null, stdout: Buffer.concat(out), stderr: Buffer.concat(err), pid, preparedAt, spawnedAt, closedAt: timestamp(now) });
    });
    if (onManifest) child.stdin.write(stdin); else child.stdin.end(stdin ?? Buffer.alloc(0));
  });
}

async function sourceSubjects(repoRoot) {
  const sourceSchemaBytes = bytes(await fs.readFile(path.join(repoRoot, SCHEMA))), configBytes = bytes(await fs.readFile(path.join(repoRoot, CONFIG))), lockBytes = bytes(await fs.readFile(path.join(repoRoot, "pnpm-lock.yaml"))), producerBytes = bytes(await fs.readFile(path.join(repoRoot, PRODUCER)));
  for (const raw of [sourceSchemaBytes, configBytes, lockBytes, producerBytes]) text(raw);
  const catalog = await computeMigrationCatalog(repoRoot);
  if (catalog.entries.length === 0 || json(await fs.readFile(path.join(repoRoot, "package.json"))).packageManager !== "pnpm@11.4.0") fail("MANUAL_EXPECTED_SCHEMA_SOURCE_INVALID");
  return { sourceSchemaBytes, configBytes, lockBytes, catalog, digests: { sourceSchemaDigest: sha256Bytes(sourceSchemaBytes), configDigest: sha256Bytes(configBytes), lockDigest: sha256Bytes(lockBytes), producerDigest: sha256Bytes(producerBytes), migrationCatalogDigest: catalog.digest } };
}
function databaseIdentity(v, data, socket) {
  if (!exact(v, DB_KEYS) || v.databaseName !== DATABASE || !/^[1-9][0-9]*$/u.test(v.databaseOid) || !/^[1-9][0-9]*$/u.test(v.systemIdentifier) || BigInt(v.systemIdentifier) > 18446744073709551615n ||
      !/^17\.11(?: \([^()]+\))?$/u.test(v.serverVersion) || v.listenAddresses !== "" || v.socketDirectory !== socket || v.dataDirectory !== data || v.configuredPort !== 5432 || ![ROLE, "pg_database_owner"].includes(v.schemaOwner) ||
      !Array.isArray(v.ownerInventory) || v.ownerInventory.length === 0 || v.ownerInventory.some((i) => !exact(i, ["objectClass", "objectName", "owner"]) || !["schema", "relation", "sequence"].includes(i.objectClass) || typeof i.objectName !== "string" || ![ROLE, "pg_database_owner"].includes(i.owner)) || !Array.isArray(v.extensions) || v.extensions.some((e) => typeof e !== "string")) fail("MANUAL_EXPECTED_SCHEMA_REFERENCE_IDENTITY_INVALID");
}
function catalogFromRows(rows, catalog) {
  if (!Array.isArray(rows) || rows.length !== catalog.entries.length || rows.some((m, i) => !exact(m, ["name", "checksum", "finished", "rolledBack", "appliedSteps"]) || m.name !== catalog.entries[i].path.split("/").at(-2) || m.checksum !== catalog.entries[i].sha256.slice(7) || m.finished !== true || m.rolledBack !== false || !Number.isInteger(m.appliedSteps) || m.appliedSteps < 1)) fail("MANUAL_EXPECTED_SCHEMA_MIGRATIONS_INVALID");
  return { catalogVersion: "migration-catalog.v1", entries: rows.map((m, i) => ({ order: i + 1, path: `apps/api/prisma/migrations/${m.name}/migration.sql`, sha256: `sha256:${m.checksum}` })) };
}

/** Fixed image-internal reference procedure; the process seam is offline only. */
export async function runReferenceExpectedSchema(envelope, { repoRoot = "/app", runProcess = spawnRaw, now = () => new Date() } = {}) {
  if (!exact(envelope, ENVELOPE_KEYS) || !/^[0-9a-f]{40}$/u.test(envelope.sourceSha) || envelope.pnpmVersion !== "11.4.0" || ENVELOPE_KEYS.filter((k) => k.endsWith("Digest")).some((k) => !digest(envelope[k]))) fail("MANUAL_EXPECTED_SCHEMA_REFERENCE_INPUT_INVALID");
  if (runProcess === spawnRaw && (process.platform !== "linux" || process.getuid() === 0)) fail("MANUAL_EXPECTED_SCHEMA_REFERENCE_RUNTIME_UNAVAILABLE");
  const subjects = await sourceSubjects(repoRoot);
  if (Object.entries(subjects.digests).some(([k, v]) => envelope[k] !== v)) fail("MANUAL_EXPECTED_SCHEMA_SOURCE_INVALID");
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), "manual-schema-reference-")); await fs.chmod(directory, 0o700);
  const commandRoot = path.posix.join("/tmp", path.basename(directory));
  if (runProcess === spawnRaw && directory !== commandRoot) fail("MANUAL_EXPECTED_SCHEMA_REFERENCE_RUNTIME_UNAVAILABLE");
  const data = `${commandRoot}/data`, socket = `${commandRoot}/socket`; await fs.mkdir(path.join(directory, "socket"), { mode: 0o700 });
  const referenceRunId = randomUUID(), rawBlobs = new Map(), creationCalls = [], readbackCalls = [], calls = [], pg = (name) => `/usr/lib/postgresql/17/bin/${name}`;
  const environment = { PATH: "/usr/local/bin:/usr/bin:/bin:/usr/lib/postgresql/17/bin", LANG: "C.UTF-8", LC_ALL: "C.UTF-8", STAGE1_ACCEPTANCE_MIGRATION_SKIP_DOTENV: "1", DATABASE_URL: `postgresql://${ROLE}@localhost:5432/${DATABASE}?host=${encodeURIComponent(socket)}&schema=public`, REFERENCE_SOCKET_DIRECTORY: socket, REFERENCE_DATA_DIRECTORY: data, HOME: commandRoot, XDG_CACHE_HOME: commandRoot, CHECKPOINT_DISABLE: "1", PRISMA_HIDE_UPDATE_MESSAGE: "1" };
  async function run(tool, command, argv, collection, timeoutMs) { const r = processResult(await runProcess(command, argv, { environment, cwd: repoRoot, timeoutMs, now })), call = capture(tool, command, argv, r, rawBlobs); collection.push(call); return { raw: r.stdout, call }; }
  const psqlArgs = ["--no-psqlrc", "--no-password", "--host", socket, "--port", "5432", "--username", ROLE, "--dbname", DATABASE, "--tuples-only", "--no-align", "--set", "ON_ERROR_STOP=1", "--command"];
  let startAttempted = false, stopped = false, manifest, originalError;
  try {
    const nodeVersion = text((await run("node-version", "/usr/local/bin/node", ["--version"], creationCalls)).raw).trim(), psqlVersion = text((await run("psql-version", pg("psql"), ["--version"], creationCalls)).raw).trim();
    if (!/^v22\.\d+\.\d+$/u.test(nodeVersion) || !/^psql \(PostgreSQL\) 17\.11(?: \([^()]+\))?$/u.test(psqlVersion)) fail("MANUAL_EXPECTED_SCHEMA_TOOLCHAIN_INVALID");
    await run("initdb", pg("initdb"), ["--pgdata", data, "--username", ROLE, "--encoding=UTF8", "--locale=C.UTF-8", "--auth-local=trust", "--auth-host=reject"], creationCalls);
    startAttempted = true;
    await run("pg-start", pg("pg_ctl"), ["--pgdata", data, "--log", `${commandRoot}/server.log`, "--wait", "--timeout=30", "--options", `-c listen_addresses='' -c unix_socket_directories=${socket} -c unix_socket_permissions=0700 -c port=5432`, "start"], creationCalls, 45000);
    const creation = await run("database-create", pg("psql"), [...psqlArgs.map((arg) => arg === DATABASE ? "postgres" : arg), `CREATE DATABASE ${DATABASE} OWNER ${ROLE}`], creationCalls), createdAt = creation.call.closedAt;
    const before = json((await run("identity-before", pg("psql"), [...psqlArgs, IDENTITY_SQL], creationCalls)).raw); databaseIdentity(before, data, socket);
    const version = await run("prisma-version", PRISMA, prismaArgs("prisma-version"), calls), prismaVersion = text(version.raw).trim();
    if (!/^prisma\s*:\s*7\.8\.0\s*$/mu.test(prismaVersion) || !prismaVersion.includes("\n")) fail("MANUAL_EXPECTED_SCHEMA_TOOLCHAIN_INVALID");
    await run("prisma-deploy", PRISMA, prismaArgs("prisma-deploy"), calls);
    const diff = await run("prisma-diff", PRISMA, prismaArgs("prisma-diff"), calls); if (text(diff.raw).trim() !== "") fail("MANUAL_EXPECTED_SCHEMA_DIFF_INVALID");
    const script = await run("prisma-script", PRISMA, prismaArgs("prisma-script"), calls); if (script.raw.length === 0) fail("MANUAL_EXPECTED_SCHEMA_RAW_INVALID");
    const identity = json((await run("identity-after", pg("psql"), [...psqlArgs, IDENTITY_SQL], readbackCalls)).raw); databaseIdentity(identity, data, socket);
    if (before.databaseOid !== identity.databaseOid || before.systemIdentifier !== identity.systemIdentifier) fail("MANUAL_EXPECTED_SCHEMA_REFERENCE_IDENTITY_INVALID");
    const migrations = await run("migration-readback", pg("psql"), [...psqlArgs, MIGRATIONS_SQL], readbackCalls), rows = json(migrations.raw), catalogIdentity = catalogFromRows(rows, subjects.catalog), migrationCatalog = addRaw(rawBlobs, encode(catalogIdentity));
    if (migrationCatalog.digest !== envelope.migrationCatalogDigest) fail("MANUAL_EXPECTED_SCHEMA_MIGRATIONS_INVALID");
    const owners = identity.ownerInventory.filter((i) => i.objectClass === "relation" && i.objectName === "_prisma_migrations"); if (owners.length !== 1 || owners[0].owner !== ROLE) fail("MANUAL_EXPECTED_SCHEMA_REFERENCE_IDENTITY_INVALID");
    const extensions = new Set(["plpgsql"]);
    for (const migration of subjects.catalog.entries) for (const match of text(await fs.readFile(path.join(repoRoot, migration.path))).matchAll(/CREATE\s+EXTENSION\s+(?:IF\s+NOT\s+EXISTS\s+)?"?([a-z0-9_]+)"?/giu)) extensions.add(match[1].toLowerCase());
    if (!encode(identity.extensions).equals(encode([...extensions].sort()))) fail("MANUAL_EXPECTED_SCHEMA_REFERENCE_IDENTITY_INVALID");
    const reread = await sourceSubjects(repoRoot); if (!encode(reread.digests).equals(encode(subjects.digests))) fail("MANUAL_EXPECTED_SCHEMA_SOURCE_INVALID");
    const readbackAt = migrations.call.closedAt;
    if (calls.some((c) => !ordered([createdAt, c.preparedAt, c.spawnedAt, c.closedAt, readbackAt]))) fail("MANUAL_EXPECTED_SCHEMA_PROCESS_INVALID");
    manifest = { sourceDigests: subjects.digests, referenceRunId, createdAt, readbackAt, identity, creationCalls, readbackCalls, calls, migrationCatalog, migrationHead: rows.at(-1).name, migrationOwner: owners[0].owner, allowedExtensions: identity.extensions, toolchain: { nodeVersion, postgresqlVersion: identity.serverVersion, prismaVersion, prismaVersionRaw: version.call.stdout }, expectedScript: script.call.stdout };
  } catch (error) { originalError = error; }
  finally {
    if (startAttempted) { try { await run("pg-stop", pg("pg_ctl"), ["--pgdata", data, "--wait", "--timeout=30", "--mode=immediate", "stop"], readbackCalls, 45000); stopped = true; } catch (error) { originalError = Object.assign(new Error("MANUAL_EXPECTED_SCHEMA_REFERENCE_CLEANUP_FAILED", { cause: originalError ?? error }), { code: "MANUAL_EXPECTED_SCHEMA_REFERENCE_CLEANUP_FAILED", referenceRunId }); } }
    if (!startAttempted || stopped) await fs.rm(directory, { recursive: true, force: true });
  }
  if (originalError) throw originalError;
  manifest.raws = [...rawBlobs].map(([d, raw]) => ({ digest: d, bytes: raw.length })).sort((a, b) => a.digest.localeCompare(b.digest));
  encode(manifest); return { manifest, rawBlobs };
}

function validateCall(call, raws, tool) {
  if (!exact(call, CALL_KEYS) || call.tool !== tool || !Number.isSafeInteger(call.pid) || call.pid < 1 || !ordered([call.preparedAt, call.spawnedAt, call.closedAt]) || call.exitCode !== 0 || call.signal !== null) fail("MANUAL_EXPECTED_SCHEMA_PROCESS_INVALID");
  const invocation = canonical(rawAt(raws, call.argv)); if (!Array.isArray(invocation) || invocation.some((s) => typeof s !== "string")) fail("MANUAL_EXPECTED_SCHEMA_PROCESS_INVALID");
  text(rawAt(raws, call.stdout)); text(rawAt(raws, call.stderr)); return invocation;
}
function validateManifest(m, raws, subjects) {
  if (!exact(m, ["sourceDigests", "referenceRunId", "createdAt", "readbackAt", "identity", "creationCalls", "readbackCalls", "calls", "migrationCatalog", "migrationHead", "migrationOwner", "allowedExtensions", "toolchain", "expectedScript", "raws"]) || !exact(m.sourceDigests, Object.keys(subjects.digests)) || !encode(m.sourceDigests).equals(encode(subjects.digests)) || !uuid(m.referenceRunId) || !Array.isArray(m.creationCalls) || !Array.isArray(m.readbackCalls) || !Array.isArray(m.calls) || m.creationCalls.length !== 6 || m.readbackCalls.length !== 3 || m.calls.length !== 4) fail("MANUAL_EXPECTED_SCHEMA_REFERENCE_INVALID");
  const needed = new Set();
  for (const [collection, tools] of [[m.creationCalls, CREATION_TOOLS], [m.readbackCalls, READBACK_TOOLS], [m.calls, PRISMA_TOOLS]]) collection.forEach((c, i) => {
    const argv = validateCall(c, raws, tools[i]); if (tools === PRISMA_TOOLS && !encode(argv).equals(encode([PRISMA, ...prismaArgs(tools[i])]))) fail("MANUAL_EXPECTED_SCHEMA_PROCESS_INVALID");
    for (const key of ["argv", "stdout", "stderr"]) needed.add(c[key].digest);
  });
  const before = json(rawAt(raws, m.creationCalls.at(-1).stdout)), after = json(rawAt(raws, m.readbackCalls[0].stdout)), root = path.posix.dirname(after.dataDirectory ?? "");
  if (!/^\/tmp\/manual-schema-reference-[a-zA-Z0-9_-]+$/u.test(root) || after.dataDirectory !== `${root}/data` || after.socketDirectory !== `${root}/socket`) fail("MANUAL_EXPECTED_SCHEMA_REFERENCE_IDENTITY_INVALID");
  databaseIdentity(before, after.dataDirectory, after.socketDirectory); databaseIdentity(after, after.dataDirectory, after.socketDirectory);
  if (!encode(m.identity).equals(encode(after)) || before.systemIdentifier !== after.systemIdentifier || before.databaseOid !== after.databaseOid) fail("MANUAL_EXPECTED_SCHEMA_REFERENCE_IDENTITY_INVALID");
  const catalog = catalogFromRows(json(rawAt(raws, m.readbackCalls[1].stdout)), subjects.catalog);
  if (!rawAt(raws, m.migrationCatalog).equals(encode(catalog)) || m.migrationCatalog.digest !== subjects.catalog.digest || m.migrationHead !== catalog.entries.at(-1).path.split("/").at(-2) || m.migrationOwner !== ROLE || after.ownerInventory.filter((i) => i.objectName === "_prisma_migrations" && i.objectClass === "relation" && i.owner === ROLE).length !== 1 || !encode(m.allowedExtensions).equals(encode(after.extensions))) fail("MANUAL_EXPECTED_SCHEMA_MIGRATIONS_INVALID");
  if (!exact(m.toolchain, ["nodeVersion", "postgresqlVersion", "prismaVersion", "prismaVersionRaw"]) || m.toolchain.nodeVersion !== text(rawAt(raws, m.creationCalls[0].stdout)).trim() || !/^v22\.\d+\.\d+$/u.test(m.toolchain.nodeVersion) || m.toolchain.postgresqlVersion !== after.serverVersion || !encode(m.toolchain.prismaVersionRaw).equals(encode(m.calls[0].stdout)) || m.toolchain.prismaVersion !== text(rawAt(raws, m.calls[0].stdout)).trim() || !/^prisma\s*:\s*7\.8\.0\s*$/mu.test(m.toolchain.prismaVersion) || !encode(m.expectedScript).equals(encode(m.calls[3].stdout)) || rawAt(raws, m.expectedScript).length === 0) fail("MANUAL_EXPECTED_SCHEMA_TOOLCHAIN_INVALID");
  if (text(rawAt(raws, m.calls[2].stdout)).trim() !== "") fail("MANUAL_EXPECTED_SCHEMA_DIFF_INVALID");
  if (m.createdAt !== m.creationCalls[4].closedAt || m.readbackAt !== m.readbackCalls[1].closedAt || m.calls.some((c) => !ordered([m.createdAt, c.preparedAt, c.spawnedAt, c.closedAt, m.readbackAt]))) fail("MANUAL_EXPECTED_SCHEMA_PROCESS_INVALID");
  needed.add(m.migrationCatalog.digest); if (needed.size !== raws.size || [...raws.keys()].some((d) => !needed.has(d))) fail("MANUAL_EXPECTED_SCHEMA_RAW_INVALID");
}
async function reopenPrivate(file, ref) {
  const before = await fs.lstat(file, { bigint: true });
  if (!before.isFile() || before.isSymbolicLink() || before.nlink !== 1n || before.size !== BigInt(ref.bytes) || before.size > BigInt(LIMIT) || (process.platform !== "win32" && (Number(before.mode) & 0o077) !== 0)) fail("MANUAL_EXPECTED_SCHEMA_RAW_INVALID");
  const handle = await fs.open(file, "r"); let raw;
  try { const held = await handle.stat({ bigint: true }); if (before.dev !== held.dev || before.ino !== held.ino) fail("MANUAL_EXPECTED_SCHEMA_RAW_INVALID"); raw = bytes(await handle.readFile()); const after = await handle.stat({ bigint: true }); if (held.dev !== after.dev || held.ino !== after.ino || held.size !== after.size || held.mtimeNs !== after.mtimeNs || held.ctimeNs !== after.ctimeNs) fail("MANUAL_EXPECTED_SCHEMA_RAW_INVALID"); } finally { await handle.close(); }
  const reopened = bytes(await fs.readFile(file)), final = await fs.lstat(file, { bigint: true });
  if (final.dev !== before.dev || final.ino !== before.ino || final.nlink !== 1n || final.size !== before.size || final.mtimeNs !== before.mtimeNs || final.ctimeNs !== before.ctimeNs || !reopened.equals(raw) || raw.length !== ref.bytes || sha256Bytes(raw) !== ref.digest) fail("MANUAL_EXPECTED_SCHEMA_RAW_INVALID"); return raw;
}

/** Internal protected-job function. Returns unpublished subjects, not admission. */
export async function produceManualExpectedSchema(input, { runProcess = spawnRaw, now = () => new Date() } = {}) {
  if (!exact(input, ["repoRoot", "proofBytes", "materialBytes", "buildIdentity"]) || typeof input.repoRoot !== "string") fail("MANUAL_EXPECTED_SCHEMA_INPUT_INVALID");
  const { repoRoot } = input, proofRaw = bytes(input.proofBytes), materialRaw = bytes(input.materialBytes), proof = canonical(proofRaw), material = json(materialRaw), buildIdentity = { ...input.buildIdentity };
  assertBuildIdentity({ proof, buildMaterialObservation: material });
  if (!exact(input.buildIdentity, IDENTITY_KEYS) || buildIdentity.repository !== "keqi119/subscription-Saas" || buildIdentity.workflowPath !== ".github/workflows/docker-images.yml" || buildIdentity.sourceRef !== "refs/heads/main" || buildIdentity.protectedEnvironment !== "trusted-image-build" || buildIdentity.runAttempt !== 1 || !/^[1-9][0-9]*$/u.test(buildIdentity.runId) || !Number.isSafeInteger(Number(buildIdentity.runId)) || buildIdentity.sourceSha !== proof.identity.sourceSha || proof.provenance.ciRunRef !== `https://github.com/${buildIdentity.repository}/actions/runs/${buildIdentity.runId}` || material.images.some((i) => i.buildRunRef !== proof.provenance.ciRunRef)) fail("MANUAL_EXPECTED_SCHEMA_IDENTITY_INVALID");
  if (runProcess === spawnRaw && (process.platform !== "linux" || process.env.RUNNER_ENVIRONMENT !== "github-hosted")) fail("MANUAL_EXPECTED_SCHEMA_HOST_RUNTIME_UNAVAILABLE");
  const environment = { PATH: process.env.PATH, LANG: "C.UTF-8", LC_ALL: "C.UTF-8", GIT_CONFIG_NOSYSTEM: "1", GIT_CONFIG_GLOBAL: process.platform === "win32" ? "NUL" : "/dev/null", GIT_TERMINAL_PROMPT: "0" }; if (process.platform === "win32") environment.SystemRoot = "C:\\Windows";
  async function host(command, argv, options = {}) { return processResult(await runProcess(command, argv, { environment, cwd: repoRoot, now, ...options })); }
  async function recheck() {
    const head = text((await host("git", ["--no-optional-locks", "-c", "core.fsmonitor=false", "rev-parse", "--verify", "HEAD"])).stdout).trim(), status = text((await host("git", ["--no-optional-locks", "-c", "core.fsmonitor=false", "status", "--porcelain", "--untracked-files=all"])).stdout), s = await sourceSubjects(repoRoot);
    if (head !== buildIdentity.sourceSha || status !== "" || s.catalog.digest !== proof.identity.migrationCatalogDigest || (await computeRepositoryContract(repoRoot)).digest !== proof.identity.repositoryContractDigest) fail("MANUAL_EXPECTED_SCHEMA_SOURCE_INVALID"); return s;
  }
  const subjects = await recheck(), pnpmVersion = text((await host("pnpm", ["--version"])).stdout).trim(); if (pnpmVersion !== "11.4.0") fail("MANUAL_EXPECTED_SCHEMA_TOOLCHAIN_INVALID");
  const dockerfile = text(await fs.readFile(path.join(repoRoot, "Dockerfile.runner"))); for (const base of [NODE_BASE, PG_BASE]) { const [name, hash] = base.split("@"); if (!dockerfile.includes(`FROM ${base} `) || !proof.provenance.baseImages.some((v) => v.name === name && v.resolvedDigest === hash)) fail("MANUAL_EXPECTED_SCHEMA_TOOLCHAIN_INVALID"); }
  const runnerImageDigest = proof.identity.images.runner.imageDigest, imageRef = `${proof.identity.images.runner.registry}@${runnerImageDigest}`;
  const privateRoot = await fs.mkdtemp(path.join(os.tmpdir(), "manual-schema-handoff-")); await fs.chmod(privateRoot, 0o700);
  const dockerConfig = path.join(privateRoot, "docker-config"); await fs.mkdir(dockerConfig, { mode: 0o700 });
  const docker = process.platform === "win32" ? "C:\\Program Files\\Docker\\Docker\\resources\\bin\\docker.exe" : "/usr/bin/docker", prefix = ["--host", process.platform === "win32" ? "npipe:////./pipe/docker_engine" : "unix:///var/run/docker.sock", "--config", dockerConfig];
  const rawBlobs = new Map(), references = [], manifests = [], envelope = { sourceSha: buildIdentity.sourceSha, ...subjects.digests, pnpmVersion }; let failure;
  try {
    for (let i = 0; i < 2; i++) {
      let id, manifest, refError; const creationCalls = [], readbackCalls = [], localRaws = new Map();
      const collect = async (tool, args, collection, options) => { const r = await host(docker, [...prefix, ...args], options); collection.push(capture(tool, docker, [...prefix, ...args], r, rawBlobs)); return r; };
      const inspect = (tool, collection) => collect(tool, ["container", "inspect", "--format", CONTAINER_FORMAT, id], collection);
      try {
        await recheck();
        id = text((await collect("container-create", ["create", "--pull=never", "--network=none", "--user=postgres", "--read-only", "--tmpfs", "/tmp:rw,nosuid,nodev,size=512m,mode=1777", "--tmpfs", "/var/lib/postgresql/data:rw,nosuid,nodev,size=16m,mode=1777", "--interactive", "--entrypoint", "/usr/local/bin/node", imageRef, "/app/" + PRODUCER, "--reference"], creationCalls)).stdout).trim();
        if (!/^[0-9a-f]{64}$/u.test(id)) { id = undefined; fail("MANUAL_EXPECTED_SCHEMA_CONTAINER_INVALID"); }
        const observed = json((await inspect("container-inspect", creationCalls)).stdout);
        if (!exact(observed, ["id", "imageId", "imageRef", "user", "network", "binds", "mounts", "tmpfs", "readonly", "status", "running", "exitCode"]) || observed.id !== id || observed.imageRef !== imageRef || observed.user !== "postgres" || observed.network !== "none" || observed.readonly !== true || (observed.binds !== null && !encode(observed.binds).equals(encode([]))) || !Array.isArray(observed.mounts) || observed.mounts.some((m) => !exact(m, ["type", "source", "destination"]) || m.type !== "tmpfs" || m.source !== "" || !["/tmp", "/var/lib/postgresql/data"].includes(m.destination)) || !exact(observed.tmpfs, ["/tmp", "/var/lib/postgresql/data"]) || observed.tmpfs["/tmp"] !== "rw,nosuid,nodev,size=512m,mode=1777" || observed.tmpfs["/var/lib/postgresql/data"] !== "rw,nosuid,nodev,size=16m,mode=1777" || observed.status !== "created" || observed.running !== false) fail("MANUAL_EXPECTED_SCHEMA_CONTAINER_INVALID");
        const image = json((await collect("image-inspect", ["image", "inspect", "--format", IMAGE_FORMAT, observed.imageId], creationCalls)).stdout);
        if (!exact(image, ["id", "repoDigests", "sourceRevision"]) || image.id !== observed.imageId || image.sourceRevision !== buildIdentity.sourceSha || !Array.isArray(image.repoDigests) || !image.repoDigests.includes(imageRef)) fail("MANUAL_EXPECTED_SCHEMA_CONTAINER_INVALID");
        await host(docker, [...prefix, "start", "--attach", "--interactive", id], { stdin: Buffer.concat([encode(envelope), Buffer.from("\n")]), timeoutMs: 600000, onManifest: async (frame) => {
          manifest = canonical(frame); if (!Array.isArray(manifest.raws) || manifest.raws.length === 0 || manifest.raws.length > 128) fail("MANUAL_EXPECTED_SCHEMA_RAW_INVALID");
          const copyRoot = path.join(privateRoot, id); await fs.mkdir(copyRoot, { mode: 0o700 }); let previous = ""; const handoffDeadline = Date.now() + 25000;
          for (const ref of manifest.raws) {
            if (!exact(ref, ["digest", "bytes"]) || !digest(ref.digest) || !Number.isSafeInteger(ref.bytes) || ref.bytes < 0 || ref.bytes > LIMIT || ref.digest <= previous) fail("MANUAL_EXPECTED_SCHEMA_RAW_INVALID"); previous = ref.digest;
            if (Date.now() >= handoffDeadline) fail("MANUAL_EXPECTED_SCHEMA_HANDOFF_INVALID");
            const name = `${ref.digest.slice(7)}.bin`, destination = path.join(copyRoot, name);
            await host(docker, [...prefix, "cp", `${id}:${OUTPUT}/${name}`, destination], { timeoutMs: 20000 }); addRaw(localRaws, await reopenPrivate(destination, ref));
          }
          if (Date.now() >= handoffDeadline) fail("MANUAL_EXPECTED_SCHEMA_HANDOFF_INVALID"); validateManifest(manifest, localRaws, subjects);
        } });
        if (!manifest) fail("MANUAL_EXPECTED_SCHEMA_HANDOFF_INVALID");
        const exited = json((await inspect("container-exit-inspect", readbackCalls)).stdout); if (exited.id !== id || exited.imageId !== image.id || exited.status !== "exited" || exited.running !== false || exited.exitCode !== 0) fail("MANUAL_EXPECTED_SCHEMA_CONTAINER_INVALID");
      } catch (error) { refError = error; }
      finally {
        if (id) {
          let cleanupFailure;
          try { await collect("container-stop", ["stop", "--time", "10", id], readbackCalls, { timeoutMs: 20000 }); } catch (error) { cleanupFailure = error; }
          try { const removed = text((await collect("container-remove", ["rm", "--force", "--volumes", id], readbackCalls, { timeoutMs: 20000 })).stdout).trim(); if (removed !== id) fail("MANUAL_EXPECTED_SCHEMA_CONTAINER_CLEANUP_FAILED"); } catch (error) { cleanupFailure ??= error; }
          if (cleanupFailure) refError = Object.assign(new Error("MANUAL_EXPECTED_SCHEMA_CONTAINER_CLEANUP_FAILED", { cause: refError ?? cleanupFailure }), { code: "MANUAL_EXPECTED_SCHEMA_CONTAINER_CLEANUP_FAILED", containerId: id });
        }
      }
      if (refError) throw refError;
      for (const raw of localRaws.values()) addRaw(rawBlobs, raw);
      const creationEvidence = addRaw(rawBlobs, encode({ recordVersion: "manual-expected-reference-creation.v1", referenceRunId: manifest.referenceRunId, calls: [...creationCalls, ...manifest.creationCalls] })), readbackEvidence = addRaw(rawBlobs, encode({ recordVersion: "manual-expected-reference-readback.v1", referenceRunId: manifest.referenceRunId, calls: [...manifest.readbackCalls, ...readbackCalls] })), db = manifest.identity;
      references.push({ referenceRunId: manifest.referenceRunId, identity: { cluster: { systemIdentifier: db.systemIdentifier, databaseContainerId: id, runnerImageDigest, postgresImageDigest: PG_DIGEST, dataDirectory: db.dataDirectory, socketDirectory: db.socketDirectory, listenAddresses: db.listenAddresses, configuredPort: db.configuredPort }, databaseName: db.databaseName, databaseOid: db.databaseOid }, createdAt: manifest.createdAt, readbackAt: manifest.readbackAt, creationEvidence, readbackEvidence, migrationCatalog: manifest.migrationCatalog, migrationHead: manifest.migrationHead, migrationOwner: manifest.migrationOwner, allowedExtensions: manifest.allowedExtensions, calls: manifest.calls });
      manifests.push(manifest);
    }
  } catch (error) { failure = error; }
  finally { await fs.rm(privateRoot, { recursive: true, force: true }); }
  if (failure) throw failure;
  const [a, b] = references, [ma, mb] = manifests, stable = (r) => ({ migrationCatalog: r.migrationCatalog, migrationHead: r.migrationHead, migrationOwner: r.migrationOwner, allowedExtensions: r.allowedExtensions });
  if (a.referenceRunId === b.referenceRunId || a.identity.cluster.databaseContainerId === b.identity.cluster.databaseContainerId || (a.identity.cluster.systemIdentifier === b.identity.cluster.systemIdentifier && a.identity.databaseOid === b.identity.databaseOid) || !encode(stable(a)).equals(encode(stable(b))) || !encode(ma.toolchain).equals(encode(mb.toolchain)) || !rawAt(rawBlobs, ma.expectedScript).equals(rawAt(rawBlobs, mb.expectedScript)) || !rawAt(rawBlobs, ma.toolchain.prismaVersionRaw).equals(rawAt(rawBlobs, mb.toolchain.prismaVersionRaw)) || !encode(ma.identity.ownerInventory).equals(encode(mb.identity.ownerInventory))) fail("MANUAL_EXPECTED_SCHEMA_REPRODUCTION_FAILED");
  const finalSubjects = await recheck(); if (!encode(finalSubjects.digests).equals(encode(subjects.digests))) fail("MANUAL_EXPECTED_SCHEMA_SOURCE_INVALID");
  const generatedAt = timestamp(now), buildProofDigest = sha256Canonical(proof), sourceSchema = addRaw(rawBlobs, subjects.sourceSchemaBytes), config = addRaw(rawBlobs, subjects.configBytes), lockfile = addRaw(rawBlobs, subjects.lockBytes), proofRef = addRaw(rawBlobs, proofRaw);
  if (references.some((r) => !ordered([r.createdAt, r.readbackAt, generatedAt]))) fail("MANUAL_EXPECTED_SCHEMA_PROCESS_INVALID");
  const provenance = { recordVersion: "manual-expected-schema-provenance.v1", buildProofDigest, proofRaw: proofRef, sourceSha: buildIdentity.sourceSha, ci: { repository: buildIdentity.repository, workflowPath: buildIdentity.workflowPath, sourceRef: buildIdentity.sourceRef, runId: buildIdentity.runId, runAttempt: 1, runnerClass: "github-hosted" }, sourceSchema: { path: SCHEMA, raw: sourceSchema }, config: { path: CONFIG, raw: config }, lockfile: { path: "pnpm-lock.yaml", raw: lockfile }, migrationCatalogDigest: subjects.catalog.digest, toolchain: { runnerImageDigest, postgresImageDigest: PG_DIGEST, ...ma.toolchain }, expectedScript: ma.expectedScript, references, generatedAt, promotionEligible: false };
  const expectation = { schemaVersion: "manual-runner-evidence.v1", recordedAt: generatedAt, promotionEligible: false, kind: "schema-expectation", buildProofDigest, sourceSchemaDigest: sourceSchema.digest, prismaVersion: ma.toolchain.prismaVersion, script: ma.expectedScript, sourceSchemaPath: SCHEMA }; validateContract("manual-runner-evidence.v1", expectation);
  return { sourceSchemaBytes: Buffer.from(subjects.sourceSchemaBytes), scriptBytes: Buffer.from(rawAt(rawBlobs, ma.expectedScript)), prismaVersionBytes: Buffer.from(rawAt(rawBlobs, ma.toolchain.prismaVersionRaw)), producerRecordBytes: encode(provenance), schemaExpectationBytes: encode(expectation), rawBlobs };
}

function stdinFrames(stream) {
  const queue = []; let held = Buffer.alloc(0), ended = false, problem, waiter;
  function wake() { if (waiter) { const resolve = waiter; waiter = undefined; resolve(); } }
  stream.on("data", (chunk) => {
    if (problem) return; held = Buffer.concat([held, chunk]);
    if (held.length > LIMIT) { problem = Object.assign(new Error("MANUAL_EXPECTED_SCHEMA_HANDOFF_INVALID"), { code: "MANUAL_EXPECTED_SCHEMA_HANDOFF_INVALID" }); wake(); return; }
    let end; while ((end = held.indexOf(10)) !== -1) { queue.push(held.subarray(0, end + 1)); held = held.subarray(end + 1); if (queue.length > 2) problem = Object.assign(new Error("MANUAL_EXPECTED_SCHEMA_HANDOFF_INVALID"), { code: "MANUAL_EXPECTED_SCHEMA_HANDOFF_INVALID" }); } wake();
  });
  stream.on("end", () => { ended = true; wake(); }); stream.on("error", (error) => { problem = error; wake(); });
  const next = async (eof = false) => {
    const deadline = Date.now() + 30000;
    while (true) {
      if (problem) throw problem;
      if (eof) { if (queue.length || held.length) fail("MANUAL_EXPECTED_SCHEMA_HANDOFF_INVALID"); if (ended) return; }
      else { if (queue.length) return queue.shift(); if (ended) fail("MANUAL_EXPECTED_SCHEMA_HANDOFF_INVALID"); }
      const remaining = deadline - Date.now(); if (remaining <= 0) fail("MANUAL_EXPECTED_SCHEMA_HANDOFF_INVALID");
      await new Promise((resolve) => { const timer = setTimeout(() => { waiter = undefined; resolve(); }, remaining); waiter = () => { clearTimeout(timer); resolve(); }; });
    }
  };
  next.assertOpen = () => { if (problem) throw problem; if (ended || queue.length || held.length) fail("MANUAL_EXPECTED_SCHEMA_HANDOFF_INVALID"); };
  return next;
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    if (process.argv.length !== 3 || process.argv[2] !== "--reference") fail("MANUAL_EXPECTED_SCHEMA_REFERENCE_INPUT_INVALID");
    const next = stdinFrames(process.stdin), first = await next(), output = await runReferenceExpectedSchema(canonical(first.subarray(0, first.length - 1)));
    next.assertOpen(); await fs.mkdir(OUTPUT, { mode: 0o700 });
    for (const [d, raw] of output.rawBlobs) { const handle = await fs.open(`${OUTPUT}/${d.slice(7)}.bin`, "wx", 0o600); try { await handle.writeFile(raw); await handle.sync(); } finally { await handle.close(); } }
    next.assertOpen(); const manifest = encode(output.manifest); if (manifest.length >= LIMIT) fail("MANUAL_EXPECTED_SCHEMA_RAW_INVALID"); process.stdout.write(Buffer.concat([manifest, Buffer.from("\n")]));
    const release = await next(); if (!release.equals(Buffer.from("RELEASE\n"))) fail("MANUAL_EXPECTED_SCHEMA_HANDOFF_INVALID"); await next(true); await fs.rm(OUTPUT, { recursive: true, force: true });
  } catch (error) { process.stderr.write(`${error.code ?? "MANUAL_EXPECTED_SCHEMA_REFERENCE_FAILED"}\n`); process.exitCode = 1; }
}
