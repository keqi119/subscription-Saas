import "reflect-metadata";

import fs from "node:fs";
import path from "node:path";

import { PermissionCode } from "@subscription-saas/shared";
import { describe, expect, it } from "vitest";

import {
  REQUIRED_ANY_PERMISSIONS_KEY,
  REQUIRED_PERMISSIONS_KEY
} from "../src/auth/auth.decorators";
import { hasAnyRequiredPermission, hasRequiredPermissions } from "../src/auth/permissions";
import { CustomerController } from "../src/customer/customer.controller";
import { FinanceController } from "../src/finance/finance.controller";
import { OrderController } from "../src/order/order.controller";
import { ProductController } from "../src/product/product.controller";
import { ReportController } from "../src/report/report.controller";
import { VehicleController } from "../src/vehicle/vehicle.controller";

describe("hasRequiredPermissions", () => {
  it("allows requests with every required permission", () => {
    expect(hasRequiredPermissions(["user:view", "role:view"], ["user:view"])).toBe(true);
  });

  it("denies requests missing a required permission", () => {
    expect(hasRequiredPermissions(["user:view"], ["user:view", "role:manage"])).toBe(false);
  });
});

describe("hasAnyRequiredPermission", () => {
  it("allows requests with one matching permission", () => {
    expect(hasAnyRequiredPermission(["quote:create"], ["vehicle:view", "quote:create"])).toBe(true);
  });

  it("denies requests without any matching permission", () => {
    expect(hasAnyRequiredPermission(["quote:view"], ["vehicle:view", "quote:create"])).toBe(false);
  });
});

describe("vehicle availability permissions", () => {
  const requiredAnyPermissions = Reflect.getMetadata(
    REQUIRED_ANY_PERMISSIONS_KEY,
    VehicleController.prototype.listAvailableVehicles
  );

  it("allows vehicle:view or quote:create for /vehicles/available", () => {
    expect(requiredAnyPermissions).toEqual([
      PermissionCode.VEHICLE_VIEW,
      PermissionCode.QUOTE_CREATE
    ]);
    expect(hasAnyRequiredPermission([PermissionCode.VEHICLE_VIEW], requiredAnyPermissions)).toBe(
      true
    );
    expect(hasAnyRequiredPermission([PermissionCode.QUOTE_CREATE], requiredAnyPermissions)).toBe(
      true
    );
  });

  it("denies /vehicles/available without either permission", () => {
    expect(hasAnyRequiredPermission([PermissionCode.QUOTE_VIEW], requiredAnyPermissions)).toBe(
      false
    );
  });

  it("keeps available subscription plans gated by quote:create", () => {
    const requiredPermissions = Reflect.getMetadata(
      REQUIRED_PERMISSIONS_KEY,
      ProductController.prototype.listAvailableSubscriptionPlans
    );
    expect(requiredPermissions).toEqual([PermissionCode.QUOTE_CREATE]);
  });
});

describe("customer order review permissions", () => {
  it("requires order review and final-plan permissions for A-line review APIs", () => {
    const reviewPermissions = Reflect.getMetadata(
      REQUIRED_PERMISSIONS_KEY,
      OrderController.prototype.reviewCredit
    );
    const reviewQueuePermissions = Reflect.getMetadata(
      REQUIRED_PERMISSIONS_KEY,
      OrderController.prototype.listReviewQueue
    );
    const finalizePermissions = Reflect.getMetadata(
      REQUIRED_PERMISSIONS_KEY,
      OrderController.prototype.finalizePlan
    );
    const rejectPermissions = Reflect.getMetadata(
      REQUIRED_PERMISSIONS_KEY,
      OrderController.prototype.rejectCustomerOrder
    );

    expect(reviewPermissions).toEqual([PermissionCode.ORDER_REVIEW]);
    expect(reviewQueuePermissions).toEqual([PermissionCode.ORDER_REVIEW]);
    expect(finalizePermissions).toEqual([PermissionCode.ORDER_CONFIRM_FINAL_PLAN]);
    expect(rejectPermissions).toEqual([PermissionCode.ORDER_REJECT]);
    expect(hasRequiredPermissions([PermissionCode.ORDER_VIEW], reviewPermissions)).toBe(false);
  });
});

