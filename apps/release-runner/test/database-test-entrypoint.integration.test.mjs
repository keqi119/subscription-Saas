import assert from "node:assert/strict";
import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";

import { sha256Bytes, sha256Canonical } from "@subscription-saas/release-foundation";

import {
  executeDatabaseTestEnvelope,
  executeFinalDatabaseManifest
} from "../src/database-test-entrypoint.mjs";

const digest = (character) => `sha256:${character.repeat(64)}`;
const repoRoot = path.resolve(import.meta.dirname, "../../..");
const fromRepo = (...segments) => path.resolve(repoRoot, ...segments);

test("executes only the integrity-bound manifest with the runtime-test identity", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "runner-database-test-"));
  const roots = {
    launch: path.join(root, "launch"),
    secrets: path.join(root, "secrets"),
    evidence: path.join(root, "evidence")
  };
  await Promise.all(Object.values(roots).map((directory) => mkdir(directory, { recursive: true })));
  const [manifest, buildProof] = await Promise.all([
    readFile(fromRepo("release/contracts/database-test-manifest.v1.json"), "utf8").then(JSON.parse),
    readFile(fromRepo("scripts/release/fixtures/build-proof.valid.json"), "utf8").then(JSON.parse)
  ]);
  await writeFile(path.join(roots.launch, "database-test-manifest.json"), JSON.stringify(manifest));
  const runtimeRole = `s1r_${"a".repeat(24)}`;
  const runtimePassword = "not-exposed-runtime-password";
  const envelope = {
    schemaVersion: "database-test-launch-envelope.v1",
    executionMode: "database-test",
    chain: "fresh",
    buildProof,
    buildProofDigest: sha256Canonical(buildProof),
    actualRunnerDigest: buildProof.identity.images.runner.imageDigest,
    databaseTestManifestReference: "launch-file:///run/launch/database-test-manifest.json",
    databaseTestManifestDigest: sha256Canonical(manifest),
    databaseTestDiscoveryDigest: digest("1"),
    capabilitySecretReference: "secret-file:///run/secrets/database-credential",
    target: {
      hostname: "postgres",
      databaseName: `s1ci_${"b".repeat(24)}`,
      tlsMode: "require",
      runtimeRole,
      runtimeCredentialFingerprint: sha256Bytes(Buffer.from(runtimePassword)),
      migrationCredentialFingerprint: digest("9")
    },
    databaseOid: "42",
    databaseIdentityFingerprint: digest("2"),
    operationId: "11111111-1111-4111-8111-111111111111",
    runId: "22222222-2222-4222-8222-222222222222",
    attemptId: "33333333-3333-4333-8333-333333333333",
    journalReference: "evidence-file:///evidence/database-tests.ndjson",
    custodyPolicyReference: "launch-file:///run/launch/custody-policy.json",
    custodyPolicyDigest: digest("3")
  };
  let execution;

  try {
    const result = await executeDatabaseTestEnvelope({
      envelope,
      roots,
      readCredential: async () => ({
        username: runtimeRole,
        password: runtimePassword,
        capabilityProfile: "runtime-test"
      }),
      executeManifest: async (input) => {
        execution = input;
        return {
          reportDigest: digest("4"),
          counts: {
            collected: 10,
            selected: 10,
            executed: 10,
            passed: 10,
            failed: 0,
            skipped: 0,
            todo: 0,
            filtered: 0,
            cancelled: 0
          }
        };
      }
    });
    assert.deepEqual(execution.manifest, manifest);
    assert.equal(execution.credential.username, runtimeRole);
    assert.equal(result.terminalStatus, "PASSED");

    await assert.rejects(
      () =>
        executeDatabaseTestEnvelope({
          envelope,
          roots,
          readCredential: async () => ({
            username: runtimeRole,
            password: runtimePassword,
            capabilityProfile: "migrate"
          }),
          executeManifest: async () => assert.fail("executor must not run")
        }),
      { code: "DATABASE_TEST_CAPABILITY_MISMATCH" }
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("rejects incomplete database test counts", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "runner-database-counts-"));
  const roots = { launch: root, secrets: root, evidence: root };
  const [manifest, buildProof] = await Promise.all([
    readFile(fromRepo("release/contracts/database-test-manifest.v1.json"), "utf8").then(JSON.parse),
    readFile(fromRepo("scripts/release/fixtures/build-proof.valid.json"), "utf8").then(JSON.parse)
  ]);
  await writeFile(path.join(root, "manifest.json"), JSON.stringify(manifest));
  const runtimeRole = `s1r_${"a".repeat(24)}`;
  const runtimePassword = "not-exposed-runtime-password";
  const envelope = {
    schemaVersion: "database-test-launch-envelope.v1",
    executionMode: "database-test",
    chain: "fresh",
    buildProof,
    buildProofDigest: sha256Canonical(buildProof),
    actualRunnerDigest: buildProof.identity.images.runner.imageDigest,
    databaseTestManifestReference: "launch-file:///run/launch/manifest.json",
    databaseTestManifestDigest: sha256Canonical(manifest),
    databaseTestDiscoveryDigest: digest("1"),
    capabilitySecretReference: "secret-file:///run/secrets/credential.json",
    target: {
      hostname: "postgres",
      databaseName: `s1ci_${"b".repeat(24)}`,
      tlsMode: "require",
      runtimeRole,
      runtimeCredentialFingerprint: sha256Bytes(Buffer.from(runtimePassword)),
      migrationCredentialFingerprint: digest("9")
    },
    databaseOid: "42",
    databaseIdentityFingerprint: digest("2"),
    operationId: "11111111-1111-4111-8111-111111111111",
    runId: "22222222-2222-4222-8222-222222222222",
    attemptId: "33333333-3333-4333-8333-333333333333",
    journalReference: "evidence-file:///evidence/database-tests.ndjson",
    custodyPolicyReference: "launch-file:///run/launch/custody-policy.json",
    custodyPolicyDigest: digest("3")
  };
  try {
    await assert.rejects(
      () =>
        executeDatabaseTestEnvelope({
          envelope,
          roots,
          readCredential: async () => ({
            username: runtimeRole,
            password: runtimePassword,
            capabilityProfile: "runtime-test"
          }),
          executeManifest: async () => ({
            counts: {
              collected: 10,
              selected: 9,
              executed: 9,
              passed: 9,
              failed: 0,
              skipped: 1,
              todo: 0,
              filtered: 0,
              cancelled: 0
            }
          })
        }),
      { code: "DATABASE_TEST_COUNT_INCOMPLETE" }
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("production database-test mode executes the fixed manifest on attested runtime identities", async () => {
  const [manifest, buildProof] = await Promise.all([
    readFile(fromRepo("release/contracts/database-test-manifest.v1.json"), "utf8").then(JSON.parse),
    readFile(fromRepo("scripts/release/fixtures/build-proof.valid.json"), "utf8").then(JSON.parse)
  ]);
  const runtimePassword = "target-runtime-password-123";
  const sourcePassword = "source-runtime-password-456";
  const targetIdentity = {
    databaseName: `s1ci_${"b".repeat(24)}`,
    databaseOid: "42",
    runtimeRole: `s1r_${"a".repeat(24)}`,
    tls: true
  };
  const sourceIdentity = {
    databaseName: `s1ci_${"c".repeat(24)}`,
    databaseOid: "43",
    runtimeRole: `s1r_${"d".repeat(24)}`,
    tls: true
  };
  const identityDigest = (identity) =>
    sha256Canonical({
      databaseName: identity.databaseName,
      databaseOid: identity.databaseOid,
      role: identity.runtimeRole,
      tls: true
    });
  const target = {
    hostname: "postgres",
    databaseName: targetIdentity.databaseName,
    tlsMode: "require",
    runtimeRole: targetIdentity.runtimeRole,
    runtimeCredentialFingerprint: sha256Bytes(Buffer.from(runtimePassword)),
    migrationCredentialFingerprint: digest("8")
  };
  const sourceTarget = {
    hostname: "postgres",
    databaseName: sourceIdentity.databaseName,
    tlsMode: "require",
    runtimeRole: sourceIdentity.runtimeRole,
    runtimeCredentialFingerprint: sha256Bytes(Buffer.from(sourcePassword)),
    migrationCredentialFingerprint: digest("7"),
    databaseOid: sourceIdentity.databaseOid,
    databaseIdentityFingerprint: identityDigest(sourceIdentity)
  };
  const envelope = {
    chain: "fresh",
    buildProof,
    databaseTestDiscoveryDigest: digest("1"),
    databaseTestManifestDigest: sha256Canonical(manifest),
    actualRunnerDigest: buildProof.identity.images.runner.imageDigest,
    target,
    databaseOid: targetIdentity.databaseOid,
    databaseIdentityFingerprint: identityDigest(targetIdentity),
    sourceTarget,
    operationId: "11111111-1111-4111-8111-111111111111",
    runId: "22222222-2222-4222-8222-222222222222"
  };
  const statements = [];
  const connectDatabase = async ({ target: requested }) => ({
    async $queryRawUnsafe() {
      const expected =
        requested.databaseName === target.databaseName ? targetIdentity : sourceIdentity;
      return [
        {
          databaseName: expected.databaseName,
          databaseOid: expected.databaseOid,
          role: expected.runtimeRole,
          superuser: false,
          createdb: false,
          createrole: false,
          bypassrls: false,
          canCreateSchema: false,
          schemaOwner: false,
          objectOwner: false,
          tls: true
        }
      ];
    },
    async $executeRawUnsafe(sql) {
      statements.push(sql);
      return 1;
    },
    async close() {}
  });
  const executions = [];
  const report = await executeFinalDatabaseManifest({
    envelope,
    manifest,
    credential: {
      capabilityProfile: "runtime-test",
      username: target.runtimeRole,
      password: runtimePassword
    },
    sourceCredential: {
      capabilityProfile: "runtime-test",
      username: sourceTarget.runtimeRole,
      password: sourcePassword
    },
    connectDatabase,
    repoRoot,
    executeProcess: async (executable, arguments_) => {
      executions.push({ executable, arguments_ });
      return executable === "node" && arguments_[0]?.includes("vitest")
        ? {
            exitCode: 0,
            signal: null,
            stderr: "",
            stdout: `${JSON.stringify({
              numTotalTests: 1,
              numPassedTests: 1,
              numFailedTests: 0,
              numPendingTests: 0,
              numTodoTests: 0,
              testResults: []
            })}\n`
          }
        : {
            exitCode: 0,
            signal: null,
            stderr: "",
            stdout: "# tests 1\n# pass 1\n# fail 0\n# cancelled 0\n# skipped 0\n# todo 0\n"
          };
    }
  });
  assert.equal(report.terminalStatus, "PASSED");
  assert.equal(report.counts.collected, manifest.suites.length);
  assert.equal(executions.length, manifest.suites.length);
  assert.ok(statements.length > 0, "runtime seed fixtures must execute");
  assert.equal(
    executions.every(({ executable }) => executable === "node"),
    true,
    "the closed mode resolves only fixed Node entrypoints"
  );
});
