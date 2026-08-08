const UTF8_DECODER = new TextDecoder("utf-8", { fatal: true });
const WINDOWS_1252_BYTE_BY_CHARACTER = new Map([
  ["€", 0x80],
  ["‚", 0x82],
  ["ƒ", 0x83],
  ["„", 0x84],
  ["…", 0x85],
  ["†", 0x86],
  ["‡", 0x87],
  ["ˆ", 0x88],
  ["‰", 0x89],
  ["Š", 0x8a],
  ["‹", 0x8b],
  ["Œ", 0x8c],
  ["Ž", 0x8e],
  ["‘", 0x91],
  ["’", 0x92],
  ["“", 0x93],
  ["”", 0x94],
  ["•", 0x95],
  ["–", 0x96],
  ["—", 0x97],
  ["˜", 0x98],
  ["™", 0x99],
  ["š", 0x9a],
  ["›", 0x9b],
  ["œ", 0x9c],
  ["ž", 0x9e],
  ["Ÿ", 0x9f]
]);
export const filenameSources = [
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
];

export function parseFilenameRepairArgs(args) {
  if (args.length === 1 && new Set(["--help", "-h"]).has(args[0])) {
    return {
      help: true,
      mode: null,
      output: null,
      rollbackBatchId: null
    };
  }

  let mode = null;
  let modeCount = 0;
  let output = null;
  let rollbackBatchId = null;
  for (let index = 0; index < args.length; index += 1) {
    const argument = args[index];
    if (argument === "--dry-run" || argument === "--apply") {
      mode = argument.slice(2);
      modeCount += 1;
      continue;
    }
    if (argument === "--rollback-batch") {
      rollbackBatchId = args[index + 1] ?? null;
      index += 1;
      if (!isUuid(rollbackBatchId)) {
        throw new Error("--rollback-batch requires a valid UUID.");
      }
      mode = "rollback";
      modeCount += 1;
      continue;
    }
    if (argument === "--output") {
      output = args[index + 1] ?? null;
      index += 1;
      if (!output || output.startsWith("--")) {
        throw new Error("--output requires a path.");
      }
      continue;
    }
    throw new Error(`Unknown argument: ${argument}`);
  }

  if (modeCount !== 1) {
    throw new Error("Specify exactly one mode: --dry-run, --apply, or --rollback-batch UUID.");
  }
  return { help: false, mode, output, rollbackBatchId };
}

export function recoverUtf8Filename(value) {
  if (typeof value !== "string" || value.length === 0) {
    return { status: "unchanged" };
  }

  const encoded = encodeLegacyText(value);
  if (!encoded) return { status: "unchanged" };

  let decoded;
  try {
    decoded = UTF8_DECODER.decode(encoded.bytes);
  } catch {
    return { status: "unchanged" };
  }

  if (
    !Buffer.from(decoded, "utf8").equals(encoded.bytes) ||
    decoded === value ||
    !looksLikeMojibake(value, decoded, encoded.usesWindows1252)
  ) {
    return { status: "unchanged" };
  }
  if (!isSafeRecoveredFilename(decoded)) {
    return {
      reason: "decoded-value-is-not-a-safe-filename",
      status: "ambiguous"
    };
  }

  const encoding =
    encoded.usesWindows1252 && !/\p{Script=Han}/u.test(decoded) ? "windows-1252" : "latin1";
  return {
    reason: `utf8-bytes-decoded-as-${encoding}`,
    status: "repair",
    value: decoded.normalize("NFC")
  };
}

