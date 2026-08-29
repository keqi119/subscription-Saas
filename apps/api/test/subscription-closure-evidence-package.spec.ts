import { Readable } from "node:stream";
import { describe, expect, it, vi } from "vitest";

import {
  assertEvidencePackageArtifactSizeBudget,
  authoritativeArtifactSha256,
  authoritativeSignedContractAuditHash,
  buildEvidencePackageBundle,
  evidencePackageManifestHash,
  redactEvidencePackage,
  SubscriptionClosureEvidencePackageService,
  verifyEvidencePackageBundle
} from "../src/subscription-closure/subscription-closure-evidence-package.service";
import { createHash } from "node:crypto";

describe("subscription closure evidence package", () => {
  it("accepts a signed contract hash only from the archived contract audit", () => {
    const hash = "a".repeat(64);
    const contract = {
      archivedAt: new Date("2026-08-28T00:00:00.000Z"),
      fileId: "file-1",
      id: "contract-1",
      signedAt: new Date("2026-08-27T00:00:00.000Z"),
      status: "ARCHIVED"
    };
    const trustedAudit = {
      action: "APPROVE",
      afterSnapshot: { fileId: "file-1", signedPdfHash: hash, status: "ARCHIVED" },
      entityId: "contract-1",
      entityType: "contract"
    };

    expect(authoritativeSignedContractAuditHash(contract, [trustedAudit])).toBe(hash);
    expect(
      authoritativeSignedContractAuditHash(contract, [
        { ...trustedAudit, entityId: "another-contract" }
      ])
    ).toBeNull();
    expect(
      authoritativeSignedContractAuditHash(contract, [
        { ...trustedAudit, afterSnapshot: { fileId: "file-2", signedPdfHash: hash } }
      ])
    ).toBeNull();
    expect(
      authoritativeSignedContractAuditHash(
        { ...contract, archivedAt: null, status: "SIGNED" },
        [trustedAudit]
      )
    ).toBeNull();
  });

  it("rejects oversized artifact metadata before downloading evidence bytes", () => {
    expect(() => assertEvidencePackageArtifactSizeBudget([
      { file: { id: "file-too-large", sizeBytes: 32n * 1024n * 1024n + 1n } }
    ])).toThrow("超过 32 MiB");
    expect(() => assertEvidencePackageArtifactSizeBudget([
      { file: { id: "file-1", sizeBytes: 32n * 1024n * 1024n } },
      { file: { id: "file-2", sizeBytes: 32n * 1024n * 1024n } },
      { file: { id: "file-3", sizeBytes: 1n } }
    ])).toThrow("总量超过 64 MiB");
  });

  it("hashes the same litigation manifest deterministically", () => {
    const first = {
      chargeLines: [{ amountCents: 1200n, id: "line-1" }],
      evidence: [{ contentSha256: "a".repeat(64), id: "evidence-1" }]
    };
    const second = {
      evidence: [{ id: "evidence-1", contentSha256: "a".repeat(64) }],
      chargeLines: [{ id: "line-1", amountCents: 1200n }]
    };
    expect(evidencePackageManifestHash(redactEvidencePackage(first))).toBe(
      evidencePackageManifestHash(redactEvidencePackage(second))
    );
  });

  it("removes provider payloads, credentials and unrelated direct identifiers", () => {
    expect(
      redactEvidencePackage({
        callbackPayload: { token: "secret" },
        customer: { idNumber: "secret-id", mobile: "13800000000", name: "allowed" },
        providerPayload: { accessKeySecret: "secret" },
        safe: { contentSha256: "a".repeat(64) }
      })
    ).toEqual({
      customer: { name: "allowed" },
      safe: { contentSha256: "a".repeat(64) }
    });
  });

  it("removes credentials from legacy external references even when the field name is not URL-shaped", () => {
    expect(
      redactEvidencePackage({
        legacyExternalReference:
          "https://user:password@legacy.test/return/photo.jpg?token=secret#proof"
      })
    ).toEqual({ legacyExternalReference: "https://legacy.test/return/photo.jpg" });
  });

  it("requires persisted authority hashes for signed contracts and financial proofs", () => {
    const hash = "a".repeat(64);
    expect(
      authoritativeArtifactSha256(null, hash, ["FINANCIAL_DISPOSITION_PROOF"], "file-1")
    ).toBe(hash);
    expect(() =>
      authoritativeArtifactSha256(null, null, ["SIGNED_SUBSCRIPTION_CONTRACT"], "file-2")
    ).toThrow("authority hash");
    expect(() =>
      authoritativeArtifactSha256("a".repeat(64), "b".repeat(64), ["RETURN_EVIDENCE"], "file-3")
    ).toThrow("conflicting authority hashes");
  });

  it("builds a self-contained bundle and rejects artifact tampering", () => {
    const artifactBytes = Buffer.from("signed return manifest", "utf8");
    const artifactHash = digest(artifactBytes);
    const manifest = {
      artifacts: [
        {
          fileId: "file-1",
          mimeType: "application/pdf",
          originalName: "return-signed.pdf",
          roles: ["RETURN_MANIFEST_SIGNED"],
          sha256: artifactHash,
          sizeBytes: artifactBytes.length
        }
      ],
      case: { id: "case-1" },
      version: 2
    };
    const manifestHash = evidencePackageManifestHash(manifest);
    const bundle = buildEvidencePackageBundle({
      artifacts: [
        {
          ...manifest.artifacts[0]!,
          dataBase64: artifactBytes.toString("base64")
        }
      ],
      manifest,
      manifestHash,
      version: 1
    });

    expect(verifyEvidencePackageBundle(bundle, manifestHash, digest(bundle))).toMatchObject({
      bundleFormat: "SUBSCRIPTION_CLOSURE_EVIDENCE_BUNDLE_V1",
      manifestHash
    });

    const tampered = Buffer.from(bundle.toString("utf8").replace("c2lnbmVk", "dGFtcGVy"));
    expect(() => verifyEvidencePackageBundle(tampered, manifestHash, digest(tampered))).toThrow(
      "证据包附件"
    );
  });

  it("recovers an ambiguous successful commit without deleting the authoritative object", async () => {
    const manifest = { artifacts: [], case: { id: "case-1" }, version: 2 };
    const manifestHash = evidencePackageManifestHash(manifest);
    const reservation = {
      createdAt: new Date(),
      fileId: null,
      fileSha256: null,
      id: "export-1",
      manifestHash,
      version: 1
    };
    let storedBytes: Buffer<ArrayBufferLike> = Buffer.alloc(0);
    let committed: Record<string, unknown> | null = null;
    let transactionCount = 0;
    const deleteObject = vi.fn(async () => undefined);
    const prisma = {
      $transaction: vi.fn(async (callback: (tx: Record<string, unknown>) => Promise<unknown>) => {
        transactionCount += 1;
        if (transactionCount === 1) {
          return callback({
            $queryRaw: vi.fn(async () => []),
            subscriptionClosureEvidencePackageExport: {
              aggregate: vi.fn(async () => ({ _max: { version: 0 } })),
              create: vi.fn(async () => reservation),
              findUnique: vi.fn(async () => null)
            }
          });
        }
        await callback({
          fileObject: { create: vi.fn(async () => ({ id: "file-1" })) },
          subscriptionClosureEvidencePackageExport: {
            update: vi.fn(async ({ data }: { data: { fileSha256: string } }) => {
              committed = {
                ...reservation,
                file: {
                  bucket: "private",
                  id: "file-1",
                  mimeType: "application/vnd.subscription-closure.evidence-bundle+json",
                  objectKey: "bundle.json",
                  originalName: "bundle.json"
                },
                fileId: "file-1",
                fileSha256: data.fileSha256
              };
              return committed;
            })
          }
        });
        throw new Error("connection lost after COMMIT");
      }),
      subscriptionClosureEvidencePackageExport: {
        deleteMany: vi.fn(async () => ({ count: 0 })),
        findUnique: vi.fn(async (query: { where: Record<string, unknown> }) =>
          "id" in query.where ? committed : null
        )
      }
    };
    const storage = {
      deleteObject,
      getObject: vi.fn(async () => ({ stream: Readable.from(storedBytes) })),
      putSubscriptionClosureEvidencePackage: vi.fn(
        async ({ buffer }: { buffer: Buffer }) => {
          storedBytes = buffer;
          return { bucket: "private", objectKey: "bundle.json", stored: {} };
        }
      )
    };
    const service = new SubscriptionClosureEvidencePackageService(
      prisma as never,
      storage as never
    );
    Object.assign(service as unknown as Record<string, unknown>, {
      buildManifestSnapshot: vi.fn(async () => ({ artifactFiles: [], manifest })),
      prepareCurrentPackage: vi.fn(async () => ({
        artifacts: [],
        baseManifestHash: manifestHash,
        manifest
      }))
    });

    await expect(service.export("case-1", "actor-1")).resolves.toMatchObject({
      exportId: "export-1",
      fileId: "file-1",
      replayed: false
    });
    expect(deleteObject).not.toHaveBeenCalled();
  });
});

function digest(value: Buffer) {
  return createHash("sha256").update(value).digest("hex");
}
