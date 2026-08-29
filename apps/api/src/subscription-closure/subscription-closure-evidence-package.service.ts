import { ConflictException, Injectable, NotFoundException } from "@nestjs/common";
import { Prisma } from "@prisma/client";
import { createHash, randomUUID } from "node:crypto";
import { Readable } from "node:stream";

import { PrismaService } from "../prisma/prisma.service";
import { StorageService } from "../storage/storage.service";
import { canonicalSubscriptionClosureJson } from "./subscription-closure.domain";

export const CLOSURE_EVIDENCE_ARTIFACT_MAX_BYTES = 32 * 1024 * 1024;
export const CLOSURE_EVIDENCE_ARTIFACTS_TOTAL_MAX_BYTES = 64 * 1024 * 1024;
export const CLOSURE_EVIDENCE_BUNDLE_MAX_BYTES = 96 * 1024 * 1024;

@Injectable()
export class SubscriptionClosureEvidencePackageService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly storage: StorageService
  ) {}

  async export(closureCaseId: string, actorId: string) {
    const prepared = await this.prepareCurrentPackage(closureCaseId);
    const manifestHash = evidencePackageManifestHash(prepared.manifest);
    const existing = await this.prisma.subscriptionClosureEvidencePackageExport.findUnique({
      where: { closureCaseId_manifestHash: { closureCaseId, manifestHash } }
    });
    if (existing?.fileId && existing.fileSha256) return project(existing, true);

    const exportId = randomUUID();
    const reservation = await this.prisma.$transaction(
      async (tx) => {
        await tx.$queryRaw(
          Prisma.sql`SELECT "id" FROM "subscription_closure_case" WHERE "id" = ${closureCaseId}::uuid FOR UPDATE`
        );
        const winner = await tx.subscriptionClosureEvidencePackageExport.findUnique({
          where: { closureCaseId_manifestHash: { closureCaseId, manifestHash } }
        });
        if (winner?.fileId && winner.fileSha256) return { record: winner, replayed: true };
        if (winner) {
          const staleBefore = Date.now() - 15 * 60 * 1000;
          if (winner.createdAt.getTime() >= staleBefore) throw exportInProgress();
          await tx.subscriptionClosureEvidencePackageExport.delete({ where: { id: winner.id } });
        }
        const lockedSnapshot = await this.buildManifestSnapshot(tx, closureCaseId);
        if (evidencePackageManifestHash(lockedSnapshot.manifest) !== prepared.baseManifestHash) {
          throw conflict(
            "CLOSURE_EVIDENCE_PACKAGE_STALE_SNAPSHOT",
            "闭环事实在证据包生成期间发生变化，请重新导出。"
          );
        }
        const latest = await tx.subscriptionClosureEvidencePackageExport.aggregate({
          _max: { version: true },
          where: { closureCaseId }
        });
        const record = await tx.subscriptionClosureEvidencePackageExport.create({
          data: {
            closureCaseId,
            createdBy: actorId,
            id: exportId,
            manifestHash,
            manifestSnapshot: prepared.manifest as Prisma.InputJsonValue,
            version: (latest._max.version ?? 0) + 1
          }
        });
        return { record, replayed: false };
      },
      { isolationLevel: Prisma.TransactionIsolationLevel.RepeatableRead, timeout: 120_000 }
    );
    if (reservation.replayed) return project(reservation.record, true);
    const version = reservation.record.version;
    const bytes = buildEvidencePackageBundle({
      artifacts: prepared.artifacts,
      manifest: prepared.manifest,
      manifestHash,
      version
    });
    const fileSha256 = sha256(bytes);
    const originalName = `subscription-closure-${closureCaseId}-evidence-bundle-v${version}.json`;
    const stored = await this.storage.putSubscriptionClosureEvidencePackage({
      buffer: bytes,
      closureCaseId,
      contentType: "application/vnd.subscription-closure.evidence-bundle+json",
      metadata: { fileSha256, manifestHash, version: String(version) },
      objectIdentity: `${exportId}-${manifestHash}`,
      originalName,
      version
    });
    try {
      const verified = await this.storage.getObject(stored.bucket, stored.objectKey);
      const verifiedBytes = await streamBuffer(
        verified.stream,
        CLOSURE_EVIDENCE_BUNDLE_MAX_BYTES
      );
      if (sha256(verifiedBytes) !== fileSha256) {
        throw conflict(
          "CLOSURE_EVIDENCE_PACKAGE_UPLOAD_MISMATCH",
          "证据包上传后校验失败，未建立法催权威记录。"
        );
      }
      verifyEvidencePackageBundle(verifiedBytes, manifestHash, fileSha256);
      const created = await this.prisma.$transaction(async (tx) => {
        const file = await tx.fileObject.create({
          data: {
            bucket: stored.bucket,
            contentSha256: fileSha256,
            mimeType: "application/vnd.subscription-closure.evidence-bundle+json",
            objectKey: stored.objectKey,
            originalName,
            sizeBytes: BigInt(bytes.length),
            uploadedBy: actorId
          }
        });
        return tx.subscriptionClosureEvidencePackageExport.update({
          data: { fileId: file.id, fileSha256 },
          where: { id: reservation.record.id }
        });
      });
      return project(created, false);
    } catch (error) {
      let recoveryReadCompleted = false;
      let committedAuthorityExists = false;
      try {
        const committed = await this.prisma.subscriptionClosureEvidencePackageExport.findUnique({
          include: { file: true },
          where: { id: reservation.record.id }
        });
        recoveryReadCompleted = true;
        if (committed?.fileId && committed.fileSha256 && committed.file) {
          committedAuthorityExists = true;
          const downloaded = await this.storage.getObject(
            committed.file.bucket,
            committed.file.objectKey
          );
          const committedBytes = await streamBuffer(
            downloaded.stream,
            CLOSURE_EVIDENCE_BUNDLE_MAX_BYTES
          );
          verifyEvidencePackageBundle(
            committedBytes,
            committed.manifestHash,
            committed.fileSha256
          );
          return project(committed, false);
        }
      } catch {
        // A failed recovery read is ambiguous. Preserve the uniquely named object so a
        // later replay can reconcile it instead of deleting a possibly committed export.
      }
      if (!recoveryReadCompleted || committedAuthorityExists) throw error;
      await this.storage.deleteObject(stored.bucket, stored.objectKey).catch(() => undefined);
      await this.prisma.subscriptionClosureEvidencePackageExport.deleteMany({
        where: { fileId: null, id: reservation.record.id }
      });
      throw error;
    }
  }

  async getObject(closureCaseId: string, exportId: string) {
    const verified = await this.verifyExport(closureCaseId, exportId);
    return {
      contentLength: verified.bytes.length,
      mimeType:
        verified.record.file!.mimeType ??
        "application/vnd.subscription-closure.evidence-bundle+json",
      originalName: verified.record.file!.originalName,
      stream: Readable.from(verified.bytes)
    };
  }

  async currentManifestHash(closureCaseId: string) {
    const prepared = await this.prepareCurrentPackage(closureCaseId);
    return evidencePackageManifestHash(prepared.manifest);
  }

  async currentManifestHashInTransaction(
    tx: Prisma.TransactionClient,
    closureCaseId: string
  ) {
    const snapshot = await this.buildManifestSnapshot(tx, closureCaseId);
    const prepared = await this.preparePackageFromSnapshot(snapshot);
    return evidencePackageManifestHash(prepared.manifest);
  }

  async verifyExport(closureCaseId: string, exportId: string) {
    const record = await this.prisma.subscriptionClosureEvidencePackageExport.findUnique({
      include: { file: true },
      where: { id: exportId }
    });
    if (
      !record ||
      record.closureCaseId !== closureCaseId ||
      !record.file ||
      !record.fileSha256
    ) {
      throw new NotFoundException("Subscription closure evidence package not found.");
    }
    const downloaded = await this.storage.getObject(record.file.bucket, record.file.objectKey);
    const bytes = await streamBuffer(downloaded.stream, CLOSURE_EVIDENCE_BUNDLE_MAX_BYTES);
    verifyEvidencePackageBundle(bytes, record.manifestHash, record.fileSha256);
    return { bytes, record };
  }

  private async prepareCurrentPackage(closureCaseId: string) {
    const snapshot = await this.prisma.$transaction(
      (tx) => this.buildManifestSnapshot(tx, closureCaseId),
      { isolationLevel: Prisma.TransactionIsolationLevel.RepeatableRead, timeout: 120_000 }
    );
    return this.preparePackageFromSnapshot(snapshot);
  }

  private async preparePackageFromSnapshot(
    snapshot: Awaited<ReturnType<SubscriptionClosureEvidencePackageService["buildManifestSnapshot"]>>
  ) {
    assertEvidencePackageArtifactSizeBudget(snapshot.artifactFiles);
    const artifacts = await Promise.all(
      snapshot.artifactFiles.map(async ({ expectedSha256, file, roles }) => {
        const downloaded = await this.storage.getObject(file.bucket, file.objectKey);
        const bytes = await streamBuffer(
          downloaded.stream,
          Math.min(Number(file.sizeBytes), CLOSURE_EVIDENCE_ARTIFACT_MAX_BYTES)
        );
        const contentSha256 = sha256(bytes);
        if (
          bytes.length !== Number(file.sizeBytes) ||
          (expectedSha256 && contentSha256 !== expectedSha256)
        ) {
          throw conflict(
            "CLOSURE_EVIDENCE_ARTIFACT_INTEGRITY_MISMATCH",
            `证据文件 ${file.id} 与已记录摘要或大小不一致，禁止导出。`
          );
        }
        return {
          dataBase64: bytes.toString("base64"),
          fileId: file.id,
          mimeType: file.mimeType ?? "application/octet-stream",
          originalName: file.originalName,
          roles,
          sha256: contentSha256,
          sizeBytes: bytes.length
        };
      })
    );
    artifacts.sort((left, right) => left.fileId.localeCompare(right.fileId));
    const artifactManifest = artifacts.map((entry) => ({
      fileId: entry.fileId,
      mimeType: entry.mimeType,
      originalName: entry.originalName,
      roles: entry.roles,
      sha256: entry.sha256,
      sizeBytes: entry.sizeBytes
    }));
    return {
      artifacts,
      baseManifestHash: evidencePackageManifestHash(snapshot.manifest),
      manifest: redactEvidencePackage({
        ...asRecord(snapshot.manifest),
        artifacts: artifactManifest,
        version: 2
      })
    };
  }

  private async buildManifestSnapshot(tx: Prisma.TransactionClient, closureCaseId: string) {
    const closureCase = await tx.subscriptionClosureCase.findUnique({
      where: { id: closureCaseId }
    });
    if (!closureCase) throw new NotFoundException("Subscription closure case not found.");
    const [
      checklistRevisions,
      evidenceLinks,
      deltaRevisions,
      clauses,
      settlements,
      chargeLines,
      responses,
      disputes,
      bills,
      dispositions,
      legalCases,
      paymentRecords,
      depositLedgers,
      documents,
      events,
      delivery,
      contract,
      notificationEvents
    ] = await Promise.all([
      tx.vehicleReturnChecklistRevision.findMany({
        include: { items: { orderBy: { itemCode: "asc" } } },
        orderBy: [{ revisionNumber: "asc" }, { id: "asc" }],
        where: { closureCaseId }
      }),
      tx.vehicleReturnEvidenceLink.findMany({
        orderBy: [{ recordedAt: "asc" }, { id: "asc" }],
        where: { closureCaseId }
      }),
      tx.vehicleConditionDeltaRevision.findMany({
        include: { items: { orderBy: { itemCode: "asc" } } },
        orderBy: [{ revisionNumber: "asc" }, { id: "asc" }],
        where: { closureCaseId }
      }),
      tx.contractChargeClauseSnapshot.findMany({
        orderBy: [{ clauseCode: "asc" }, { clauseVersion: "asc" }],
        where: { contractId: closureCase.contractId }
      }),
      tx.subscriptionClosureSettlementRevision.findMany({
        orderBy: [{ revisionNumber: "asc" }, { id: "asc" }],
        where: { closureCaseId }
      }),
      tx.subscriptionClosureChargeLine.findMany({
        orderBy: [{ createdAt: "asc" }, { id: "asc" }],
        where: { closureCaseId }
      }),
      tx.subscriptionClosureCustomerResponse.findMany({
        orderBy: [{ respondedAt: "asc" }, { id: "asc" }],
        where: { closureCaseId }
      }),
      tx.subscriptionClosureChargeDispute.findMany({
        include: { decision: true },
        orderBy: [{ createdAt: "asc" }, { id: "asc" }],
        where: { closureCaseId }
      }),
      tx.receivableBill.findMany({
        orderBy: [{ createdAt: "asc" }, { id: "asc" }],
        where: { orderId: closureCase.orderId }
      }),
      tx.subscriptionClosureReceivableDisposition.findMany({
        orderBy: [{ createdAt: "asc" }, { id: "asc" }],
        where: { closureCaseId }
      }),
      tx.subscriptionClosureLegalCollectionCase.findMany({
        include: { events: { orderBy: [{ occurredAt: "asc" }, { id: "asc" }] } },
        orderBy: [{ openedAt: "asc" }, { id: "asc" }],
        where: { closureCaseId }
      }),
      tx.paymentRecord.findMany({
        include: { writeOffs: { orderBy: [{ writeOffAt: "asc" }, { id: "asc" }] } },
        orderBy: [{ receivedAt: "asc" }, { id: "asc" }],
        where: { deletedAt: null, orderId: closureCase.orderId }
      }),
      tx.depositLedger.findMany({
        orderBy: [{ occurredAt: "asc" }, { id: "asc" }],
        where: { deletedAt: null, orderId: closureCase.orderId }
      }),
      tx.subscriptionClosureDocumentRevision.findMany({
        orderBy: [{ documentType: "asc" }, { revisionNumber: "asc" }],
        where: { closureCaseId }
      }),
      tx.subscriptionClosureEvent.findMany({
        orderBy: [{ sequence: "asc" }, { id: "asc" }],
        where: { closureCaseId }
      }),
      tx.vehicleDeliveryHandover.findFirst({
        orderBy: [{ archivedAt: "desc" }, { id: "asc" }],
        where: {
          archivedAt: { not: null },
          archiveStatus: "ARCHIVED",
          deletedAt: null,
          orderId: closureCase.orderId,
          signedDocumentFileId: { not: null },
          signedPdfHash: { not: null },
          status: "ARCHIVED"
        }
      }),
      tx.contract.findUnique({
        where: { id: closureCase.contractId }
      }),
      tx.notificationEvent.findMany({
        include: { notification: true },
        orderBy: [{ createdAt: "asc" }, { id: "asc" }],
        where: {
          OR: [
            { aggregateId: closureCase.id, aggregateType: "SUBSCRIPTION_CLOSURE" },
            { aggregateId: closureCase.orderId, aggregateType: "SUBSCRIPTION_ORDER" }
          ]
        }
      })
    ]);
    const evidenceIds = evidenceLinks
      .map(({ evidenceId }) => evidenceId)
      .filter((id): id is string => Boolean(id));
    const evidence = await tx.assetWorkOrderEvidence.findMany({
      orderBy: [{ recordedAt: "asc" }, { id: "asc" }],
      where: { id: { in: evidenceIds } }
    });
    const relatedEntityIds = [
      closureCaseId,
      ...checklistRevisions.map(({ id }) => id),
      ...evidenceLinks.map(({ id }) => id),
      ...evidence.map(({ id }) => id),
      ...deltaRevisions.map(({ id }) => id),
      ...settlements.map(({ id }) => id),
      ...chargeLines.map(({ id }) => id),
      ...responses.map(({ id }) => id),
      ...disputes.map(({ id }) => id),
      ...bills.map(({ id }) => id),
      ...dispositions.map(({ id }) => id),
      ...legalCases.map(({ id }) => id),
      ...documents.map(({ id }) => id),
      closureCase.contractId
    ];
    const audits = await tx.auditLog.findMany({
      orderBy: [{ createdAt: "asc" }, { id: "asc" }],
      where: { entityId: { in: [...new Set(relatedEntityIds)] } }
    });
    const artifactByFileId = new Map<
      string,
      { expectedSha256: string | null; roles: Set<string> }
    >();
    const addArtifact = (fileId: string | null | undefined, role: string, expected?: string | null) => {
      if (!fileId) return;
      const normalizedExpected = isSha256(expected) ? expected!.toLowerCase() : null;
      const current = artifactByFileId.get(fileId);
      if (current) {
        if (
          current.expectedSha256 &&
          normalizedExpected &&
          current.expectedSha256 !== normalizedExpected
        ) {
          throw conflict(
            "CLOSURE_EVIDENCE_ARTIFACT_HASH_CONFLICT",
            `证据文件 ${fileId} 存在冲突摘要，禁止导出。`
          );
        }
        current.expectedSha256 ??= normalizedExpected;
        current.roles.add(role);
        return;
      }
      artifactByFileId.set(fileId, {
        expectedSha256: normalizedExpected,
        roles: new Set([role])
      });
    };
    const signedContractAuditHash = authoritativeSignedContractAuditHash(contract, audits);
    if (!contract?.fileId || !signedContractAuditHash) {
      throw conflict(
        "CLOSURE_SIGNED_CONTRACT_AUTHORITY_MISSING",
        "当前合同缺少与已归档签署文件绑定的权威审计，禁止导出证据包。"
      );
    }
    addArtifact(
      contract.fileId,
      "SIGNED_SUBSCRIPTION_CONTRACT",
      signedContractAuditHash
    );
    addArtifact(
      delivery?.signedDocumentFileId,
      "SIGNED_DELIVERY_HANDOVER",
      delivery?.signedPdfHash
    );
    for (const item of evidence) {
      addArtifact(item.fileId, "RETURN_EVIDENCE", item.contentSha256);
    }
    for (const document of documents) {
      addArtifact(
        document.sourceFileId,
        `${document.documentType}_SOURCE`,
        document.sourceFileHash
      );
      addArtifact(
        document.signedFileId,
        `${document.documentType}_SIGNED`,
        document.signedFileHash
      );
    }
    for (const disposition of dispositions) {
      addArtifact(disposition.proofFileId, "FINANCIAL_DISPOSITION_PROOF");
    }
    const fileIds = [...artifactByFileId.keys()].sort();
    const files = await tx.fileObject.findMany({
      orderBy: { id: "asc" },
      where: { id: { in: fileIds } }
    });
    if (files.length !== fileIds.length) {
      throw conflict(
        "CLOSURE_EVIDENCE_ARTIFACT_FILE_MISSING",
        "证据包引用的原始文件记录不完整，禁止导出。"
      );
    }
    for (const file of files) {
      const reference = artifactByFileId.get(file.id)!;
      reference.expectedSha256 = authoritativeArtifactSha256(
        reference.expectedSha256,
        file.contentSha256,
        [...reference.roles],
        file.id
      );
    }
    const manifest = redactEvidencePackage({
      artifactAuthorities: files.map((file) => {
        const reference = artifactByFileId.get(file.id)!;
        return {
          expectedSha256: reference.expectedSha256,
          fileId: file.id,
          mimeType: file.mimeType,
          originalName: file.originalName,
          roles: [...reference.roles].sort(),
          sizeBytes: file.sizeBytes
        };
      }),
      case: {
        caseNo: closureCase.caseNo,
        closureType: closureCase.closureType,
        contractId: closureCase.contractId,
        currentChecklistRevisionId: closureCase.currentChecklistRevisionId,
        currentDeltaRevisionId: closureCase.currentDeltaRevisionId,
        currentSettlementRevisionId: closureCase.currentSettlementRevisionId,
        customerId: closureCase.customerId,
        financialStatus: closureCase.financialStatus,
        finalDisposition: closureCase.finalDisposition,
        id: closureCase.id,
        operationalCompletedAt: closureCase.operationalCompletedAt,
        orderId: closureCase.orderId,
        physicalControlMode: closureCase.physicalControlMode,
        status: closureCase.status,
        vehicleId: closureCase.vehicleId,
        version: closureCase.version
      },
      chargeLines,
      checklistRevisions,
      contract,
      contractClauses: clauses,
      customerResponses: responses,
      deliveryArtifact: delivery
        ? {
            archivedAt: delivery.archivedAt,
            id: delivery.id,
            manifestHash: delivery.manifestHash,
            signedDocumentFileId: delivery.signedDocumentFileId,
            signedPdfHash: delivery.signedPdfHash
          }
        : null,
      dispositions,
      disputes,
      documents,
      evidence,
      evidenceLinks,
      legalCases,
      notifications: notificationEvents,
      paymentRecords,
      depositLedgers,
      settlementRevisions: settlements,
      timeline: { audits, events },
      version: 2,
      conditionDeltaRevisions: deltaRevisions,
      receivableBills: bills
    });
    return {
      artifactFiles: files.map((file) => {
        const reference = artifactByFileId.get(file.id)!;
        return {
          expectedSha256: reference.expectedSha256,
          file,
          roles: [...reference.roles].sort()
        };
      }),
      manifest
    };
  }
}

