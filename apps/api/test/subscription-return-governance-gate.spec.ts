import { describe, expect, it, vi } from "vitest";

import { SubscriptionReturnGovernanceService } from "../src/subscription-closure/subscription-return-governance.service";

function serviceFixture(input: {
  configValue?: string;
  evidenceLinks?: number;
  checklistRevisionId?: string | null;
  missingConfigService?: boolean;
}) {
  const count = vi.fn().mockResolvedValue(0);
  const prisma = {
    businessExceptionApproval: { count },
    contractESignTask: { count },
    subscriptionClosureCase: {
      findUnique: vi.fn().mockResolvedValue({
        currentChecklistRevisionId: input.checklistRevisionId ?? null,
        currentDeltaRevisionId: null,
        id: "closure-1"
      })
    },
    subscriptionClosureChargeLine: { count },
    subscriptionClosureCustomerResponse: { count },
    subscriptionClosureEvidencePackageExport: { count },
    subscriptionClosureLegalCollectionCase: { count },
    subscriptionClosureReceivableDisposition: { count },
    vehicleReturnEvidenceLink: {
      count: vi.fn().mockResolvedValue(input.evidenceLinks ?? 0)
    }
  };
  const service = new SubscriptionReturnGovernanceService(
    prisma as never,
    {} as never,
    undefined,
    undefined,
    undefined,
    undefined,
    input.missingConfigService
      ? undefined
      : ({ get: vi.fn().mockReturnValue(input.configValue) } as never)
  );
  return { prisma, service };
}

describe("subscription return three-stage write gate", () => {
  it("blocks a case with no governed facts while the feature is disabled", async () => {
    const { service } = serviceFixture({ configValue: "false" });
    await expect(service.assertThreeStageWriteAllowed("closure-1")).rejects.toMatchObject({
      response: expect.objectContaining({ code: "SUBSCRIPTION_RETURN_THREE_STAGE_DISABLED" })
    });
  });

  it.each([
    ["a missing ConfigService", { missingConfigService: true }],
    ["an undefined config value", {}],
    ["an empty config value", { configValue: "" }],
    ["a mixed-case config value", { configValue: "True" }],
    ["a whitespace-padded config value", { configValue: " true" }]
  ])("blocks a new governed case with %s", async (_name, fixture) => {
    const { service } = serviceFixture(fixture);
    await expect(service.assertThreeStageWriteAllowed("closure-1")).rejects.toMatchObject({
      response: expect.objectContaining({ code: "SUBSCRIPTION_RETURN_THREE_STAGE_DISABLED" })
    });
  });

  it("lets an existing governed case continue while the feature is disabled", async () => {
    const { service } = serviceFixture({ configValue: "false", evidenceLinks: 1 });
    await expect(service.assertThreeStageWriteAllowed("closure-1")).resolves.toBeUndefined();
  });

  it("does not query case facts while the feature is enabled", async () => {
    const { prisma, service } = serviceFixture({ configValue: "true" });
    await expect(service.assertThreeStageWriteAllowed("closure-1")).resolves.toBeUndefined();
    expect(prisma.subscriptionClosureCase.findUnique).not.toHaveBeenCalled();
  });
});
