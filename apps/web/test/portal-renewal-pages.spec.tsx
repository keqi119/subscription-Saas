import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

const repoRoot = join(__dirname, "..", "..", "..");

function readOptional(path: string) {
  try {
    return readFileSync(join(repoRoot, path), "utf8");
  } catch {
    return "";
  }
}

describe("Portal renewal pages", () => {
  const applications = readOptional("apps/web/src/app/portal/applications/page.tsx");
  const renewals = readOptional("apps/web/src/app/portal/renewals/page.tsx");
  const renewalDetail = readOptional("apps/web/src/app/portal/renewals/[id]/page.tsx");
  const changeDetail = readOptional("apps/web/src/app/portal/subscription-changes/[id]/page.tsx");

  it("keeps a D-30 renewal card in My Applications with a direct journey link", () => {
    expect(applications).toContain("listPortalRenewals");
    expect(applications).toContain("续订与到期安排");
    expect(applications).toContain("/portal/renewals/");
  });

  it("renders renewal list and mutually exclusive RENEW or EXPIRE decisions", () => {
    expect(renewals).toContain("listPortalRenewals");
    expect(renewalDetail).toContain('decision: "RENEW"');
    expect(renewalDetail).toContain('decide("RENEW")');
    expect(renewalDetail).toContain('decide("EXPIRE")');
    expect(renewalDetail).toContain('detail.allowedActions.includes("RENEW")');
    expect(renewalDetail).toContain('detail.allowedActions.includes("EXPIRE")');
    expect(renewalDetail).toContain("detail.featureAvailability.enabled");
    expect(renewalDetail).toContain("申请续订");
    expect(renewalDetail).toContain("到期结束");
  });

  it("confirms the exact quote revision, records rejection reason and refreshes stale 409 state", () => {
    expect(changeDetail).toContain("confirmPortalRenewalQuote");
    expect(changeDetail).toContain("rejectPortalRenewalQuote");
    expect(changeDetail).toContain("currentQuote.revision");
    expect(changeDetail).toContain("拒绝原因");
    expect(changeDetail).toContain("error.status === 409");
    expect(changeDetail).toContain("await loadChange()");
  });

  it("shows the supplemental agreement and routes signing through the existing contract page", () => {
    expect(changeDetail).toContain("补充协议");
    expect(changeDetail).toContain("/portal/contracts/");
    expect(changeDetail).toContain("等待签署归档");
  });

  it("uses responsive cards without horizontal table overflow", () => {
    for (const source of [renewals, renewalDetail, changeDetail]) {
      expect(source).toContain("maxWidth: 920");
      expect(source).not.toContain("<Table");
      expect(source).not.toContain("scroll={{ x:");
    }
  });
});
