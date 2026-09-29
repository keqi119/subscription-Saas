// Internal fixed-image runtime. This owns only its database connection and child
// processes. H1 still owns container launch/authentication, result custody and
// independent deletion readback; the general Runner entrypoint is not widened.
import { readFile } from "node:fs/promises";
import path from "node:path";
import postgres from "postgres";
import { computeMigrationCatalog, sha256Canonical } from "@subscription-saas/release-foundation";
import { createPostgresConnector } from "./postgres-connector.mjs";
import { createDatabaseRuntimeAdapter } from "./database-runtime-adapter.mjs";
import { validateFinalMigrationInput } from "./final-migration-input.mjs";
import { createFinalMigrationProcessRunner } from "./final-migration-process.mjs";
import {
  createFinalMigrationSession,
  validateFinalMigrationCredential
} from "./final-migration-session.mjs";
import { runnerError } from "./error-codes.mjs";

const connect = createPostgresConnector({
  createClient: (options) =>
    postgres({ ...options, connection: { statement_timeout: 60000, lock_timeout: 30000 } })
});

export async function openFinalMigrationRuntime({
  input,
  credential,
  signal,
  repoRoot = "/app",
  connectDatabase = connect
}) {
  if (!signal || signal.aborted || typeof signal.addEventListener !== "function")
    throw runnerError("R3_FINAL_MIGRATION_ABORTED");
  // Hold copies before the first asynchronous read. The caller's objects cannot
  // replace a credential or target while the fixed image inputs are loading.
  input = structuredClone(input);
  credential = structuredClone(credential);
  const read = async (name) =>
    JSON.parse(await readFile(path.join(repoRoot, "release/contracts", name), "utf8"));
  const [manifest, discovery, globalObjectPolicy, migrationCatalog] = await Promise.all([
    read("database-test-manifest.v1.json"),
    read("database-test-discovery.v1.json"),
    read("migration-global-object-policy.v1.json"),
    computeMigrationCatalog(repoRoot)
  ]);
  const held = validateFinalMigrationInput({
    input,
    manifest,
    migrationCatalog,
    globalObjectPolicy
  });
  if (input.databaseTestDiscoveryDigest !== sha256Canonical(discovery))
    throw runnerError("FINAL_MIGRATION_INPUT_INVALID");
  validateFinalMigrationCredential(held.input, credential);
  if (signal.aborted) throw runnerError("R3_FINAL_MIGRATION_ABORTED");
  const processOriginals = [];
  const controller = new AbortController();
  const runProcess = createFinalMigrationProcessRunner({
    repoRoot,
    signal: controller.signal,
    originals: processOriginals
  });
  const database = await connectDatabase({ credential, target: held.target });
  let closing,
    closed = false;
  const close = () => {
    if (!closing) {
      closed = true;
      signal.removeEventListener("abort", onAbort);
      controller.abort();
      closing = Promise.allSettled([
        Promise.resolve().then(() => database.close()),
        runProcess.drain()
      ]).then((results) => {
        const failed = results.find(({ status }) => status === "rejected");
        if (failed) throw failed.reason;
      });
    }
    return closing;
  };
  const onAbort = () => {
    close().catch(() => {});
  };
  signal.addEventListener("abort", onAbort, { once: true });
  try {
    if (signal.aborted) throw runnerError("R3_FINAL_MIGRATION_ABORTED");
    const adapter = createDatabaseRuntimeAdapter({
      database,
      credential,
      target: held.target,
      repoRoot,
      runProcess,
      // Ambient PG variables, NODE_OPTIONS and host credentials cannot flow to
      // the migration subprocess. DATABASE_URL is set by the fixed adapter.
      environment: {
        PATH: "/pnpm:/usr/local/bin:/usr/lib/postgresql/17/bin:/usr/bin:/bin",
        HOME: "/tmp",
        NODE_ENV: "production"
      }
    });
    const session = createFinalMigrationSession({
      input: held.input,
      manifest,
      migrationCatalog,
      globalObjectPolicy,
      database: adapter,
      credential
    });
    const invoke = async (stage, args) => {
      try {
        if (closed || signal.aborted) throw runnerError("R3_FINAL_MIGRATION_ABORTED");
        const result = await session[stage](...args);
        if (closed || signal.aborted) throw runnerError("R3_FINAL_MIGRATION_ABORTED");
        if (stage !== "verify") return result;
        await close();
        return Object.freeze({
          ...result,
          processOriginals: Object.freeze(processOriginals.slice())
        });
      } catch (cause) {
        let closeError;
        try {
          await close();
        } catch (error) {
          closeError = error;
        }
        const error = runnerError("R3_FINAL_MIGRATION_FAILED");
        Object.defineProperties(error, {
          cause: { value: cause },
          originals: { value: cause.originals },
          processOriginals: { value: Object.freeze(processOriginals.slice()) },
          closeError: { value: closeError }
        });
        throw error;
      }
    };
    return Object.freeze({
      plan: (...args) => invoke("plan", args),
      apply: (...args) => invoke("apply", args),
      verify: (...args) => invoke("verify", args),
      close
    });
  } catch (cause) {
    try {
      await close();
    } catch (closeError) {
      Object.defineProperty(cause, "closeError", { value: closeError });
    }
    throw cause;
  }
}
