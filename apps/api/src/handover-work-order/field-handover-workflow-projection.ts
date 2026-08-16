export type FieldHandoverDisplayStatus =
  | "HANDOVER_PDF_GENERATING"
  | "ESIGN_INITIATION_PENDING"
  | "CUSTOMER_SIGNATURE_PENDING"
  | "PLATFORM_SEAL_PENDING"
  | "ARCHIVE_PENDING"
  | "ARCHIVE_FAILED"
  | "COMPLETED"
  | "CANCELLED"
  | "VOIDED"
  | "FAILED"
  | "INCONSISTENT"
  | "FIELD_WORK_PENDING"
  | "CUSTOMER_REVIEW_PENDING";

export interface FieldHandoverWorkflowSignerFacts {
  signedAt: Date | null;
  signerStatus: string;
  slotId: string;
}

export interface FieldHandoverWorkflowTaskFacts {
  signers: FieldHandoverWorkflowSignerFacts[];
  taskStatus: string;
}

export interface FieldHandoverWorkflowHandoverFacts {
  archiveStatus: string;
  archivedAt: Date | null;
  signedDocumentFileId: string | null;
  signedPdfHash: string | null;
  sourceDocumentFileId: string | null;
  status: string;
  updatedAt: Date | null;
}

export interface FieldHandoverWorkflowFacts {
  handover: FieldHandoverWorkflowHandoverFacts | null;
  task: FieldHandoverWorkflowTaskFacts | null;
  workOrderStatus: string;
}

export interface FieldHandoverWorkflowProjection {
  completedAt: string | null;
  displayStatus: FieldHandoverDisplayStatus;
  displayStatusLabel: string;
  taskGroup: "ACTIVE" | "ENDED";
}

const TERMINAL_WORK_ORDER_STATUSES = new Map<
  string,
  Pick<FieldHandoverWorkflowProjection, "displayStatus" | "displayStatusLabel">
>([
  ["CANCELLED", { displayStatus: "CANCELLED", displayStatusLabel: "已取消" }],
  ["VOIDED", { displayStatus: "VOIDED", displayStatusLabel: "已作废" }],
  ["FAILED", { displayStatus: "FAILED", displayStatusLabel: "处理失败" }]
]);

const CUSTOMER_REVIEW_STATUSES = new Set([
  "CUSTOMER_OBJECTED",
  "CUSTOMER_REVIEWING",
  "EVIDENCE_SUBMITTED"
]);

const READY_FOR_STAGE2_STATUSES = new Set([
  "CUSTOMER_CONFIRMED",
  "CUSTOMER_SIGNED",
  "FIELD_COMPLETED",
  "OPS_REVIEW_PENDING",
  "OPS_REVIEWED",
  "PLATFORM_SEALED",
  "SIGNING"
]);

