import fs from "node:fs";
import path from "node:path";

import { describe, expect, it } from "vitest";

describe("default seed baseline customer and catalog data", () => {
  const seedSource = fs.readFileSync(path.resolve(__dirname, "../prisma/seed.mjs"), "utf8");

  it("does not create default application, quote, order, or contract scenarios", () => {
    for (const oldFunctionName of [
      "seedCustomerSelfServiceReviewOrder",
      "seedSelfServiceApplicationReviewScenario",
      "seedDeliveryHandoverAcceptanceOrders"
    ]) {
      expect(seedSource).not.toContain(oldFunctionName);
    }

    for (const forbiddenCreate of [
      "prisma.application.upsert",
      "prisma.subscriptionQuote.upsert",
      "prisma.subscriptionOrder.upsert",
      "prisma.contract.upsert",
      "prisma.vehicleDelivery.upsert",
      "prisma.vehicleReturn.upsert",
      "prisma.receivableBill.upsert",
      "prisma.paymentRecord.upsert",
      "prisma.paymentWriteOff.upsert",
      "prisma.collectionCase.upsert",
      "prisma.orderEntitlementAccount.upsert"
    ]) {
      expect(seedSource).not.toContain(forbiddenCreate);
    }
  });

  it("keeps default seed entrypoint scoped to cleanup and master data", () => {
    const mainSource = functionSourceFor("main");

    expect(mainSource).toContain("await cleanupDefaultSeedFlowData()");
    expect(mainSource).toContain("await seedDefaultDepositRules(adminUser.id)");
    expect(mainSource).toContain("await seedBaselineSubscriptionCatalog(adminUser.id)");
    expect(mainSource).toContain("await seedBaselineCustomerLeads(adminUser.id)");
    expect(mainSource).toContain("await seedDemoVehicles(adminUser.id)");
    expect(mainSource).not.toContain("seedCustomerSelfServiceReviewOrder");
    expect(mainSource).not.toContain("seedDeliveryHandoverAcceptanceOrders");
  });

  it("keeps clean customer leads without binding applications or orders", () => {
    const leadSource = sourceBetween("const baselineCustomerLeads = [", "const oldDefaultFlowSeedData = {");
    const seedLeadsFunction = functionSourceFor("seedBaselineCustomerLeads");

    for (const marker of [
      "CUS-SEED-LEAD-A-001",
      "CUS-SEED-LEAD-B-001",
      "CUS-SEED-LEAD-C-001",
      "CUS-SEED-LEAD-COMPANY-001",
      'customerType: "COMPANY"',
      'status: "LEAD"'
    ]) {
      expect(seedSource).toContain(marker);
    }
    expect(leadSource).not.toContain("applicationNo");
    expect(leadSource).not.toContain("orderNo");
    expect(seedLeadsFunction).toContain("prisma.customer.upsert");
    expect(seedLeadsFunction).not.toContain("prisma.application");
    expect(seedLeadsFunction).not.toContain("prisma.subscriptionOrder");
  });

  it("keeps active baseline product packages and subscription plan", () => {
    const catalogSource = functionSourceFor("seedBaselineSubscriptionCatalog");

    for (const marker of [
      "PROD-AUTO-ET5",
      "2026-AUTO-REVIEW",
      "VPK-AUTO-ET5-STANDARD",
      "MPK-AUTO-ET5-1500",
      "EPK-AUTO-ET5-POWER",
      "BPK-AUTO-ET5-WASH",
      "PLAN-AUTO-ET5-STANDARD",
      'status: "ACTIVE"',
      'monthlyFeeMode: "FIXED_AMOUNT"'
    ]) {
      expect(seedSource).toContain(marker);
    }

    for (const upsert of [
      "prisma.product.upsert",
      "prisma.productVersion.upsert",
      "prisma.productPriceRule.upsert",
      "prisma.vehiclePackage.upsert",
      "prisma.mileagePackage.upsert",
      "prisma.energyPackage.upsert",
      "prisma.benefitPackage.upsert",
      "prisma.subscriptionPlan.upsert"
    ]) {
      expect(catalogSource).toContain(upsert);
    }
  });

  it("keeps seed idempotent for baseline objects", () => {
    expect(seedSource).toContain("skipDuplicates: true");
    expect(seedSource).toContain("prisma.auditLog.findFirst");

    expect(functionSourceFor("seedDefaultDepositRules")).toContain("prisma.depositRule.findFirst");
    expect(functionSourceFor("seedDefaultDepositRules")).toContain("prisma.depositRule.update");
    expect(functionSourceFor("seedDefaultDepositRules")).toContain("prisma.depositRule.create");

    for (const functionName of [
      "seedDefaultUsers",
      "seedBaselineSubscriptionCatalog",
      "seedBaselineCustomerLeads",
      "seedDemoVehicles"
    ]) {
      expect(functionSourceFor(functionName)).toContain(".upsert");
    }
  });

  function functionSourceFor(functionName: string) {
    const start = seedSource.indexOf(`async function ${functionName}`);
    expect(start).toBeGreaterThanOrEqual(0);

    const nextFunction = seedSource.indexOf("\nasync function ", start + 1);
    return seedSource.slice(start, nextFunction === -1 ? seedSource.length : nextFunction);
  }

  function sourceBetween(startMarker: string, endMarker: string) {
    const start = seedSource.indexOf(startMarker);
    const end = seedSource.indexOf(endMarker);

    expect(start).toBeGreaterThanOrEqual(0);
    expect(end).toBeGreaterThan(start);

    return seedSource.slice(start, end);
  }
});
