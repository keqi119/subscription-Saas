import assert from "node:assert/strict";
import test from "node:test";

import {
  executeFilenameRepair,
  filenameSources,
  parseFilenameRepairArgs,
  recoverUtf8Filename
} from "./repair-upload-filenames-core.mjs";

const APPLY_BATCH_ID = "11111111-1111-4111-8111-111111111111";
const ROLLBACK_BATCH_ID = "22222222-2222-4222-8222-222222222222";
const TEST_SOURCES = [
  {
    entityType: "VehicleDocument",
    fields: ["fileName"],
    model: "vehicleDocument"
  }
];

test("repairs UTF-8 bytes decoded as latin1", () => {
  assert.deepEqual(recoverUtf8Filename("è½¦è¾è¡Œé©¶è¯.pdf"), {
    reason: "utf8-bytes-decoded-as-latin1",
    status: "repair",
    value: "车辆行驶证.pdf"
  });
});

test("repairs Windows-1252 punctuation in mojibake", () => {
  assert.deepEqual(recoverUtf8Filename("â‚¬-receipt.pdf"), {
    reason: "utf8-bytes-decoded-as-windows-1252",
    status: "repair",
    value: "€-receipt.pdf"
  });
});

test("leaves valid Chinese and legitimate latin names unchanged", () => {
  assert.equal(recoverUtf8Filename("车辆行驶证.pdf").status, "unchanged");
  assert.equal(recoverUtf8Filename("résumé.pdf").status, "unchanged");
});

test("marks a decoded replacement character for manual review", () => {
  assert.deepEqual(recoverUtf8Filename("ï¿½.pdf"), {
    reason: "decoded-value-is-not-a-safe-filename",
    status: "ambiguous"
  });
});

test("is idempotent", () => {
  const once = recoverUtf8Filename("è½¦è¾è¡Œé©¶è¯.pdf");
  assert.equal(once.status, "repair");
  assert.equal(recoverUtf8Filename(once.value).status, "unchanged");
});

test("keeps the persisted filename source registry explicit", () => {
  assert.deepEqual(filenameSources, [
    {
      entityType: "CustomerProfileMaterial",
      fields: ["fileName", "originalName"],
      model: "customerProfileMaterial"
    },
    {
      entityType: "ApplicationMaterialFile",
      fields: ["fileName"],
      model: "applicationMaterialFile"
    },
    {
      entityType: "VehicleListingMedia",
      fields: ["fileName", "originalName"],
      model: "vehicleListingMedia"
    },
    {
      entityType: "VehicleDocument",
      fields: ["fileName", "originalName"],
      model: "vehicleDocument"
    },
    {
      entityType: "VehicleBaasContractAttachment",
      fields: ["fileName", "originalName"],
      model: "vehicleBaasContractAttachment"
    },
    {
      entityType: "MarketPriceImportBatch",
      fields: ["fileName"],
      model: "marketPriceImportBatch"
    },
    {
      entityType: "ServiceCaseAttachment",
      fields: ["fileName", "originalName"],
      model: "serviceCaseAttachment"
    },
    {
      entityType: "FileObject",
      fields: ["originalName"],
      model: "fileObject"
    }
  ]);
});

test("requires one explicit CLI mode and validates rollback batches", () => {
  assert.deepEqual(parseFilenameRepairArgs(["--dry-run"]), {
    help: false,
    mode: "dry-run",
    output: null,
    rollbackBatchId: null
  });
  assert.deepEqual(
    parseFilenameRepairArgs([
      "--rollback-batch",
      APPLY_BATCH_ID,
      "--output",
      "reports/rollback.json"
    ]),
    {
      help: false,
      mode: "rollback",
      output: "reports/rollback.json",
      rollbackBatchId: APPLY_BATCH_ID
    }
  );
  assert.deepEqual(parseFilenameRepairArgs(["--help"]), {
    help: true,
    mode: null,
    output: null,
    rollbackBatchId: null
  });
  assert.throws(() => parseFilenameRepairArgs([]), /exactly one mode/);
  assert.throws(() => parseFilenameRepairArgs(["--dry-run", "--apply"]), /exactly one mode/);
  assert.throws(() => parseFilenameRepairArgs(["--rollback-batch", "not-a-uuid"]), /valid UUID/);
});

test("dry-run reports candidates without opening a write transaction", async () => {
  const harness = createPrismaHarness();

  const result = await executeFilenameRepair({
    batchId: APPLY_BATCH_ID,
    mode: "dry-run",
    prisma: harness.prisma,
    sources: TEST_SOURCES
  });

  assert.deepEqual(result.summary, {
    ambiguous: 0,
    failed: 0,
    repaired: 1,
    scanned: 2,
    unchanged: 1
  });
  assert.deepEqual(result.sources, {
    VehicleDocument: {
      ambiguous: 0,
      failed: 0,
      repaired: 1,
      scanned: 2,
      unchanged: 1
    }
  });
  assert.equal(harness.transactionCount(), 0);
  assert.equal(harness.auditRows.length, 0);
  assert.equal(harness.rows.get("document-1").fileName, "è½¦è¾è¡Œé©¶è¯.pdf");
});

