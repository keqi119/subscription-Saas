import { ConfigService } from "@nestjs/config";
import type { Prisma } from "@prisma/client";
import { createHash, randomUUID } from "node:crypto";
import { describe, expect, it } from "vitest";

import { MockESignProvider } from "../src/esign/mock-esign.provider";
import {
  canonicalSubscriptionClosureJson,
  hashSubscriptionClosureSnapshot
} from "../src/subscription-closure/subscription-closure.domain";
import { validateExactReturnManifestSuccessorChain } from "../src/subscription-closure/subscription-closure.service";
import {
  resolveReturnManifestCallbackUrl,
  ReturnManifestESignService
} from "../src/esign/return-manifest-esign.service";

describe("ReturnManifestESignService production surface", () => {
  it("owns start, verified callback completion, and exact finalization", () => {
    expect(ReturnManifestESignService.prototype).toEqual(
      expect.objectContaining({
        finalize: expect.any(Function),
        handleVerifiedCallback: expect.any(Function),
        reconcile: expect.any(Function),
        start: expect.any(Function)
      })
    );
  });

  it("uses the configured local provider for distinct unsigned and signed PDF bytes", async () => {
    const provider = new MockESignProvider(
      new ConfigService({ PORTAL_BASE_URL: "http://localhost:3000" })
    );
    const unsigned = Buffer.from("%PDF-1.7\nRETURN_MANIFEST_UNSIGNED\n", "utf8");
    const sha256 = createHash("sha256").update(unsigned).digest("hex");
    const taskId = randomUUID();
    const taskNo = `ESG-${randomUUID()}`;
    const contractId = randomUUID();
    const customerSignerId = randomUUID();
    const started = await provider.createReturnManifestTask({
      callbackUrl: "http://localhost:4000/esign/callback/mock",
      contractId,
      customer: {
        customerId: randomUUID(),
        name: "Local provider customer",
        phone: "13800000000",
        signerId: customerSignerId
      },
      documentName: "return-manifest-provider.pdf",
      providerSourcePdf: {
        buffer: unsigned,
        fileName: "return-manifest-provider.pdf",
        sha256
      },
      taskId,
      taskNo,
      transactionId: "0123456789abcdef0123456789abcdef"
    });
    await expect(
      provider.reconcileReturnManifestTask?.({
        callbackUrl: "http://localhost:4000/esign/callback/mock",
        contractId,
        customer: {
          customerId: started.customer.providerCustomerId,
          name: "Local provider customer",
          phone: "13800000000",
          signerId: customerSignerId
        },
        documentName: "return-manifest-provider.pdf",
        providerSourcePdf: {
          buffer: unsigned,
          fileName: "return-manifest-provider.pdf",
          sha256
        },
        taskId,
        taskNo,
        transactionId: "0123456789abcdef0123456789abcdef"
      })
    ).resolves.toMatchObject({
      providerEnvelopeId: started.providerEnvelopeId,
      providerTaskId: started.providerTaskId
    });
    await provider.verifyCallback({
      eventType: "RETURN_MANIFEST_CUSTOMER_SIGNED",
      providerTaskId: started.providerTaskId
    });
    const completed = await provider.completeReturnManifestTask({
      contractId: randomUUID(),
      customer: {
        providerCustomerId: started.customer.providerCustomerId,
        providerTransactionId: started.customer.providerTransactionId,
        signerId: customerSignerId
      },
      documentName: "return-manifest-provider.pdf",
      platform: {
        signerId: randomUUID(),
        transactionId: "fedcba9876543210fedcba9876543210"
      },
      providerEnvelopeId: started.providerEnvelopeId,
      providerTaskId: started.providerTaskId,
      providerSourcePdf: unsigned,
      taskId,
      taskNo
    });

    expect(completed.signedPdf.buffer).not.toEqual(unsigned);
    expect(completed.signedPdf.buffer.subarray(0, unsigned.length)).toEqual(unsigned);
    expect(completed.signedPdf.contentType).toBe("application/pdf");
    expect(completed.signedPdf.fileName).toBe("return-manifest-provider-signed.pdf");
    expect(started.rawResponse).toMatchObject({ signingStage: "STAGE6_RETURN_MANIFEST" });
    expect(started.customer).toMatchObject({
      providerTransactionId: "0123456789abcdef0123456789abcdef"
    });
  });

  it("rejects local callback URLs for the production Fadada provider", () => {
    const productionConfig = (apiBaseUrl: string) =>
      new ConfigService({
        API_BASE_URL: apiBaseUrl,
        ESIGN_PROVIDER: "fadada",
        FADADA_APP_ID: "test-app",
        FADADA_APP_SECRET: "test-secret",
        FADADA_BASE_URL: "https://provider.example.com",
        FADADA_ENV: "production"
      });

    let rejected: unknown;
    try {
      resolveReturnManifestCallbackUrl(productionConfig("http://localhost:4000"));
    } catch (error) {
      rejected = error;
    }
    expect(rejected).toMatchObject({
      response: { code: "RETURN_MANIFEST_ESIGN_CALLBACK_URL_INVALID" },
      status: 409
    });
    expect(
      resolveReturnManifestCallbackUrl(productionConfig("https://api.subscription.example.com/"))
    ).toBe("https://api.subscription.example.com/esign/callback/fadada");
  });
});

