import { createHash } from "node:crypto";

export function parseStage1ReturnClosureBackfillArgs(args) {
  let mode = null;
  let output = null;
  for (let index = 0; index < args.length; index += 1) {
    const argument = args[index];
    if (argument === "--dry-run" || argument === "--apply") {
      if (mode) invalid();
      mode = argument === "--apply" ? "apply" : "dry-run";
      continue;
    }
    if (argument === "--output") {
      const value = args[index + 1];
      if (output || !value || value.startsWith("--") || !value.trim()) invalid();
      output = value;
      index += 1;
      continue;
    }
    if (argument.startsWith("--output=")) {
      const value = argument.slice(9);
      if (output || !value.trim()) invalid();
      output = value;
      continue;
    }
    invalid();
  }
  if (!mode) invalid();
  return { mode, output };
}

export function classifyStage1ReturnClosureBackfill(snapshot = {}) {
  const closures = array(snapshot.closures).slice().sort(byId);
  const deliveries = array(snapshot.deliveries);
  const damages = array(snapshot.damages);
  const contracts = array(snapshot.contracts);
  const clauses = array(snapshot.clauses);
  const links = array(snapshot.links);
  const files = array(snapshot.files);
  const fileIds = new Set(files.map((file) => file.id));
  const fileById = new Map(files.map((file) => [file.id, file]));
  const audits = array(snapshot.audits);
  const bills = array(snapshot.bills);
  const dispositions = array(snapshot.dispositions);
  const settlementById = new Map(
    array(snapshot.settlements).map((settlement) => [settlement.id, settlement])
  );
  const closureById = new Map(closures.map((closure) => [closure.id, closure]));
  const contractById = new Map(contracts.map((contract) => [contract.id, contract]));
  const existingClauseByKey = new Map(
    clauses.map((clause) => [clauseKey(clause.contractId, clause.clauseCode, clause.clauseVersion), clause])
  );
  const existingLinkKeys = new Set(links.map((link) => link.sourceKey));
  const legacyEvidenceLinks = [];
  const clauseSnapshots = [];
  const financialUpdates = [];
  const fileAuthorityUpdates = [];
  const manualReview = [];

  for (const settlement of array(snapshot.settlements)) {
    if (
      settlement.stage !== "FINALIZED" ||
      (settlement.publishedAt && settlement.publicationSnapshot)
    ) {
      continue;
    }
    const closure = closureById.get(settlement.closureCaseId);
    manualReview.push(
      closure
        ? issue(closure, "MISSING_SETTLEMENT_PUBLICATION_FACT", {
            settlementRevisionId: settlement.id
          })
        : {
            closureCaseId: settlement.closureCaseId,
            code: "MISSING_SETTLEMENT_PUBLICATION_FACT",
            orderId: null,
            settlementRevisionId: settlement.id
          }
    );
  }

  for (const closure of closures) {
    if (!closure) continue;
    const contract = contractById.get(closure.contractId);
    if (contract) {
      const file = typeof contract.fileId === "string" ? fileById.get(contract.fileId) : null;
      const auditHash = [...audits]
        .reverse()
        .filter(
          (audit) =>
            audit.entityId === contract.id &&
            audit.entityType === "contract" &&
            ["APPROVE", "UPDATE"].includes(audit.action)
        )
        .map((audit) => record(audit.afterSnapshot))
        .find(
          (snapshot) =>
            snapshot.status === "ARCHIVED" &&
            snapshot.fileId === contract.fileId &&
            validSha256(snapshot.signedPdfHash)
        )?.signedPdfHash;
      const persistedHash = validSha256(file?.contentSha256)
        ? String(file.contentSha256).toLowerCase()
        : null;
      const trustedAuditHash = validSha256(auditHash) ? String(auditHash).toLowerCase() : null;
      const archivedContractAuthority =
        contract.status === "ARCHIVED" &&
        validTimestamp(contract.signedAt) &&
        validTimestamp(contract.archivedAt) &&
        typeof contract.fileId === "string" &&
        Boolean(trustedAuditHash);
      if (!file || !archivedContractAuthority) {
        manualReview.push(issue(closure, "MISSING_SIGNED_CONTRACT_FILE_AUTHORITY"));
      } else if (persistedHash && trustedAuditHash && persistedHash !== trustedAuditHash) {
        manualReview.push(issue(closure, "SIGNED_CONTRACT_FILE_AUTHORITY_CONFLICT"));
      } else if (file && !persistedHash && trustedAuditHash) {
        fileAuthorityUpdates.push({
          closureCaseId: closure.id,
          contractId: contract.id,
          disposition: "UPDATE",
          expectedContentSha256: null,
          fileId: file.id,
          toContentSha256: trustedAuditHash
        });
      }
    } else {
      manualReview.push(issue(closure, "MISSING_SIGNED_CONTRACT_FILE_AUTHORITY"));
    }
    if (closure.retiredAt) continue;
    const delivery = deliveries.find(
      (item) =>
        item.orderId === closure.orderId &&
        item.status === "ARCHIVED" &&
        item.archiveStatus === "ARCHIVED" &&
        validTimestamp(item.archivedAt) &&
        typeof item.signedDocumentFileId === "string" &&
        fileIds.has(item.signedDocumentFileId) &&
        typeof item.signedPdfHash === "string" &&
        /^[a-f0-9]{64}$/i.test(item.signedPdfHash)
    );
    if (!delivery) manualReview.push(issue(closure, "MISSING_SIGNED_DELIVERY_BASELINE"));
    if (!closure.currentChecklistRevisionId) manualReview.push(issue(closure, "MISSING_RETURN_CHECKLIST"));
    if (!closure.currentDeltaRevisionId) manualReview.push(issue(closure, "MISSING_CONDITION_DELTA"));

    for (const damage of damages.filter((item) => item.orderId === closure.orderId && !item.deletedAt)) {
      for (const [index, url] of urls(damage.photoUrls).entries()) {
        const sourceKey = `legacy-return-url:${damage.id}:${index}:${sha256(url).slice(0, 16)}`;
        legacyEvidenceLinks.push({
          closureCaseId: closure.id,
          damageId: damage.id,
          disposition: existingLinkKeys.has(sourceKey) ? "UNCHANGED" : "CREATE",
          evidencePurpose: "LEGACY_EXTERNAL_REFERENCE",
          legacyExternalReference: url,
          sourceId: closure.id,
          sourceKey,
          sourceType: "STAGE1_RETURN_CLOSURE_BACKFILL",
          visibility: "CUSTOMER_VISIBLE"
        });
      }
    }

    if (!contract) {
      manualReview.push(issue(closure, "MISSING_CONTRACT_SNAPSHOT"));
    } else {
      const compiledClauses = compileHistoricalClauses(contract);
      for (const compiled of compiledClauses) {
        const key = clauseKey(contract.id, compiled.clauseCode, compiled.clauseVersion);
        const existing = existingClauseByKey.get(key);
        clauseSnapshots.push({
          ...compiled,
          contractId: contract.id,
          disposition: !existing
            ? "CREATE"
            : existing.compilationHash === compiled.compilationHash
              ? "UNCHANGED"
              : "CONFLICT"
        });
      }
      if (compiledClauses[0].status === "MANUAL_CLAUSE_REVIEW_REQUIRED") {
        manualReview.push(issue(closure, "MANUAL_CLAUSE_REVIEW_REQUIRED"));
      }
    }

    const settlement = closure.currentSettlementRevisionId
      ? settlementById.get(closure.currentSettlementRevisionId)
      : null;
    if (
      !settlement &&
      array(snapshot.settlements).some((item) => item.closureCaseId === closure.id)
    ) {
      manualReview.push(issue(closure, "MISSING_CURRENT_SETTLEMENT_POINTER"));
    }
    const closureBills = bills.filter(
      (bill) => bill.orderId === closure.orderId && !bill.deletedAt
    );
    if (
      settlement &&
      BigInt(String(settlement.amountDueCents ?? 0)) > 0n &&
      closureBills.length === 0
    ) {
      manualReview.push(issue(closure, "MISSING_RECEIVABLE_BILLS"));
    }
    const closureDispositions = dispositions.filter(
      (item) => item.closureCaseId === closure.id
    );
    const target = deriveFinancialStatus(
      settlement,
      closureBills,
      closureDispositions
    );
    financialUpdates.push({
      authorityFingerprint: financialAuthorityFingerprint(closureBills, closureDispositions),
      closureCaseId: closure.id,
      disposition: closure.financialStatus === target ? "UNCHANGED" : "UPDATE",
      expectedVersion: closure.version,
      from: closure.financialStatus,
      orderId: closure.orderId,
      to: target
    });
  }

  legacyEvidenceLinks.sort(bySourceKey);
  clauseSnapshots.sort((left, right) => clauseKey(left.contractId, left.clauseCode, left.clauseVersion).localeCompare(clauseKey(right.contractId, right.clauseCode, right.clauseVersion)));
  financialUpdates.sort((left, right) => left.closureCaseId.localeCompare(right.closureCaseId));
  fileAuthorityUpdates.sort((left, right) => left.fileId.localeCompare(right.fileId));
  manualReview.sort((left, right) => `${left.closureCaseId}:${left.code}`.localeCompare(`${right.closureCaseId}:${right.code}`));
  const quarantinedClosureIds = [...new Set(manualReview.map((item) => item.closureCaseId))].sort();
  const quarantinedClosureIdSet = new Set(quarantinedClosureIds);
  const quarantinedContractIds = [
    ...new Set(
      closures
        .filter((closure) => quarantinedClosureIdSet.has(closure.id))
        .map((closure) => closure.contractId)
        .filter((contractId) => typeof contractId === "string")
    )
  ].sort();
  return {
    clauseSnapshots,
    counters: {
      clauseCreates: clauseSnapshots.filter((item) => item.disposition === "CREATE").length,
      clauseConflicts: clauseSnapshots.filter((item) => item.disposition === "CONFLICT").length,
      financialUpdates: financialUpdates.filter((item) => item.disposition === "UPDATE").length,
      fileAuthorityUpdates: fileAuthorityUpdates.filter((item) => item.disposition === "UPDATE").length,
      legacyUrlCreates: legacyEvidenceLinks.filter((item) => item.disposition === "CREATE").length,
      manualReview: manualReview.length,
      scannedClosures: closures.filter((item) => item && !item.retiredAt).length
    },
    financialUpdates,
    fileAuthorityUpdates,
    legacyEvidenceLinks,
    manualReview,
    publicationValidationReady: !manualReview.some(
      (item) => item.code === "MISSING_SETTLEMENT_PUBLICATION_FACT"
    ),
    quarantinedClosureIds,
    quarantinedContractIds
  };
}

