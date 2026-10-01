// Replay the existing manual revocation chain from the owner's private journal.
// The default path is read only; the session may opt into its existing
// create-only head-checkpoint recovery after establishing live authority.
import path from "node:path";

import { sha256Bytes, sha256Canonical } from "./digest.mjs";
import { encodeManualJson } from "./manual-stage1-contracts.mjs";
import { validateContract } from "./schema-registry.mjs";

const CODE = "MANUAL_REVOCATION_UNVERIFIED";
const DIGEST = /^sha256:[0-9a-f]{64}$/u;
const need = (value) => {
  if (!value) throw Object.assign(new Error(CODE), { code: CODE });
};
const same = (left, right) => sha256Canonical(left) === sha256Canonical(right);

function instant(value) {
  need(
    typeof value === "string" &&
      /^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d\.\d{3}Z$/u.test(value) &&
      Number.isFinite(Date.parse(value)) &&
      new Date(value).toISOString() === value
  );
  return Date.parse(value);
}

export async function readManualRevocationHistory({
  store,
  journalRoot,
  profileDigest,
  ownerId,
  recordSchema,
  now,
  checkpoint = null,
  writeCheckpoint = false
}) {
  try {
    need(
      store &&
        typeof store.checkedPath === "function" &&
        typeof store.read === "function" &&
        typeof store.fs?.readdir === "function" &&
        typeof store.fs?.lstat === "function" &&
        (!writeCheckpoint || typeof store.create === "function") &&
        typeof journalRoot === "string" &&
        path.isAbsolute(journalRoot) &&
        path.normalize(journalRoot) === journalRoot &&
        DIGEST.test(profileDigest) &&
        typeof ownerId === "string" &&
        ownerId.length > 0 &&
        ["manual-operation-record.v1", "manual-operation-record.v2"].includes(recordSchema) &&
        typeof writeCheckpoint === "boolean" &&
        (checkpoint === null ||
          (checkpoint &&
            Number.isSafeInteger(checkpoint.sequence) &&
            checkpoint.sequence >= 0 &&
            DIGEST.test(checkpoint.digest)))
    );
    const readAt = instant(now);
    const prefix = profileDigest.slice(7);
    const dir = path.join(journalRoot, "revocations");
    await store.checkedPath(dir);
    const names = (await store.fs.readdir(dir)).filter((name) => name.startsWith(`${prefix}-`));
    need(names.length > 0);
    const records = [];
    for (let sequence = 0; sequence < names.length; sequence++) {
      const name = `${prefix}-${sequence}.json`;
      need(names.includes(name));
      const bytes = await store.read(path.join(dir, name));
      const record = JSON.parse(bytes);
      need(encodeManualJson(record).equals(bytes));
      validateContract(recordSchema, record);
      need(
        record.kind === "revocation" &&
          record.sequence === sequence &&
          record.profileDigest === profileDigest &&
          record.ownerId === ownerId &&
          record.previousRevocationDigest ===
            (sequence ? sha256Canonical(records[sequence - 1]) : null) &&
          (sequence ? record.action !== "GENESIS" : record.action === "GENESIS")
      );
      need(
        instant(record.recordedAt) <= readAt &&
          (!sequence || instant(record.recordedAt) >= instant(records[sequence - 1].recordedAt))
      );
      const original = await store.read(
        path.join(journalRoot, "objects", `${sha256Canonical(record).slice(7)}.json`)
      );
      need(original.equals(bytes));
      records.push(record);
    }
    // A canonical original without its unique sequence slot is uncertainty.
    const originalDir = path.join(journalRoot, "objects");
    await store.checkedPath(originalDir);
    for (const name of await store.fs.readdir(originalDir)) {
      need(/^[0-9a-f]{64}\.json$/u.test(name));
      const bytes = await store.read(path.join(originalDir, name));
      need(sha256Bytes(bytes) === `sha256:${name.slice(0, -5)}`);
      const original = JSON.parse(bytes);
      if (original.kind === "revocation" && original.profileDigest === profileDigest)
        need(records[original.sequence] && same(records[original.sequence], original));
    }
    const checkpointDir = path.join(journalRoot, "checkpoints");
    await store.checkedPath(checkpointDir);
    for (const name of (await store.fs.readdir(checkpointDir)).filter((name) =>
      name.startsWith(`${prefix}-`)
    )) {
      const saved = JSON.parse(await store.read(path.join(checkpointDir, name)));
      need(
        saved.kind === "revocation" &&
          saved.profileDigest === profileDigest &&
          records[saved.sequence] &&
          same(records[saved.sequence], saved)
      );
    }
    if (checkpoint)
      need(
        records[checkpoint.sequence] &&
          sha256Canonical(records[checkpoint.sequence]) === checkpoint.digest
      );
    const head = records.at(-1);
    const digest = sha256Canonical(head);
    const checkpointFile = path.join(checkpointDir, `${prefix}-${head.sequence}.json`);
    try {
      await store.fs.lstat(checkpointFile);
    } catch (error) {
      if (error.code !== "ENOENT" || !writeCheckpoint) throw error;
      await store.create(checkpointFile, encodeManualJson(head));
    }
    need((await store.read(checkpointFile)).equals(encodeManualJson(head)));
    return { records, checkpoint: { sequence: head.sequence, digest } };
  } catch {
    throw Object.assign(new Error(CODE), { code: CODE });
  }
}