describe("order entitlement permissions", () => {
  it("gates entitlement query, generation, and consumption APIs behind entitlement permissions", () => {
    const viewPermissions = Reflect.getMetadata(
      REQUIRED_PERMISSIONS_KEY,
      OrderController.prototype.getOrderEntitlements
    );
    const usageListPermissions = Reflect.getMetadata(
      REQUIRED_PERMISSIONS_KEY,
      OrderController.prototype.listOrderEntitlementUsages
    );
    const generatePermissions = Reflect.getMetadata(
      REQUIRED_PERMISSIONS_KEY,
      OrderController.prototype.generateOrderEntitlements
    );
    const renewMonthlyPermissions = Reflect.getMetadata(
      REQUIRED_PERMISSIONS_KEY,
      OrderController.prototype.renewOrderMonthlyEntitlements
    );
    const batchRenewMonthlyPermissions = Reflect.getMetadata(
      REQUIRED_PERMISSIONS_KEY,
      OrderController.prototype.generateMonthlyEntitlements
    );
    const expirePermissions = Reflect.getMetadata(
      REQUIRED_PERMISSIONS_KEY,
      OrderController.prototype.expireEntitlements
    );
    const consumePermissions = Reflect.getMetadata(
      REQUIRED_PERMISSIONS_KEY,
      OrderController.prototype.consumeOrderEntitlement
    );

    expect(viewPermissions).toEqual([PermissionCode.ENTITLEMENT_VIEW]);
    expect(usageListPermissions).toEqual([PermissionCode.ENTITLEMENT_VIEW]);
    expect(generatePermissions).toEqual([PermissionCode.ENTITLEMENT_GENERATE]);
    expect(renewMonthlyPermissions).toEqual([PermissionCode.ENTITLEMENT_GENERATE]);
    expect(batchRenewMonthlyPermissions).toEqual([PermissionCode.ENTITLEMENT_GENERATE]);
    expect(expirePermissions).toEqual([PermissionCode.ENTITLEMENT_ADJUST]);
    expect(consumePermissions).toEqual([PermissionCode.ENTITLEMENT_CONSUME]);
    expect(hasRequiredPermissions([PermissionCode.ENTITLEMENT_VIEW], viewPermissions)).toBe(true);
    expect(hasRequiredPermissions([PermissionCode.ENTITLEMENT_VIEW], usageListPermissions)).toBe(
      true
    );
    expect(hasRequiredPermissions([PermissionCode.ENTITLEMENT_VIEW], generatePermissions)).toBe(
      false
    );
    expect(hasRequiredPermissions([PermissionCode.ENTITLEMENT_VIEW], renewMonthlyPermissions)).toBe(
      false
    );
    expect(hasRequiredPermissions([PermissionCode.ENTITLEMENT_VIEW], expirePermissions)).toBe(
      false
    );
    expect(hasRequiredPermissions([PermissionCode.ENTITLEMENT_VIEW], consumePermissions)).toBe(
      false
    );
  });
});

describe("self-service application permissions", () => {
  it("keeps self-service application intake behind application permissions", () => {
    const requiredAnyPermissions = Reflect.getMetadata(
      REQUIRED_ANY_PERMISSIONS_KEY,
      CustomerController.prototype.createSelfServiceApplication
    );

    expect(requiredAnyPermissions).toEqual([
      PermissionCode.APPLICATION_MANAGE,
      PermissionCode.APPLICATION_SUBMIT
    ]);
    expect(
      hasAnyRequiredPermission([PermissionCode.APPLICATION_SUBMIT], requiredAnyPermissions)
    ).toBe(true);
    expect(
      hasAnyRequiredPermission([PermissionCode.APPLICATION_REVIEW], requiredAnyPermissions)
    ).toBe(false);
  });

  it("gates application review workflow behind review and order-create permissions", () => {
    const reviewPermissions = Reflect.getMetadata(
      REQUIRED_PERMISSIONS_KEY,
      CustomerController.prototype.reviewApplicationCredit
    );
    const queuePermissions = Reflect.getMetadata(
      REQUIRED_PERMISSIONS_KEY,
      CustomerController.prototype.listApplicationReviewQueue
    );
    const finalizePermissions = Reflect.getMetadata(
      REQUIRED_PERMISSIONS_KEY,
      CustomerController.prototype.finalizeApplicationPlan
    );
    const createOrderPermissions = Reflect.getMetadata(
      REQUIRED_PERMISSIONS_KEY,
      CustomerController.prototype.createOrderFromApplication
    );
    const cancelAnyPermissions = Reflect.getMetadata(
      REQUIRED_ANY_PERMISSIONS_KEY,
      CustomerController.prototype.cancelApplication
    );

    expect(reviewPermissions).toEqual([PermissionCode.APPLICATION_REVIEW]);
    expect(queuePermissions).toEqual([PermissionCode.APPLICATION_REVIEW]);
    expect(finalizePermissions).toEqual([PermissionCode.APPLICATION_REVIEW]);
    expect(createOrderPermissions).toEqual([
      PermissionCode.QUOTE_CREATE,
      PermissionCode.ORDER_CREATE
    ]);
    expect(cancelAnyPermissions).toEqual([
      PermissionCode.APPLICATION_MANAGE,
      PermissionCode.APPLICATION_REVIEW
    ]);
    expect(hasRequiredPermissions([PermissionCode.APPLICATION_VIEW], reviewPermissions)).toBe(
      false
    );
  });
});

