import {
  ContractStatus,
  DeliveryHandoverStatus
} from "@prisma/client";
import { describe, expect, it } from "vitest";

import {
  STAGE2_HANDOVER_PDF_RENDERER_VERSION,
  STAGE2_HANDOVER_SOURCE_ARTIFACT_VERSION,
  validateStage2SourceArtifactBinding
} from "../src/handover-work-order/stage2-handover-source-artifact";

describe("Stage 2 source artifact renderer binding", () => {
  it("accepts a historical active-task binding unless a current renderer is explicitly required", () => {
    const fixture = sourceBindingFixture({
      artifactVersion: 1,
      rendererVersion: null
    });

    expect(
      validateStage2SourceArtifactBinding(fixture.input)
    ).toMatchObject({
      artifactVersion: 1,
      rendererVersion: null
    });
    expect(
      validateStage2SourceArtifactBinding({
        ...fixture.input,
        expectedArtifactVersion: STAGE2_HANDOVER_SOURCE_ARTIFACT_VERSION,
        expectedRendererVersion: STAGE2_HANDOVER_PDF_RENDERER_VERSION
      })
    ).toBeNull();
  });

  it("accepts the current source and renderer versions for unsigned reuse", () => {
    const fixture = sourceBindingFixture({
      artifactVersion: STAGE2_HANDOVER_SOURCE_ARTIFACT_VERSION,
      rendererVersion: STAGE2_HANDOVER_PDF_RENDERER_VERSION
    });

    expect(
      validateStage2SourceArtifactBinding({
        ...fixture.input,
        expectedArtifactVersion: STAGE2_HANDOVER_SOURCE_ARTIFACT_VERSION,
        expectedRendererVersion: STAGE2_HANDOVER_PDF_RENDERER_VERSION
      })
    ).toMatchObject({
      artifactVersion: STAGE2_HANDOVER_SOURCE_ARTIFACT_VERSION,
      rendererVersion: STAGE2_HANDOVER_PDF_RENDERER_VERSION
    });
  });
});

function sourceBindingFixture(input: {
  artifactVersion: number;
  rendererVersion: number | null;
}) {
  const manifestHash = "a".repeat(64);
  const sourcePdfHash = "b".repeat(64);
  const fileObject = {
    bucket: "application-materials",
    id: "file-1",
    mimeType: "application/pdf",
    objectKey: "contracts/contract-1/generated/handover.pdf",
    sizeBytes: 1024
  };
  const stage2HandoverPdfArtifact = {
    artifactVersion: input.artifactVersion,
    fileId: fileObject.id,
    sourcePdfHash,
    ...(input.rendererVersion === null
      ? {}
      : { rendererVersion: input.rendererVersion })
  };
  const handover = {
    artifactVersion: input.artifactVersion,
    handoverContract: {
      contractSnapshot: {
        evidencePackage: { manifestHash },
        fileId: fileObject.id,
        handoverId: "handover-1",
        orderId: "order-1",
        stage2HandoverPdfArtifact,
        workOrderId: "work-order-1"
      },
      customerId: "customer-1",
      deletedAt: null,
      fileId: fileObject.id,
      id: "contract-1",
      orderId: "order-1",
      status: ContractStatus.GENERATED
    },
    handoverContractId: "contract-1",
    id: "handover-1",
    manifestHash,
    orderId: "order-1",
    sourceDocumentFileId: fileObject.id,
    sourceObjectKey: fileObject.objectKey,
    sourcePdfHash,
    status: DeliveryHandoverStatus.SOURCE_GENERATED
  };
  return {
    input: {
      expectedCustomerId: "customer-1",
      expectedHandoverId: handover.id,
      expectedManifestHash: manifestHash,
      expectedOrderId: handover.orderId,
      expectedWorkOrderId: "work-order-1",
      fileObject,
      handover,
      maxSizeBytes: 18 * 1024 * 1024
    }
  };
}
