import assert from "node:assert/strict";
import path from "node:path";
import test from "node:test";

import { sha256Canonical } from "../src/digest.mjs";
import { encodeManualJson } from "../src/manual-stage1-contracts.mjs";
import { readManualRevocationHistory } from "../src/manual-revocation-history.mjs";

const profileDigest = `sha256:${"a".repeat(64)}`;
const ownerId = "stage1-owner";
const journalRoot = path.resolve("/private/stage1-journal");
const now = "2026-09-29T00:00:03.000Z";
const name = (sequence) => `${profileDigest.slice(7)}-${sequence}.json`;

function fixture() {
  const genesis = {
    schemaVersion: "manual-operation-record.v2",
    kind: "revocation",
    profileDigest,
    recordedAt: "2026-09-29T00:00:00.000Z",
    promotionEligible: false,
    ownerId,
    sequence: 0,
    previousRevocationDigest: null,
    action: "GENESIS",
    authorizationId: null,
    reasonCode: null
  };
  const revoked = {
    ...genesis,
    recordedAt: "2026-09-29T00:00:01.000Z",
    sequence: 1,
    previousRevocationDigest: sha256Canonical(genesis),
    action: "REVOKE_PROFILE",
    reasonCode: "OWNER_REVOKED"
  };
  const files = new Map();
  const dirs = ["revocations", "objects", "checkpoints"].map((part) =>
    path.join(journalRoot, part)
  );
  const [slots, objects, checkpoints] = dirs;
  for (const record of [genesis, revoked]) {
    files.set(path.join(slots, name(record.sequence)), encodeManualJson(record));
    files.set(
      path.join(objects, `${sha256Canonical(record).slice(7)}.json`),
      encodeManualJson(record)
    );
    files.set(path.join(checkpoints, name(record.sequence)), encodeManualJson(record));
  }
  let writes = 0;
  const store = {
    checkedPath: async (file) => {
      assert.ok(dirs.includes(file));
    },
    read: async (file) => {
      if (!files.has(file)) throw Object.assign(new Error("missing"), { code: "ENOENT" });
      return Buffer.from(files.get(file));
    },
    create: async (file, bytes) => {
      writes++;
      if (files.has(file)) throw Object.assign(new Error("exists"), { code: "EEXIST" });
      files.set(file, Buffer.from(bytes));
    },
    fs: {
      readdir: async (dir) => {
        assert.ok(dirs.includes(dir));
        return [...files.keys()]
          .filter((file) => path.dirname(file) === dir)
          .map((file) => path.basename(file));
      },
      lstat: async (file) => {
        if (!files.has(file)) throw Object.assign(new Error("missing"), { code: "ENOENT" });
        return { isFile: () => true };
      }
    }
  };
  const read = (options = {}) =>
    readManualRevocationHistory({
      store,
      journalRoot,
      profileDigest,
      ownerId,
      recordSchema: "manual-operation-record.v2",
      now,
      checkpoint: null,
      ...options
    });
  return { genesis, revoked, files, dirs, read, writes: () => writes };
}

test("revocation history verifies a complete chain without writing", async () => {
  const f = fixture();
  const result = await f.read();
  assert.deepEqual(result.records, [f.genesis, f.revoked]);
  assert.deepEqual(result.checkpoint, {
    sequence: 1,
    digest: sha256Canonical(f.revoked)
  });
  assert.equal(f.writes(), 0);
});

test("revocation history rejects missing head checkpoint unless create-only mode is explicit", async () => {
  const f = fixture();
  f.files.delete(path.join(f.dirs[2], name(1)));
  await assert.rejects(f.read(), { code: "MANUAL_REVOCATION_UNVERIFIED" });
  assert.equal(f.writes(), 0);
  const result = await f.read({ writeCheckpoint: true });
  assert.deepEqual(result.checkpoint, { sequence: 1, digest: sha256Canonical(f.revoked) });
  assert.equal(f.writes(), 1);
  assert.deepEqual(f.files.get(path.join(f.dirs[2], name(1))), encodeManualJson(f.revoked));
});

test("revocation history rejects orphan journal originals and rolled-back checkpoints", async () => {
  const orphan = fixture();
  const extra = {
    ...orphan.revoked,
    recordedAt: "2026-09-29T00:00:02.000Z",
    sequence: 2,
    previousRevocationDigest: sha256Canonical(orphan.revoked)
  };
  orphan.files.set(
    path.join(orphan.dirs[1], `${sha256Canonical(extra).slice(7)}.json`),
    encodeManualJson(extra)
  );
  await assert.rejects(orphan.read(), { code: "MANUAL_REVOCATION_UNVERIFIED" });
  assert.equal(orphan.writes(), 0);

  const rollback = fixture();
  rollback.files.set(path.join(rollback.dirs[2], name(2)), encodeManualJson(extra));
  await assert.rejects(rollback.read(), { code: "MANUAL_REVOCATION_UNVERIFIED" });
  assert.equal(rollback.writes(), 0);

  const remembered = fixture();
  await assert.rejects(
    remembered.read({ checkpoint: { sequence: 2, digest: sha256Canonical(extra) } }),
    { code: "MANUAL_REVOCATION_UNVERIFIED" }
  );
  assert.equal(remembered.writes(), 0);
});
