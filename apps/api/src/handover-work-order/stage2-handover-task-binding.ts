import {
  ESignDocumentType,
  ESignSigningStage,
  ESignTaskStatus,
  Prisma
} from "@prisma/client";

const ACTIVE_STAGE2_ESIGN_TASK_STATUSES = [
  ESignTaskStatus.CREATED,
  ESignTaskStatus.SIGNING,
  ESignTaskStatus.WAITING_CUSTOMER
] as const;

export function buildAuthoritativeStage2TaskWhere({
  contractId,
  orderId,
  taskId
}: {
  contractId: string | null | undefined;
  orderId: string | null | undefined;
  taskId?: string | null;
}): Prisma.ContractESignTaskWhereInput | null {
  if (!contractId || !orderId) {
    return null;
  }
  return {
    contractId,
    deletedAt: null,
    documentType: ESignDocumentType.DELIVERY_HANDOVER,
    ...(taskId ? { id: taskId } : {}),
    orderId,
    signingStage:
      ESignSigningStage.STAGE2_DELIVERY_HANDOVER,
    taskStatus: {
      in: [...ACTIVE_STAGE2_ESIGN_TASK_STATUSES]
    }
  };
}

export interface Stage2HandoverTaskSourceBindingInput {
  expectedCustomerId?: string;
  expectedOrderId?: string;
  handover: unknown;
  task: unknown;
}

export function matchesStage2HandoverTaskSourceBinding(
  input: Stage2HandoverTaskSourceBindingInput
) {
  const handover = asRecord(input.handover);
  const task = asRecord(input.task);
  const contract = asRecord(handover?.handoverContract);
  const snapshot = asRecord(task?.requestSnapshot);
  if (!handover || !task || !contract || !snapshot) {
    return false;
  }

  const handoverContractId = readString(handover.handoverContractId);
  const sourceDocumentFileId = readString(handover.sourceDocumentFileId);
  return (
    readString(handover.handoverESignTaskId) === readString(task.id) &&
    readString(task.contractId) === handoverContractId &&
    readString(contract.id) === handoverContractId &&
    readString(contract.fileId) === sourceDocumentFileId &&
    snapshot.artifactVersion === handover.artifactVersion &&
    snapshot.contractId === task.contractId &&
    snapshot.contractId === contract.id &&
    snapshot.handoverId === handover.id &&
    snapshot.manifestHash === handover.manifestHash &&
    snapshot.sourceDocumentFileId === handover.sourceDocumentFileId &&
    snapshot.sourceDocumentFileId === contract.fileId &&
    snapshot.sourcePdfHash === handover.sourcePdfHash &&
    (
      input.expectedOrderId === undefined ||
      (
        readString(handover.orderId) === input.expectedOrderId &&
        readString(contract.orderId) === input.expectedOrderId &&
        readString(task.orderId) === input.expectedOrderId
      )
    ) &&
    (
      input.expectedCustomerId === undefined ||
      (
        readString(contract.customerId) === input.expectedCustomerId &&
        readString(task.customerId) === input.expectedCustomerId
      )
    )
  );
}

function asRecord(value: unknown): null | Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown>
    : null;
}

function readString(value: unknown) {
  return typeof value === "string" && value.trim() ? value : null;
}