export function redactEvidencePackage(value: unknown): unknown {
  if (typeof value === "bigint") return value.toString();
  if (value instanceof Prisma.Decimal) return value.toString();
  if (value instanceof Date) return value.toISOString();
  if (value === null || typeof value !== "object") return value;
  if (Array.isArray(value)) return value.map(redactEvidencePackage);
  const result: Record<string, unknown> = {};
  for (const [key, item] of Object.entries(value as Record<string, unknown>)) {
    const normalized = key.toLowerCase().replace(/[^a-z0-9]/g, "");
    if (
      normalized.includes("callbackpayload") ||
      normalized.includes("providerpayload") ||
      normalized.includes("privatekey") ||
      normalized.includes("bankaccount") ||
      normalized.includes("password") ||
      normalized.includes("credential") ||
      normalized.includes("secret") ||
      normalized === "clientip" ||
      normalized === "ipaddress" ||
      normalized === "useragent" ||
      normalized === "accesstoken" ||
      normalized === "authorization" ||
      normalized === "cookie" ||
      normalized === "mobile" ||
      normalized === "phone" ||
      normalized === "recipientphone" ||
      normalized === "email" ||
      normalized === "address" ||
      normalized === "openid" ||
      normalized === "recipientopenid" ||
      normalized === "idcard" ||
      normalized === "idnumber" ||
      normalized === "refreshtoken" ||
      normalized === "token"
    ) {
      continue;
    }
    result[key] =
      typeof item === "string" && (normalized.includes("url") || isHttpUrl(item))
        ? redactUrl(item)
        : redactEvidencePackage(item);
  }
  return result;
}

