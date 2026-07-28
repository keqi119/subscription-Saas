import {
  STAGE2_HANDOVER_PDF_HARD_MAX_BYTES,
  STAGE2_HANDOVER_SOURCE_ARTIFACT_VERSION,
  buildCanonicalStage2PdfJobKey,
  canonicalStage2Sha256,
  stage2BackfillJobMatchesCandidate,
  stage2Sha256Digest
} from "./stage2-handover-workflow-contract.mjs";

const TERMINAL_WORK_ORDER_STATUSES = new Set(["CANCELLED", "FAILED", "VOIDED"]);
const TERMINAL_HANDOVER_STATUSES = new Set(["ARCHIVED", "CANCELLED", "FAILED"]);
const TERMINAL_TASK_STATUSES = new Set(["CANCELLED", "EXPIRED", "FAILED"]);
const CUSTOMER_TASK_WORK_ORDER_STATUSES = new Set(["CUSTOMER_CONFIRMED", "SIGNING"]);
const PLATFORM_TASK_WORK_ORDER_STATUSES =
  new Set(["CUSTOMER_CONFIRMED", "SIGNING", "CUSTOMER_SIGNED"]);
const ARCHIVE_TASK_WORK_ORDER_STATUSES =
  new Set(["CUSTOMER_CONFIRMED", "SIGNING", "CUSTOMER_SIGNED", "PLATFORM_SEALED"]);

export function parseStage2HandoverWorkflowBackfillMode(args) {
  if (args.length !== 1 || (args[0] !== "--dry-run" && args[0] !== "--apply")) {
    throw new Error("Specify exactly one of --dry-run or --apply.");
  }
  return args[0] === "--apply" ? "apply" : "dry-run";
}

export function buildStage2HandoverWorkflowBackfillPlan(records) {
  const operatorSnapshotUpdates = [];
  const exceptions = [];
  const jobCandidates = [];

  for (const record of records) {
    const operator = planOperatorSnapshot(record);
    if (operator.update) {
      operatorSnapshotUpdates.push(operator.update);
    }
    if (operator.exception) {
      exceptions.push(operator.exception);
    }

    const workflow = planNextWorkflowJob(record, {
      operatorReady: operator.ready
    });
    if (workflow.exception) {
      exceptions.push(workflow.exception);
    }
    if (workflow.candidate) {
      const existing = findExistingWorkflowJob(
        record,
        workflow.candidate.idempotencyKey
      );
      if (!existing) {
        jobCandidates.push(workflow.candidate);
      } else if (
        !stage2BackfillJobMatchesCandidate(existing, workflow.candidate)
      ) {
        exceptions.push({
          code: "STAGE2_WORKFLOW_JOB_CONFLICT",
          sourceId: nonEmptyString(existing.id) ? existing.id : record.id,
          workOrderId: record.id
        });
      }
    }
  }

  return {
    exceptions,
    jobCandidates,
    operatorSnapshotUpdates,
    recordCount: records.length
  };
}

function planOperatorSnapshot(record) {
  if (record.operatorType === "INTERNAL") {
    if (!record.assignedInternalUserId) {
      return {
        exception: {
          code: "INTERNAL_OPERATOR_NOT_ASSIGNED",
          sourceId: record.id,
          workOrderId: record.id
        },
        ready: false,
        update: null
      };
    }
    const user = record.assignedInternalUser;
    const name = normalizeName(user?.name);
    const phone = normalizeChinaMobile(user?.mobile);
    if (!user || user.id !== record.assignedInternalUserId || user.deletedAt) {
      return {
        exception: {
          code: "INTERNAL_OPERATOR_NOT_FOUND",
          sourceId: record.assignedInternalUserId,
          workOrderId: record.id
        },
        ready: false,
        update: null
      };
    }
    if (!phone) {
      return {
        exception: {
          code: "INTERNAL_OPERATOR_MOBILE_INVALID",
          sourceId: user.id,
          workOrderId: record.id
        },
        ready: false,
        update: null
      };
    }
    if (!name) {
      return {
        exception: {
          code: "INTERNAL_OPERATOR_NAME_INVALID",
          sourceId: user.id,
          workOrderId: record.id
        },
        ready: false,
        update: null
      };
    }
    return canonicalOperatorPlan(record, {
      name,
      operatorType: "INTERNAL",
      phone,
      sourceId: user.id
    });
  }

  if (record.operatorType === "EXTERNAL") {
    const name = normalizeName(record.externalOperatorName);
    const phone = normalizeChinaMobile(record.externalOperatorPhone);
    if (!name || !phone) {
      return {
        exception: {
          code: "EXTERNAL_OPERATOR_SNAPSHOT_INVALID",
          sourceId: record.id,
          workOrderId: record.id
        },
        ready: false,
        update: null
      };
    }
    return canonicalOperatorPlan(record, {
      name,
      operatorType: "EXTERNAL",
      phone,
      sourceId: record.id
    });
  }

  return {
    exception: {
      code: "OPERATOR_TYPE_INVALID",
      sourceId: record.id,
      workOrderId: record.id
    },
    ready: false,
    update: null
  };
}

