import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

describe("portal subscription return settlement", () => {
  it("binds one customer response to the exact final revision and retains active payment", () => {
    const source = readFileSync(
      join(
        __dirname,
        "../../../apps/web/src/components/subscription-closure/portal-return-settlement-panel.tsx"
      ),
      "utf8"
    );
    expect(source).toContain("settlementHash: closure.settlement.resultHash");
    expect(source).toContain("settlementRevisionId: closure.settlement.id");
    expect(source).toContain("确认同意最终方案");
    expect(source).toContain("提交逐项争议");
    expect(source).toContain("uploadPortalSubscriptionClosureDisputeEvidence");
    expect(source).toContain("争议理由与证明");
    expect(source).toContain("evidenceIds: [uploaded.evidenceId]");
    expect(source).toContain("支付无争议账单");
    expect(source).toContain("CUSTOMER_VISIBLE");
    expect(source).not.toContain("approvalComment");
    expect(source).not.toContain("providerPayload");
  });
});