export async function executeFilenameRepair({
  batchId,
  mode,
  prisma,
  rollbackBatchId,
  sources = filenameSources
}) {
  if (mode === "rollback") {
    return rollbackFilenameRepair({
      batchId,
      prisma,
      rollbackBatchId,
      sources
    });
  }
  if (!new Set(["apply", "dry-run"]).has(mode)) {
    throw new Error("FILENAME_REPAIR_MODE_INVALID");
  }

  const report = createReport(batchId, mode);
  for (const source of sources) {
    const model = requireModel(prisma, source.model);
    const select = Object.fromEntries(["id", ...source.fields].map((field) => [field, true]));
    const records = await model.findMany({ orderBy: { id: "asc" }, select });

    for (const record of records) {
      const candidates = [];
      for (const field of source.fields) {
        const value = record[field];
        if (typeof value !== "string") continue;

        incrementReport(report, source.entityType, "scanned");
        const decision = recoverUtf8Filename(value);
        if (decision.status === "unchanged") {
          incrementReport(report, source.entityType, "unchanged");
          continue;
        }
        if (decision.status === "ambiguous") {
          incrementReport(report, source.entityType, "ambiguous");
          report.rows.push(reportRow(source, record.id, field, value, null, decision));
          continue;
        }

        candidates.push({
          after: decision.value,
          before: value,
          field,
          reason: decision.reason
        });
        report.rows.push(reportRow(source, record.id, field, value, decision.value, decision));
      }

      if (mode === "dry-run") {
        incrementReport(report, source.entityType, "repaired", candidates.length);
        continue;
      }
      if (candidates.length === 0) continue;

      try {
        await applyRecordRepair({
          batchId,
          candidates,
          entityId: record.id,
          prisma,
          source
        });
        incrementReport(report, source.entityType, "repaired", candidates.length);
      } catch (error) {
        incrementReport(report, source.entityType, "failed", candidates.length);
        for (const candidate of candidates) {
          const row = report.rows.find(
            (item) => item.entityId === record.id && item.field === candidate.field
          );
          if (row) {
            row.status = "failed";
            row.reason = safeErrorReason(error);
          }
        }
      }
    }
  }

  return report;
}

async function applyRecordRepair({ batchId, candidates, entityId, prisma, source }) {
  await prisma.$transaction(async (tx) => {
    const model = requireModel(tx, source.model);
    const select = Object.fromEntries(
      ["id", ...candidates.map(({ field }) => field)].map((field) => [field, true])
    );
    const current = await model.findUnique({ select, where: { id: entityId } });
    if (!current) {
      throw new Error("FILENAME_REPAIR_SOURCE_NOT_FOUND");
    }
    for (const candidate of candidates) {
      if (current[candidate.field] !== candidate.before) {
        throw new Error("FILENAME_REPAIR_SOURCE_CHANGED");
      }
    }

    await model.update({
      data: Object.fromEntries(candidates.map(({ after, field }) => [field, after])),
      where: { id: entityId }
    });
    for (const candidate of candidates) {
      await tx.auditLog.create({
        data: auditData({
          after: candidate.after,
          batchId,
          before: candidate.before,
          entityId,
          field: candidate.field,
          source
        })
      });
    }
  });
}

async function rollbackFilenameRepair({ batchId, prisma, rollbackBatchId, sources }) {
  if (!rollbackBatchId) {
    throw new Error("FILENAME_REPAIR_ROLLBACK_BATCH_REQUIRED");
  }
  const report = createReport(batchId, "rollback", rollbackBatchId);
  const sourceByEntityType = new Map(sources.map((source) => [source.entityType, source]));
  const audits = await prisma.auditLog.findMany({
    orderBy: [{ createdAt: "desc" }, { id: "desc" }],
    where: {
      action: "UPDATE",
      beforeSnapshot: { equals: rollbackBatchId, path: ["batchId"] },
      module: "FILENAME_REPAIR"
    }
  });

  for (const audit of audits) {
    incrementReport(report, audit.entityType, "scanned");
    const source = sourceByEntityType.get(audit.entityType);
    const field = audit.beforeSnapshot?.field;
    const before = audit.beforeSnapshot?.value;
    const after = audit.afterSnapshot?.value;
    if (
      !source ||
      !source.fields.includes(field) ||
      !audit.entityId ||
      typeof before !== "string" ||
      typeof after !== "string"
    ) {
      incrementReport(report, audit.entityType, "ambiguous");
      report.rows.push({
        entityId: audit.entityId ?? null,
        entityType: audit.entityType,
        field: typeof field === "string" ? field : null,
        reason: "rollback-audit-invalid",
        status: "ambiguous"
      });
      continue;
    }

    try {
      const outcome = await prisma.$transaction(async (tx) => {
        const model = requireModel(tx, source.model);
        const current = await model.findUnique({
          select: { [field]: true, id: true },
          where: { id: audit.entityId }
        });
        if (!current) throw new Error("FILENAME_REPAIR_SOURCE_NOT_FOUND");
        if (current[field] === before) return "unchanged";
        if (current[field] !== after) {
          throw new Error("FILENAME_REPAIR_ROLLBACK_SOURCE_CHANGED");
        }

        await model.update({
          data: { [field]: before },
          where: { id: audit.entityId }
        });
        await tx.auditLog.create({
          data: {
            ...auditData({
              after: before,
              batchId,
              before: after,
              entityId: audit.entityId,
              field,
              source
            }),
            afterSnapshot: {
              batchId,
              field,
              rollbackOfBatchId: rollbackBatchId,
              value: before
            }
          }
        });
        return "repaired";
      });
      incrementReport(report, audit.entityType, outcome);
      report.rows.push({
        after: before,
        before: after,
        entityId: audit.entityId,
        entityType: audit.entityType,
        field,
        reason: "rollback",
        status: outcome
      });
    } catch (error) {
      incrementReport(report, audit.entityType, "failed");
      report.rows.push({
        after: before,
        before: after,
        entityId: audit.entityId,
        entityType: audit.entityType,
        field,
        reason: safeErrorReason(error),
        status: "failed"
      });
    }
  }

  return report;
}