export function authoritativeArtifactSha256(
  expectedSha256: string | null | undefined,
  persistedSha256: string | null | undefined,
  roles: readonly string[],
  fileId: string
) {
  const expected = isSha256(expectedSha256) ? expectedSha256!.toLowerCase() : null;
  const persisted = isSha256(persistedSha256) ? persistedSha256!.toLowerCase() : null;
  if (expected && persisted && expected !== persisted) {
    throw conflict(
      "CLOSURE_EVIDENCE_ARTIFACT_HASH_CONFLICT",
      `Evidence file ${fileId} has conflicting authority hashes.`
    );
  }
  const authority = expected ?? persisted;
  if (
    !authority &&
    roles.some((role) =>
      ["FINANCIAL_DISPOSITION_PROOF", "SIGNED_SUBSCRIPTION_CONTRACT"].includes(role)
    )
  ) {
    throw conflict(
      "CLOSURE_EVIDENCE_ARTIFACT_AUTHORITY_MISSING",
      `Evidence file ${fileId} has no persisted authority hash.`
    );
  }
  return authority;
}

export function authoritativeSignedContractAuditHash(
  contractValue: unknown,
  auditValues: readonly unknown[]
) {
  const contract = asRecord(contractValue);
  if (
    contract.status !== "ARCHIVED" ||
    typeof contract.fileId !== "string" ||
    !contract.fileId ||
    !validTimestamp(contract.signedAt) ||
    !validTimestamp(contract.archivedAt)
  ) {
    return null;
  }
  const audit = [...auditValues].reverse().find((value) => {
    const item = asRecord(value);
    if (
      item.entityType !== "contract" ||
      item.entityId !== contract.id ||
      !["APPROVE", "UPDATE"].includes(String(item.action ?? ""))
    ) {
      return false;
    }
    const after = asRecord(item.afterSnapshot);
    return (
      after.status === "ARCHIVED" &&
      after.fileId === contract.fileId &&
      isSha256(after.signedPdfHash)
    );
  });
  const hash = asRecord(asRecord(audit).afterSnapshot).signedPdfHash;
  return isSha256(hash) ? hash.toLowerCase() : null;
}

