import { readFileSync } from "node:fs";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

import {
  getFadadaBlockingMessage,
  getFadadaNextActionLabel,
  getFadadaReadinessAvailability,
  getFadadaReadinessTone,
  type FadadaOnboardingReadiness
} from "../src/lib/fadada-onboarding-ui";

const repoRoot = join(__dirname, "..", "..", "..");

describe("Fadada onboarding UI helpers", () => {
  it("maps cert-bound blocking into the customer-facing readiness message", () => {
    expect(getFadadaBlockingMessage({
      blockingCode: "FADADA_CERT_NOT_BOUND",
      readyForSigning: false
    })).toBe("请先完成法大大实名认证并绑定实名证书");
  });

  it("uses bind-cert guidance for the APPLY_CERT next action instead of restarting real-name", () => {
    const readiness: FadadaOnboardingReadiness = {
      blockingCode: "FADADA_CERT_NOT_BOUND",
      nextAction: "APPLY_CERT",
      readyForSigning: false,
      realNameProviderVerified: true
    };

    expect(getFadadaBlockingMessage(readiness)).toBe("实名已完成，请刷新并绑定法大大实名证书");
    expect(getFadadaNextActionLabel(readiness)).toBe("刷新并绑定实名证书");
    expect(getFadadaNextActionLabel(readiness)).not.toBe("去完成实名认证");
  });

  it("keeps manual provider-id attachments blocked for signing", () => {
    const readiness: FadadaOnboardingReadiness = {
      blockingCode: "FADADA_MANUAL_ONLY_NOT_SIGNING_READY",
      readyForSigning: false
    };

    expect(getFadadaBlockingMessage(readiness)).toContain("缺少供应商实名与证书绑定证据");
    expect(getFadadaReadinessAvailability(readiness)).toEqual({
      allowed: false,
      reason: expect.stringContaining("缺少供应商实名与证书绑定证据")
    });
  });

  it("returns a positive action state only when provider readiness is signing-enabled", () => {
    expect(getFadadaReadinessTone({ blockingCode: null, readyForSigning: true })).toBe("success");
    expect(getFadadaReadinessAvailability({ blockingCode: null, readyForSigning: true })).toEqual({
      allowed: true
    });
  });

  it("chooses start, continue and refresh labels from the next action", () => {
    expect(getFadadaNextActionLabel({ nextAction: "START_REALNAME_VERIFICATION", readyForSigning: false })).toBe("去完成实名认证");
    expect(getFadadaNextActionLabel({ nextAction: "WAIT_REALNAME_CALLBACK", readyForSigning: false })).toBe("继续实名认证");
    expect(getFadadaNextActionLabel({ nextAction: "QUERY_PROVIDER_STATUS", readyForSigning: false })).toBe("刷新认证状态");
  });
});

describe("Fadada onboarding page wiring", () => {
  it("wires Portal contract signing through onboarding status, start and refresh endpoints", () => {
    const source = read("apps/web/src/app/portal/contracts/[id]/page.tsx");

    expect(source).toContain("/portal/esign-onboarding/status");
    expect(source).toContain("/portal/esign-onboarding/real-name");
    expect(source).toContain("/portal/esign-onboarding/refresh");
    expect(source).toContain("getFadadaBlockingMessage");
    expect(source).toContain("getFadadaReadinessAvailability");
  });

  it("wires Admin contract e-sign action through customer onboarding readiness", () => {
    const source = read("apps/web/src/app/contracts/[id]/page.tsx");

    expect(source).toContain("esign-onboarding/status");
    expect(source).toContain("esign-onboarding/refresh");
    expect(source).toContain("getFadadaBlockingMessage");
    expect(source).toContain("getFadadaReadinessAvailability");
  });
});

describe("Identity profile application gates", () => {
  it("wires Portal profile completion through the profile endpoint without rendering full ID numbers", () => {
    const source = read("apps/web/src/app/portal/me/page.tsx");

    expect(source).toContain("/portal/profile");
    expect(source).toContain("idCardNo");
    expect(source).toContain("idCardNoMasked");
    expect(source).toContain("profileComplete");
  });

  it("keeps Portal profile search params behind Suspense for production prerender", () => {
    const source = read("apps/web/src/app/portal/me/page.tsx");

    expect(source).toContain("Suspense");
    expect(source).toContain("function PortalMeContent");
    expect(source).toContain("<PortalMeContent />");
    expect(source.indexOf("<Suspense")).toBeLessThan(source.indexOf("<PortalMeContent />"));
  });

  it("blocks Portal catalog submission through profile precheck before application creation", () => {
    const source = read("apps/web/src/app/portal/catalog/[id]/page.tsx");

    expect(source).toContain("profileComplete === false");
    expect(source).toContain("missingProfileFields");
    expect(source).toContain("/portal/me?redirect=");
  });

  it("collects customer identity fields in the assisted application modal", () => {
    const source = read("apps/web/src/app/applications/page.tsx");

    expect(source).toContain("customerIdentity");
    expect(source).toContain("idCardNo");
    expect(source).toContain("身份证号");
    expect(source).toContain("^\\d{17}[\\dXx]$");
  });
});

function read(file: string) {
  return readFileSync(join(repoRoot, file), "utf8");
}
