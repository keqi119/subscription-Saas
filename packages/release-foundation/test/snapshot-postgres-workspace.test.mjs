import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import { sha256Bytes, sha256Canonical } from "../src/digest.mjs";
import { createPostgresSanitizationWorkspace } from "../src/snapshot/postgres-workspace.mjs";

const contract = JSON.parse(
  readFileSync(new URL("../../../release/contracts/sanitization-contract.v1.json", import.meta.url))
);
const identity = { databaseName: "isolated", databaseOid: "2", systemIdentifier: "123" };

function fixture({ sourceIsTarget = false, failUpdate = false } = {}) {
  const calls = [];
  const tokenizationKey = Buffer.alloc(32, 7);
  let ended = 0,
    destroyed = 0,
    restored = 0;
  const client = {
    processID: 123,
    async query(sql, values) {
      calls.push({ sql, values });
      if (sql.includes("system_identifier"))
        return {
          rows: [
            {
              database_name: "isolated",
              database_oid: "2",
              system_identifier: "123",
              backend_pid: 123,
              role_name: "migrate",
              role_oid: "33"
            }
          ]
        };
      if (sql.includes("AS relation_count")) return { rows: [{ relation_count: 0 }] };
      if (sql.startsWith("SELECT id::text")) {
        if (values[0] !== null) return { rows: [] };
        const table = sql.includes('"customer"') ? "public.customer" : null;
        return { rows: table ? [{ id: "id-1", mobile: "13800138000" }] : [] };
      }
      if (sql.startsWith("UPDATE")) {
        if (failUpdate) throw new Error("do not expose row values");
        return { rowCount: 1, rows: [] };
      }
      return { rows: [] };
    },
    async end() {
      ended++;
    }
  };
  const dump = Buffer.from("PGDMP\0synthetic");
  const workspace = createPostgresSanitizationWorkspace({
    client,
    sourceDatabaseIdentityFingerprint: sourceIsTarget
      ? sha256Canonical(identity)
      : sha256Canonical("source"),
    workspaceDatabaseIdentityFingerprint: sha256Canonical(identity),
    tokenizationKey,
    restoreDump: async () => {
      restored++;
    },
    exportDump: async () => dump,
    expandArchive: async ({ expectedArchiveDigest }) => ({ archiveDigest: expectedArchiveDigest }),
    destroyResource: async () => {
      destroyed++;
      return { removed: true };
    }
  });
  return {
    workspace,
    calls,
    tokenizationKey,
    dump,
    counts: () => ({ ended, destroyed, restored })
  };
}

test("workspace refuses the source identity before restore and cleans its own resource", async () => {
  const f = fixture({ sourceIsTarget: true });
  await assert.rejects(f.workspace.restoreRaw(f.dump), {
    code: "SNAPSHOT_WORKSPACE_TARGET_INVALID"
  });
  assert.deepEqual(f.counts(), { ended: 1, destroyed: 1, restored: 0 });
});

test("workspace transforms only the isolated target and fails closed on update errors", async () => {
  for (const failUpdate of [false, true]) {
    const f = fixture({ failUpdate });
    await f.workspace.restoreRaw(f.dump);
    const apply = () =>
      f.workspace.applyTransformations({
        contract,
        tokenizationSecretReference: "secret://stage1-snapshot-export/tokenization-key",
        sourceDatabaseAccess: "forbidden"
      });
    if (failUpdate) {
      await assert.rejects(apply(), { code: "SNAPSHOT_WORKSPACE_QUERY_FAILED" });
      assert.deepEqual(f.counts(), { ended: 1, destroyed: 1, restored: 1 });
    } else {
      await apply();
      const update = f.calls.find(({ sql }) => sql.startsWith("UPDATE"));
      assert.match(update.values[0], /^snap_[0-9a-f]{24}$/);
      assert.equal(update.values.at(-1), "id-1");
      assert.ok(!update.sql.includes("13800138000"));
      const dump = await f.workspace.exportSanitized();
      const expansion = await f.workspace.expandSanitizedArchive({
        archive: dump,
        expectedArchiveDigest: sha256Bytes(dump),
        maxExpandedBytes: 1073741824
      });
      assert.equal(expansion.archiveDigest, sha256Bytes(dump));
      await f.workspace.destroy();
      assert.deepEqual(f.counts(), { ended: 1, destroyed: 1, restored: 1 });
    }
    assert.deepEqual(f.tokenizationKey, Buffer.alloc(32, 7));
  }
});