function canonicalOperatorPlan(record, { name, operatorType, phone, sourceId }) {
  const unchanged = record.fieldOperatorName === name && record.fieldOperatorPhone === phone;
  return {
    exception: null,
    ready: true,
    update: unchanged
      ? null
      : {
          expectedFieldOperatorName: record.fieldOperatorName ?? null,
          expectedFieldOperatorPhone: record.fieldOperatorPhone ?? null,
          fieldOperatorName: name,
          fieldOperatorPhone: phone,
          operatorType,
          sourceId,
          workOrderId: record.id
        }
  };
}

function planNextWorkflowJob(record, { operatorReady }) {
  if (isTerminal(record)) {
    return noWorkflowChange();
  }

  if (record.handoverType !== "DELIVERY_OUTBOUND") {
    return workflowException(record, "STAGE2_HANDOVER_TYPE_INVALID");
  }

  const handover = record.handover;
  if (
    !handover ||
    !record.handoverId ||
    handover.id !== record.handoverId ||
    handover.orderId !== record.orderId ||
    record.order?.id !== record.orderId ||
    handover.deletedAt
  ) {
    return workflowException(record, "STAGE2_HANDOVER_BINDING_INVALID");
  }

  const confirmedReview = readConfirmedReview(record);
  if (!confirmedReview) {
    return workflowException(record, "STAGE2_REVIEW_BINDING_INVALID");
  }

  const sourceState = readReadySource(record, handover, confirmedReview);
  if (sourceState.invalid) {
    return workflowException(record, "STAGE2_SOURCE_BINDING_INVALID");
  }
  const source = sourceState.source;
  const typedTask = readTypedTask(record, handover, source);
  if (typedTask.invalid) {
    return workflowException(record, "STAGE2_TASK_BINDING_INVALID");
  }
  if (typedTask.task) {
    if (!source) {
      return workflowException(record, "STAGE2_SOURCE_BINDING_INVALID");
    }
    const signerJob = planSignerJob(
      record,
      handover,
      source,
      typedTask.task
    );
    return signerJob ?? noWorkflowChange();
  }

  if (handover.status === "SOURCE_GENERATED") {
    if (
      !source ||
      record.status !== "CUSTOMER_CONFIRMED" ||
      source.contractStatus !== "GENERATED"
    ) {
      return workflowException(record, "STAGE2_SOURCE_BINDING_INVALID");
    }
    if (!operatorReady) {
      return noWorkflowChange();
    }
    return {
      candidate: {
        eSignTaskId: null,
        handoverId: handover.id,
        idempotencyKey: `field-notify:${record.id}:${source.artifactVersion}`,
        jobType: "NOTIFY_FIELD_ESIGN_READY",
        payload: {
          artifactVersion: source.artifactVersion,
          manifestHash: source.manifestHash,
          sourcePdfHash: source.sourcePdfHash
        },
        workOrderId: record.id
      },
      exception: null
    };
  }

  if (
    handover.status !== "DRAFT" ||
    record.status !== "CUSTOMER_CONFIRMED" ||
    source
  ) {
    return workflowException(record, "STAGE2_WORKFLOW_STATE_INVALID");
  }
  const idempotencyKey = buildCanonicalStage2PdfJobKey({
    manifestHash: confirmedReview.manifestHash,
    reviewAttemptId: confirmedReview.id,
    workOrderId: record.id
  });
  if (!idempotencyKey) {
    return workflowException(record, "STAGE2_REVIEW_BINDING_INVALID");
  }
  return {
    candidate: {
      eSignTaskId: null,
      handoverId: handover.id,
      idempotencyKey,
      jobType: "GENERATE_SOURCE_PDF",
      payload: {
        manifestHash: confirmedReview.manifestHash,
        reviewAttemptId: confirmedReview.id
      },
      workOrderId: record.id
    },
    exception: null
  };
}