describe("billing finance permissions", () => {
  it("gates billing and payment APIs behind finance permissions", () => {
    const generatePermissions = Reflect.getMetadata(
      REQUIRED_PERMISSIONS_KEY,
      FinanceController.prototype.generateInitialBills
    );
    const generateDamageFeePermissions = Reflect.getMetadata(
      REQUIRED_PERMISSIONS_KEY,
      FinanceController.prototype.generateDamageFeeBill
    );
    const billsPermissions = Reflect.getMetadata(
      REQUIRED_PERMISSIONS_KEY,
      FinanceController.prototype.listOrderBills
    );
    const summaryPermissions = Reflect.getMetadata(
      REQUIRED_PERMISSIONS_KEY,
      FinanceController.prototype.getOrderFinanceSummary
    );
    const settlementPermissions = Reflect.getMetadata(
      REQUIRED_PERMISSIONS_KEY,
      FinanceController.prototype.getDepositSettlement
    );
    const deductPermissions = Reflect.getMetadata(
      REQUIRED_PERMISSIONS_KEY,
      FinanceController.prototype.deductDeposit
    );
    const refundPermissions = Reflect.getMetadata(
      REQUIRED_PERMISSIONS_KEY,
      FinanceController.prototype.refundDeposit
    );
    const createPaymentPermissions = Reflect.getMetadata(
      REQUIRED_PERMISSIONS_KEY,
      FinanceController.prototype.createPayment
    );
    const writeOffPermissions = Reflect.getMetadata(
      REQUIRED_PERMISSIONS_KEY,
      FinanceController.prototype.writeOffPayment
    );

    expect(generatePermissions).toEqual([PermissionCode.BILLING_GENERATE]);
    expect(generateDamageFeePermissions).toEqual([PermissionCode.BILLING_GENERATE]);
    expect(billsPermissions).toEqual([PermissionCode.BILLING_VIEW]);
    expect(summaryPermissions).toEqual([PermissionCode.BILLING_VIEW]);
    expect(settlementPermissions).toEqual([PermissionCode.DEPOSIT_LEDGER_VIEW]);
    expect(deductPermissions).toEqual([PermissionCode.DEPOSIT_LEDGER_DEDUCT]);
    expect(refundPermissions).toEqual([PermissionCode.DEPOSIT_LEDGER_REFUND]);
    expect(hasRequiredPermissions([PermissionCode.DEPOSIT_LEDGER_VIEW], deductPermissions)).toBe(
      false
    );
    expect(hasRequiredPermissions([PermissionCode.DEPOSIT_LEDGER_DEDUCT], deductPermissions)).toBe(
      true
    );
    expect(hasRequiredPermissions([PermissionCode.DEPOSIT_LEDGER_VIEW], refundPermissions)).toBe(
      false
    );
    expect(hasRequiredPermissions([PermissionCode.DEPOSIT_LEDGER_REFUND], refundPermissions)).toBe(
      true
    );
    expect(createPaymentPermissions).toEqual([PermissionCode.PAYMENT_CREATE]);
    expect(writeOffPermissions).toEqual([PermissionCode.PAYMENT_WRITE_OFF]);
  });
});

