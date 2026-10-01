// Fixed final-image entrypoint. The H1 holder owns launch authentication,
// physical target checks, lifecycle authority and custody of the result.
import { readFile, writeFile } from "node:fs/promises";

import {
  sha256Bytes,
  sha256Canonical,
  validateContract
} from "@subscription-saas/release-foundation";
import { runR3FinalRunnerChannel } from "../../../scripts/release/r3-final-runtime-channel.mjs";
import { validateFinalDatabaseTestAssignments } from "./database-test-envelope.mjs";
import { executePreparedFinalManifest } from "./final-database-manifest.mjs";
import { createPostgresConnector } from "./postgres-connector.mjs";

const CODE = "R3_FINAL_RUNTIME_INPUT_INVALID";
const MANIFEST_REFERENCE = "launch-file:///run/launch/database-test-manifest.json";
const FILES = Object.freeze({
  manifest: "/app/release/contracts/database-test-manifest.v1.json",
  discovery: "/app/release/contracts/database-test-discovery.v1.json",
  targetPolicies: "/app/release/contracts/database-target-policies.v1.json",
  hostedPolicy: "/app/release/contracts/manual-stage1-r3-target-policy.v1.json"
});
const need = (condition) => {
  if (!condition) throw Object.assign(new Error(CODE), { code: CODE });
};
const exact = (value, keys) =>
  value &&
  typeof value === "object" &&
  !Array.isArray(value) &&
  Object.keys(value).sort().join(",") === [...keys].sort().join(",");

async function fixedJson(readFixed, filename) {
  const bytes = await readFixed(filename);
  need(Buffer.isBuffer(bytes) && bytes.length > 0 && bytes.length <= 1024 * 1024);
  return JSON.parse(bytes.toString("utf8"));
}

function credentialNames(envelope, credentials, runtimePreparations) {
  const databases = Object.values(envelope.suiteAssignments)
    .filter((assignment) => assignment.kind === "suite")
    .flatMap((assignment) => Object.values(assignment.databases));
  const names = databases.map(({ databaseName }) => databaseName);
  need(
    new Set(names).size === names.length &&
      exact(credentials, names) &&
      exact(runtimePreparations, names)
  );
  for (const database of databases) {
    const credential = credentials[database.databaseName];
    const prepared = runtimePreparations[database.databaseName];
    need(
      exact(credential, ["username", "password", "capabilityProfile"]) &&
        credential.username === database.runtimeRole &&
        credential.capabilityProfile === "runtime-test" &&
        typeof credential.password === "string" &&
        credential.password.length >= 16 &&
        sha256Bytes(Buffer.from(credential.password, "utf8")) ===
          database.runtimeCredentialFingerprint &&
        database.runtimeCredentialFingerprint !== database.migrationCredentialFingerprint &&
        exact(prepared, ["migrationEvidenceDigest", "schemaFixture"]) &&
        prepared.migrationEvidenceDigest === database.migrationEvidenceDigest
    );
  }
  return names.sort();
}

async function fixedManifestInput(input, { readFixed, writeFixed }) {
  need(exact(input, ["envelope", "credentials", "runtimePreparations", "lifecycleContext"]));
  const held = structuredClone(input);
  const { envelope, credentials } = held;
  need(envelope?.databaseTestManifestReference === MANIFEST_REFERENCE);
  const [manifest, discovery, targetPolicies, hostedPolicy] = await Promise.all([
    fixedJson(readFixed, FILES.manifest),
    fixedJson(readFixed, FILES.discovery),
    fixedJson(readFixed, FILES.targetPolicies),
    fixedJson(readFixed, FILES.hostedPolicy)
  ]);
  validateContract("database-target-policies.v1", targetPolicies);
  validateContract("manual-stage1-r3-target-policy.v1", hostedPolicy);
  const policy = targetPolicies.policies.find(
    ({ policyId }) => policyId === "s1-release-compose-ephemeral"
  );
  need(
    policy &&
      hostedPolicy.databaseTargetPolicyId === policy.policyId &&
      hostedPolicy.profileDigest === envelope.profileDigest &&
      policy.requiredImageDigest === envelope.postgres?.imageDigest &&
      envelope.postgres.hostname === "postgres" &&
      envelope.postgres.port === 5432 &&
      envelope.postgres.tlsMode === "require"
  );
  const discoveryDigest = sha256Canonical(discovery);
  validateFinalDatabaseTestAssignments({ envelope, manifest, discoveryDigest });
  const names = credentialNames(envelope, credentials, held.runtimePreparations);
  // START contains the only credential source. No repository or ambient secret
  // is read; these exact create-only paths are mounted tmpfs in the owned image.
  await writeFixed(
    "/run/launch/database-test-manifest.json",
    Buffer.from(`${JSON.stringify(manifest)}\n`),
    { flag: "wx", mode: 0o600 }
  );
  for (const name of names) {
    const credential = credentials[name];
    const secret = Buffer.from(
      `${JSON.stringify({
        username: credential.username,
        password: credential.password,
        host: "postgres",
        port: 5432,
        database: name,
        tlsMode: "require"
      })}\n`
    );
    try {
      await writeFixed(`/run/secrets/${name}-runtime-test.json`, secret, {
        flag: "wx",
        mode: 0o600
      });
    } finally {
      secret.fill(0);
    }
  }
  return {
    envelope,
    manifest,
    discoveryDigest,
    credentials,
    runtimePreparations: held.runtimePreparations
  };
}

// The CLI calls this with no arguments. Injection is internal to the small
// fixed-file unit test and never appears in the image's argv or environment.
export async function runFinalRuntimeEntrypoint({
  incoming = process.stdin,
  outgoing = process.stdout,
  signal = new AbortController().signal,
  readFixed = readFile,
  writeFixed = writeFile,
  runChannel = runR3FinalRunnerChannel,
  executeManifest = executePreparedFinalManifest,
  connectDatabase = createPostgresConnector()
} = {}) {
  await runChannel({
    incoming,
    outgoing,
    signal,
    executeManifest: async (input, { executeLifecycle, signal: channelSignal }) => {
      const prepared = await fixedManifestInput(input, { readFixed, writeFixed });
      return executeManifest({
        ...prepared,
        connectDatabase,
        executeLifecycle,
        signal: channelSignal,
        repoRoot: "/app"
      });
    }
  });
  // The channel already emitted its finite result. The CLI must add no output.
}