function planSignerJob(record, handover, source, task) {
  if (TERMINAL_TASK_STATUSES.has(task.taskStatus)) {
    return workflowException(record, "STAGE2_TASK_NOT_ACTIVE");
  }

  const signers = readTypedSigners(task);
  if (!signers) {
    return workflowException(record, "STAGE2_SIGNER_BINDING_INVALID");
  }
  const { customerSigner, customerTransactionId, platformSigner, platformTransactionId } = signers;
  if (customerSigner.providerTransactionId !== customerTransactionId) {
    return workflowException(record, "STAGE2_CUSTOMER_TRANSACTION_INVALID");
  }
  if (
    (platformSigner.providerTransactionId &&
      platformSigner.providerTransactionId !== platformTransactionId) ||
    (["SIGNED", "SIGNING"].includes(platformSigner.signerStatus) &&
      platformSigner.providerTransactionId !== platformTransactionId)
  ) {
    return workflowException(record, "STAGE2_PLATFORM_TRANSACTION_INVALID");
  }

  if (customerSigner.signerStatus === "SIGNED" && platformSigner.signerStatus === "SIGNED") {
    if (
      !ARCHIVE_TASK_WORK_ORDER_STATUSES.has(record.status) ||
      handover.status !== "SIGNED" ||
      source.contractStatus !== "SIGNED" ||
      task.taskStatus !== "COMPLETED"
    ) {
      return workflowException(record, "STAGE2_WORKFLOW_STATE_INVALID");
    }
    return {
      candidate: {
        eSignTaskId: task.id,
        handoverId: handover.id,
        idempotencyKey: `archive:${task.id}:${source.artifactVersion}`,
        jobType: "ARCHIVE_SIGNED_PDF",
        payload: { artifactVersion: source.artifactVersion },
        workOrderId: record.id
      },
      exception: null
    };
  }

  if (customerSigner.signerStatus === "SIGNED") {
    if (
      !PLATFORM_TASK_WORK_ORDER_STATUSES.has(record.status) ||
      handover.status !== "PENDING_PLATFORM_SEAL" ||
      source.contractStatus !== "SIGNING" ||
      task.taskStatus !== "SIGNING"
    ) {
      return workflowException(record, "STAGE2_WORKFLOW_STATE_INVALID");
    }
    const jobType =
      platformSigner.signerStatus === "SIGNING"
        ? "RECONCILE_PLATFORM_SEAL"
        : platformSigner.signerStatus === "PENDING"
          ? "AUTO_SEAL_PLATFORM"
          : null;
    if (!jobType) {
      return workflowException(record, "STAGE2_WORKFLOW_STATE_INVALID");
    }
    const keyPrefix = jobType === "AUTO_SEAL_PLATFORM" ? "platform-seal" : "platform-reconcile";
    return {
      candidate: {
        eSignTaskId: task.id,
        handoverId: handover.id,
        idempotencyKey: `${keyPrefix}:${task.id}:${platformTransactionId}`,
        jobType,
        payload: { platformTransactionId },
        workOrderId: record.id
      },
      exception: null
    };
  }

  if (
    ["PENDING", "SIGNING"].includes(customerSigner.signerStatus) &&
    customerSigner.providerTransactionId === customerTransactionId
  ) {
    if (
      !CUSTOMER_TASK_WORK_ORDER_STATUSES.has(record.status) ||
      handover.status !== "PENDING_CUSTOMER_SIGNATURE" ||
      source.contractStatus !== "SIGNING" ||
      !["WAITING_CUSTOMER", "SIGNING"].includes(task.taskStatus) ||
      platformSigner.signerStatus !== "PENDING" ||
      platformSigner.providerTransactionId
    ) {
      return workflowException(record, "STAGE2_WORKFLOW_STATE_INVALID");
    }
    return {
      candidate: {
        eSignTaskId: task.id,
        handoverId: handover.id,
        idempotencyKey: `customer-reconcile:${task.id}:${customerTransactionId}`,
        jobType: "RECONCILE_CUSTOMER_SIGNATURE",
        payload: { customerTransactionId },
        workOrderId: record.id
      },
      exception: null
    };
  }

  return workflowException(record, "STAGE2_WORKFLOW_STATE_INVALID");
}