describe("report permissions", () => {
  it("gates report APIs behind report permissions", () => {
    const dashboardPermissions = Reflect.getMetadata(
      REQUIRED_PERMISSIONS_KEY,
      ReportController.prototype.getDashboardSummary
    );
    const ordersPermissions = Reflect.getMetadata(
      REQUIRED_PERMISSIONS_KEY,
      ReportController.prototype.getOrderReport
    );
    const ordersExportPermissions = Reflect.getMetadata(
      REQUIRED_PERMISSIONS_KEY,
      ReportController.prototype.exportOrderReport
    );
    const orderDetailsPermissions = Reflect.getMetadata(
      REQUIRED_PERMISSIONS_KEY,
      ReportController.prototype.getOrderDetails
    );
    const orderDetailsExportPermissions = Reflect.getMetadata(
      REQUIRED_PERMISSIONS_KEY,
      ReportController.prototype.exportOrderDetails
    );
    const financePermissions = Reflect.getMetadata(
      REQUIRED_PERMISSIONS_KEY,
      ReportController.prototype.getFinanceReport
    );
    const financeExportPermissions = Reflect.getMetadata(
      REQUIRED_PERMISSIONS_KEY,
      ReportController.prototype.exportFinanceReport
    );
    const billDetailsPermissions = Reflect.getMetadata(
      REQUIRED_PERMISSIONS_KEY,
      ReportController.prototype.getBillDetails
    );
    const billDetailsExportPermissions = Reflect.getMetadata(
      REQUIRED_PERMISSIONS_KEY,
      ReportController.prototype.exportBillDetails
    );
    const depositPoolPermissions = Reflect.getMetadata(
      REQUIRED_PERMISSIONS_KEY,
      ReportController.prototype.getDepositPoolReport
    );
    const depositPoolExportPermissions = Reflect.getMetadata(
      REQUIRED_PERMISSIONS_KEY,
      ReportController.prototype.exportDepositPoolReport
    );
    const depositLedgerDetailsPermissions = Reflect.getMetadata(
      REQUIRED_PERMISSIONS_KEY,
      ReportController.prototype.getDepositLedgerDetails
    );
    const depositLedgerDetailsExportPermissions = Reflect.getMetadata(
      REQUIRED_PERMISSIONS_KEY,
      ReportController.prototype.exportDepositLedgerDetails
    );
    const collectionAnyPermissions = Reflect.getMetadata(
      REQUIRED_ANY_PERMISSIONS_KEY,
      ReportController.prototype.getCollectionReport
    );
    const collectionExportAnyPermissions = Reflect.getMetadata(
      REQUIRED_ANY_PERMISSIONS_KEY,
      ReportController.prototype.exportCollectionReport
    );
    const overdueBillDetailsAnyPermissions = Reflect.getMetadata(
      REQUIRED_ANY_PERMISSIONS_KEY,
      ReportController.prototype.getOverdueBillDetails
    );
    const overdueBillDetailsExportAnyPermissions = Reflect.getMetadata(
      REQUIRED_ANY_PERMISSIONS_KEY,
      ReportController.prototype.exportOverdueBillDetails
    );
    const collectionCaseDetailsAnyPermissions = Reflect.getMetadata(
      REQUIRED_ANY_PERMISSIONS_KEY,
      ReportController.prototype.getCollectionCaseDetails
    );
    const collectionCaseDetailsExportAnyPermissions = Reflect.getMetadata(
      REQUIRED_ANY_PERMISSIONS_KEY,
      ReportController.prototype.exportCollectionCaseDetails
    );
    const vehicleAssetPermissions = Reflect.getMetadata(
      REQUIRED_PERMISSIONS_KEY,
      ReportController.prototype.getVehicleAssetReport
    );
    const vehicleAssetExportPermissions = Reflect.getMetadata(
      REQUIRED_PERMISSIONS_KEY,
      ReportController.prototype.exportVehicleAssetReport
    );
    const vehicleDetailsPermissions = Reflect.getMetadata(
      REQUIRED_PERMISSIONS_KEY,
      ReportController.prototype.getVehicleDetails
    );
    const vehicleDetailsExportPermissions = Reflect.getMetadata(
      REQUIRED_PERMISSIONS_KEY,
      ReportController.prototype.exportVehicleDetails
    );
    const assetProfitabilitySummaryPermissions = Reflect.getMetadata(
      REQUIRED_PERMISSIONS_KEY,
      ReportController.prototype.getAssetProfitabilitySummary
    );
    const assetProfitabilitySummaryExportPermissions = Reflect.getMetadata(
      REQUIRED_PERMISSIONS_KEY,
      ReportController.prototype.exportAssetProfitabilitySummary
    );
    const assetProfitabilityVehiclesPermissions = Reflect.getMetadata(
      REQUIRED_PERMISSIONS_KEY,
      ReportController.prototype.getAssetProfitabilityVehicles
    );
    const assetProfitabilityVehiclesExportPermissions = Reflect.getMetadata(
      REQUIRED_PERMISSIONS_KEY,
      ReportController.prototype.exportAssetProfitabilityVehicles
    );
    const assetProfitabilityVehicleDetailPermissions = Reflect.getMetadata(
      REQUIRED_PERMISSIONS_KEY,
      ReportController.prototype.getAssetProfitabilityVehicleDetail
    );
    const assetProfitabilityVehicleDetailExportPermissions = Reflect.getMetadata(
      REQUIRED_PERMISSIONS_KEY,
      ReportController.prototype.exportAssetProfitabilityVehicleDetail
    );
    const entitlementReportPermissions = Reflect.getMetadata(
      REQUIRED_PERMISSIONS_KEY,
      ReportController.prototype.getEntitlementReport
    );
    const entitlementGrantDetailsPermissions = Reflect.getMetadata(
      REQUIRED_PERMISSIONS_KEY,
      ReportController.prototype.getEntitlementGrantDetails
    );
    const entitlementUsageDetailsPermissions = Reflect.getMetadata(
      REQUIRED_PERMISSIONS_KEY,
      ReportController.prototype.getEntitlementUsageDetails
    );

    expect(dashboardPermissions).toEqual([PermissionCode.REPORT_VIEW]);
    expect(ordersPermissions).toEqual([PermissionCode.REPORT_VIEW]);
    expect(ordersExportPermissions).toEqual([PermissionCode.REPORT_VIEW]);
    expect(orderDetailsPermissions).toEqual([PermissionCode.REPORT_VIEW]);
    expect(orderDetailsExportPermissions).toEqual([PermissionCode.REPORT_VIEW]);
    expect(financePermissions).toEqual([PermissionCode.REPORT_FINANCE]);
    expect(financeExportPermissions).toEqual([PermissionCode.REPORT_FINANCE]);
    expect(billDetailsPermissions).toEqual([PermissionCode.REPORT_FINANCE]);
    expect(billDetailsExportPermissions).toEqual([PermissionCode.REPORT_FINANCE]);
    expect(depositPoolPermissions).toEqual([PermissionCode.REPORT_FINANCE]);
    expect(depositPoolExportPermissions).toEqual([PermissionCode.REPORT_FINANCE]);
    expect(depositLedgerDetailsPermissions).toEqual([PermissionCode.REPORT_FINANCE]);
    expect(depositLedgerDetailsExportPermissions).toEqual([PermissionCode.REPORT_FINANCE]);
    expect(collectionAnyPermissions).toEqual([
      PermissionCode.REPORT_FINANCE,
      PermissionCode.COLLECTION_VIEW
    ]);
    expect(collectionExportAnyPermissions).toEqual([
      PermissionCode.REPORT_FINANCE,
      PermissionCode.COLLECTION_VIEW
    ]);
    expect(overdueBillDetailsAnyPermissions).toEqual([
      PermissionCode.REPORT_FINANCE,
      PermissionCode.COLLECTION_VIEW
    ]);
    expect(overdueBillDetailsExportAnyPermissions).toEqual([
      PermissionCode.REPORT_FINANCE,
      PermissionCode.COLLECTION_VIEW
    ]);
    expect(collectionCaseDetailsAnyPermissions).toEqual([
      PermissionCode.REPORT_FINANCE,
      PermissionCode.COLLECTION_VIEW
    ]);
    expect(collectionCaseDetailsExportAnyPermissions).toEqual([
      PermissionCode.REPORT_FINANCE,
      PermissionCode.COLLECTION_VIEW
    ]);
    expect(vehicleAssetPermissions).toEqual([PermissionCode.REPORT_ASSET]);
    expect(vehicleAssetExportPermissions).toEqual([PermissionCode.REPORT_ASSET]);
    expect(vehicleDetailsPermissions).toEqual([PermissionCode.REPORT_ASSET]);
    expect(vehicleDetailsExportPermissions).toEqual([PermissionCode.REPORT_ASSET]);
    expect(assetProfitabilitySummaryPermissions).toEqual([PermissionCode.REPORT_ASSET]);
    expect(assetProfitabilitySummaryExportPermissions).toEqual([PermissionCode.REPORT_ASSET]);
    expect(assetProfitabilityVehiclesPermissions).toEqual([PermissionCode.REPORT_ASSET]);
    expect(assetProfitabilityVehiclesExportPermissions).toEqual([PermissionCode.REPORT_ASSET]);
    expect(assetProfitabilityVehicleDetailPermissions).toEqual([PermissionCode.REPORT_ASSET]);
    expect(assetProfitabilityVehicleDetailExportPermissions).toEqual([
      PermissionCode.REPORT_ASSET
    ]);
    expect(
      hasRequiredPermissions([PermissionCode.REPORT_VIEW], assetProfitabilitySummaryPermissions)
    ).toBe(false);
    expect(
      hasRequiredPermissions(
        [PermissionCode.REPORT_VIEW],
        assetProfitabilitySummaryExportPermissions
      )
    ).toBe(false);
    expect(entitlementReportPermissions).toEqual([
      PermissionCode.REPORT_VIEW,
      PermissionCode.ENTITLEMENT_VIEW
    ]);
    expect(entitlementGrantDetailsPermissions).toEqual([
      PermissionCode.REPORT_VIEW,
      PermissionCode.ENTITLEMENT_VIEW
    ]);
    expect(entitlementUsageDetailsPermissions).toEqual([
      PermissionCode.REPORT_VIEW,
      PermissionCode.ENTITLEMENT_VIEW
    ]);
    expect(hasRequiredPermissions([PermissionCode.REPORT_VIEW], financePermissions)).toBe(false);
    expect(hasRequiredPermissions([PermissionCode.REPORT_VIEW], financeExportPermissions)).toBe(
      false
    );
    expect(hasRequiredPermissions([PermissionCode.REPORT_VIEW], billDetailsPermissions)).toBe(
      false
    );
    expect(hasRequiredPermissions([PermissionCode.REPORT_VIEW], billDetailsExportPermissions)).toBe(
      false
    );
    expect(
      hasAnyRequiredPermission([PermissionCode.COLLECTION_VIEW], collectionAnyPermissions)
    ).toBe(true);
    expect(
      hasAnyRequiredPermission([PermissionCode.COLLECTION_VIEW], collectionExportAnyPermissions)
    ).toBe(true);
    expect(
      hasAnyRequiredPermission([PermissionCode.COLLECTION_VIEW], overdueBillDetailsAnyPermissions)
    ).toBe(true);
    expect(
      hasAnyRequiredPermission(
        [PermissionCode.COLLECTION_VIEW],
        overdueBillDetailsExportAnyPermissions
      )
    ).toBe(true);
    expect(
      hasAnyRequiredPermission(
        [PermissionCode.COLLECTION_VIEW],
        collectionCaseDetailsAnyPermissions
      )
    ).toBe(true);
    expect(
      hasAnyRequiredPermission(
        [PermissionCode.COLLECTION_VIEW],
        collectionCaseDetailsExportAnyPermissions
      )
    ).toBe(true);
    expect(hasRequiredPermissions([PermissionCode.REPORT_VIEW], entitlementReportPermissions)).toBe(
      false
    );
    expect(
      hasRequiredPermissions([PermissionCode.ENTITLEMENT_VIEW], entitlementReportPermissions)
    ).toBe(false);
    expect(
      hasRequiredPermissions(
        [PermissionCode.REPORT_VIEW, PermissionCode.ENTITLEMENT_VIEW],
        entitlementReportPermissions
      )
    ).toBe(true);
  });
});