export function applicableStage1ReturnClassification(classification) {
  const quarantinedClosureIds = new Set(array(classification.quarantinedClosureIds));
  const quarantinedContractIds = new Set(array(classification.quarantinedContractIds));
  return {
    ...classification,
    clauseSnapshots: array(classification.clauseSnapshots).filter(
      (item) => !quarantinedContractIds.has(item.contractId)
    ),
    financialUpdates: array(classification.financialUpdates).filter(
      (item) => !quarantinedClosureIds.has(item.closureCaseId)
    ),
    fileAuthorityUpdates: array(classification.fileAuthorityUpdates).filter(
      (item) =>
        !quarantinedClosureIds.has(item.closureCaseId) &&
        !quarantinedContractIds.has(item.contractId)
    ),
    legacyEvidenceLinks: array(classification.legacyEvidenceLinks).filter(
      (item) => !quarantinedClosureIds.has(item.closureCaseId)
    )
  };
}

export async function executeStage1ReturnClosureBackfill({
  apply,
  generatedAt = new Date().toISOString(),
  load,
  mode
}) {
  if (!new Set(["dry-run", "apply"]).has(mode)) throw new Error("STAGE1_RETURN_CLOSURE_BACKFILL_MODE_INVALID");
  const snapshot = await load();
  const classification = classifyStage1ReturnClosureBackfill(snapshot);
  const unsafeToApply = classification.counters.clauseConflicts > 0;
  const blocked = unsafeToApply || classification.counters.manualReview > 0;
  let applied = null;
  if (mode === "apply" && !unsafeToApply) {
    applied = await apply(applicableStage1ReturnClassification(classification));
  }
  const reportClassification = {
    ...classification,
    legacyEvidenceLinks: classification.legacyEvidenceLinks.map((item) => ({
      ...item,
      legacyExternalReference: sanitizeLegacyUrl(item.legacyExternalReference)
    }))
  };
  return {
    exitCode: blocked ? 1 : 0,
    report: { applied, blocked, generatedAt, mode, ...reportClassification }
  };
}