function readTypedTask(record, handover, source) {
  const task = handover.handoverESignTask;
  if (!handover.handoverESignTaskId && !task) {
    return { invalid: false, task: null };
  }
  const snapshot = asRecord(task?.requestSnapshot);
  const slotIds = snapshot?.slotIds;
  if (
    !source ||
    !task ||
    handover.handoverESignTaskId !== task.id ||
    task.deletedAt ||
    task.signingStage !== "STAGE2_DELIVERY_HANDOVER" ||
    task.documentType !== "DELIVERY_HANDOVER" ||
    task.orderId !== record.orderId ||
    task.customerId !== record.order?.customerId ||
    task.contractId !== source.contractId ||
    snapshot?.artifactVersion !== source.artifactVersion ||
    snapshot?.contractId !== source.contractId ||
    snapshot?.documentType !== "DELIVERY_HANDOVER" ||
    snapshot?.handoverId !== handover.id ||
    snapshot?.manifestHash !== source.manifestDigest ||
    snapshot?.signingStage !== "STAGE2_DELIVERY_HANDOVER" ||
    snapshot?.sourceDocumentFileId !== source.fileId ||
    snapshot?.sourcePdfHash !== source.sourcePdfHash ||
    !Array.isArray(slotIds) ||
    slotIds.length !== 2 ||
    !slotIds.includes("STAGE2_HANDOVER_CUSTOMER") ||
    !slotIds.includes("STAGE2_HANDOVER_PLATFORM")
  ) {
    return { invalid: true, task: null };
  }
  return { invalid: false, task };
}

function readTypedSigners(task) {
  if (!Array.isArray(task.signers) || task.signers.length !== 2) {
    return null;
  }
  const customer = task.signers.filter((signer) =>
    signerMatches(signer, "STAGE2_HANDOVER_CUSTOMER", "CUSTOMER", "CUSTOMER_MANUAL_SIGN")
  );
  const platform = task.signers.filter((signer) =>
    signerMatches(signer, "STAGE2_HANDOVER_PLATFORM", "PLATFORM", "PLATFORM_AUTO_SEAL")
  );
  if (customer.length !== 1 || platform.length !== 1) {
    return null;
  }
  if (
    customer[0].customerId !== task.customerId ||
    (platform[0].customerId ?? null) !== null
  ) {
    return null;
  }
  const customerTransactionId = buildProviderTransactionId(task.taskNo, "H1");
  const platformTransactionId = buildProviderTransactionId(task.taskNo, "H2");
  if (!customerTransactionId || !platformTransactionId) {
    return null;
  }
  return {
    customerSigner: customer[0],
    customerTransactionId,
    platformSigner: platform[0],
    platformTransactionId
  };
}

function signerMatches(signer, slotId, signerType, providerActionType) {
  return (
    !signer.deletedAt &&
    signer.documentType === "DELIVERY_HANDOVER" &&
    signer.providerActionType === providerActionType &&
    signer.required === true &&
    signer.signerType === signerType &&
    signer.slotId === slotId
  );
}

function readReadySource(record, handover, confirmedReview) {
  if (!hasSourceState(handover)) {
    return {
      invalid: false,
      source: null
    };
  }

  const artifactVersion = positiveInteger(handover.artifactVersion);
  const manifestDigest = stage2Sha256Digest(handover.manifestHash);
  const sourcePdfHash = stage2Sha256Digest(handover.sourcePdfHash);
  const contract = asRecord(handover.handoverContract);
  const contractSnapshot = asRecord(contract?.contractSnapshot);
  const evidencePackage = asRecord(contractSnapshot?.evidencePackage);
  const artifact = asRecord(contractSnapshot?.stage2HandoverPdfArtifact);
  const fileObject = asRecord(handover.sourceFileObject);
  const fileSize = Number(fileObject?.sizeBytes);
  if (
    artifactVersion !== STAGE2_HANDOVER_SOURCE_ARTIFACT_VERSION ||
    !manifestDigest ||
    canonicalStage2Sha256(manifestDigest) !== confirmedReview.manifestHash ||
    !sourcePdfHash ||
    !nonEmptyString(handover.handoverContractId) ||
    !nonEmptyString(handover.sourceDocumentFileId) ||
    !nonEmptyString(handover.sourceObjectKey) ||
    !contract ||
    contract.id !== handover.handoverContractId ||
    contract.deletedAt ||
    contract.orderId !== record.orderId ||
    contract.customerId !== record.order?.customerId ||
    contract.fileId !== handover.sourceDocumentFileId ||
    !["GENERATED", "SIGNING", "SIGNED"].includes(contract.status) ||
    contractSnapshot?.workOrderId !== record.id ||
    contractSnapshot?.handoverId !== handover.id ||
    contractSnapshot?.orderId !== record.orderId ||
    contractSnapshot?.fileId !== handover.sourceDocumentFileId ||
    canonicalStage2Sha256(evidencePackage?.manifestHash) !==
      confirmedReview.manifestHash ||
    artifact?.artifactVersion !== artifactVersion ||
    artifact?.fileId !== handover.sourceDocumentFileId ||
    stage2Sha256Digest(artifact?.sourcePdfHash) !== sourcePdfHash ||
    fileObject?.id !== handover.sourceDocumentFileId ||
    !nonEmptyString(fileObject.bucket) ||
    fileObject.objectKey !== handover.sourceObjectKey ||
    fileObject.mimeType?.trim().toLowerCase() !== "application/pdf" ||
    !Number.isSafeInteger(fileSize) ||
    fileSize <= 0 ||
    fileSize > STAGE2_HANDOVER_PDF_HARD_MAX_BYTES
  ) {
    return {
      invalid: true,
      source: null
    };
  }
  return {
    invalid: false,
    source: {
      artifactVersion,
      contractId: contract.id,
      contractStatus: contract.status,
      fileId: handover.sourceDocumentFileId,
      manifestDigest,
      manifestHash: confirmedReview.manifestHash,
      sourcePdfHash
    }
  };
}