describe("seed permission calibration", () => {
  const seedSource = fs.readFileSync(path.resolve(__dirname, "../prisma/seed.mjs"), "utf8");

  it("seeds baseline users for each operating role", () => {
    for (const marker of [
      '["admin", "系统管理员", "admin@example.com", "ADMIN"]',
      '["sa", "销售顾问", "sa@example.com", "SA"]',
      '["op", "运营管理", "op@example.com", "OP"]',
      '["rc", "风控专员", "rc@example.com", "RC"]',
      '["fi", "财务专员", "fi@example.com", "FI"]',
      '["as", "资产运营", "as@example.com", "AS"]',
      '["cs", "客服运营", "cs@example.com", "CS"]',
      '["gm", "运营总监", "gm@example.com", "GM"]'
    ]) {
      expect(seedSource).toContain(marker);
    }

    expect(seedSource).toContain("async function seedDefaultUsers");
    expect(seedSource).toContain("await seedDefaultUsers()");
    expect(seedSource).toContain("prisma.user.upsert");
    expect(seedSource).toContain("prisma.userRole.upsert");
  });

  it("defines vehicle and subscription plan permissions for ADMIN all-permission seeding", () => {
    for (const permission of [
      "vehicle:view",
      "vehicle:create",
      "vehicle:update",
      "vehicle:delete",
      "vehicle:update_status",
      "vehicle:initialize_sale_price",
      "vehicle:review_sale_price",
      "vehicle:history_view",
      "subscription_plan:view",
      "subscription_plan:create",
      "subscription_plan:update",
      "subscription_plan:activate",
      "subscription_plan:deactivate",
      "subscription_plan:delete",
      "delivery:view",
      "delivery:prepare",
      "delivery:confirm",
      "vehicle_return:view",
      "vehicle_return:prepare",
      "vehicle_return:confirm",
      "vehicle_return:damage_record",
      "billing:view",
      "billing:generate",
      "payment:view",
      "payment:create",
      "payment:write_off",
      "deposit_ledger:view",
      "deposit_ledger:deduct",
      "deposit_ledger:refund",
      "entitlement:view",
      "entitlement:generate",
      "entitlement:adjust",
      "entitlement:consume",
      "report:view",
      "report:finance",
      "report:asset"
    ]) {
      expect(seedSource).toContain(`"${permission}"`);
    }
    expect(seedSource).toContain("const allPermissions = await prisma.permission.findMany()");
    expect(seedSource).toContain("allPermissions.map((permission)");
  });

  it("gives OP and SA quote, vehicle, application, and subscription plan access", () => {
    for (const roleCode of ["SA", "OP"]) {
      expectRolePermissions(roleCode, [
        "application:view",
        "quote:create",
        "quote:view",
        "vehicle:view",
        "subscription_plan:view"
      ]);
    }

    expect(seedSource).toContain('"quote:create"');
    expect(seedSource).toContain('"subscription_plan:view"');
    expect(seedSource).toContain('const vehicleViewPermissions = ["vehicle:view"');
  });

  it("gives AS the vehicle management permission set", () => {
    expect(seedSource).toContain('for (const roleCode of ["FI", "AS"])');
    expect(seedSource).toContain(
      'roleCode === "AS" ? vehicleManagementPermissions : vehicleViewPermissions'
    );
    expect(seedSource).toContain('"vehicle:initialize_sale_price"');
    expect(seedSource).toContain('"vehicle:review_sale_price"');
  });

  it("calibrates A-line order review permissions by role", () => {
    for (const permission of ["order:review", "order:confirm_final_plan", "order:reject"]) {
      expect(seedSource).toContain(`"${permission}"`);
    }

    expectRolePermissions("OP", ["order:review", "order:confirm_final_plan", "order:reject"]);
    expectRolePermissions("RC", ["order:review", "order:reject"]);
    expect(seedSource).toContain('...(roleCode === "AS" ? ["order:review", "order:reject"] : [])');
    expect(seedSource).toContain('...(roleCode === "AS" ? ["orders.review"] : [])');
    expect(roleHasPermission(rolePermissionArray("SA"), "order:review")).toBe(false);
    expect(roleHasMenu(roleMenuArray("SA"), "orders.review")).toBe(false);
  });

  it("calibrates delivery permissions by role", () => {
    for (const permission of ["delivery:view", "delivery:prepare", "delivery:confirm"]) {
      expect(seedSource).toContain(`"${permission}"`);
    }

    expectRolePermissions("OP", ["delivery:view", "delivery:prepare", "delivery:confirm"]);
    expectRolePermissions("SA", ["delivery:view"]);
    expect(seedSource).toContain(
      'roleCode === "AS" ? ["delivery:view", "delivery:prepare", "delivery:confirm"] : []'
    );
    expect(roleHasPermission(rolePermissionArray("SA"), "delivery:prepare")).toBe(false);
    expect(roleHasPermission(rolePermissionArray("SA"), "delivery:confirm")).toBe(false);
  });

  it("calibrates vehicle return permissions by role", () => {
    for (const permission of [
      "vehicle_return:view",
      "vehicle_return:prepare",
      "vehicle_return:confirm",
      "vehicle_return:damage_record"
    ]) {
      expect(seedSource).toContain(`"${permission}"`);
    }

    expectRolePermissions("OP", [
      "vehicle_return:view",
      "vehicle_return:prepare",
      "vehicle_return:confirm",
      "vehicle_return:damage_record"
    ]);
    expectRolePermissions("SA", ["vehicle_return:view"]);
    expect(seedSource).toContain('for (const roleCode of ["FI", "AS"])');
    expect(seedSource).toContain('roleCode === "AS"');
    expect(seedSource).toContain('"vehicle_return:view"');
    expect(seedSource).toContain('"vehicle_return:prepare"');
    expect(seedSource).toContain('"vehicle_return:confirm"');
    expect(seedSource).toContain('"vehicle_return:damage_record"');
    expect(roleHasPermission(rolePermissionArray("SA"), "vehicle_return:prepare")).toBe(false);
  });

  it("calibrates billing finance permissions by role", () => {
    for (const permission of [
      "billing:view",
      "billing:generate",
      "payment:view",
      "payment:create",
      "payment:write_off",
      "deposit_ledger:view",
      "deposit_ledger:deduct",
      "deposit_ledger:refund"
    ]) {
      expect(seedSource).toContain(`"${permission}"`);
    }

    expect(seedSource).toContain("const financeManagementPermissions = [");
    expect(seedSource).toContain('...(roleCode === "FI" ? financeManagementPermissions : [])');
    expectRolePermissions("OP", ["billing:view", "deposit_ledger:view", "deposit_ledger:deduct"]);
    expectRolePermissions("SA", ["billing:view"]);
    expectRolePermissions("GM", ["billing:view", "payment:view", "deposit_ledger:view"]);
    expect(roleHasPermission(rolePermissionArray("OP"), "payment:create")).toBe(false);
    expect(roleHasPermission(rolePermissionArray("OP"), "deposit_ledger:refund")).toBe(false);
    expect(roleHasPermission(rolePermissionArray("SA"), "payment:write_off")).toBe(false);
  });

  it("calibrates entitlement permissions by role", () => {
    for (const permission of [
      "entitlement:view",
      "entitlement:generate",
      "entitlement:adjust",
      "entitlement:consume"
    ]) {
      expect(seedSource).toContain(`"${permission}"`);
    }

    expect(seedSource).toContain('const entitlementViewPermissions = ["entitlement:view"]');
    expect(seedSource).toContain(
      'const entitlementGeneratePermissions = ["entitlement:view", "entitlement:generate"]'
    );
    expect(seedSource).toContain(
      'const entitlementOperationPermissions = ["entitlement:view", "entitlement:generate", "entitlement:adjust", "entitlement:consume"]'
    );
    expectRolePermissions("OP", [
      "entitlement:view",
      "entitlement:generate",
      "entitlement:adjust",
      "entitlement:consume"
    ]);
    expectRolePermissions("SA", ["entitlement:view"]);
    expectRolePermissions("GM", ["entitlement:view"]);
    expect(roleHasPermission(rolePermissionArray("SA"), "entitlement:generate")).toBe(false);
    expect(roleHasPermission(rolePermissionArray("GM"), "entitlement:generate")).toBe(false);
    expect(roleHasPermission(rolePermissionArray("SA"), "entitlement:consume")).toBe(false);
    expect(roleHasPermission(rolePermissionArray("GM"), "entitlement:consume")).toBe(false);
    expect(roleHasPermission(rolePermissionArray("OP"), "entitlement:adjust")).toBe(true);
  });

  it("calibrates report permissions by role", () => {
    for (const permission of ["report:view", "report:finance", "report:asset"]) {
      expect(seedSource).toContain(`"${permission}"`);
    }

    expectRolePermissions("OP", ["report:view", "report:asset"]);
    expectRolePermissions("GM", ["report:view", "report:finance", "report:asset"]);
    expect(seedSource).toContain(
      'const reportFinancePermissions = ["report:view", "report:finance"]'
    );
    expect(seedSource).toContain('const reportAssetPermissions = ["report:asset"]');
    expect(seedSource).toContain(
      '...(roleCode === "FI" ? reportFinancePermissions : reportAssetPermissions)'
    );
    expect(seedSource).toContain('const reportOverviewMenuCodes = ["reports", "reports.overview"]');
    expect(seedSource).toContain('const reportAssetMenuCodes = ["reports", "reports.asset_profitability"]');
    expect(seedSource).toContain(
      '["reports", "经营看板", "/reports", "dashboard", 75, null, null]'
    );
    expect(seedSource).toContain(
      '["reports.overview", "经营总览", "/reports", "dashboard", 10, "report:view", "reports"]'
    );
    expect(seedSource).toContain(
      '["reports.asset_profitability", "资产经营分析", "/reports/asset-profitability", "car", 20, "report:asset", "reports"]'
    );
    expect(roleHasMenu(roleMenuArray("OP"), "reports")).toBe(true);
    expect(roleHasMenu(roleMenuArray("OP"), "reports.overview")).toBe(true);
    expect(roleHasMenu(roleMenuArray("OP"), "reports.asset_profitability")).toBe(true);
    expect(roleHasMenu(roleMenuArray("GM"), "reports")).toBe(true);
    expect(roleHasMenu(roleMenuArray("GM"), "reports.overview")).toBe(true);
    expect(roleHasMenu(roleMenuArray("GM"), "reports.asset_profitability")).toBe(true);
    expect(seedSource).toContain(
      '...(roleCode === "FI" ? [...reportOverviewMenuCodes, ...financeMenuCodes] : [])'
    );
    expect(seedSource).toContain('...(roleCode === "AS" ? reportAssetMenuCodes : [])');
    expect(roleHasPermission(rolePermissionArray("SA"), "report:view")).toBe(false);
    expect(roleHasPermission(rolePermissionArray("SA"), "report:finance")).toBe(false);
    expect(roleHasPermission(rolePermissionArray("OP"), "report:finance")).toBe(false);
    expect(
      roleHasPermission(permissionConstantSource("reportAssetPermissions"), "report:view")
    ).toBe(false);
  });

  function expectRolePermissions(roleCode: string, permissionCodes: string[]) {
    const permissionsSource = rolePermissionArray(roleCode);

    for (const permissionCode of permissionCodes) {
      expect(roleHasPermission(permissionsSource, permissionCode)).toBe(true);
    }
  }

  function rolePermissionArray(roleCode: string) {
    const pattern = new RegExp(
      `await\\s+assignRoleAccess\\(\\s*["']${escapeRegExp(roleCode)}["']\\s*,\\s*\\[([\\s\\S]*?)\\]\\s*,`
    );
    const match = seedSource.match(pattern);
    const source = match?.[1];

    expect(source).toBeDefined();
    return source ?? "";
  }

  function roleMenuArray(roleCode: string) {
    const pattern = new RegExp(
      `await\\s+assignRoleAccess\\(\\s*["']${escapeRegExp(roleCode)}["']\\s*,\\s*\\[[\\s\\S]*?\\]\\s*,\\s*\\[([\\s\\S]*?)\\]\\s*\\)`
    );
    const match = seedSource.match(pattern);
    const source = match?.[1];

    expect(source).toBeDefined();
    return source ?? "";
  }

  function roleHasMenu(source: string, menuCode: string) {
    return sourceHasValue(source, menuCode);
  }

  function roleHasPermission(source: string, permissionCode: string, seen = new Set<string>()) {
    return sourceHasValue(source, permissionCode, seen);
  }

  function sourceHasValue(source: string, value: string, seen = new Set<string>()) {
    if (containsQuotedValue(source, value)) {
      return true;
    }

    for (const identifier of spreadIdentifiers(source)) {
      if (seen.has(identifier)) {
        continue;
      }

      seen.add(identifier);

      if (sourceHasValue(permissionConstantSource(identifier), value, seen)) {
        return true;
      }
    }

    return false;
  }

  function permissionConstantSource(identifier: string) {
    const parts: string[] = [];
    const declarationPattern = new RegExp(
      `const\\s+${escapeRegExp(identifier)}\\s*=\\s*\\[([\\s\\S]*?)\\];`
    );
    const declarationMatch = seedSource.match(declarationPattern);
    const declarationSource = declarationMatch?.[1];

    if (declarationSource) {
      parts.push(declarationSource);
    }

    const pushPattern = new RegExp(`${escapeRegExp(identifier)}\\.push\\(([\\s\\S]*?)\\);`, "g");

    for (const pushMatch of seedSource.matchAll(pushPattern)) {
      const pushSource = pushMatch[1];

      if (pushSource) {
        parts.push(pushSource);
      }
    }

    return parts.join("\n");
  }

  function spreadIdentifiers(source: string) {
    const identifiers: string[] = [];

    for (const match of source.matchAll(/\.\.\.([A-Za-z_$][\w$]*)/g)) {
      const identifier = match[1];

      if (identifier) {
        identifiers.push(identifier);
      }
    }

    return identifiers;
  }

  function containsQuotedValue(source: string, value: string) {
    return new RegExp(`["']${escapeRegExp(value)}["']`).test(source);
  }

  function escapeRegExp(value: string) {
    return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  }
});