test("apply repairs and audits atomically, then converges on a second run", async () => {
  const harness = createPrismaHarness();

  const first = await executeFilenameRepair({
    batchId: APPLY_BATCH_ID,
    mode: "apply",
    prisma: harness.prisma,
    sources: TEST_SOURCES
  });
  const second = await executeFilenameRepair({
    batchId: ROLLBACK_BATCH_ID,
    mode: "apply",
    prisma: harness.prisma,
    sources: TEST_SOURCES
  });

  assert.equal(first.summary.repaired, 1);
  assert.equal(second.summary.repaired, 0);
  assert.equal(second.summary.unchanged, 2);
  assert.equal(harness.rows.get("document-1").fileName, "车辆行驶证.pdf");
  assert.equal(harness.auditRows.length, 1);
  assert.deepEqual(harness.auditRows[0], {
    action: "UPDATE",
    afterSnapshot: {
      batchId: APPLY_BATCH_ID,
      field: "fileName",
      value: "车辆行驶证.pdf"
    },
    beforeSnapshot: {
      batchId: APPLY_BATCH_ID,
      field: "fileName",
      value: "è½¦è¾è¡Œé©¶è¯.pdf"
    },
    entityId: "document-1",
    entityType: "VehicleDocument",
    module: "FILENAME_REPAIR"
  });
  assert.equal(harness.transactionCount(), 1);
});

test("rollback restores only the requested batch before value", async () => {
  const harness = createPrismaHarness();
  await executeFilenameRepair({
    batchId: APPLY_BATCH_ID,
    mode: "apply",
    prisma: harness.prisma,
    sources: TEST_SOURCES
  });

  const result = await executeFilenameRepair({
    batchId: ROLLBACK_BATCH_ID,
    mode: "rollback",
    prisma: harness.prisma,
    rollbackBatchId: APPLY_BATCH_ID,
    sources: TEST_SOURCES
  });

  assert.equal(result.summary.repaired, 1, JSON.stringify(result));
  assert.equal(harness.rows.get("document-1").fileName, "è½¦è¾è¡Œé©¶è¯.pdf");
  assert.equal(harness.auditRows.length, 2);
  assert.equal(harness.auditRows[1].beforeSnapshot.batchId, ROLLBACK_BATCH_ID);
  assert.equal(harness.auditRows[1].afterSnapshot.rollbackOfBatchId, APPLY_BATCH_ID);
});

function createPrismaHarness() {
  const rows = new Map([
    ["document-1", { id: "document-1", fileName: "è½¦è¾è¡Œé©¶è¯.pdf" }],
    ["document-2", { id: "document-2", fileName: "résumé.pdf" }]
  ]);
  const auditRows = [];
  let transactions = 0;

  const model = {
    findMany: async ({ orderBy, select }) => {
      assert.deepEqual(orderBy, { id: "asc" });
      assert.equal(select.id, true);
      assert.equal(select.fileName, true);
      return [...rows.values()].map((row) => structuredClone(row));
    },
    findUnique: async ({ select, where }) => {
      assert.equal(select.id, true);
      const row = rows.get(where.id);
      return row ? structuredClone(row) : null;
    },
    update: async ({ data, where }) => {
      const row = rows.get(where.id);
      if (!row) throw new Error("missing test row");
      Object.assign(row, structuredClone(data));
      return structuredClone(row);
    }
  };
  const tx = {
    auditLog: {
      create: async ({ data }) => {
        auditRows.push(structuredClone(data));
        return structuredClone(data);
      }
    },
    vehicleDocument: model
  };
  const prisma = {
    $transaction: async (operation) => {
      transactions += 1;
      const rowSnapshot = structuredClone([...rows.entries()]);
      const auditSnapshot = structuredClone(auditRows);
      try {
        return await operation(tx);
      } catch (error) {
        rows.clear();
        for (const [id, row] of rowSnapshot) rows.set(id, row);
        auditRows.splice(0, auditRows.length, ...auditSnapshot);
        throw error;
      }
    },
    auditLog: {
      findMany: async ({ orderBy, where }) => {
        assert.deepEqual(orderBy, [{ createdAt: "desc" }, { id: "desc" }]);
        return auditRows
          .filter(
            (row) =>
              row.module === where.module &&
              row.action === where.action &&
              row.beforeSnapshot.batchId === where.beforeSnapshot.equals
          )
          .map((row, index) => ({
            ...structuredClone(row),
            createdAt: new Date(1_000 - index),
            id: `audit-${index + 1}`
          }));
      }
    },
    vehicleDocument: model
  };

  return {
    auditRows,
    prisma,
    rows,
    transactionCount: () => transactions
  };
}
