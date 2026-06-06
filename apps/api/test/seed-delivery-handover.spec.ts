import fs from "node:fs";
import path from "node:path";

import { describe, expect, it } from "vitest";

describe("delivery handover acceptance seed", () => {
  const seedSource = fs.readFileSync(path.resolve(__dirname, "../prisma/seed.mjs"), "utf8");

  it("defines the Stage 6.1 delivery acceptance orders and vehicles", () => {
    for (const marker of [
      "deliveryHandoverAcceptanceSeeds",
      "ORD-DELIVERY-PREPARE-001",
      "ORD-DELIVERY-CONFIRM-001",
      "交付验收测试客户A",
      "交付验收测试客户B",
      "TESTDELIVERYPREPARE001",
      "TESTDELIVERYCONFIRM001",
      "沪A交付01",
      "沪A交付02"
    ]) {
      expect(seedSource).toContain(marker);
    }
  });

  it("creates idempotent dependencies for delivery-check readable orders", () => {
    const functionSource = functionSourceFor("seedDeliveryHandoverAcceptanceOrders");

    expect(seedSource).toContain("await seedDeliveryHandoverAcceptanceOrders(adminUser.id)");
    expect(functionSource).toContain("prisma.customer.upsert");
    expect(functionSource).toContain("prisma.application.upsert");
    expect(functionSource).toContain("prisma.subscriptionQuote.upsert");
    expect(functionSource).toContain("prisma.subscriptionOrder.upsert");
    expect(functionSource).toContain("prisma.contract.upsert");
    expect(functionSource).toContain("prisma.vehicle.upsert");
    expect(functionSource).toContain("prisma.vehicleDelivery.upsert");
    expect(functionSource).toContain("where: { customerNo: seed.customerNo }");
    expect(functionSource).toContain("where: { applicationNo: seed.applicationNo }");
    expect(functionSource).toContain("where: { quoteNo: seed.quoteNo }");
    expect(functionSource).toContain("where: { orderNo: seed.orderNo }");
    expect(functionSource).toContain("where: { contractNo: seed.contractNo }");
    expect(functionSource).toContain("where: { vin: seed.vin }");
    expect(functionSource).toContain("where: { orderId: order.id }");
  });

  it("keeps both acceptance orders linked to signed contracts and reserved vehicles", () => {
    const functionSource = functionSourceFor("seedDeliveryHandoverAcceptanceOrders");

    expect(functionSource).toContain('orderStatus: seed.deliveryScenario === "CONFIRM" ? "PENDING_DELIVERY" : "PENDING_PAYMENT"');
    expect(functionSource).toContain('status: "SIGNED"');
    expect(functionSource).toContain("signedAt");
    expect(functionSource).toContain("contractId: contract.id");
    expect(functionSource).toContain('status: "RESERVED"');
    expect(functionSource).toContain('salePriceStatus: "EFFECTIVE"');
    expect(functionSource).toContain("currentSalePriceAmount: BigInt(vehicleSalePriceAmount)");
    expect(functionSource).toContain("insuranceStartDate");
    expect(functionSource).toContain("insuranceEndDate");
    expect(functionSource).toContain("batteryCapacityKwh: 75");
    expect(functionSource).toContain('batteryUsageType: "BUYOUT"');
  });

  it("creates a READY delivery record with all confirmation items for the confirm order", () => {
    const functionSource = functionSourceFor("seedDeliveryHandoverAcceptanceOrders");

    expect(seedSource).toContain('deliveryNo: "DLV-DELIVERY-CONFIRM-001"');
    expect(functionSource).toContain('deliveryStatus: "READY"');
    for (const marker of [
      "contractSignedConfirmed: true",
      "depositReceivedConfirmed: true",
      "firstMonthlyFeeReceivedConfirmed: true",
      "insuranceValidConfirmed: true",
      "vehiclePreparedConfirmed: true",
      "vehiclePhotosConfirmed: true",
      "customerIdentityConfirmed: true",
      "handoverDocumentsConfirmed: true"
    ]) {
      expect(functionSource).toContain(marker);
    }
  });

  it("seeds non-empty quote and order snapshots for order detail rendering", () => {
    const functionSource = functionSourceFor("seedDeliveryHandoverAcceptanceOrders");

    for (const marker of [
      "vehicleSnapshot",
      "packageSnapshot",
      "depositRuleSnapshot",
      "pricing: packageSnapshot.pricing",
      "currentSalePriceAmount: vehicleSalePriceAmount",
      "vehicleBaseFeeAmount",
      "mileagePackagePriceAmount",
      "energyPackagePriceAmount",
      "benefitPackagePriceAmount",
      "monthlyFeeAmount",
      "depositAmount",
      "defaultRate: 0.018"
    ]) {
      expect(functionSource).toContain(marker);
    }
  });

  function functionSourceFor(functionName: string) {
    const start = seedSource.indexOf(`async function ${functionName}`);
    expect(start).toBeGreaterThanOrEqual(0);

    const nextFunction = seedSource.indexOf("\nasync function ", start + 1);
    return seedSource.slice(start, nextFunction === -1 ? seedSource.length : nextFunction);
  }
});