export function financialAuthorityFingerprint(bills, dispositions) {
  return sha256(canonical({
    bills: array(bills)
      .map((bill) => ({
        deletedAt: bill.deletedAt ?? null,
        id: bill.id,
        orderId: bill.orderId,
        paidAmount: String(bill.paidAmount ?? 0),
        remainingAmount: String(bill.remainingAmount ?? 0)
      }))
      .sort(byId),
    dispositions: array(dispositions)
      .map((item) => ({
        billId: item.billId,
        closureCaseId: item.closureCaseId,
        createdAt: String(item.createdAt),
        disposition: item.disposition,
        id: item.id ?? null,
        supersedesDispositionId: item.supersedesDispositionId ?? null
      }))
      .sort((left, right) =>
        `${left.createdAt}:${left.id ?? ""}`.localeCompare(`${right.createdAt}:${right.id ?? ""}`)
      )
  }));
}

function compileHistoricalClauses(contract) {
  const root = record(contract.contractSnapshot);
  const order = record(root.order);
  const quote = record(root.quoteSnapshot);
  const monthly = integer(order.mileageLimitKm ?? quote.mileageLimitKm);
  const unitPriceCents = integer(order.overMileageFeeAmount ?? quote.overMileageFeeAmount);
  const periodMonths = positiveInteger(order.periodMonths ?? quote.periodMonths) ?? 1;
  const sourceText = typeof root.contentTemplate === "string" ? root.contentTemplate : "";
  const primaryClause =
    monthly !== null && unitPriceCents !== null && unitPriceCents > 0
      ? {
          chargeType: "OVER_MILEAGE",
          clauseCode: "OVER_MILEAGE",
          clauseVersion: 1,
          evidenceRequirementSnapshot: { required: ["DELIVERY_MILEAGE", "RETURN_MILEAGE"] },
          exemptionSnapshot: { normalWearApplies: false },
          pricingSnapshot: {
            includedQuantity: monthly * periodMonths,
            monthlyIncludedQuantity: monthly,
            periodMonths,
            unitPriceCents
          },
          sourceTextHash: sha256(sourceText),
          sourceTextLocator: "contractSnapshot.order.overMileageFeeAmount",
          status: "EXECUTABLE",
          unit: "KILOMETER"
        }
      : manualHistoricalClause("OVER_MILEAGE", sourceText);
  const clauses = [primaryClause];
  for (const itemCode of [
    "ACCESSORIES",
    "BATTERY",
    "CHARGING_EQUIPMENT",
    "KEY",
    "REGISTRATION_CERTIFICATE",
    "VEHICLE_EXTERIOR",
    "VEHICLE_INTERIOR"
  ]) {
    clauses.push(manualHistoricalClause(`MISSING_${itemCode}`, sourceText));
    clauses.push(manualHistoricalClause(`DAMAGE_${itemCode}`, sourceText));
  }
  return clauses.map((clause) => ({
    ...clause,
    compilationHash: sha256(canonical(clause))
  }));
}

