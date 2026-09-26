import { spawn } from "node:child_process";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { fileURLToPath } from "node:url";
import { TextDecoder } from "node:util";
import { canonicalJson, computeMigrationCatalog, computeRepositoryContract, sha256Bytes, sha256Canonical, validateContract } from "../../packages/release-foundation/src/index.mjs";
import { assertBuildIdentity } from "./verify-build-proof.mjs";

const LIMIT = 1048576;
const SCHEMA = "apps/api/prisma/schema.prisma";
const CONFIG = "apps/api/prisma.config.ts";
const PRODUCER = "scripts/release/manual-expected-schema-producer.mjs";
const NODE_BASE = "node:22-bookworm-slim@sha256:6c74791e557ce11fc957704f6d4fe134a7bc8d6f5ca4403205b2966bd488f6b3";
const PG_BASE = "postgres:17.11-bookworm@sha256:051f7b7b3abdd564d5d1bd1e8c4b9c1b6e77087d1dd22020ede611c096a272e0";
const ENVELOPE_KEYS = ["sourceSha", "migrationCatalogDigest", "sourceSchemaDigest", "configDigest", "lockDigest", "producerDigest", "pnpmVersion"];
const IDENTITY_KEYS = ["sourceSha", "repository", "workflowPath", "sourceRef", "runId", "runAttempt", "protectedEnvironment"];
const ROLE = "expected_schema_owner";
const DATABASE = "expected_schema_reference";
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
 'socketDirectory', current_setting('unix_socket_directories'))::text`;
const MIGRATIONS_SQL = `SELECT coalesce(json_agg(m ORDER BY m.name),'[]'::json)::text FROM (
 SELECT migration_name::text AS name,checksum::text AS checksum,finished_at IS NOT NULL AS finished,
 rolled_back_at IS NOT NULL AS "rolledBack",applied_steps_count AS "appliedSteps" FROM public._prisma_migrations
) m`;

function fail(code, details) { throw Object.assign(new Error(code), { code, details }); }
function exact(value, keys) {
  return value && typeof value === "object" && !Array.isArray(value) &&
    [Object.prototype, null].includes(Object.getPrototypeOf(value)) &&
    Reflect.ownKeys(value).length === keys.length && keys.every((key) => {
      const d = Object.getOwnPropertyDescriptor(value, key);
      return d?.enumerable && "value" in d;
    });
}
function bytes(value) {
  if (!(value instanceof Uint8Array) || value.byteLength > LIMIT) fail("MANUAL_EXPECTED_SCHEMA_RAW_INVALID");
  return Buffer.from(value);
}
function text(value) { try { return new TextDecoder("utf-8", { fatal: true }).decode(bytes(value)); } catch { fail("MANUAL_EXPECTED_SCHEMA_RAW_INVALID"); } }
function json(value) { try { return JSON.parse(text(value)); } catch { fail("MANUAL_EXPECTED_SCHEMA_JSON_INVALID"); } }
function encode(value) { return bytes(Buffer.from(canonicalJson(value))); }
function unbase64(value) {
  if (typeof value !== "string" || value.length > Math.ceil(LIMIT / 3) * 4) fail("MANUAL_EXPECTED_SCHEMA_RAW_INVALID");
  const raw = bytes(Buffer.from(value, "base64"));
  if (raw.toString("base64") !== value) fail("MANUAL_EXPECTED_SCHEMA_RAW_INVALID");
  text(raw); return raw;
}
function timestamp(now) {
  const date = now();
  if (!(date instanceof Date) || !Number.isFinite(date.getTime())) fail("MANUAL_EXPECTED_SCHEMA_CLOCK_INVALID");
  return date.toISOString();
}
function processResult(value) {
  if (!exact(value, ["stdout", "stderr", "exitCode", "signal"]) || !Number.isInteger(value.exitCode) ||
      (value.signal !== null && typeof value.signal !== "string")) fail("MANUAL_EXPECTED_SCHEMA_PROCESS_INVALID");
  const stdout = bytes(value.stdout), stderr = bytes(value.stderr);
  text(stdout); text(stderr);
  if (value.exitCode !== 0 || value.signal !== null) fail("MANUAL_EXPECTED_SCHEMA_PROCESS_FAILED", { exitCode: value.exitCode, signal: value.signal });
  return { ...value, stdout, stderr };
}

// Raw buffers are captured before decoding. Neither timeout nor killed process
// produces successful close evidence. No shell or ambient datasource is used.
function spawnRaw(command, argv, { environment, cwd, stdin, timeoutMs = 300000 }) {
  return new Promise((resolve, reject) => {
    const child = spawn(command, argv, { env: environment, cwd, shell: false, windowsHide: true, stdio: ["pipe", "pipe", "pipe"] });
    const out = [], err = []; let outSize = 0, errSize = 0, failure = null, killTimer, closeTimer;
    function finish(error, value) { clearTimeout(timer); clearTimeout(killTimer); clearTimeout(closeTimer); if (error) reject(error); else resolve(value); }
    function abort(code) {
      if (failure) return;
      failure = Object.assign(new Error(code), { code }); child.kill("SIGTERM");
      killTimer = setTimeout(() => child.kill("SIGKILL"), 2000);
      closeTimer = setTimeout(() => finish(failure), 5000);
    }
    const timer = setTimeout(() => abort("MANUAL_EXPECTED_SCHEMA_PROCESS_TIMEOUT"), timeoutMs);
    child.stdout.on("data", (chunk) => { outSize += chunk.length; if (outSize > LIMIT) abort("MANUAL_EXPECTED_SCHEMA_RAW_INVALID"); else out.push(chunk); });
    child.stderr.on("data", (chunk) => { errSize += chunk.length; if (errSize > LIMIT) abort("MANUAL_EXPECTED_SCHEMA_RAW_INVALID"); else err.push(chunk); });
    child.once("error", (error) => finish(error));
    child.stdin.on("error", (error) => { if (error.code !== "EPIPE") finish(error); });
    child.once("close", (exitCode, signal) => finish(failure, { exitCode: exitCode ?? 1, signal: signal ?? null, stdout: Buffer.concat(out), stderr: Buffer.concat(err) }));
    child.stdin.end(stdin ?? Buffer.alloc(0));
  });
}

async function sourceSubjects(repoRoot) {
  const sourceSchemaBytes = bytes(await fs.readFile(path.join(repoRoot, SCHEMA))); text(sourceSchemaBytes);
  const configBytes = bytes(await fs.readFile(path.join(repoRoot, CONFIG))); text(configBytes);
  const lockBytes = bytes(await fs.readFile(path.join(repoRoot, "pnpm-lock.yaml"))); text(lockBytes);
  const producerBytes = bytes(await fs.readFile(path.join(repoRoot, PRODUCER))); text(producerBytes);
  const catalog = await computeMigrationCatalog(repoRoot);
  if (catalog.entries.length === 0 || json(await fs.readFile(path.join(repoRoot, "package.json"))).packageManager !== "pnpm@11.4.0") fail("MANUAL_EXPECTED_SCHEMA_SOURCE_INVALID");
  return { sourceSchemaBytes, catalog, digests: { sourceSchemaDigest: sha256Bytes(sourceSchemaBytes), configDigest: sha256Bytes(configBytes), lockDigest: sha256Bytes(lockBytes), producerDigest: sha256Bytes(producerBytes), migrationCatalogDigest: catalog.digest } };
}

/** Fixed image-internal reference procedure. Options are low-level offline test seams. */
export async function runReferenceExpectedSchema(envelope, { repoRoot = "/app", runProcess = spawnRaw, now = () => new Date() } = {}) {
  if (!exact(envelope, ENVELOPE_KEYS) || !/^[0-9a-f]{40}$/u.test(envelope.sourceSha) || envelope.pnpmVersion !== "11.4.0" ||
      ENVELOPE_KEYS.filter((k) => k.endsWith("Digest")).some((k) => !/^sha256:[0-9a-f]{64}$/u.test(envelope[k]))) fail("MANUAL_EXPECTED_SCHEMA_REFERENCE_INPUT_INVALID");
  if (runProcess === spawnRaw && (process.platform !== "linux" || process.getuid() === 0)) fail("MANUAL_EXPECTED_SCHEMA_REFERENCE_RUNTIME_UNAVAILABLE");
  const subjects = await sourceSubjects(repoRoot);
  if (Object.entries(subjects.digests).some(([key, value]) => envelope[key] !== value)) fail("MANUAL_EXPECTED_SCHEMA_SOURCE_INVALID");
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), "manual-schema-reference-"));
  await fs.chmod(directory, 0o700);
  const data = path.join(directory, "data"), socket = path.join(directory, "socket");
  await fs.mkdir(socket, { mode: 0o700 });
  const referenceId = randomUUID(), commands = [], lifecycle = { allocatedAt: timestamp(now) };
  const pg = (name) => `/usr/lib/postgresql/17/bin/${name}`;
  const prisma = path.join(repoRoot, "apps/release-runner/node_modules/.bin/prisma");
  // Prisma's host query parameter selects a Unix socket directory. The server
  // additionally has no TCP listeners, inside a container with network:none.
  const databaseUrl = `postgresql://${ROLE}@localhost:5432/${DATABASE}?host=${encodeURIComponent(socket)}&schema=public`;
  const environment = { PATH: "/usr/local/bin:/usr/bin:/bin:/usr/lib/postgresql/17/bin", LANG: "C.UTF-8", LC_ALL: "C.UTF-8", STAGE1_ACCEPTANCE_MIGRATION_SKIP_DOTENV: "1", DATABASE_URL: databaseUrl, REFERENCE_SOCKET_DIRECTORY: socket, HOME: directory, XDG_CACHE_HOME: directory, CHECKPOINT_DISABLE: "1", PRISMA_HIDE_UPDATE_MESSAGE: "1" };
  async function run(command, argv, timeoutMs) {
    const startedAt = timestamp(now);
    const result = processResult(await runProcess(command, argv, { environment, cwd: repoRoot, timeoutMs }));
    commands.push({ command, argv, startedAt, closedAt: timestamp(now), exitCode: result.exitCode, signal: result.signal,
      stdout: { digest: sha256Bytes(result.stdout), bytes: result.stdout.length }, stderr: { digest: sha256Bytes(result.stderr), bytes: result.stderr.length } });
    return result.stdout;
  }
  const psqlArgs = ["--no-psqlrc", "--no-password", "--host", socket, "--port", "5432", "--username", ROLE, "--dbname", DATABASE, "--tuples-only", "--no-align", "--set", "ON_ERROR_STOP=1", "--command"];
  let startAttempted = false, stopped = false, output, originalError;
  try {
    const nodeVersion = text(await run("/usr/local/bin/node", ["--version"])).trim();
    const psqlVersion = text(await run(pg("psql"), ["--version"])).trim();
    if (!/^v22\.\d+\.\d+$/u.test(nodeVersion) || !/^psql \(PostgreSQL\) 17\.11(?: \([^()]+\))?$/u.test(psqlVersion)) fail("MANUAL_EXPECTED_SCHEMA_TOOLCHAIN_INVALID");
    const prismaVersionBytes = await run(prisma, ["--version"]), prismaVersion = text(prismaVersionBytes).trim();
    if (!/^prisma\s*:\s*7\.8\.0\s*$/mu.test(prismaVersion) || !prismaVersion.includes("\n")) fail("MANUAL_EXPECTED_SCHEMA_TOOLCHAIN_INVALID");
    await run(pg("initdb"), ["--pgdata", data, "--username", ROLE, "--encoding=UTF8", "--locale=C.UTF-8", "--auth-local=trust", "--auth-host=reject"]);
    lifecycle.initializedAt = timestamp(now);
    startAttempted = true;
    await run(pg("pg_ctl"), ["--pgdata", data, "--log", path.join(directory, "server.log"), "--wait", "--timeout=30", "--options", `-c listen_addresses='' -c unix_socket_directories=${socket} -c unix_socket_permissions=0700 -c port=5432`, "start"], 45000);
    lifecycle.startedAt = timestamp(now);
    await run(pg("psql"), [...psqlArgs.map((arg) => arg === DATABASE ? "postgres" : arg), `CREATE DATABASE ${DATABASE} OWNER ${ROLE}`]);
    lifecycle.databaseCreatedAt = timestamp(now);
    const before = json(await run(pg("psql"), [...psqlArgs, IDENTITY_SQL]));
    await run(prisma, ["migrate", "deploy", "--schema", path.join(repoRoot, SCHEMA), "--config", path.join(repoRoot, CONFIG)]);
    const migrations = json(await run(pg("psql"), [...psqlArgs, MIGRATIONS_SQL]));
    if (!Array.isArray(migrations) || migrations.length !== subjects.catalog.entries.length || migrations.some((m, i) =>
      !exact(m, ["name", "checksum", "finished", "rolledBack", "appliedSteps"]) || m.name !== subjects.catalog.entries[i].path.split("/").at(-2) ||
      m.checksum !== subjects.catalog.entries[i].sha256.slice(7) || m.finished !== true || m.rolledBack !== false || !Number.isInteger(m.appliedSteps) || m.appliedSteps < 1)) fail("MANUAL_EXPECTED_SCHEMA_MIGRATIONS_INVALID");
    const identity = json(await run(pg("psql"), [...psqlArgs, IDENTITY_SQL]));
    if (!exact(identity, ["databaseName", "databaseOid", "systemIdentifier", "serverVersion", "schemaOwner", "ownerInventory", "extensions", "listenAddresses", "socketDirectory"]) ||
      identity.databaseName !== DATABASE || !/^[1-9][0-9]*$/u.test(identity.databaseOid) || !/^[1-9][0-9]*$/u.test(identity.systemIdentifier) ||
      !/^17\.11(?: \([^()]+\))?$/u.test(identity.serverVersion) || identity.listenAddresses !== "" || identity.socketDirectory !== socket ||
      before.databaseOid !== identity.databaseOid || before.systemIdentifier !== identity.systemIdentifier ||
      ![ROLE, "pg_database_owner"].includes(identity.schemaOwner) || !Array.isArray(identity.ownerInventory) || identity.ownerInventory.length === 0 ||
      identity.ownerInventory.some((i) => !exact(i, ["objectClass", "objectName", "owner"]) || ![ROLE, "pg_database_owner"].includes(i.owner)) || !Array.isArray(identity.extensions)) fail("MANUAL_EXPECTED_SCHEMA_REFERENCE_IDENTITY_INVALID");
    const extensions = new Set(["plpgsql"]);
    for (const migration of subjects.catalog.entries) {
      const sql = text(await fs.readFile(path.join(repoRoot, migration.path)));
      for (const match of sql.matchAll(/CREATE\s+EXTENSION\s+(?:IF\s+NOT\s+EXISTS\s+)?"?([a-z0-9_]+)"?/giu)) extensions.add(match[1].toLowerCase());
    }
    if (canonicalJson(identity.extensions) !== canonicalJson([...extensions].sort())) fail("MANUAL_EXPECTED_SCHEMA_REFERENCE_IDENTITY_INVALID");
    await run(prisma, ["migrate", "diff", "--from-config-datasource", "--to-schema", path.join(repoRoot, SCHEMA), "--exit-code", "--config", path.join(repoRoot, CONFIG)]);
    const scriptBytes = await run(prisma, ["migrate", "diff", "--from-empty", "--to-config-datasource", "--script", "--config", path.join(repoRoot, CONFIG)]);
    if (scriptBytes.length === 0) fail("MANUAL_EXPECTED_SCHEMA_RAW_INVALID");
    const reread = await sourceSubjects(repoRoot);
    if (canonicalJson(reread.digests) !== canonicalJson(subjects.digests) || !reread.sourceSchemaBytes.equals(subjects.sourceSchemaBytes)) fail("MANUAL_EXPECTED_SCHEMA_SOURCE_INVALID");
    output = { ...subjects.digests, sourceSchemaBase64: subjects.sourceSchemaBytes.toString("base64"), scriptBase64: scriptBytes.toString("base64"),
      referenceId, lifecycle, databaseIdentity: identity, creationReadback: before, migrations, migrationHead: migrations.at(-1).name,
      tools: { nodeVersion, pnpmVersion: envelope.pnpmVersion, psqlVersion, postgresqlVersion: identity.serverVersion, prismaVersion, prismaVersionRawDigest: sha256Bytes(prismaVersionBytes), prismaVersionRawBytes: prismaVersionBytes.length }, commands };
  } catch (error) { originalError = error; }
  finally {
    if (startAttempted) {
      try { await run(pg("pg_ctl"), ["--pgdata", data, "--wait", "--timeout=30", "--mode=immediate", "stop"], 45000); stopped = true; lifecycle.stoppedAt = timestamp(now); }
      catch (error) { originalError = Object.assign(new Error("MANUAL_EXPECTED_SCHEMA_REFERENCE_CLEANUP_FAILED", { cause: originalError ?? error }), { code: "MANUAL_EXPECTED_SCHEMA_REFERENCE_CLEANUP_FAILED", referenceId }); }
    }
    // Never remove a data directory while a server might still be alive. The
    // outer producer will stop/remove the exact disposable container on failure.
    if (!startAttempted || stopped) await fs.rm(directory, { recursive: true, force: true });
  }
  if (originalError) throw originalError;
  encode(output); return output;
}