function isHttpUrl(value: string) {
  return /^https?:\/\//i.test(value);
}

function redactUrl(value: string) {
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

export function evidencePackageManifestHash(value: unknown) {
  return sha256(canonicalSubscriptionClosureJson(value as never));
}

export function buildEvidencePackageBundle(input: Readonly<{
  artifacts: readonly Readonly<{
    dataBase64: string;
    fileId: string;
    mimeType: string;
    originalName: string;
    roles: readonly string[];
    sha256: string;
    sizeBytes: number;
  }>[];
  manifest: unknown;
  manifestHash: string;
  version: number;
}>) {
  const bytes = Buffer.from(
    canonicalSubscriptionClosureJson({
      artifacts: input.artifacts,
      bundleFormat: "SUBSCRIPTION_CLOSURE_EVIDENCE_BUNDLE_V1",
      manifest: input.manifest,
      manifestHash: input.manifestHash,
      version: input.version
    } as never),
    "utf8"
  );
  if (bytes.length > CLOSURE_EVIDENCE_BUNDLE_MAX_BYTES) {
    throw conflict(
      "CLOSURE_EVIDENCE_PACKAGE_SIZE_LIMIT_EXCEEDED",
      "证据包超过 96 MiB 导出上限，请减少重复附件后重试。"
    );
  }
  return bytes;
}

export function verifyEvidencePackageBundle(
  bytes: Buffer,
  expectedManifestHash: string,
  expectedFileSha256: string
) {
  if (bytes.length > CLOSURE_EVIDENCE_BUNDLE_MAX_BYTES) {
    throw conflict(
      "CLOSURE_EVIDENCE_PACKAGE_SIZE_LIMIT_EXCEEDED",
      "证据包超过 96 MiB 校验上限。"
    );
  }
  if (sha256(bytes) !== expectedFileSha256) {
    throw conflict(
      "CLOSURE_EVIDENCE_PACKAGE_FILE_HASH_MISMATCH",
      "证据包文件摘要校验失败。"
    );
  }
  let parsed: Record<string, unknown>;
  try {
    parsed = asRecord(JSON.parse(bytes.toString("utf8")));
  } catch {
    throw conflict("CLOSURE_EVIDENCE_PACKAGE_INVALID", "证据包格式无效。");
  }
  if (
    parsed.bundleFormat !== "SUBSCRIPTION_CLOSURE_EVIDENCE_BUNDLE_V1" ||
    parsed.manifestHash !== expectedManifestHash ||
    evidencePackageManifestHash(parsed.manifest) !== expectedManifestHash
  ) {
    throw conflict(
      "CLOSURE_EVIDENCE_PACKAGE_MANIFEST_HASH_MISMATCH",
      "证据包清单摘要校验失败。"
    );
  }
  const manifestArtifacts = Array.isArray(asRecord(parsed.manifest).artifacts)
    ? (asRecord(parsed.manifest).artifacts as unknown[]).map(asRecord)
    : [];
  const bundledArtifacts = Array.isArray(parsed.artifacts)
    ? parsed.artifacts.map(asRecord)
    : [];
  if (manifestArtifacts.length !== bundledArtifacts.length) {
    throw conflict("CLOSURE_EVIDENCE_PACKAGE_ARTIFACT_MISMATCH", "证据包附件清单不完整。");
  }
  for (const artifact of bundledArtifacts) {
    const dataBase64 = typeof artifact.dataBase64 === "string" ? artifact.dataBase64 : "";
    const artifactBytes = Buffer.from(dataBase64, "base64");
    const descriptor = manifestArtifacts.find((item) => item.fileId === artifact.fileId);
    if (
      !descriptor ||
      !isSha256(artifact.sha256) ||
      sha256(artifactBytes) !== artifact.sha256 ||
      artifactBytes.length !== artifact.sizeBytes ||
      canonicalSubscriptionClosureJson(descriptor as never) !==
        canonicalSubscriptionClosureJson(
          {
            fileId: artifact.fileId,
            mimeType: artifact.mimeType,
            originalName: artifact.originalName,
            roles: artifact.roles,
            sha256: artifact.sha256,
            sizeBytes: artifact.sizeBytes
          } as never
        )
    ) {
      throw conflict(
        "CLOSURE_EVIDENCE_PACKAGE_ARTIFACT_MISMATCH",
        `证据包附件 ${String(artifact.fileId ?? "unknown")} 校验失败。`
      );
    }
  }
  return parsed;
}

function sha256(value: string | Buffer) {
  return createHash("sha256").update(value).digest("hex");
}

function isSha256(value: unknown): value is string {
  return typeof value === "string" && /^[0-9a-f]{64}$/i.test(value);
}

function asRecord(value: unknown): Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
}

