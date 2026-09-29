import assert from "node:assert/strict";
import test from "node:test";
import { finalDatabaseEnvelopeFixture } from "./fixtures/final-database-envelope.mjs";

const mismatch = { code: "DATABASE_TEST_TARGET_ASSIGNMENT_MISMATCH" };
const validator = async () =>
  (await import("../src/database-test-envelope.mjs").catch(() => ({})))
    .validateFinalDatabaseTestAssignments;

test("final envelope rejects malformed UUID identities in the shared schema validator", async () => {
  const { validateDatabaseTestEnvelopeVersion } = await import("../src/database-test-envelope.mjs");
  const { envelope } = await finalDatabaseEnvelopeFixture();
  for (const field of ["sessionId", "operationId", "runId", "attemptId"])
    assert.throws(
      () => validateDatabaseTestEnvelopeVersion({ ...envelope, [field]: "invalid-uuid" }),
      { code: "CONTRACT_SCHEMA_INVALID" }
    );
});

test("final envelope binds every required suite to independent planned targets", async () => {
  const validate = await validator();
  assert.equal(typeof validate, "function");
  for (const chain of ["fresh", "snapshot"]) {
    const { envelope, manifest } = await finalDatabaseEnvelopeFixture(chain);
    const result = validate({
      envelope,
      manifest,
      discoveryDigest: envelope.databaseTestDiscoveryDigest
    });
    assert.deepEqual(
      result.selections.map(({ suiteId }) => suiteId),
      manifest.suites.map(({ suiteId }) => suiteId)
    );
    assert.ok(Object.isFrozen(result) && Object.isFrozen(result.selections));
    const lifecycle = result.selections.find(
      ({ r3ExecutionMode }) => r3ExecutionMode === "lifecycle-owned"
    );
    assert.equal(lifecycle.databaseAssignment.reservations.length, 2);
    const applicationName = result.plan.targets.at(-1).databaseName;
    assert.ok(
      result.selections.every(({ assignment }) => assignment.databaseName !== applicationName)
    );
    const first = result.selections.find(({ r3ExecutionMode }) => r3ExecutionMode === "suite");
    const retained = first.databaseAssignment.databases.target.databaseOid;
    envelope.suiteAssignments[first.suiteId].databases.target.databaseOid = "999999";
    assert.equal(first.databaseAssignment.databases.target.databaseOid, retained);
  }
});

test("final envelope rejects missing suites, target aliases, wrong markers and reused credentials", async () => {
  const validate = await validator();
  assert.equal(typeof validate, "function");
  const fixture = await finalDatabaseEnvelopeFixture("snapshot");
  const ordinary = Object.keys(fixture.envelope.suiteAssignments).filter(
    (key) => fixture.envelope.suiteAssignments[key].kind === "suite"
  );
  const lifecycle = Object.keys(fixture.envelope.suiteAssignments).find(
    (key) => fixture.envelope.suiteAssignments[key].kind === "lifecycle-owned"
  );
  const changes = [
    (e) => delete e.suiteAssignments[ordinary[0]],
    (e) => (e.suiteAssignments.extra = structuredClone(e.suiteAssignments[ordinary[0]])),
    (e) =>
      (e.suiteAssignments[ordinary[1]].databases.target = structuredClone(
        e.suiteAssignments[ordinary[0]].databases.target
      )),
    (e) => (e.suiteAssignments[ordinary[0]].databases.target.marker = "wrong-marker"),
    (e) =>
      (e.suiteAssignments[ordinary[1]].databases.target.databaseOid =
        e.suiteAssignments[ordinary[0]].databases.target.databaseOid),
    (e) => {
      const target = e.suiteAssignments[ordinary[0]].databases.target;
      target.migrationCredentialFingerprint = target.runtimeCredentialFingerprint;
    },
    (e) =>
      (e.suiteAssignments[ordinary[1]].databases.target.runtimeCredentialFingerprint =
        e.suiteAssignments[ordinary[0]].databases.target.runtimeCredentialFingerprint),
    (e) => (e.suiteAssignments[lifecycle].reservations[1].shard = 0),
    (e) => delete e.suiteAssignments[lifecycle].reservations[0].roles.restore,
    (e) => (e.databaseTargetPlanDigest = `sha256:${"f".repeat(64)}`),
    (e) => (e.sourceSha = "f".repeat(40))
  ];
  for (const change of changes) {
    const envelope = structuredClone(fixture.envelope);
    change(envelope);
    assert.throws(
      () =>
        validate({
          envelope,
          manifest: fixture.manifest,
          discoveryDigest: fixture.envelope.databaseTestDiscoveryDigest
        }),
      mismatch
    );
  }
});