function auditData({ after, batchId, before, entityId, field, source }) {
  return {
    action: "UPDATE",
    afterSnapshot: { batchId, field, value: after },
    beforeSnapshot: { batchId, field, value: before },
    entityId,
    entityType: source.entityType,
    module: "FILENAME_REPAIR"
  };
}

function createReport(batchId, mode, rollbackBatchId = null) {
  return {
    batchId,
    mode,
    rollbackBatchId,
    rows: [],
    sources: {},
    summary: {
      ambiguous: 0,
      failed: 0,
      repaired: 0,
      scanned: 0,
      unchanged: 0
    }
  };
}

function incrementReport(report, entityType, counter, count = 1) {
  report.summary[counter] += count;
  report.sources[entityType] ??= {
    ambiguous: 0,
    failed: 0,
    repaired: 0,
    scanned: 0,
    unchanged: 0
  };
  report.sources[entityType][counter] += count;
}

function reportRow(source, entityId, field, before, after, decision) {
  return {
    after,
    before,
    entityId,
    entityType: source.entityType,
    field,
    reason: decision.reason ?? null,
    status: decision.status
  };
}

function encodeLegacyText(value) {
  const bytes = [];
  let usesWindows1252 = false;
  for (const character of value) {
    const codePoint = character.codePointAt(0);
    if (WINDOWS_1252_BYTE_BY_CHARACTER.has(character)) {
      bytes.push(WINDOWS_1252_BYTE_BY_CHARACTER.get(character));
      usesWindows1252 = true;
    } else if (codePoint <= 0xff) {
      bytes.push(codePoint);
    } else {
      return null;
    }
  }
  return { bytes: Buffer.from(bytes), usesWindows1252 };
}

function looksLikeMojibake(value, decoded, usesWindows1252) {
  if (/\p{Script=Han}/u.test(decoded) && !/\p{Script=Han}/u.test(value)) {
    return true;
  }
  if (usesWindows1252) {
    return [...value].some((character) => WINDOWS_1252_BYTE_BY_CHARACTER.has(character));
  }
  return /[\u0080-\u009fÃÂâðåæçèéï]/u.test(value) && /[^\u0000-\u007f]/u.test(decoded);
}

function isSafeRecoveredFilename(value) {
  if (!value || value === "." || value === ".." || value.includes("�")) {
    return false;
  }
  if (value.normalize("NFC").length > 255) return false;
  for (const character of value) {
    const codePoint = character.codePointAt(0);
    if (
      codePoint <= 0x1f ||
      (codePoint >= 0x7f && codePoint <= 0x9f) ||
      (codePoint >= 0x202a && codePoint <= 0x202e) ||
      (codePoint >= 0x2066 && codePoint <= 0x2069) ||
      character === "/" ||
      character === "\\"
    ) {
      return false;
    }
  }
  return value === value.trim();
}

function requireModel(client, modelName) {
  const model = client?.[modelName];
  if (!model) throw new Error(`FILENAME_REPAIR_MODEL_MISSING:${modelName}`);
  return model;
}

function safeErrorReason(error) {
  return error instanceof Error ? error.message : "FILENAME_REPAIR_UNKNOWN_ERROR";
}

function isUuid(value) {
  return (
    typeof value === "string" &&
    /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu.test(value)
  );
}
