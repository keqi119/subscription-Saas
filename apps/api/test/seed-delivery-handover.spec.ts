import fs from "node:fs";
import path from "node:path";

import { describe, expect, it } from "vitest";

describe("default seed baseline vehicle and flow cleanup", () => {
  const seedSource = fs.readFileSync(path.resolve(__dirname, "../prisma/seed.mjs"), "utf8");

  it("keeps legacy flow markers only as cleanup targets", () => {
    const cleanupMarkersSource = sourceBetween(
      "const oldDefaultFlowSeedData = {",
      "const productManagementPermissions = ["
    );
    const cleanupFunctionSource = functionSourceFor("cleanupDefaultSeedFlowData");

    for (const marker of [
      "APP-SELF-SERVICE-REVIEW-001",
      "ORD-DELIVERY-PREPARE-001",
      "ORD-DELIVERY-CONFIRM-001",
      "CON-DELIVERY-CONFIRM-001",
      "DLV-DELIVERY-CONFIRM-001",
      "TESTDELIVERYPREPARE001",
      "TESTDELIVERYCONFIRM001"
    ]) {
      expect(cleanupMarkersSource).toContain(marker);
    }

    expect(cleanupFunctionSource).toContain("deleteMany");
    expect(cleanupFunctionSource).not.toContain(".upsert");
    expect(cleanupFunctionSource).not.toContain(".create(");
  });

  it("cleans all default flow object families in dependency order", () => {
    const cleanupFunctionSource = functionSourceFor("cleanupDefaultSeedFlowData");

    for (const deleteTarget of [
      "orderEntitlementUsage.deleteMany",
      "orderEntitlementGrant.deleteMany",
      "orderEntitlementAccount.deleteMany",
      "collectionAction.deleteMany",
      "collectionCaseBill.deleteMany",
      "collectionCase.deleteMany",
      "depositLedger.deleteMany",
      "paymentWriteOff.deleteMany",
      "paymentRecord.deleteMany",
      "receivableBill.deleteMany",
      "vehicleReturnDamage.deleteMany",
      "vehicleReturn.deleteMany",
      "vehicleDelivery.deleteMany",
      "orderChange.deleteMany",
      "contract.deleteMany",
      "subscriptionOrder.deleteMany",
      "subscriptionQuote.deleteMany",
      "applicationActionLog.deleteMany",
      "applicationMaterialFile.deleteMany",
      "applicationMaterialGroup.deleteMany",
      "applicationMaterial.deleteMany",
      "application.deleteMany"
    ]) {
      expect(cleanupFunctionSource).toContain(deleteTarget);
    }

    expect(cleanupFunctionSource.indexOf("paymentWriteOff.deleteMany")).toBeLessThan(
      cleanupFunctionSource.indexOf("paymentRecord.deleteMany")
    );
    expect(cleanupFunctionSource.indexOf("vehicleReturnDamage.deleteMany")).toBeLessThan(
      cleanupFunctionSource.indexOf("vehicleReturn.deleteMany")
    );
    expect(cleanupFunctionSource.indexOf("contract.deleteMany")).toBeLessThan(
      cleanupFunctionSource.indexOf("subscriptionOrder.deleteMany")
    );
    expect(cleanupFunctionSource.indexOf("subscriptionOrder.deleteMany")).toBeLessThan(
      cleanupFunctionSource.indexOf("subscriptionQuote.deleteMany")
    );
  });

  it("keeps default vehicle seeds available with initialized sale price and insurance", () => {
    const vehicleFunctionSource = functionSourceFor("seedDemoVehicles");

    for (const marker of [
      "VEH-DEMO-ET5-001",
      "VEH-DEMO-ET7-001",
      "VEH-DEMO-ES6-001",
      "TESTVINET50000001",
      "TESTVINET70000001",
      "TESTVINES60000001",
      'status: "AVAILABLE"',
      'salePriceStatus: "EFFECTIVE"',
      "currentSalePriceAmount: BigInt(vehicleSeed.currentSalePriceAmount)",
      "purchasePriceAmount: BigInt(vehicleSeed.purchasePriceAmount)",
      'policyType: "COMPULSORY_TRAFFIC"',
      'policyType: "COMMERCIAL"',
      'reviewType: "INITIAL_POOL"'
    ]) {
      expect(seedSource).toContain(marker);
    }

    expect(vehicleFunctionSource).not.toContain('status: "REVIEW_RESERVED"');
    expect(vehicleFunctionSource).not.toContain('status: "RESERVED"');
    expect(vehicleFunctionSource).not.toContain('status: "LEASED"');
    expect(vehicleFunctionSource).not.toContain('status: "RETURNED"');
    expect(vehicleFunctionSource).not.toContain('status: "MAINTENANCE"');
  });

  it("does not create default financial, collection, return, or entitlement demo data", () => {
    for (const forbiddenCreate of [
      "prisma.receivableBill.create",
      "prisma.paymentRecord.create",
      "prisma.paymentWriteOff.create",
      "prisma.depositLedger.create",
      "prisma.collectionCase.create",
      "prisma.collectionCaseBill.create",
      "prisma.collectionAction.create",
      "prisma.vehicleDelivery.create",
      "prisma.vehicleReturn.create",
      "prisma.vehicleReturnDamage.create",
      "prisma.orderEntitlementAccount.create",
      "prisma.orderEntitlementGrant.create",
      "prisma.orderEntitlementUsage.create"
    ]) {
      expect(seedSource).not.toContain(forbiddenCreate);
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
