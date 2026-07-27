import { Injectable } from "@nestjs/common";
import { ConfigService } from "@nestjs/config";
import {
  ContractStatus,
  VehicleHandoverWorkflowJobStatus,
  VehicleHandoverWorkflowJobType
} from "@prisma/client";

import { PrismaService } from "../prisma/prisma.service";
import { HandoverWorkOrderService } from "./handover-work-order.service";
import { Stage2HandoverWorkflowRepository } from "./stage2-handover-workflow.repository";
import {
  ClaimedStage2WorkflowJob,
  Stage2HandoverWorkflowHandler,
  WorkflowHandlerResult
} from "./stage2-handover-workflow.types";

const STAGE2_HANDOVER_WORKFLOW_ENABLED_ENV =
  "STAGE2_HANDOVER_WORKFLOW_ENABLED";
const DEFAULT_LEASE_MS = 120_000;
const SHA256_DIGEST_PATTERN = /^[0-9a-f]{64}$/;

export type Stage2HandoverWorkflowProjectionState =
  | "PDF_PENDING"
  | "PDF_READY"
  | "WORKFLOW_EXCEPTION";

export interface Stage2HandoverWorkflowProjection {
  artifactVersion: number | null;
  errorCode: null | string;
  jobId: null | string;
  state: Stage2HandoverWorkflowProjectionState;
}

const sourceProjectionSelect = {
  handover: {
    select: {
      artifactVersion: true,
      handoverContract: {
        select: {
          deletedAt: true,
          fileId: true,
          id: true,
          status: true
        }
      },
      handoverContractId: true,
      manifestHash: true,
      sourceDocumentFileId: true,
      sourceObjectKey: true,
      sourcePdfHash: true
    }
  },
  id: true
} as const;

@Injectable()
export class Stage2HandoverWorkflowService
  implements Stage2HandoverWorkflowHandler {
  constructor(
    private readonly prisma: PrismaService,
    private readonly config: ConfigService,
    private readonly repository: Stage2HandoverWorkflowRepository,
    private readonly handoverWorkOrderService: HandoverWorkOrderService
  ) {}

  isEnabled() {
    return this.config
      .get<string>(STAGE2_HANDOVER_WORKFLOW_ENABLED_ENV)
      ?.trim()
      .toLowerCase() === "true";
  }

  async handle(
    job: ClaimedStage2WorkflowJob
  ): Promise<WorkflowHandlerResult> {
    if (job.jobType !== VehicleHandoverWorkflowJobType.GENERATE_SOURCE_PDF) {
      throw new Error("STAGE2_HANDOVER_WORKFLOW_JOB_NOT_IMPLEMENTED");
    }
    const manifestHash = readRequiredManifestHash(job.payload);
    return this.withLeaseHeartbeat(job, async (lease) => {
      const artifact = await this.handoverWorkOrderService
        .ensureStage2HandoverPdf(job.workOrderId, manifestHash, { lease });
      return {
        kind: "COMPLETED",
        result: {
          artifactId: artifact.artifactId,
          artifactStatus: artifact.status
        }
      };
    });
  }

  async getProjection(
    workOrderId: string
  ): Promise<null | Stage2HandoverWorkflowProjection> {
    if (!this.isEnabled()) {
      return null;
    }

    const job = await this.prisma.vehicleHandoverWorkflowJob.findFirst({
      orderBy: { createdAt: "desc" },
      where: {
        jobType: VehicleHandoverWorkflowJobType.GENERATE_SOURCE_PDF,
        workOrderId
      }
    });
    if (!job) {
      return null;
    }
    if (job.jobStatus === VehicleHandoverWorkflowJobStatus.DEAD_LETTER) {
      return {
        artifactVersion: null,
        errorCode: job.lastErrorCode ?? "WORKFLOW_ERROR",
        jobId: job.id,
        state: "WORKFLOW_EXCEPTION"
      };
    }

    const workOrder = await this.prisma.vehicleHandoverWorkOrder.findUnique({
      select: sourceProjectionSelect,
      where: { id: workOrderId }
    });
    const source = workOrder?.handover ?? null;
    const fileObject = source?.sourceDocumentFileId
      ? await this.prisma.fileObject.findUnique({
          where: { id: source.sourceDocumentFileId }
        })
      : null;
    if (
      source &&
      isLocallyReadySource(source, fileObject, readManifestHash(job.payload))
    ) {
      return {
        artifactVersion: source.artifactVersion,
        errorCode: null,
        jobId: job.id,
        state: "PDF_READY"
      };
    }
    if (job.jobStatus === VehicleHandoverWorkflowJobStatus.COMPLETED) {
      return {
        artifactVersion: null,
        errorCode: "SOURCE_ARTIFACT_INVALID",
        jobId: job.id,
        state: "WORKFLOW_EXCEPTION"
      };
    }
    return {
      artifactVersion: null,
      errorCode: null,
      jobId: job.id,
      state: "PDF_PENDING"
    };
  }

  private async withLeaseHeartbeat<T>(
    job: ClaimedStage2WorkflowJob,
    operation: (lease: {
      assertLease(): Promise<void>;
      jobId: string;
      leaseMs: number;
      leaseToken: string;
    }) => Promise<T>
  ) {
    const leaseMs = readPositiveInteger(
      this.config.get<string>("STAGE2_HANDOVER_WORKER_LEASE_MS"),
      DEFAULT_LEASE_MS
    );
    const intervalMs = Math.max(10, Math.floor(leaseMs / 3));
    let heartbeat = Promise.resolve();
    let leaseLost = false;
    let stopped = false;
    const renew = () => {
      heartbeat = heartbeat.then(async () => {
        if (stopped || leaseLost) {
          return;
        }
        try {
          leaseLost = !await this.repository.renewLease(
            job.id,
            job.leaseToken,
            leaseMs
          );
        } catch {
          leaseLost = true;
        }
      });
      return heartbeat;
    };
    const assertLease = async () => {
      await renew();
      if (leaseLost) {
        throw new Error("STAGE2_HANDOVER_WORKFLOW_LEASE_LOST");
      }
    };

    await assertLease();
    const timer = setInterval(() => {
      void renew();
    }, intervalMs);
    timer.unref?.();
    try {
      return await operation({
        assertLease,
        jobId: job.id,
        leaseMs,
        leaseToken: job.leaseToken
      });
    } finally {
      clearInterval(timer);
      stopped = true;
      await heartbeat;
    }
  }
}

