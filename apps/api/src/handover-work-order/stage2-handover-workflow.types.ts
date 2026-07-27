import {
  Prisma,
  VehicleHandoverWorkflowJob,
  VehicleHandoverWorkflowJobType
} from "@prisma/client";

import { PrismaService } from "../prisma/prisma.service";

export const STAGE2_HANDOVER_WORKFLOW_HANDLER = Symbol(
  "STAGE2_HANDOVER_WORKFLOW_HANDLER"
);

export type Stage2HandoverWorkflowDb = Prisma.TransactionClient | PrismaService;

export interface EnqueueStage2WorkflowJobInput {
  availableAt?: Date;
  eSignTaskId?: string;
  handoverId?: string;
  idempotencyKey: string;
  jobType: VehicleHandoverWorkflowJobType;
  maxAttempts?: number;
  payload?: Prisma.InputJsonValue;
  workOrderId: string;
}

export type ClaimedStage2WorkflowJob = Omit<
  VehicleHandoverWorkflowJob,
  "leaseExpiresAt" | "leaseToken"
> & {
  leaseExpiresAt: Date;
  leaseToken: string;
};

export interface Stage2WorkflowError {
  code: string;
  message: string;
}

export interface RescheduleStage2WorkflowJobInput {
  availableAt: Date;
  error?: Stage2WorkflowError;
  incrementAttempt?: boolean;
  result?: Prisma.InputJsonValue;
}

export type WorkflowHandlerResult =
  | { kind: "COMPLETED"; result?: Prisma.InputJsonValue }
  | {
      availableAt: Date;
      kind: "OBSERVED_SIGNING";
      result?: Prisma.InputJsonValue;
    };

export interface Stage2HandoverWorkflowHandler {
  handle(job: ClaimedStage2WorkflowJob): Promise<WorkflowHandlerResult>;
  readonly supportedJobTypes: readonly VehicleHandoverWorkflowJobType[];
}
