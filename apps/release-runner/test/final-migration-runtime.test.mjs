import assert from "node:assert/strict";
import path from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";
import { sha256Bytes } from "@subscription-saas/release-foundation";
import { finalMigrationInputFixture } from "./fixtures/final-migration-input.mjs";

const repoRoot = path.resolve(fileURLToPath(new URL("../../../", import.meta.url)));

test("final migration runtime rejects a credential before connecting and closes a failed session", async () => {
  const { openFinalMigrationRuntime } = await import("../src/final-migration-runtime.mjs");
  const { input } = await finalMigrationInputFixture();
  const credential = {
    username: input.database.migrationRole,
    password: "synthetic-private-migration-password",
    capabilityProfile: "migrate"
  };
  input.database.migrationCredentialFingerprint = sha256Bytes(Buffer.from(credential.password));
  let connected = 0,
    closed = 0;
  const controller = new AbortController();
  const options = {
    input,
    credential,
    repoRoot,
    signal: controller.signal,
    connectDatabase: async () => {
      connected++;
      return {
        $queryRawUnsafe: async () => {
          throw new Error("synthetic query failure");
        },
        $transaction: async () => assert.fail("must not acquire migration lock"),
        close: async () => {
          closed++;
        }
      };
    }
  };
  await assert.rejects(
    () =>
      openFinalMigrationRuntime({
        ...options,
        credential: { ...credential, password: "wrong-password-value" }
      }),
    { code: "R3_FINAL_MIGRATION_CREDENTIAL_INVALID" }
  );
  assert.equal(connected, 0);
  const runtime = await openFinalMigrationRuntime(options);
  await assert.rejects(
    () => runtime.plan(),
    (error) => {
      assert.equal(error.code, "R3_FINAL_MIGRATION_FAILED");
      assert.deepEqual(error.processOriginals, []);
      return true;
    }
  );
  assert.equal(connected, 1);
  assert.equal(closed, 1);
  await runtime.close();
  assert.equal(closed, 1);
  assert.equal(JSON.stringify(runtime).includes(credential.password), false);
  const premature = await openFinalMigrationRuntime(options);
  await assert.rejects(
    () => premature.prepare({ predecessorDigest: input.expectedSchemaDigest }),
    (error) => error.cause?.code === "R3_FINAL_MIGRATION_SEQUENCE_INVALID"
  );
  assert.equal(closed, 2);
});