function readConfirmedReview(record) {
  const review = record.latestReview;
  const manifestHash = canonicalStage2Sha256(
    review?.evidenceSnapshot?.evidencePackage?.manifestHash
  );
  if (
    record.status === "CUSTOMER_OBJECTED" ||
    !record.customerConfirmedAt ||
    record.customerObjectedAt ||
    review?.status !== "CUSTOMER_CONFIRMED" ||
    review?.workOrderId !== record.id ||
    review?.orderId !== record.orderId ||
    review?.handoverId !== record.handoverId ||
    !sameTimestamp(review?.customerConfirmedAt, record.customerConfirmedAt) ||
    !nonEmptyString(review.id) ||
    !manifestHash
  ) {
    return null;
  }
  return {
    id: review.id.trim(),
    manifestHash
  };
}

function isTerminal(record) {
  const handover = record.handover;
  return (
    TERMINAL_WORK_ORDER_STATUSES.has(record.status) ||
    TERMINAL_HANDOVER_STATUSES.has(handover?.status) ||
    handover?.archiveStatus === "ARCHIVED" ||
    Boolean(handover?.archivedAt)
  );
}

function findExistingWorkflowJob(record, idempotencyKey) {
  return (
    (record.workflowJobs ?? []).find(
      (job) => job?.idempotencyKey === idempotencyKey
    ) ?? null
  );
}

function normalizeName(value) {
  if (typeof value !== "string") {
    return null;
  }
  const normalized = value.trim();
  return normalized && normalized.length <= 64 ? normalized : null;
}

function normalizeChinaMobile(value) {
  if (typeof value !== "string") {
    return null;
  }
  let normalized = stripWrappingQuotes(value).replace(/[\s-]/g, "");
  if (normalized.startsWith("+86") && normalized.length === 14) {
    normalized = normalized.slice(3);
  } else if (normalized.startsWith("0086") && normalized.length === 15) {
    normalized = normalized.slice(4);
  } else if (normalized.startsWith("86") && normalized.length === 13) {
    normalized = normalized.slice(2);
  }
  return /^1[3-9]\d{9}$/.test(normalized) ? normalized : null;
}

function stripWrappingQuotes(value) {
  const trimmed = value.trim();
  for (const quote of ['"', "'"]) {
    if (trimmed.startsWith(quote) && trimmed.endsWith(quote)) {
      return trimmed.slice(1, -1).trim();
    }
  }
  return trimmed;
}

function buildProviderTransactionId(taskNo, suffix) {
  if (typeof taskNo !== "string") {
    return null;
  }
  const normalized = taskNo.replace(/[^A-Za-z0-9]/g, "");
  return normalized ? `${normalized.slice(0, 32 - suffix.length)}${suffix}` : null;
}

function positiveInteger(value) {
  return Number.isSafeInteger(value) && value > 0 ? value : null;
}

function nonEmptyString(value) {
  return typeof value === "string" && Boolean(value.trim());
}

function hasSourceState(handover) {
  return Boolean(
    handover.status === "SOURCE_GENERATED" ||
    handover.handoverContractId ||
    handover.sourceDocumentFileId ||
    handover.sourceObjectKey ||
    handover.sourcePdfHash ||
    handover.manifestHash
  );
}

function sameTimestamp(left, right) {
  const leftTime = new Date(left).getTime();
  const rightTime = new Date(right).getTime();
  return (
    Number.isFinite(leftTime) &&
    Number.isFinite(rightTime) &&
    leftTime === rightTime
  );
}

function asRecord(value) {
  return value && typeof value === "object" && !Array.isArray(value)
    ? value
    : null;
}

function noWorkflowChange() {
  return { candidate: null, exception: null };
}

function workflowException(record, code) {
  return {
    candidate: null,
    exception: {
      code,
      sourceId: record.handoverId ?? record.id,
      workOrderId: record.id
    }
  };
}