function validTimestamp(value: unknown) {
  if (value instanceof Date) return Number.isFinite(value.getTime());
  return typeof value === "string" && Number.isFinite(Date.parse(value));
}

export function assertEvidencePackageArtifactSizeBudget(
  artifactFiles: readonly Readonly<{ file: Readonly<{ id: string; sizeBytes: bigint }> }>[]
) {
  let total = 0n;
  for (const { file } of artifactFiles) {
    if (file.sizeBytes < 0n || file.sizeBytes > BigInt(CLOSURE_EVIDENCE_ARTIFACT_MAX_BYTES)) {
      throw conflict(
        "CLOSURE_EVIDENCE_ARTIFACT_SIZE_LIMIT_EXCEEDED",
        `证据文件 ${file.id} 超过 32 MiB 导出上限。`
      );
    }
    total += file.sizeBytes;
    if (total > BigInt(CLOSURE_EVIDENCE_ARTIFACTS_TOTAL_MAX_BYTES)) {
      throw conflict(
        "CLOSURE_EVIDENCE_PACKAGE_SIZE_LIMIT_EXCEEDED",
        "证据附件总量超过 64 MiB 导出上限，请减少重复附件后重试。"
      );
    }
  }
}

async function streamBuffer(stream: NodeJS.ReadableStream, maxBytes: number) {
  const chunks: Buffer[] = [];
  let total = 0;
  for await (const chunk of stream) {
    const bytes = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    total += bytes.length;
    if (total > maxBytes) {
      throw conflict(
        "CLOSURE_EVIDENCE_PACKAGE_SIZE_LIMIT_EXCEEDED",
        "证据文件实际大小超过允许上限，已中止读取。"
      );
    }
    chunks.push(bytes);
  }
  return Buffer.concat(chunks, total);
}

function exportInProgress() {
  return conflict(
    "CLOSURE_EVIDENCE_PACKAGE_EXPORT_IN_PROGRESS",
    "相同证据包正在固化，请稍后重试。"
  );
}

function conflict(code: string, message: string) {
  return new ConflictException({ code, message });
}

function project(record: Readonly<Record<string, unknown>>, replayed: boolean) {
  return {
    exportId: record.id,
    fileId: record.fileId,
    manifestHash: record.manifestHash,
    replayed,
    version: record.version
  };
}
