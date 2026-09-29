import assert from "node:assert/strict";
import test from "node:test";

import { sha256Canonical } from "../../../packages/release-foundation/src/digest.mjs";
import { validateFinalMigrationInput } from "../src/final-migration-input.mjs";
import { finalMigrationInputFixture } from "./fixtures/final-migration-input.mjs";

const code = "FINAL_MIGRATION_INPUT_INVALID";

test("binds an ordinary final target and a physical lifecycle target", async () => {
  for (const options of [{}, { lifecycleShard: 1, chain: "snapshot" }]) {
    const fixture = await finalMigrationInputFixture(options);
    const result = validateFinalMigrationInput(fixture);
    assert.equal(result.input.database.databaseName, fixture.input.database.databaseName);
    assert.equal(result.target.databaseName, fixture.input.database.databaseName);
    assert.deepEqual(result.allowedExtensions, ["btree_gist", "pgcrypto", "plpgsql"]);
    assert.ok(Object.isFrozen(result) && Object.isFrozen(result.input.database));
    assert.equal(result.assignment.kind, fixture.input.assignment.kind);
  }
});

test("rejects mismatched build, plan, role, marker, lock, policy, and extra wire fields", async () => {
  const fixture = await finalMigrationInputFixture();
  const altered = (change) => {
    const copy = structuredClone(fixture);
    change(copy);
    assert.throws(() => validateFinalMigrationInput(copy), { code });
  };
  altered(({ input }) => {
    input.sourceSha = "0".repeat(40);
  });
  altered(({ input }) => {
    input.runnerContainerId = input.migrationContainerId;
  });
  altered(({ input }) => {
    input.migrationContainerId = input.postgres.containerId;
  });
  altered(({ input }) => {
    input.databaseTargetPlanDigest = `sha256:${"0".repeat(64)}`;
  });
  altered(({ input }) => {
    input.database.migrationRole = `s1m_${"0".repeat(24)}`;
  });
  altered(({ input }) => {
    input.database.runtimeCredentialFingerprint = input.database.migrationCredentialFingerprint;
  });
  altered(({ input }) => {
    input.database.marker = "{}";
  });
  altered(({ input }) => {
    input.database.targetLockDigest = `sha256:${"0".repeat(64)}`;
  });
  altered(({ input }) => {
    input.database.databaseIdentityFingerprint = `sha256:${"0".repeat(64)}`;
  });
  altered(({ input }) => {
    input.database.password = "secret";
  });
  altered(({ input }) => {
    input.assignment.name = "source";
  });
  altered(({ globalObjectPolicy }) => {
    globalObjectPolicy.allowedExtensions = ["pgcrypto"];
  });
  altered(({ input }) => {
    input.migrationCatalogDigest = `sha256:${"0".repeat(64)}`;
  });
  altered(({ migrationCatalog }) => {
    migrationCatalog.entries[0].sha256 = `sha256:${"0".repeat(64)}`;
  });
});

test("binds all parent facts while excluding per-database migration fields", async () => {
  const fixture = await finalMigrationInputFixture();
  const initial = validateFinalMigrationInput(fixture);
  const changed = structuredClone(fixture);
  changed.input.matchingSourceResultDigest = `sha256:${"7".repeat(64)}`;
  assert.notEqual(
    validateFinalMigrationInput(changed).parentBindingDigest,
    initial.parentBindingDigest
  );
  const other = structuredClone(fixture);
  other.input.expectedSchemaDigest = `sha256:${"8".repeat(64)}`;
  assert.equal(validateFinalMigrationInput(other).parentBindingDigest, initial.parentBindingDigest);
  assert.equal(
    initial.parentBindingDigest,
    sha256Canonical(
      Object.fromEntries(
        Object.entries(fixture.input).filter(
          ([key]) =>
            ![
              "schemaVersion",
              "assignment",
              "database",
              "migrationContainerId",
              "expectedSchemaDigest",
              "migrationCatalogDigest"
            ].includes(key)
        )
      )
    )
  );
});