/** Internal protected-job producer. No dispatch, target, storage or admission API. */
export async function produceManualExpectedSchema(input, { runProcess = spawnRaw, now = () => new Date() } = {}) {
  if (!exact(input, ["repoRoot", "proofBytes", "materialBytes", "buildIdentity"]) || typeof input.repoRoot !== "string") fail("MANUAL_EXPECTED_SCHEMA_INPUT_INVALID");
  const { repoRoot } = input, proofRaw = bytes(input.proofBytes), materialRaw = bytes(input.materialBytes), proof = json(proofRaw), material = json(materialRaw);
  const buildIdentity = { ...input.buildIdentity };
  assertBuildIdentity({ proof, buildMaterialObservation: material });
  if (!proofRaw.equals(encode(proof)) || !exact(input.buildIdentity, IDENTITY_KEYS) ||
      buildIdentity.repository !== "keqi119/subscription-Saas" || buildIdentity.workflowPath !== ".github/workflows/docker-images.yml" ||
      buildIdentity.sourceRef !== "refs/heads/main" || buildIdentity.protectedEnvironment !== "trusted-image-build" || buildIdentity.runAttempt !== 1 ||
      !/^[1-9][0-9]*$/u.test(buildIdentity.runId) || !Number.isSafeInteger(Number(buildIdentity.runId)) || buildIdentity.sourceSha !== proof.identity.sourceSha ||
      proof.provenance.ciRunRef !== `https://github.com/${buildIdentity.repository}/actions/runs/${buildIdentity.runId}` ||
      material.images.some((i) => i.buildRunRef !== proof.provenance.ciRunRef)) fail("MANUAL_EXPECTED_SCHEMA_IDENTITY_INVALID");
  if (runProcess === spawnRaw && process.platform !== "linux") fail("MANUAL_EXPECTED_SCHEMA_HOST_RUNTIME_UNAVAILABLE");
  const environment = { PATH: process.env.PATH, LANG: "C.UTF-8", LC_ALL: "C.UTF-8", GIT_CONFIG_NOSYSTEM: "1", GIT_CONFIG_GLOBAL: process.platform === "win32" ? "NUL" : "/dev/null", GIT_TERMINAL_PROMPT: "0" };
  if (process.platform === "win32") environment.SystemRoot = "C:\\Windows";
  async function host(command, argv, options = {}) { return processResult(await runProcess(command, argv, { environment, cwd: repoRoot, ...options })); }
  async function recheck() {
    const head = text((await host("git", ["--no-optional-locks", "-c", "core.fsmonitor=false", "rev-parse", "--verify", "HEAD"])).stdout).trim();
    const status = text((await host("git", ["--no-optional-locks", "-c", "core.fsmonitor=false", "status", "--porcelain", "--untracked-files=all"])).stdout);
    const subjects = await sourceSubjects(repoRoot);
    if (head !== buildIdentity.sourceSha || status !== "" || subjects.catalog.digest !== proof.identity.migrationCatalogDigest ||
        (await computeRepositoryContract(repoRoot)).digest !== proof.identity.repositoryContractDigest) fail("MANUAL_EXPECTED_SCHEMA_SOURCE_INVALID");
    return subjects;
  }
  const subjects = await recheck();
  const pnpmVersion = text((await host("pnpm", ["--version"])).stdout).trim();
  if (pnpmVersion !== "11.4.0") fail("MANUAL_EXPECTED_SCHEMA_TOOLCHAIN_INVALID");
  const dockerfile = text(await fs.readFile(path.join(repoRoot, "Dockerfile.runner")));
  for (const base of [NODE_BASE, PG_BASE]) {
    const [name, hash] = base.split("@");
    if (!dockerfile.includes(`FROM ${base} `) || !proof.provenance.baseImages.some((v) => v.name === name && v.resolvedDigest === hash)) fail("MANUAL_EXPECTED_SCHEMA_TOOLCHAIN_INVALID");
  }
  const imageRef = `${proof.identity.images.runner.registry}@${proof.identity.images.runner.imageDigest}`;
  const dockerConfig = await fs.mkdtemp(path.join(os.tmpdir(), "manual-schema-docker-config-")); await fs.chmod(dockerConfig, 0o700);
  const docker = process.platform === "win32" ? "C:\\Program Files\\Docker\\Docker\\resources\\bin\\docker.exe" : "/usr/bin/docker";
  const dockerPrefix = ["--host", process.platform === "win32" ? "npipe:////./pipe/docker_engine" : "unix:///var/run/docker.sock", "--config", dockerConfig];
  const references = [], envelope = { sourceSha: buildIdentity.sourceSha, ...subjects.digests, pnpmVersion };
  let failure;
  try {
    for (let i = 0; i < 2; i++) {
      let id, removed = false, reference, referenceFailure;
      try {
        await recheck();
        id = text((await host(docker, [...dockerPrefix, "create", "--pull=never", "--network=none", "--user=postgres", "--read-only", "--tmpfs", "/tmp:rw,nosuid,nodev,size=512m,mode=1777", "--tmpfs", "/var/lib/postgresql/data:rw,nosuid,nodev,size=16m,mode=1777", "--interactive", "--entrypoint", "/usr/local/bin/node", imageRef, "/app/" + PRODUCER, "--reference"])).stdout).trim();
        if (!/^[0-9a-f]{64}$/u.test(id)) { id = undefined; fail("MANUAL_EXPECTED_SCHEMA_CONTAINER_INVALID"); }
        const inspect = async () => json((await host(docker, [...dockerPrefix, "container", "inspect", "--format", CONTAINER_FORMAT, id])).stdout);
        const inspected = await inspect();
        if (!exact(inspected, ["id", "imageId", "imageRef", "user", "network", "binds", "mounts", "tmpfs", "readonly", "status", "running", "exitCode"]) ||
            inspected.id !== id || inspected.imageRef !== imageRef || inspected.user !== "postgres" || inspected.network !== "none" || inspected.readonly !== true ||
            (inspected.binds !== null && canonicalJson(inspected.binds) !== "[]") || !Array.isArray(inspected.mounts) || inspected.mounts.some((m) =>
              !exact(m, ["type", "source", "destination"]) || m.type !== "tmpfs" || m.source !== "" || !["/tmp", "/var/lib/postgresql/data"].includes(m.destination)) ||
            !exact(inspected.tmpfs, ["/tmp", "/var/lib/postgresql/data"]) || inspected.tmpfs["/tmp"] !== "rw,nosuid,nodev,size=512m,mode=1777" ||
            inspected.tmpfs["/var/lib/postgresql/data"] !== "rw,nosuid,nodev,size=16m,mode=1777" || inspected.status !== "created" || inspected.running !== false) fail("MANUAL_EXPECTED_SCHEMA_CONTAINER_INVALID");
        const image = json((await host(docker, [...dockerPrefix, "image", "inspect", "--format", IMAGE_FORMAT, inspected.imageId])).stdout);
        if (!exact(image, ["id", "repoDigests", "sourceRevision"]) || image.id !== inspected.imageId || image.sourceRevision !== buildIdentity.sourceSha ||
            !Array.isArray(image.repoDigests) || !image.repoDigests.includes(imageRef)) fail("MANUAL_EXPECTED_SCHEMA_CONTAINER_INVALID");
        const startedAt = timestamp(now);
        const transport = (await host(docker, [...dockerPrefix, "start", "--attach", "--interactive", id], { stdin: encode(envelope), timeoutMs: 600000 })).stdout;
        reference = json(transport);
        if (!exact(reference, [...Object.keys(subjects.digests), "sourceSchemaBase64", "scriptBase64", "referenceId", "lifecycle", "databaseIdentity", "creationReadback", "migrations", "migrationHead", "tools", "commands"]) ||
            Object.entries(subjects.digests).some(([key, value]) => reference[key] !== value)) fail("MANUAL_EXPECTED_SCHEMA_SOURCE_INVALID");
        const source = unbase64(reference.sourceSchemaBase64), script = unbase64(reference.scriptBase64);
        if (!source.equals(subjects.sourceSchemaBytes) || script.length === 0 || !reference.lifecycle?.stoppedAt) fail("MANUAL_EXPECTED_SCHEMA_REFERENCE_INVALID");
        const finished = await inspect();
        if (finished.id !== id || finished.imageId !== image.id || finished.status !== "exited" || finished.running !== false || finished.exitCode !== 0) fail("MANUAL_EXPECTED_SCHEMA_CONTAINER_INVALID");
        reference = { ...reference, container: { id, imageId: image.id, imageRef, sourceRevision: image.sourceRevision, user: inspected.user, network: inspected.network, readonly: inspected.readonly, startedAt, closedAt: timestamp(now), exitCode: finished.exitCode }, source, script };
      } catch (error) { referenceFailure = error; }
      finally {
        if (id) {
          let cleanupFailure;
          try { await host(docker, [...dockerPrefix, "stop", "--time", "10", id], { timeoutMs: 20000 }); }
          catch (error) { cleanupFailure = error; }
          try {
            const response = text((await host(docker, [...dockerPrefix, "rm", "--force", "--volumes", id], { timeoutMs: 20000 })).stdout).trim();
            if (response !== id) fail("MANUAL_EXPECTED_SCHEMA_CONTAINER_CLEANUP_FAILED");
            removed = true;
          } catch (error) { cleanupFailure ??= error; }
          if (cleanupFailure) referenceFailure = Object.assign(new Error("MANUAL_EXPECTED_SCHEMA_CONTAINER_CLEANUP_FAILED", { cause: referenceFailure ?? cleanupFailure }), { code: "MANUAL_EXPECTED_SCHEMA_CONTAINER_CLEANUP_FAILED", containerId: id });
        }
      }
      if (referenceFailure) throw referenceFailure;
      if (!removed) fail("MANUAL_EXPECTED_SCHEMA_CONTAINER_CLEANUP_FAILED");
      references.push(reference);
    }
  } catch (error) { failure = error; }
  finally { await fs.rm(dockerConfig, { recursive: true, force: true }); }
  if (failure) throw failure;
  const [a, b] = references;
  const stable = (r) => ({ migrations: r.migrations, migrationHead: r.migrationHead, schemaOwner: r.databaseIdentity.schemaOwner, ownerInventory: r.databaseIdentity.ownerInventory, extensions: r.databaseIdentity.extensions, tools: r.tools });
  if (a.referenceId === b.referenceId || a.container.id === b.container.id || a.databaseIdentity.systemIdentifier === b.databaseIdentity.systemIdentifier ||
      !a.source.equals(b.source) || !a.script.equals(b.script) || canonicalJson(stable(a)) !== canonicalJson(stable(b))) fail("MANUAL_EXPECTED_SCHEMA_REPRODUCTION_FAILED");
  const finalSubjects = await recheck();
  if (canonicalJson(finalSubjects.digests) !== canonicalJson(subjects.digests)) fail("MANUAL_EXPECTED_SCHEMA_SOURCE_INVALID");
  const recordedAt = timestamp(now), buildProofDigest = sha256Canonical(proof), scriptRef = { digest: sha256Bytes(a.script), bytes: a.script.length };
  const producerRecord = { schemaVersion: "manual-expected-schema-producer.v1", recordedAt, promotionEligible: false, buildIdentity, buildProofDigest,
    proofRawDigest: sha256Bytes(proofRaw), materialRawDigest: sha256Bytes(materialRaw), ...subjects.digests,
    sourceSchemaPath: SCHEMA, configPath: CONFIG, baseImages: [NODE_BASE, PG_BASE], runnerImage: imageRef, script: scriptRef,
    references: references.map((reference) => Object.fromEntries(Object.entries(reference).filter(([key]) => !["sourceSchemaBase64", "scriptBase64", "source", "script"].includes(key)))) };
  const schemaExpectation = { schemaVersion: "manual-runner-evidence.v1", recordedAt, promotionEligible: false, kind: "schema-expectation", buildProofDigest,
    sourceSchemaDigest: subjects.digests.sourceSchemaDigest, prismaVersion: a.tools.prismaVersion, script: scriptRef, sourceSchemaPath: SCHEMA };
  validateContract("manual-runner-evidence.v1", schemaExpectation);
  return { sourceSchemaBytes: Buffer.from(a.source), scriptBytes: Buffer.from(a.script), producerRecordBytes: encode(producerRecord), schemaExpectationBytes: encode(schemaExpectation) };
}

// Only this fixed inner procedure is executable. Host orchestration is an
// internal protected-job function; this mode supplies no publication authority.
if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    if (process.argv.length !== 3 || process.argv[2] !== "--reference") fail("MANUAL_EXPECTED_SCHEMA_REFERENCE_INPUT_INVALID");
    const chunks = []; let size = 0;
    for await (const chunk of process.stdin) { size += chunk.length; if (size > LIMIT) fail("MANUAL_EXPECTED_SCHEMA_RAW_INVALID"); chunks.push(chunk); }
    const record = await runReferenceExpectedSchema(json(Buffer.concat(chunks)));
    process.stdout.write(encode(record));
  } catch (error) { process.stderr.write(`${error.code ?? "MANUAL_EXPECTED_SCHEMA_REFERENCE_FAILED"}\n`); process.exitCode = 1; }
}
