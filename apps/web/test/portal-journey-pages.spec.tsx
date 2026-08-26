import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";

import { PortalJourneyNextActionCard } from "../src/components/portal/portal-journey-next-action-card";
import type { PortalSubscriptionJourney } from "../src/lib/portal-journey-view-model";

describe("Portal journey pages", () => {
  it("renders at most one primary customer CTA", () => {
    const html = renderToStaticMarkup(
      <PortalJourneyNextActionCard
        applicationId="application-1"
        initialJourney={journey()}
      />
    );

    expect(html).toContain('data-testid="portal-journey-next-action"');
    expect(html.match(/确认最终方案/g)).toHaveLength(1);
    expect(html).not.toMatch(/signUrl|prepay|providerPayload/i);
  });

  it("embeds the shared card and preserves the displayed plan revision", () => {
    const application = source("../src/app/portal/applications/[id]/page.tsx");
    const order = source("../src/app/portal/orders/[id]/page.tsx");
    const contract = source("../src/app/portal/contracts/[id]/page.tsx");

    expect(application).toContain("<PortalJourneyNextActionCard");
    expect(application).toContain(
      "buildPortalFinalPlanConfirmationRequest("
    );
    expect(application).toContain("finalPlan.finalPlanCommercialHash");
    expect(order).toContain("<PortalJourneyNextActionCard");
    expect(order).toContain('id="bills"');
    expect(contract).toContain("<PortalJourneyNextActionCard");
    expect(contract).toContain("orderId={contract.order.id}");
  });

  it("uses visibility-aware bounded polling only when the API marks it enabled", () => {
    const component = source(
      "../src/components/portal/portal-journey-next-action-card.tsx"
    );

    expect(component).toContain('document.visibilityState !== "visible"');
    expect(component).toContain("pollCountRef.current >= journey.polling.maxAttempts");
    expect(component).toContain("journey?.polling.enabled");
  });
});

function source(relativePath: string) {
  return readFileSync(fileURLToPath(new URL(relativePath, import.meta.url)), "utf8");
}

function journey(): PortalSubscriptionJourney {
  return {
    blockerText: null,
    currentStepCode: "CUSTOMER_PLAN_CONFIRMATION",
    currentStepStatus: "WAITING_CUSTOMER",
    finalPlanRevision: 3,
    id: "journey-1",
    links: {
      application: "/portal/applications/application-1",
      bills: [],
      contract: null,
      contractSign: null,
      order: null
    },
    nextAction: {
      href: "/portal/applications/application-1",
      label: "确认最终方案",
      type: "CONFIRM_FINAL_PLAN"
    },
    polling: { enabled: false, intervalMs: 5000, maxAttempts: 24 },
    status: "WAITING_CUSTOMER",
    version: 1
  };
}
