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
