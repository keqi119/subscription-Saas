import { randomUUID } from "node:crypto";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";

import {
  assertCustodyComplete,
  canonicalJson,
  custodyEvidence,
  sha256Bytes,
  sha256Canonical
} from "../../packages/release-foundation/src/index.mjs";

function custodyError(code, details) {
  return Object.assign(new Error(code), { code, details });
}

function safeSegment(value, code) {
  if (!/^[a-z0-9][a-z0-9-]{0,63}$/u.test(value ?? "")) throw custodyError(code);
  return value;
}

function safeLocalFile(root, chain, attemptId, name) {
  const absolute = path.resolve(
    root,
    safeSegment(chain, "FINAL_EVIDENCE_CHAIN_INVALID"),
    attemptId,
    `${safeSegment(name, "FINAL_EVIDENCE_STAGE_INVALID")}.json`
  );
  const relative = path.relative(path.resolve(root), absolute);
  if (!relative || relative.startsWith("..") || path.isAbsolute(relative)) {
    throw custodyError("FINAL_EVIDENCE_PATH_FORBIDDEN");
  }
  return absolute;
}

async function writeCreateOnly(file, value, existsCode) {
  await mkdir(path.dirname(file), { recursive: true });
  const bytes = Buffer.from(canonicalJson(value), "utf8");
  try {
    await writeFile(file, bytes, { flag: "wx" });
  } catch (error) {
    if (error?.code === "EEXIST") throw custodyError(existsCode);
    throw error;
  }
  const readback = await readFile(file);
  if (sha256Bytes(readback) !== sha256Bytes(bytes)) {
    throw custodyError("FINAL_EVIDENCE_LOCAL_READBACK_MISMATCH");
  }
  return bytes;
}

function assertUploader(uploader) {
  if (
    uploader?.trustPolicy !== "immutable-content-addressed/v1" ||
    typeof uploader.createOnly !== "function" ||
    typeof uploader.read !== "function" ||
    typeof uploader.writerIdentity !== "string" ||
    uploader.auditReaderIdentity !== "audit-reader"
  ) {
    throw custodyError("FINAL_EVIDENCE_UPLOADER_INVALID");
  }
}

function safeStorageFile(root, key) {
  if (
    typeof key !== "string" ||
    !/^(?:evidence\/[0-9a-f]{64}\.json|receipts\/[0-9a-f-]{36}\.json)$/u.test(key)
  ) {
    throw custodyError("FINAL_EVIDENCE_STORAGE_KEY_INVALID");
  }
  const absolute = path.resolve(root, ...key.split("/"));
  const relative = path.relative(path.resolve(root), absolute);
  if (!relative || relative.startsWith("..") || path.isAbsolute(relative)) {
    throw custodyError("FINAL_EVIDENCE_PATH_FORBIDDEN");
  }
  return absolute;
}

export function createFileCustodyUploader({ root }) {
  if (typeof root !== "string" || root.length === 0) {
    throw custodyError("FINAL_EVIDENCE_STORAGE_ROOT_REQUIRED");
  }
  return Object.freeze({
    trustPolicy: "immutable-content-addressed/v1",
    writerIdentity: "release-final-gate",
    auditReaderIdentity: "audit-reader",
    async createOnly({ key, bytes, requestedAt, retainUntil }) {
      const file = safeStorageFile(root, key);
      await mkdir(path.dirname(file), { recursive: true });
      try {
        await writeFile(file, bytes, { flag: "wx" });
      } catch (error) {
        if (error?.code === "EEXIST") return Object.freeze({ created: false });
        throw error;
      }
      const readback = await readFile(file);
      return Object.freeze({
        created: true,
        storeRef: `evidence-file:///${key}`,
        contentSizeBytes: readback.byteLength,
        storedAt: requestedAt,
        retainUntil
      });
    },
    async read({ key }) {
      return readFile(safeStorageFile(root, key));
    }
  });
}