describe("produced return-manifest task audit chronology", () => {
  it("accepts the complete controlled producer facts with strictly increasing stage times", async () => {
    const h = manifestAuditChronologyFixture(false);
    await expect(
      validateExactReturnManifestSuccessorChain(h.tx, h.closureCase, h.revisions, h.current)
    ).resolves.toBe(true);
    expect(h.taskAuditReadIds).toEqual(h.causalAuditIds);
    expect(h.queryCalls).toEqual(
      expect.arrayContaining([
        "subscriptionClosureEvent",
        "contractESignTask",
        "subscriptionClosureCommandReceipt",
        "fileObject",
        "auditLog"
      ])
    );
  });

  it("accepts shared-millisecond facts when UUID order happens to follow the causal chain", async () => {
    const h = manifestAuditChronologyFixture(true, false);
    await expect(
      validateExactReturnManifestSuccessorChain(h.tx, h.closureCase, h.revisions, h.current)
    ).resolves.toBe(true);
    expect(h.taskAuditReadIds).toEqual(h.causalAuditIds);
  });

  it("accepts the same complete facts when lawful stage times share a millisecond and UUID order reverses causality", async () => {
    const h = manifestAuditChronologyFixture(true);
    const result = await validateExactReturnManifestSuccessorChain(
      h.tx,
      h.closureCase,
      h.revisions,
      h.current
    );
    expect(h.taskAuditReadIds).toEqual([...h.causalAuditIds].reverse());
    expect(result).toBe(true);
  });

  it.each(manifestAuditIdPermutations([51, 52, 53, 54]))(
    "accepts every same-millisecond causal audit UUID permutation %j/%j/%j/%j",
    async (...ids) => {
      const h = manifestAuditChronologyFixture(true, false);
      h.taskAuditRows.forEach((audit, index) => {
        audit.id = `00000000-0000-4000-8000-${String(ids[index]).padStart(12, "0")}`;
      });
      await expect(
        validateExactReturnManifestSuccessorChain(h.tx, h.closureCase, h.revisions, h.current)
      ).resolves.toBe(true);
    }
  );

  it.each(["closed cycle", "UPDATE self-loop"])(
    "rejects a four-row %s even when its last snapshot equals the actual task",
    async (kind) => {
      const h = manifestAuditChronologyFixture(true, false);
      const actual = h.taskAuditRows[3]!.afterSnapshot as ManifestDiagnosticRow;
      const previous = { ...actual, documentName: "controlled previous state" };
      const earlier = { ...actual, documentName: "controlled earlier state" };
      const states =
        kind === "closed cycle"
          ? [actual, previous, earlier, actual]
          : [earlier, previous, actual, actual];
      h.taskAuditRows.forEach((audit, index) => {
        audit.beforeSnapshot = index === 0 ? null : states[index - 1];
        audit.afterSnapshot = states[index];
      });
      await expect(
        validateExactReturnManifestSuccessorChain(h.tx, h.closureCase, h.revisions, h.current)
      ).resolves.toBe(false);
    }
  );

  it.each(manifestAuditChainDamage())("rejects %s", async (_name, damage) => {
    const h = manifestAuditChronologyFixture(true, false);
    damage(h);
    await expect(
      validateExactReturnManifestSuccessorChain(h.tx, h.closureCase, h.revisions, h.current)
    ).resolves.toBe(false);
  });

  it("rejects decreasing semantic times even when every audit time matches its task stage", async () => {
    const h = manifestAuditChronologyFixture(false, false, [0, 20, 10, 30]);
    await expect(
      validateExactReturnManifestSuccessorChain(h.tx, h.closureCase, h.revisions, h.current)
    ).resolves.toBe(false);
  });

  it("rejects a disconnected complete snapshot link with strictly increasing stage times", async () => {
    const h = manifestAuditChronologyFixture(false, false);
    h.taskAuditRows[2]!.beforeSnapshot = { disconnected: true };
    await expect(
      validateExactReturnManifestSuccessorChain(h.tx, h.closureCase, h.revisions, h.current)
    ).resolves.toBe(false);
  });
});

