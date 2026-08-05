import { ESignDocumentType, ESignSigningStage } from "@prisma/client";
import { describe, expect, it } from "vitest";

import { resolveContractESignProfile } from "../src/esign/esign.service";

describe("Stage 3 extension e-sign mapping", () => {
  it("uses a dedicated persisted Stage 3 identity with the proven Stage 1 PDF slot protocol", () => {
    expect(resolveContractESignProfile({ subscriptionChange: { id: "change-1" } })).toEqual({
      documentType: ESignDocumentType.SUBSCRIPTION_EXTENSION_AGREEMENT,
      forceMultiSlot: true,
      providerSigningStage: "STAGE1_CONTRACT",
      signingStage: ESignSigningStage.STAGE3_SUBSCRIPTION_EXTENSION
    });
  });

  it("keeps the original contract mapping unchanged", () => {
    expect(resolveContractESignProfile({ subscriptionChange: null })).toEqual({
      documentType: ESignDocumentType.SUBSCRIPTION_CONTRACT,
      forceMultiSlot: false,
      providerSigningStage: "STAGE1_CONTRACT",
      signingStage: ESignSigningStage.STAGE1_SUBSCRIPTION_CONTRACT
    });
  });
});
