const SHA256_PATTERN = /^[0-9a-f]{64}$/;
const TERMINAL_WORK_ORDER_STATUSES = new Set(["CANCELLED", "FAILED", "VOIDED"]);
const TERMINAL_HANDOVER_STATUSES = new Set(["ARCHIVED", "CANCELLED", "FAILED"]);
const TERMINAL_TASK_STATUSES = new Set(["CANCELLED", "EXPIRED", "FAILED"]);

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
    if (
      workflow.candidate &&
      !existingIdempotencyKeys(record).has(workflow.candidate.idempotencyKey)
    ) {
      jobCandidates.push(workflow.candidate);
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

  const handover = record.handover;
  if (!handover || !record.handoverId || handover.id !== record.handoverId || handover.deletedAt) {
    return workflowException(record, "STAGE2_HANDOVER_BINDING_INVALID");
  }

  const typedTask = readTypedTask(handover);
  if (typedTask.invalid) {
    return workflowException(record, "STAGE2_TASK_BINDING_INVALID");
  }
  if (typedTask.task) {
    const signerJob = planSignerJob(record, handover, typedTask.task);
    return signerJob ?? noWorkflowChange();
  }

  const source = readReadySource(handover);
  if (source) {
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

  const confirmedReview = readConfirmedReview(record);
  if (!confirmedReview) {
    return noWorkflowChange();
  }
  return {
    candidate: {
      eSignTaskId: null,
      handoverId: handover.id,
      idempotencyKey: `pdf:${record.id}:${confirmedReview.id}:${confirmedReview.manifestHash}`,
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

function planSignerJob(record, handover, task) {
  if (TERMINAL_TASK_STATUSES.has(task.taskStatus)) {
    return noWorkflowChange();
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
    const artifactVersion = positiveInteger(handover.artifactVersion);
    if (!artifactVersion) {
      return workflowException(record, "STAGE2_ARTIFACT_VERSION_INVALID");
    }
    return {
      candidate: {
        eSignTaskId: task.id,
        handoverId: handover.id,
        idempotencyKey: `archive:${task.id}:${artifactVersion}`,
        jobType: "ARCHIVE_SIGNED_PDF",
        payload: { artifactVersion },
        workOrderId: record.id
      },
      exception: null
    };
  }

  if (customerSigner.signerStatus === "SIGNED") {
    const jobType =
      platformSigner.signerStatus === "SIGNING"
        ? "RECONCILE_PLATFORM_SEAL"
        : platformSigner.signerStatus === "PENDING"
          ? "AUTO_SEAL_PLATFORM"
          : null;
    if (!jobType) {
      return noWorkflowChange();
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

  return noWorkflowChange();
}

function readTypedTask(handover) {
  const task = handover.handoverESignTask;
  if (!handover.handoverESignTaskId && !task) {
    return { invalid: false, task: null };
  }
  if (
    !task ||
    handover.handoverESignTaskId !== task.id ||
    task.deletedAt ||
    task.signingStage !== "STAGE2_DELIVERY_HANDOVER" ||
    task.documentType !== "DELIVERY_HANDOVER"
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

function readReadySource(handover) {
  const artifactVersion = positiveInteger(handover.artifactVersion);
  const manifestHash = normalizeDigest(handover.manifestHash);
  const sourcePdfHash = normalizeDigest(handover.sourcePdfHash);
  if (
    !artifactVersion ||
    !manifestHash ||
    !sourcePdfHash ||
    !nonEmptyString(handover.sourceDocumentFileId)
  ) {
    return null;
  }
  return {
    artifactVersion,
    manifestHash,
    sourcePdfHash
  };
}

function readConfirmedReview(record) {
  const review = record.latestReview;
  const manifestHash = normalizeDigest(review?.evidenceSnapshot?.evidencePackage?.manifestHash);
  if (
    !record.customerConfirmedAt ||
    review?.status !== "CUSTOMER_CONFIRMED" ||
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

function existingIdempotencyKeys(record) {
  return new Set(
    (record.workflowJobs ?? []).map((job) => job?.idempotencyKey).filter(nonEmptyString)
  );
}

function normalizeName(value) {
  if (typeof value !== "string") {
    return null;
  }
  const normalized = value.trim().replace(/\s+/g, " ");
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

function normalizeDigest(value) {
  if (typeof value !== "string") {
    return null;
  }
  const normalized = value
    .trim()
    .toLowerCase()
    .replace(/^sha256:/, "");
  return SHA256_PATTERN.test(normalized) ? normalized : null;
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
