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
});