function manualHistoricalClause(chargeType, sourceText) {
  return {
    chargeType,
    clauseCode: chargeType,
    clauseVersion: 1,
    evidenceRequirementSnapshot: { required: ["RETURN_ITEM_EVIDENCE"] },
    exemptionSnapshot: { manualReviewRequired: true },
    pricingSnapshot: {},
    sourceTextHash: sha256(sourceText),
    sourceTextLocator: "contractSnapshot",
    status: "MANUAL_CLAUSE_REVIEW_REQUIRED",
    unit: "ITEM"
  };
}

function deriveFinancialStatus(settlement, bills, dispositions) {
  if (!settlement || !new Set(["FINALIZED", "SETTLED"]).has(settlement.stage)) return "DRAFT";
  if (bills.length === 0) {
    return BigInt(String(settlement.amountDueCents ?? 0)) === 0n
      ? "SETTLED"
      : "AWAITING_CUSTOMER";
  }
  if (bills.every((bill) => BigInt(String(bill.remainingAmount ?? 0)) === 0n)) return "SETTLED";
  const latest = new Map();
  for (const item of [...dispositions].sort((left, right) => String(left.createdAt).localeCompare(String(right.createdAt)))) {
    latest.set(item.billId, item.disposition);
  }
  const values = [...latest.values()];
  if (values.includes("LEGAL_COLLECTION")) return "LEGAL_COLLECTION";
  if (values.includes("DISPUTED")) return "DISPUTED";
  if (values.includes("COLLECTION_PENDING") || values.includes("OPEN")) return "COLLECTION_PENDING";
  if (bills.some((bill) => BigInt(String(bill.paidAmount ?? 0)) > 0n)) return "PARTIALLY_PAID";
  return "AWAITING_CUSTOMER";
}