function manifestAuditIdPermutations(values: number[]): number[][] {
  if (values.length === 0) return [[]];
  return values.flatMap((value, index) =>
    manifestAuditIdPermutations(values.filter((_item, other) => index !== other)).map((suffix) => [
      value,
      ...suffix
    ])
  );
}

function manifestAuditChainDamage(): [
  string,
  (h: ReturnType<typeof manifestAuditChronologyFixture>) => void
][] {
  return [
    [
      "a missing audit",
      (h) => {
        h.audits.splice(h.audits.indexOf(h.taskAuditRows[1]!), 1);
      }
    ],
    [
      "an extra audit",
      (h) => {
        h.audits.push({ ...h.taskAuditRows[1], id: "00000000-0000-4000-8000-000000000099" });
      }
    ],
    [
      "duplicate audit IDs",
      (h) => {
        h.taskAuditRows[2]!.id = h.taskAuditRows[1]!.id;
      }
    ],
    [
      "two CREATE roots",
      (h) => {
        h.taskAuditRows[1]!.action = "CREATE";
        h.taskAuditRows[1]!.beforeSnapshot = null;
      }
    ],
    [
      "no CREATE root",
      (h) => {
        h.taskAuditRows[0]!.action = "UPDATE";
      }
    ],
    [
      "a non-null CREATE predecessor",
      (h) => {
        h.taskAuditRows[0]!.beforeSnapshot = {};
      }
    ],
    [
      "two eligible UPDATE successors",
      (h) => {
        h.taskAuditRows[2]!.beforeSnapshot = h.taskAuditRows[0]!.afterSnapshot;
      }
    ],
    [
      "a disconnected UPDATE",
      (h) => {
        h.taskAuditRows[2]!.beforeSnapshot = { disconnected: true };
      }
    ],
    [
      "an unexpected action",
      (h) => {
        h.taskAuditRows[2]!.action = "DELETE";
      }
    ],
    [
      "wrong current task actor",
      (h) => {
        h.taskAuditRows[2]!.operatorId = "00000000-0000-4000-8000-000000000099";
      }
    ],
    [
      "wrong audit entity",
      (h) => {
        h.taskAuditRows[2]!.entityId = "00000000-0000-4000-8000-000000000099";
      }
    ],
    [
      "wrong audit entity type",
      (h) => {
        h.taskAuditRows[2]!.entityType = "other";
      }
    ],
    [
      "wrong audit module",
      (h) => {
        h.taskAuditRows[2]!.module = "other";
      }
    ],
    [
      "non-null audit IP",
      (h) => {
        h.taskAuditRows[2]!.ipAddress = "127.0.0.1";
      }
    ],
    [
      "non-null audit user agent",
      (h) => {
        h.taskAuditRows[2]!.userAgent = "controlled";
      }
    ],
    [
      "wrong immutable source",
      (h) => {
        h.task.sourceId = "00000000-0000-4000-8000-000000000099";
      }
    ],
    [
      "wrong stage audit time",
      (h) => {
        h.taskAuditRows[1]!.createdAt = new Date(
          (h.taskAuditRows[1]!.createdAt as Date).getTime() + 1
        );
      }
    ],
    [
      "a final snapshot different from the actual task",
      (h) => {
        h.taskAuditRows[3]!.afterSnapshot = { final: "different" };
      }
    ],
    [
      "a lifecycle file hash mismatch",
      (h) => {
        h.task.responseSnapshot.signedFileHash = "0".repeat(64);
      }
    ]
  ];
}