function isLocallyReadySource(
  source: null | {
    artifactVersion: number;
    handoverContract: null | {
      deletedAt: Date | null;
      fileId: null | string;
      id: string;
      status: ContractStatus;
    };
    handoverContractId: null | string;
    manifestHash: null | string;
    sourceDocumentFileId: null | string;
    sourceObjectKey: null | string;
    sourcePdfHash: null | string;
  },
  fileObject: null | {
    bucket: string;
    id: string;
    mimeType: null | string;
    objectKey: string;
    sizeBytes: bigint;
  },
  expectedManifestHash: null | string
) {
  if (!source || !fileObject || !expectedManifestHash) {
    return false;
  }
  const contract = source.handoverContract;
  const fileSize = Number(fileObject.sizeBytes);
  return (
    source.artifactVersion === 1 &&
    normalizeSha256(source.manifestHash) === expectedManifestHash &&
    normalizeSha256(source.sourcePdfHash) !== null &&
    Boolean(source.handoverContractId) &&
    contract?.id === source.handoverContractId &&
    !contract.deletedAt &&
    contract.status === ContractStatus.GENERATED &&
    contract.fileId === source.sourceDocumentFileId &&
    fileObject.id === source.sourceDocumentFileId &&
    Boolean(fileObject.bucket) &&
    fileObject.objectKey === source.sourceObjectKey &&
    fileObject.mimeType?.trim().toLowerCase() === "application/pdf" &&
    Number.isSafeInteger(fileSize) &&
    fileSize > 0
  );
}

function readManifestHash(payload: unknown) {
  if (!payload || typeof payload !== "object" || Array.isArray(payload)) {
    return null;
  }
  return normalizeSha256((payload as Record<string, unknown>).manifestHash);
}

function normalizeSha256(value: unknown) {
  if (typeof value !== "string") {
    return null;
  }
  const digest = value.trim().toLowerCase().replace(/^sha256:/, "");
  return SHA256_DIGEST_PATTERN.test(digest) ? digest : null;
}

function readRequiredManifestHash(payload: unknown) {
  if (!payload || typeof payload !== "object" || Array.isArray(payload)) {
    throw new Error("STAGE2_HANDOVER_WORKFLOW_MANIFEST_HASH_INVALID");
  }
  const value = (payload as Record<string, unknown>).manifestHash;
  const digest = normalizeSha256(value);
  if (!digest) {
    throw new Error("STAGE2_HANDOVER_WORKFLOW_MANIFEST_HASH_INVALID");
  }
  return `sha256:${digest}`;
}

function readPositiveInteger(value: unknown, fallback: number) {
  const parsed = Number(value);
  return Number.isSafeInteger(parsed) && parsed > 0 ? parsed : fallback;
}