function issue(closure, code, metadata = {}) {
  return { closureCaseId: closure.id, code, orderId: closure.orderId, ...metadata };
}

function urls(value) {
  return Array.isArray(value)
    ? [...new Set(value.filter((item) => typeof item === "string" && /^https?:\/\//i.test(item)))]
    : [];
}

function sanitizeLegacyUrl(value) {
  try {
    const url = new URL(value);
    url.username = "";
    url.password = "";
    url.search = "";
    url.hash = "";
    return url.toString();
  } catch {
    return value;
  }
}

function clauseKey(contractId, code, version) {
  return `${contractId}:${code}:${version}`;
}

function integer(value) {
  if (typeof value === "string" && /^(?:0|[1-9]\d*)$/.test(value)) value = Number(value);
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 0 ? value : null;
}

function positiveInteger(value) {
  const parsed = integer(value);
  return parsed !== null && parsed > 0 ? parsed : null;
}

function validTimestamp(value) {
  const date = value instanceof Date ? value : typeof value === "string" ? new Date(value) : null;
  return Boolean(date && !Number.isNaN(date.getTime()));
}

function validSha256(value) {
  return typeof value === "string" && /^[a-f0-9]{64}$/i.test(value);
}

function canonical(value) {
  if (Array.isArray(value)) return `[${value.map(canonical).join(",")}]`;
  if (value && typeof value === "object") return `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${canonical(value[key])}`).join(",")}}`;
  return JSON.stringify(value);
}

function sha256(value) {
  return createHash("sha256").update(value).digest("hex");
}

function record(value) {
  return value && typeof value === "object" && !Array.isArray(value) ? value : {};
}

function array(value) {
  return Array.isArray(value) ? value : [];
}

function byId(left, right) {
  return String(left?.id ?? "").localeCompare(String(right?.id ?? ""));
}

function bySourceKey(left, right) {
  return left.sourceKey.localeCompare(right.sourceKey);
}

function invalid() {
  throw new Error("STAGE1_RETURN_CLOSURE_BACKFILL_ARGUMENTS_INVALID");
}