export function createFinalCustodyAdapters({
  evidenceRoot,
  chain,
  attemptId,
  custodyPolicy,
  uploader,
  attestationRef,
  now = () => new Date(),
  createReceiptId = randomUUID
}) {
  if (typeof evidenceRoot !== "string" || evidenceRoot.length === 0) {
    throw custodyError("FINAL_EVIDENCE_ROOT_REQUIRED");
  }
  safeSegment(chain, "FINAL_EVIDENCE_CHAIN_INVALID");
  if (!/^[0-9a-f-]{36}$/iu.test(attemptId ?? "")) {
    throw custodyError("FINAL_EVIDENCE_ATTEMPT_INVALID");
  }
  assertUploader(uploader);
  let authorized = false;
  const retainedReceipts = new Map();

  async function store(name, value, existsCode = "FINAL_EVIDENCE_ATTEMPT_ALREADY_EXISTS") {
    await writeCreateOnly(safeLocalFile(evidenceRoot, chain, attemptId, name), value, existsCode);
    const receipt = await custodyEvidence({
      value,
      policy: custodyPolicy,
      storage: uploader,
      now,
      createReceiptId,
      attestationRef
    });
    assertCustodyComplete(receipt, sha256Canonical(value));
    return receipt;
  }

  return Object.freeze({
    async custodyComponent(name, value) {
      if (retainedReceipts.has(name)) {
        throw custodyError("FINAL_EVIDENCE_STAGE_ALREADY_CUSTODIED", { name });
      }
      const receipt = await store(name, value);
      retainedReceipts.set(name, receipt);
      return receipt;
    },

    async custody({ stageEvidence, buildEvidence }) {
      if (
        !stageEvidence ||
        typeof stageEvidence !== "object" ||
        Array.isArray(stageEvidence) ||
        Object.keys(stageEvidence).length === 0 ||
        typeof buildEvidence !== "function"
      ) {
        throw custodyError("FINAL_EVIDENCE_CUSTODY_INPUT_INVALID");
      }
      const receipts = [];
      for (const name of Object.keys(stageEvidence).sort()) {
        if (retainedReceipts.has(name)) {
          throw custodyError("FINAL_EVIDENCE_STAGE_ALREADY_CUSTODIED", { name });
        }
        const receipt = await store(name, stageEvidence[name]);
        retainedReceipts.set(name, receipt);
      }
      receipts.push(...[...retainedReceipts.values()]);
      const custodyReceiptDigests = receipts.map((receipt) => sha256Canonical(receipt));
      const evidence = buildEvidence({ custodyReceiptDigests });
      await writeCreateOnly(
        safeLocalFile(evidenceRoot, chain, attemptId, "final-compose-evidence"),
        evidence,
        "FINAL_EVIDENCE_ATTEMPT_ALREADY_EXISTS"
      );
      authorized = true;
      return Object.freeze({
        attemptId,
        evidence: Object.freeze(evidence),
        receipts: Object.freeze(receipts),
        custodyReceiptDigests: Object.freeze(custodyReceiptDigests)
      });
    },

    async recordFailure(failure) {
      const receipt = await store("failure", failure, "FINAL_EVIDENCE_FAILURE_ALREADY_RECORDED");
      return Object.freeze({
        terminalStatus: failure.terminalStatus,
        failure: Object.freeze({ ...failure }),
        failureProofDigest: sha256Canonical(failure),
        custodyReceiptDigest: sha256Canonical(receipt)
      });
    },

    async readback(receipt) {
      assertCustodyComplete(receipt, receipt?.contentDigest);
      const bytes = await uploader.read({
        key: `evidence/${receipt.contentDigest.slice("sha256:".length)}.json`,
        identity: uploader.auditReaderIdentity
      });
      if (sha256Bytes(Buffer.from(bytes)) !== receipt.contentDigest) {
        throw custodyError("EVIDENCE_READBACK_DIGEST_MISMATCH");
      }
      return true;
    },

    cleanupAuthorized() {
      return authorized;
    }
  });
}
