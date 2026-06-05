import fs from "node:fs";
import path from "node:path";

import { describe, expect, it } from "vitest";

describe("customer self-service review order seed", () => {
  const seedSource = fs.readFileSync(path.resolve(__dirname, "../prisma/seed.mjs"), "utf8");

  it("creates an idempotent A-line review order for manual acceptance", () => {
    for (const marker of [
      "A线自助下单测试客户",
      "13900000051",
      "TESTAUTOORDERET5001",
      "A线ET5标准订阅套餐",
      "ORD-AUTO-REVIEW-ET5-001"
    ]) {
      expect(seedSource).toContain(marker);
    }

    expect(seedSource).toContain("async function seedCustomerSelfServiceReviewOrder");
    expect(seedSource).toContain("await seedCustomerSelfServiceReviewOrder(adminUser.id)");
    expect(seedSource).toContain("prisma.subscriptionOrder.upsert");
    expect(seedSource).toContain("where: { orderNo: autoReviewSeed.orderNo }");
    expect(seedSource).toContain('orderSource: "CUSTOMER_SELF_SERVICE"');
    expect(seedSource).toContain('orderStatus: "PENDING_REVIEW"');
    expect(seedSource).toContain('creditReviewStatus: "PENDING"');
    expect(seedSource).toContain('productReviewStatus: "PENDING"');
    expect(seedSource).toContain('vehicleReviewStatus: "PENDING"');
    expect(seedSource).toContain('depositStatus: "PENDING_CONFIRM"');
    expect(seedSource).toContain("finalDepositAmount: null");
    expect(seedSource).toContain('status: "REVIEW_RESERVED"');
    expect(seedSource).toContain('reviewType: "INITIAL_POOL"');
    expect(seedSource).toContain('monthlyFeeMode: "FIXED_AMOUNT"');
    expect(seedSource).not.toContain('monthlyFeeMode: "MANUAL_QUOTE"');
  });

  it("creates an idempotent self-service application review scenario", () => {
    const functionSource = functionSourceFor("seedSelfServiceApplicationReviewScenario");

    for (const marker of [
      "selfServiceApplicationReviewSeed",
      "APP-SELF-SERVICE-REVIEW-001",
      "13900000052",
      "TESTSELFAPPET5001",
      "VEH-SELF-SERVICE-APP-ET5-001"
    ]) {
      expect(seedSource).toContain(marker);
    }

    expect(seedSource).toContain("await seedSelfServiceApplicationReviewScenario(adminUser.id)");
    expect(functionSource).toContain("prisma.subscriptionPlan.findUniqueOrThrow");
    expect(functionSource).toContain("where: { planNo: autoReviewSeed.planNo }");
    expect(functionSource).toContain("prisma.customer.upsert");
    expect(functionSource).toContain("where: { customerNo: selfServiceApplicationReviewSeed.customerNo }");
    expect(functionSource).toContain("prisma.vehicle.upsert");
    expect(functionSource).toContain("where: { vin: selfServiceApplicationReviewSeed.vin }");
    expect(functionSource).toContain("prisma.application.upsert");
    expect(functionSource).toContain("where: { applicationNo: selfServiceApplicationReviewSeed.applicationNo }");
    expect(functionSource).toContain('applicationSource: "SELF_SERVICE"');
    expect(functionSource).toContain('status: "SUBMITTED"');
    expect(functionSource).toContain('materialReviewStatus: "PENDING"');
    expect(functionSource).toContain('creditReviewStatus: "PENDING"');
    expect(functionSource).toContain('productReviewStatus: "PENDING"');
    expect(functionSource).toContain('vehicleReviewStatus: "PENDING"');
    expect(functionSource).toContain('depositStatus: "PENDING_CONFIRM"');
    expect(functionSource).toContain('planConfirmStatus: "PENDING"');
    expect(functionSource).toContain("finalDepositAmount: null");
    expect(functionSource).toContain("intentVehicleId: vehicle.id");
    expect(functionSource).toContain("intentSubscriptionPlanId: subscriptionPlan.id");
    expect(functionSource).toContain("intentSnapshot");
    expect(functionSource).toContain("customerSelectedSnapshot");
    expect(functionSource).toContain('status: "REVIEW_RESERVED"');
  });

  it("keeps the self-service application seed before quote and order creation", () => {
    const functionSource = functionSourceFor("seedSelfServiceApplicationReviewScenario");

    expect(functionSource).not.toContain("subscriptionQuote");
    expect(functionSource).not.toContain("subscriptionOrder");
    expect(seedSource).toContain("async function seedCustomerSelfServiceReviewOrder");
    expect(seedSource).toContain("await seedDemoVehicles(adminUser.id)");
  });

  function functionSourceFor(functionName: string) {
    const start = seedSource.indexOf(`async function ${functionName}`);
    expect(start).toBeGreaterThanOrEqual(0);

    const nextFunction = seedSource.indexOf("\nasync function ", start + 1);
    return seedSource.slice(start, nextFunction === -1 ? seedSource.length : nextFunction);
  }
});