export function projectFieldHandoverWorkflow(
  input: FieldHandoverWorkflowFacts
): FieldHandoverWorkflowProjection {
  const terminalWorkOrder = TERMINAL_WORK_ORDER_STATUSES.get(
    input.workOrderStatus
  );
  if (terminalWorkOrder) {
    return ended(terminalWorkOrder.displayStatus, terminalWorkOrder.displayStatusLabel);
  }

  const handover = input.handover;
  if (!handover) {
    if (READY_FOR_STAGE2_STATUSES.has(input.workOrderStatus)) {
      return active("HANDOVER_PDF_GENERATING", "交接单生成中");
    }
    return projectRawWorkOrder(input.workOrderStatus);
  }

  if (handover.status === "CANCELLED") {
    return ended("CANCELLED", "已取消", handover.updatedAt);
  }
  if (handover.status === "FAILED") {
    return ended("FAILED", "处理失败", handover.updatedAt);
  }

  const customerSigner = findSigner(input.task, "STAGE2_HANDOVER_CUSTOMER");
  const platformSigner = findSigner(input.task, "STAGE2_HANDOVER_PLATFORM");
  const customerSigned = isSigned(customerSigner);
  const platformSigned = isSigned(platformSigner);
  const taskCompleted = input.task?.taskStatus === "COMPLETED";
  const fullSignatureFacts = taskCompleted && customerSigned && platformSigned;

  if (handover.status === "ARCHIVED" || handover.archiveStatus === "ARCHIVED") {
    if (
      handover.status === "ARCHIVED" &&
      handover.archiveStatus === "ARCHIVED" &&
      handover.archivedAt &&
      handover.signedDocumentFileId &&
      handover.signedPdfHash &&
      fullSignatureFacts
    ) {
      return ended("COMPLETED", "已完成", handover.archivedAt);
    }
    return inconsistent();
  }

  if (handover.archiveStatus === "FAILED") {
    return fullSignatureFacts
      ? active("ARCHIVE_FAILED", "归档异常")
      : inconsistent();
  }

  if (handover.status === "SIGNED") {
    return fullSignatureFacts
      ? active("ARCHIVE_PENDING", "签署完成，归档中")
      : inconsistent();
  }

  if (handover.status === "PENDING_PLATFORM_SEAL") {
    return customerSigned
      ? active("PLATFORM_SEAL_PENDING", "平台盖章中")
      : inconsistent();
  }

  if (handover.status === "PENDING_CUSTOMER_SIGNATURE") {
    return customerSigned
      ? inconsistent()
      : active("CUSTOMER_SIGNATURE_PENDING", "待客户签署");
  }

  if (handover.status === "SOURCE_GENERATED") {
    if (!handover.sourceDocumentFileId) {
      return inconsistent();
    }
    if (!input.task) {
      return active("ESIGN_INITIATION_PENDING", "待发起签署");
    }
    if (fullSignatureFacts) {
      return active("ARCHIVE_PENDING", "签署完成，归档中");
    }
    if (customerSigned) {
      return active("PLATFORM_SEAL_PENDING", "平台盖章中");
    }
    if (["CREATED", "SIGNING", "WAITING_CUSTOMER"].includes(input.task.taskStatus)) {
      return active("CUSTOMER_SIGNATURE_PENDING", "待客户签署");
    }
    return inconsistent();
  }

  if (handover.status === "DRAFT") {
    if (handover.sourceDocumentFileId || input.task) {
      return inconsistent();
    }
    return READY_FOR_STAGE2_STATUSES.has(input.workOrderStatus)
      ? active("HANDOVER_PDF_GENERATING", "交接单生成中")
      : projectRawWorkOrder(input.workOrderStatus);
  }

  return inconsistent();
}

export function getFieldHandoverDisplayPriority(
  status: FieldHandoverDisplayStatus
) {
  const priorities: Record<FieldHandoverDisplayStatus, number> = {
    FIELD_WORK_PENDING: 0,
    CUSTOMER_REVIEW_PENDING: 1,
    HANDOVER_PDF_GENERATING: 2,
    ESIGN_INITIATION_PENDING: 3,
    CUSTOMER_SIGNATURE_PENDING: 4,
    PLATFORM_SEAL_PENDING: 5,
    ARCHIVE_PENDING: 5,
    ARCHIVE_FAILED: 6,
    INCONSISTENT: 6,
    COMPLETED: 7,
    CANCELLED: 7,
    VOIDED: 7,
    FAILED: 7
  };
  return priorities[status];
}

function projectRawWorkOrder(status: string): FieldHandoverWorkflowProjection {
  if (CUSTOMER_REVIEW_STATUSES.has(status)) {
    return active("CUSTOMER_REVIEW_PENDING", rawWorkOrderLabel(status));
  }
  return active("FIELD_WORK_PENDING", rawWorkOrderLabel(status));
}

function rawWorkOrderLabel(status: string) {
  const labels: Record<string, string> = {
    ASSIGNED: "已分配",
    CUSTOMER_OBJECTED: "客户有异议",
    CUSTOMER_REVIEWING: "客户复核中",
    DRAFT: "草稿",
    EVIDENCE_SUBMITTED: "资料已提交",
    FIELD_IN_PROGRESS: "现场处理中"
  };
  return labels[status] ?? "待现场处理";
}

function findSigner(task: FieldHandoverWorkflowTaskFacts | null, slotId: string) {
  return task?.signers?.find((signer) => signer.slotId === slotId) ?? null;
}

function isSigned(signer: FieldHandoverWorkflowSignerFacts | null) {
  return signer?.signerStatus === "SIGNED" && signer.signedAt instanceof Date;
}

function active(
  displayStatus: FieldHandoverDisplayStatus,
  displayStatusLabel: string
): FieldHandoverWorkflowProjection {
  return {
    completedAt: null,
    displayStatus,
    displayStatusLabel,
    taskGroup: "ACTIVE"
  };
}

function ended(
  displayStatus: FieldHandoverDisplayStatus,
  displayStatusLabel: string,
  completedAt: Date | null = null
): FieldHandoverWorkflowProjection {
  return {
    completedAt: completedAt?.toISOString() ?? null,
    displayStatus,
    displayStatusLabel,
    taskGroup: "ENDED"
  };
}

function inconsistent(): FieldHandoverWorkflowProjection {
  return active("INCONSISTENT", "状态异常，请联系运营");
}