type ManifestDiagnosticRow = Record<string, unknown>;

// Controlled IO rows follow the actual producer mappings at reserve/start/
// completion/finalize and repository document/event/receipt writes. This does
// not run the producer, Prisma, storage, provider, clock or a database.
// Both cases use this one factory so all repeated dates and hashes stay bound.
function manifestAuditChronologyFixture(
  sharedMillisecond: boolean,
  reverseAuditIds = true,
  stageOffsets?: [number, number, number, number]
) {
  const id = (value: number) => `00000000-0000-4000-8000-${String(value).padStart(12, "0")}`;
  const at = (offset: number) => new Date(Date.UTC(2026, 8, 26, 10, 0, 0, offset));
  const times = (stageOffsets ?? [0, 10, 20, 30]).map((offset) =>
    at(sharedMillisecond ? 0 : offset)
  );
  const [reservedAt, startedAt, completedAt, finalizedAt] = times as [Date, Date, Date, Date];
  const generatedAt = at(-10);
  const actorId = id(1);
  const closureCase = {
    caseNo: "SC-manifest-audit-diagnostic",
    contractId: id(2),
    customerId: id(3),
    id: id(4),
    orderId: id(5),
    returnAssetWorkOrderId: id(6),
    returnHandoverWorkOrderId: id(7),
    vehicleId: id(8),
    vehicleReturnId: id(9)
  };
  const taskSource = {
    id: closureCase.id,
    key: "return-manifest-esign:diagnostic",
    type: "SUBSCRIPTION_CLOSURE_ESIGN"
  };
  const signedSource = { ...taskSource, key: "return-manifest-signed:diagnostic" };
  const archivedSource = { ...taskSource, key: "return-manifest-archived:diagnostic" };
  const generatedSource = {
    id: closureCase.id,
    key: "generated-manifest:diagnostic",
    type: "SUBSCRIPTION_CLOSURE"
  };
  const documentSnapshot = {
    assetWorkOrderId: closureCase.returnAssetWorkOrderId,
    caseNo: closureCase.caseNo,
    closureCaseId: closureCase.id,
    contractId: closureCase.contractId,
    customerId: closureCase.customerId,
    handoverWorkOrderId: closureCase.returnHandoverWorkOrderId,
    orderId: closureCase.orderId,
    vehicleId: closureCase.vehicleId,
    vehicleReturnId: closureCase.vehicleReturnId
  };
  const documentHash = hashSubscriptionClosureSnapshot(documentSnapshot);
  const signedHash = createHash("sha256").update("controlled signed PDF bytes").digest("hex");
  const providerHash = createHash("sha256").update("controlled unsigned PDF bytes").digest("hex");
  const json = (value: unknown): Record<string, unknown> =>
    JSON.parse(
      JSON.stringify(value, (_key, item) => (typeof item === "bigint" ? item.toString() : item))
    );
  const file = (
    fileId: string,
    createdAt: Date,
    mimeType: string,
    sizeBytes: bigint,
    name: string
  ) => ({
    id: fileId,
    bucket: "subscription-closure",
    createdAt,
    mimeType,
    objectKey: `subscription-closure/${closureCase.id}/${name}`,
    originalName: name,
    sizeBytes,
    uploadedBy: actorId
  });
  const documentSize = BigInt(
    Buffer.byteLength(canonicalSubscriptionClosureJson(documentSnapshot))
  );
  const generatedFile = file(
    id(10),
    generatedAt,
    "application/json",
    documentSize,
    "manifest-r1.json"
  );
  const sourceFile = file(
    id(11),
    reservedAt,
    "application/json",
    documentSize,
    "manifest-source.json"
  );
  const providerFile = file(id(12), reservedAt, "application/pdf", 100n, "manifest-provider.pdf");
  const signedFile = file(id(13), finalizedAt, "application/pdf", 150n, "manifest-signed.pdf");
  const files = [generatedFile, sourceFile, providerFile, signedFile];
  const generatedTaskId = id(14);
  const taskId = id(15);
  const revisions = ["GENERATED", "SIGNED", "ARCHIVED"].map((stage, index) => {
    const source = [generatedSource, signedSource, archivedSource][index]!;
    return {
      id: id(20 + index),
      closureCaseId: closureCase.id,
      documentType: "RETURN_MANIFEST",
      stage,
      revisionNumber: index + 1,
      supersedesRevisionId: index === 0 ? null : id(19 + index),
      documentSnapshot,
      documentSnapshotHash: documentHash,
      sourceFileHash: documentHash,
      sourceFileId: index === 0 ? generatedFile.id : sourceFile.id,
      contractESignTaskId: index === 0 ? generatedTaskId : taskId,
      vehicleReturnId: closureCase.vehicleReturnId,
      handoverWorkOrderId: closureCase.returnHandoverWorkOrderId,
      generatedBy: actorId,
      generatedAt: index === 0 ? generatedAt : finalizedAt,
      createdAt: index === 0 ? generatedAt : finalizedAt,
      signedAt: index === 0 ? null : finalizedAt,
      signedBy: index === 0 ? null : actorId,
      signedFileId: index === 0 ? null : signedFile.id,
      signedFileHash: index === 0 ? null : signedHash,
      archivedAt: index === 2 ? finalizedAt : null,
      archivedBy: index === 2 ? actorId : null,
      sourceId: source.id,
      sourceType: source.type,
      sourceKey: source.key
    };
  }) as Prisma.SubscriptionClosureDocumentRevisionGetPayload<Record<string, never>>[];
  const generated = revisions[0]!;
  const current = {
    closureCaseId: closureCase.id,
    documentRevisionId: revisions[2]!.id,
    documentType: "RETURN_MANIFEST",
    updatedBy: actorId
  };
  const taskBase = {
    callbackSnapshot: null,
    completedAt: null,
    contractId: closureCase.contractId,
    createdAt: reservedAt,
    createdBy: actorId,
    customerId: closureCase.customerId,
    deletedAt: null,
    documentName: providerFile.originalName,
    documentObjectKey: providerFile.objectKey,
    documentType: "RETURN_MANIFEST",
    errorSnapshot: null,
    id: taskId,
    orderId: closureCase.orderId,
    provider: "MOCK",
    providerEnvelopeId: null,
    providerTaskId: null,
    requestSnapshot: {
      actorId,
      archivedSource,
      checklistSnapshot: {},
      caseNo: closureCase.caseNo,
      closureCaseId: closureCase.id,
      documentSnapshot,
      documentSnapshotHash: documentHash,
      documentType: "RETURN_MANIFEST",
      generatedRevisionId: generated.id,
      idempotencyKey: "diagnostic",
      providerSourceFile: json(providerFile),
      providerSourceFileHash: providerHash,
      renderedAt: generatedAt.toISOString(),
      signedSource,
      sourceFile: json(sourceFile),
      sourceFileHash: documentHash,
      taskSource,
      version: 1
    },
    responseSnapshot: null,
    signedDocumentObjectKey: null,
    signingStage: "STAGE6_RETURN_MANIFEST",
    sourceId: taskSource.id,
    sourceKey: taskSource.key,
    sourceType: taskSource.type,
    startedAt: null,
    taskNo: "ESG20260926100000ABCD",
    taskStatus: "CREATED",
    updatedAt: reservedAt,
    updatedBy: actorId
  };
  const providerStart = {
    customer: {
      providerCustomerId: "mock-customer",
      providerSignerId: "mock-signer",
      providerTransactionId: "mock-customer-transaction",
      signUrlExpiresAt: null
    },
    providerEnvelopeId: "mock-envelope",
    providerTaskId: "mock-task"
  };
  const startedTask = {
    ...taskBase,
    startedAt,
    updatedAt: startedAt,
    taskStatus: "WAITING_CUSTOMER",
    providerTaskId: providerStart.providerTaskId,
    providerEnvelopeId: providerStart.providerEnvelopeId,
    responseSnapshot: { providerStart }
  };
  const callbackPayload = {
    eventType: "RETURN_MANIFEST_CUSTOMER_SIGNED",
    providerTaskId: providerStart.providerTaskId
  };
  const providerCompletion = {
    customer: { providerTransactionId: providerStart.customer.providerTransactionId },
    platform: {
      providerSignerId: "mock-platform",
      providerTransactionId: "mock-platform-transaction"
    },
    signedPdf: {
      contentType: "application/pdf",
      fileName: signedFile.originalName,
      sha256: signedHash,
      sizeBytes: signedFile.sizeBytes.toString()
    }
  };
  const { createdAt: _pendingCreatedAt, id: _pendingId, ...pendingFile } = signedFile;
  void _pendingCreatedAt;
  void _pendingId;
  const completedTask = {
    ...startedTask,
    callbackSnapshot: callbackPayload,
    completedAt,
    updatedAt: completedAt,
    signedDocumentObjectKey: signedFile.objectKey,
    taskStatus: "COMPLETED",
    responseSnapshot: {
      providerCompletion,
      providerStart,
      pendingSignedFile: { ...json(pendingFile), hash: signedHash }
    }
  };
  const finalizedTask = {
    ...completedTask,
    updatedAt: finalizedAt,
    responseSnapshot: {
      providerCompletion,
      providerStart,
      signedFile: json(signedFile),
      signedFileHash: signedHash,
      signedFileId: signedFile.id
    }
  };
  const initialSigners = ["CUSTOMER", "PLATFORM"].map((signerType, index) => ({
    id: id(30 + index),
    taskId,
    createdAt: reservedAt,
    updatedAt: reservedAt,
    deletedAt: null,
    customerId: index === 0 ? closureCase.customerId : null,
    documentType: "RETURN_MANIFEST",
    providerActionType: index === 0 ? "CUSTOMER_MANUAL_SIGN" : "PLATFORM_AUTO_SEAL",
    required: true,
    signerName: index === 0 ? "Controlled customer" : "Subscription platform",
    signerPhone: index === 0 ? "13800000000" : null,
    signerStatus: "PENDING",
    signerType,
    slotId: index === 0 ? "RETURN_MANIFEST_CUSTOMER" : "RETURN_MANIFEST_PLATFORM",
    snapshot: { documentType: "RETURN_MANIFEST", source: taskSource },
    providerSignerId: null,
    providerTransactionId: null,
    signedAt: null,
    signUrl: null,
    signUrlExpiresAt: null
  }));
  const signers = initialSigners.map((signer, index) => ({
    ...signer,
    updatedAt: completedAt,
    signedAt: completedAt,
    signerStatus: "SIGNED",
    providerSignerId:
      index === 0
        ? providerStart.customer.providerCustomerId
        : providerCompletion.platform.providerSignerId,
    providerTransactionId:
      index === 0
        ? providerStart.customer.providerTransactionId
        : providerCompletion.platform.providerTransactionId
  }));
  const callback = {
    id: id(32),
    taskId,
    operationKey: `return-manifest:${taskId}:customer-signed`,
    provider: "MOCK",
    providerTaskId: providerStart.providerTaskId,
    providerTransactionId: providerStart.providerTaskId,
    verified: true,
    handled: true,
    handledAt: completedAt,
    receivedAt: completedAt,
    payload: callbackPayload,
    payloadHash: createHash("sha256")
      .update(canonicalSubscriptionClosureJson(callbackPayload))
      .digest("hex")
  };
  const generatedTask = {
    ...taskBase,
    id: generatedTaskId,
    createdAt: generatedAt,
    updatedAt: generatedAt,
    documentName: generatedFile.originalName,
    documentObjectKey: generatedFile.objectKey,
    provider: "OTHER",
    sourceId: generatedSource.id,
    sourceType: generatedSource.type,
    sourceKey: generatedSource.key,
    requestSnapshot: {
      closureCaseId: closureCase.id,
      documentSnapshotHash: documentHash,
      documentType: "RETURN_MANIFEST",
      returnManifestSource: generatedSource,
      revisionNumber: 1,
      sourceFileHash: documentHash,
      sourceFileId: generatedFile.id
    },
    signers: [],
    callbacks: []
  };
  // Sign URLs are nullable columns in the real task; included in the row but
  // omitted from its immutable audit projection, exactly as the producer does.
  const task = {
    ...finalizedTask,
    signUrl: null,
    signUrlExpiresAt: null,
    signers,
    callbacks: [callback]
  };
  const audits: ManifestDiagnosticRow[] = [];
  const audit = (
    auditId: string,
    entityType: string,
    entityId: string,
    createdAt: Date,
    after: unknown,
    before: unknown = null,
    action = "CREATE"
  ) => ({
    id: auditId,
    action,
    entityId,
    entityType,
    module: "subscription_closure",
    operatorId: actorId,
    beforeSnapshot: before === null ? null : json(before),
    afterSnapshot: json(after),
    createdAt,
    ipAddress: null,
    userAgent: null
  });
  for (const [index, f] of [sourceFile, providerFile, signedFile].entries())
    audits.push(audit(id(40 + index), "file_object", f.id, f.createdAt, f));
  for (const [index, signer] of initialSigners.entries())
    audits.push(
      audit(id(43 + index), "contract_esign_signer", signer.id, signer.createdAt, signer)
    );
  const causalAuditIds = [id(51), id(52), id(53), id(54)];
  if (reverseAuditIds) causalAuditIds.reverse();
  const taskStates = [taskBase, startedTask, completedTask, finalizedTask];
  for (const [index, state] of taskStates.entries())
    audits.push(
      audit(
        causalAuditIds[index]!,
        "contract_esign_task",
        taskId,
        times[index]!,
        state,
        index === 0 ? null : taskStates[index - 1],
        index === 0 ? "CREATE" : "UPDATE"
      )
    );
  const events: ManifestDiagnosticRow[] = [];
  const receipts: ManifestDiagnosticRow[] = [];
  // Event/receipt/audit facts use the repository's actual persisted projection
  // shapes, including full payload hashes and immutable revision outcome.
  for (const [index, revision] of revisions.entries()) {
    const source = { id: revision.sourceId, key: revision.sourceKey, type: revision.sourceType };
    const payload = {
      actorId,
      archivedAt: revision.archivedAt,
      archivedBy: revision.archivedBy,
      closureCaseId: closureCase.id,
      contractESignTaskId: revision.contractESignTaskId,
      documentSnapshot,
      documentType: "RETURN_MANIFEST",
      documentRevisionId: revision.id,
      expectedCurrentRevisionId: revision.supersedesRevisionId,
      expectedVersion: index,
      generatedAt: revision.generatedAt,
      handoverWorkOrderId: closureCase.returnHandoverWorkOrderId,
      signedAt: revision.signedAt,
      signedBy: revision.signedBy,
      signedFileHash: revision.signedFileHash,
      signedFileId: revision.signedFileId,
      source,
      sourceFileHash: documentHash,
      sourceFileId: revision.sourceFileId,
      stage: revision.stage,
      vehicleReturnId: closureCase.vehicleReturnId
    };
    const {
      sourceId: _sourceId,
      sourceType: _sourceType,
      sourceKey: _sourceKey,
      ...outcomeFields
    } = revision;
    void _sourceId;
    void _sourceType;
    void _sourceKey;
    const outcome = json({ ...outcomeFields, source });
    const persistedAt = revision.createdAt;
    const eventId = id(60 + index);
    events.push({
      id: eventId,
      actorId,
      closureCaseId: closureCase.id,
      eventType: "DOCUMENT_REVISION_CREATED",
      beforeStatus: "PREPARING_RETURN",
      afterStatus: "PREPARING_RETURN",
      sequence: index + 2,
      sourceId: source.id,
      sourceType: source.type,
      sourceKey: source.key,
      occurredAt: revision.generatedAt,
      recordedAt: persistedAt,
      detailSnapshot: {
        documentRevisionId: revision.id,
        documentType: "RETURN_MANIFEST",
        revisionNumber: index + 1
      }
    });
    receipts.push({
      id: id(70 + index),
      actorId,
      closureCaseId: closureCase.id,
      commandType: "CREATE_DOCUMENT_REVISION",
      eventId,
      sourceId: source.id,
      sourceType: source.type,
      sourceKey: source.key,
      payloadHash: hashSubscriptionClosureSnapshot(payload),
      payloadSnapshot: json(payload),
      outcomeSnapshot: outcome,
      createdAt: persistedAt
    });
    audits.push(
      audit(id(80 + index), "subscription_closure_event", eventId, persistedAt, {
        action: "CREATE_DOCUMENT_REVISION",
        closureCaseId: closureCase.id,
        eventId,
        outcome,
        source
      })
    );
  }
  const taskAuditReadIds: string[] = [];
  const queryCalls: string[] = [];
  const tables: Record<string, ManifestDiagnosticRow[]> = {
    subscriptionClosureEvent: events,
    subscriptionClosureCommandReceipt: receipts,
    contractESignTask: [generatedTask, task],
    fileObject: files,
    auditLog: audits
  };
  const tx = Object.fromEntries(
    Object.entries(tables).map(([name, rows]) => [
      name,
      {
        findMany: async (input: {
          where?: ManifestDiagnosticRow;
          orderBy?: Record<string, "asc" | "desc">[];
        }) => {
          queryCalls.push(name);
          const found = rows.filter((row) => manifestDiagnosticWhere(row, input.where ?? {}));
          for (const order of [...(input.orderBy ?? [])].reverse()) {
            const [field, direction] = Object.entries(order)[0]!;
            found.sort((a, b) => {
              const left = a[field] instanceof Date ? a[field].getTime() : a[field];
              const right = b[field] instanceof Date ? b[field].getTime() : b[field];
              const compared =
                typeof left === "number" && typeof right === "number"
                  ? left - right
                  : left === right
                    ? 0
                    : String(left) < String(right)
                      ? -1
                      : 1;
              return direction === "asc" ? compared : -compared;
            });
          }
          if (name === "auditLog" && input.where?.entityId === taskId)
            taskAuditReadIds.push(...found.map((row) => String(row.id)));
          return structuredClone(found);
        }
      }
    ])
  ) as unknown as Prisma.TransactionClient;
  const taskAuditRows = audits.filter((audit) => audit.entityId === taskId);
  return {
    tx,
    closureCase,
    revisions,
    current,
    causalAuditIds,
    taskAuditReadIds,
    queryCalls,
    audits,
    taskAuditRows,
    task
  };
}

function manifestDiagnosticWhere(
  row: ManifestDiagnosticRow,
  where: ManifestDiagnosticRow
): boolean {
  return Object.entries(where).every(([key, value]) => {
    if (key === "OR")
      return (value as ManifestDiagnosticRow[]).some((item) => manifestDiagnosticWhere(row, item));
    if (value !== null && typeof value === "object") {
      const filter = value as ManifestDiagnosticRow;
      if ("in" in filter) return (filter.in as unknown[]).includes(row[key]);
      if ("startsWith" in filter) return String(row[key]).startsWith(String(filter.startsWith));
      throw new Error(`Unsupported controlled IO predicate: ${key}`);
    }
    return row[key] === value;
  });
}
