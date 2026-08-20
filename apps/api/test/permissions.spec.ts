import "reflect-metadata";

import fs from "node:fs";
import path from "node:path";

import { RequestMethod } from "@nestjs/common";
import { METHOD_METADATA, PATH_METADATA } from "@nestjs/common/constants";
import { PermissionCode, SYSTEM_MENUS } from "@subscription-saas/shared";
import { describe, expect, it } from "vitest";

import {
  REQUIRED_ANY_PERMISSIONS_KEY,
  REQUIRED_PERMISSIONS_KEY
} from "../src/auth/auth.decorators";
import { hasAnyRequiredPermission, hasRequiredPermissions } from "../src/auth/permissions";
import { AssetFactsController } from "../src/asset-facts/asset-facts.controller";
import { AssetOperationsController } from "../src/asset-operations/asset-operations.controller";
import { CustomerController } from "../src/customer/customer.controller";
import { FinanceController } from "../src/finance/finance.controller";
import { FinancingController } from "../src/financing/financing.controller";
import { NotificationAdminController } from "../src/notification/notification.controller";
import { OrderController } from "../src/order/order.controller";
import { ProductController } from "../src/product/product.controller";
import { ReportController } from "../src/report/report.controller";
import {
  ResidualMarketController,
  VehicleResidualForecastController
} from "../src/residual-market/residual-market.controller";
import { RevenueRightController } from "../src/revenue-right/revenue-right.controller";
import { ServiceCaseController } from "../src/service-case/service-case.controller";
import { SubscriptionJourneyController } from "../src/subscription-journey/subscription-journey.controller";
import { VehicleAssetPoolController } from "../src/vehicle-asset-pool/vehicle-asset-pool.controller";
import { VehicleBaasController } from "../src/vehicle-baas/vehicle-baas.controller";
import { VehicleDepreciationController } from "../src/vehicle-depreciation/vehicle-depreciation.controller";
import { VehicleInsuranceController } from "../src/vehicle-insurance/vehicle-insurance.controller";
import { VehicleModelDefinitionController } from "../src/vehicle-model-definition/vehicle-model-definition.controller";
import { VehicleValuationReviewController } from "../src/vehicle-valuation-review/vehicle-valuation-review.controller";
import { VehicleController } from "../src/vehicle/vehicle.controller";

const CAPITAL_STRUCTURE_VIEW_PERMISSION = "capital_structure:view";
const CAPITAL_STRUCTURE_MANAGE_PERMISSION = "capital_structure:manage";
const FINANCING_VIEW_PERMISSION = "financing:view";
const FINANCING_MANAGE_PERMISSION = "financing:manage";
const VEHICLE_ASSET_POOL_VIEW_PERMISSION = "vehicle_asset_pool:view";
const VEHICLE_ASSET_POOL_MANAGE_PERMISSION = "vehicle_asset_pool:manage";
const VEHICLE_INSURANCE_VIEW_PERMISSION = "vehicle_insurance:view";
const VEHICLE_INSURANCE_MANAGE_PERMISSION = "vehicle_insurance:manage";
const VEHICLE_DOCUMENT_VIEW_PERMISSION = "vehicle_document:view";
const VEHICLE_DOCUMENT_MANAGE_PERMISSION = "vehicle_document:manage";
const VEHICLE_BAAS_VIEW_PERMISSION = "vehicle_baas:view";
const VEHICLE_BAAS_MANAGE_PERMISSION = "vehicle_baas:manage";
const VEHICLE_DEPRECIATION_VIEW_PERMISSION = "vehicle_depreciation:view";
const VEHICLE_DEPRECIATION_MANAGE_PERMISSION = "vehicle_depreciation:manage";
const VEHICLE_MODEL_VIEW_PERMISSION = "vehicle_model:view";
const VEHICLE_MODEL_MANAGE_PERMISSION = "vehicle_model:manage";
const INSURANCE_CLAIM_VIEW_PERMISSION = "insurance_claim:view";
const INSURANCE_CLAIM_MANAGE_PERMISSION = "insurance_claim:manage";
const REVENUE_RIGHT_VIEW_PERMISSION = "revenue_right:view";
const REVENUE_RIGHT_MANAGE_PERMISSION = "revenue_right:manage";
const REVENUE_SHARE_VIEW_PERMISSION = "revenue_share:view";
const REVENUE_SHARE_MANAGE_PERMISSION = "revenue_share:manage";
const RESIDUAL_MARKET_VIEW_PERMISSION = "residual_market:view";
const RESIDUAL_MARKET_MANAGE_PERMISSION = "residual_market:manage";
const RESIDUAL_MARKET_IMPORT_PERMISSION = "residual_market:import";
const RESIDUAL_CURVE_VIEW_PERMISSION = "residual_curve:view";
const RESIDUAL_CURVE_GENERATE_PERMISSION = "residual_curve:generate";
const RESIDUAL_CURVE_MANAGE_PERMISSION = "residual_curve:manage";
const RESIDUAL_FORECAST_VIEW_PERMISSION = "residual_forecast:view";
const RESIDUAL_FORECAST_GENERATE_PERMISSION = "residual_forecast:generate";
const RESIDUAL_FORECAST_MANAGE_PERMISSION = "residual_forecast:manage";
const RESIDUAL_MODEL_RUN_VIEW_PERMISSION = "residual_model_run:view";
const RESIDUAL_MODEL_RUN_MANAGE_PERMISSION = "residual_model_run:manage";
const VEHICLE_VALUATION_REVIEW_VIEW_PERMISSION = "vehicle_valuation_review:view";
const VEHICLE_VALUATION_REVIEW_CREATE_PERMISSION = "vehicle_valuation_review:create";
const VEHICLE_VALUATION_REVIEW_APPROVE_PERMISSION = "vehicle_valuation_review:approve";
const FLEET_OPS_READ_PERMISSION = "fleet_ops:read";
const FLEET_OPS_MENU_CODE = "vehicles.fleet_ops";

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

describe("asset facts permissions", () => {
  it("requires asset_facts:view for vehicle and order fact projections", () => {
    for (const handler of [
      AssetFactsController.prototype.getByVehicle,
      AssetFactsController.prototype.getByOrder
    ]) {
      const requiredPermissions = Reflect.getMetadata(REQUIRED_PERMISSIONS_KEY, handler);
      expect(requiredPermissions).toEqual([PermissionCode.ASSET_FACTS_VIEW]);
      expect(hasRequiredPermissions([], requiredPermissions)).toBe(false);
      expect(hasRequiredPermissions([PermissionCode.ASSET_FACTS_VIEW], requiredPermissions)).toBe(
        true
      );
    }
  });

  it("separates ownership administration from subscription-period repair", () => {
    for (const handler of [
      AssetFactsController.prototype.openOwnershipPeriod,
      AssetFactsController.prototype.closeOwnershipPeriod
    ]) {
      expect(Reflect.getMetadata(REQUIRED_PERMISSIONS_KEY, handler)).toEqual([
        PermissionCode.ASSET_OWNER_MANAGE
      ]);
    }
    for (const handler of [
      AssetFactsController.prototype.openSubscriptionPeriod,
      AssetFactsController.prototype.closeSubscriptionPeriod
    ]) {
      expect(Reflect.getMetadata(REQUIRED_PERMISSIONS_KEY, handler)).toEqual([
        PermissionCode.VEHICLE_PERIOD_MANAGE
      ]);
    }
  });
});

describe("asset operations permissions", () => {
  it("publishes the exact five permission codes", () => {
    expect([
      PermissionCode.ASSET_OPERATIONS_VIEW,
      PermissionCode.ASSET_WORK_ORDER_MANAGE,
      PermissionCode.VEHICLE_RESTRICTION_MANAGE,
      PermissionCode.VEHICLE_RESTRICTION_RELEASE,
      PermissionCode.VEHICLE_RESTRICTION_APPROVE_RELEASE
    ]).toEqual([
      "asset_operations:view",
      "asset_work_order:manage",
      "vehicle_restriction:manage",
      "vehicle_restriction:release",
      "vehicle_restriction:approve_release"
    ]);
  });

  it("gates reads, work-order commands, restriction creation, and release exactly", () => {
    for (const handler of [
      AssetOperationsController.prototype.getWorkOrderDetail,
      AssetOperationsController.prototype.listVehicleWorkOrders,
      AssetOperationsController.prototype.listVehicleRestrictions,
      AssetOperationsController.prototype.getVehicleAvailability
    ]) {
      expect(Reflect.getMetadata(REQUIRED_PERMISSIONS_KEY, handler)).toEqual([
        PermissionCode.ASSET_OPERATIONS_VIEW
      ]);
    }
    for (const handler of [
      AssetOperationsController.prototype.createWorkOrder,
      AssetOperationsController.prototype.assignWorkOrder,
      AssetOperationsController.prototype.transitionWorkOrder,
      AssetOperationsController.prototype.appendNote,
      AssetOperationsController.prototype.appendEvidence
    ]) {
      expect(Reflect.getMetadata(REQUIRED_PERMISSIONS_KEY, handler)).toEqual([
        PermissionCode.ASSET_WORK_ORDER_MANAGE
      ]);
    }
    expect(
      Reflect.getMetadata(
        REQUIRED_PERMISSIONS_KEY,
        AssetOperationsController.prototype.createRestriction
      )
    ).toEqual([PermissionCode.VEHICLE_RESTRICTION_MANAGE]);
    expect(
      Reflect.getMetadata(
        REQUIRED_ANY_PERMISSIONS_KEY,
        AssetOperationsController.prototype.releaseRestriction
      )
    ).toEqual([
      PermissionCode.VEHICLE_RESTRICTION_RELEASE,
      PermissionCode.VEHICLE_RESTRICTION_APPROVE_RELEASE
    ]);
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

describe("vehicle asset cost profile permissions", () => {
  const getPermissions = Reflect.getMetadata(
    REQUIRED_ANY_PERMISSIONS_KEY,
    VehicleController.prototype.getAssetCostProfile
  );
  const previewPermissions = Reflect.getMetadata(
    REQUIRED_ANY_PERMISSIONS_KEY,
    VehicleController.prototype.getAssetCostProfilePreview
  );
  const updatePermissions = Reflect.getMetadata(
    REQUIRED_PERMISSIONS_KEY,
    VehicleController.prototype.upsertAssetCostProfile
  );

  it("allows vehicle:view or report:asset to read asset cost profiles and previews", () => {
    expect(getPermissions).toEqual([PermissionCode.VEHICLE_VIEW, PermissionCode.REPORT_ASSET]);
    expect(previewPermissions).toEqual([PermissionCode.VEHICLE_VIEW, PermissionCode.REPORT_ASSET]);
    expect(hasAnyRequiredPermission([PermissionCode.VEHICLE_VIEW], getPermissions)).toBe(true);
    expect(hasAnyRequiredPermission([PermissionCode.REPORT_ASSET], previewPermissions)).toBe(true);
  });

  it("requires vehicle:manage to upsert asset cost profiles", () => {
    expect(updatePermissions).toEqual([PermissionCode.VEHICLE_MANAGE]);
    expect(hasRequiredPermissions([PermissionCode.VEHICLE_VIEW], updatePermissions)).toBe(false);
    expect(hasRequiredPermissions([PermissionCode.VEHICLE_MANAGE], updatePermissions)).toBe(true);
  });
});

describe("vehicle capital structure permissions", () => {
  const listEventsPermissions = Reflect.getMetadata(
    REQUIRED_ANY_PERMISSIONS_KEY,
    VehicleController.prototype.listCapitalEvents
  );
  const previewPermissions = Reflect.getMetadata(
    REQUIRED_ANY_PERMISSIONS_KEY,
    VehicleController.prototype.getCapitalStructure
  );
  const createEventPermissions = Reflect.getMetadata(
    REQUIRED_PERMISSIONS_KEY,
    VehicleController.prototype.createCapitalEvent
  );
  const updateEventPermissions = Reflect.getMetadata(
    REQUIRED_PERMISSIONS_KEY,
    VehicleController.prototype.updateCapitalEvent
  );
  const cancelEventPermissions = Reflect.getMetadata(
    REQUIRED_PERMISSIONS_KEY,
    VehicleController.prototype.cancelCapitalEvent
  );

  it("allows capital_structure:view, vehicle:view, or report:asset to read capital structure data", () => {
    const expected = [
      CAPITAL_STRUCTURE_VIEW_PERMISSION,
      PermissionCode.VEHICLE_VIEW,
      PermissionCode.REPORT_ASSET
    ];
    expect(listEventsPermissions).toEqual(expected);
    expect(previewPermissions).toEqual(expected);
    expect(
      hasAnyRequiredPermission([CAPITAL_STRUCTURE_VIEW_PERMISSION], listEventsPermissions)
    ).toBe(true);
    expect(hasAnyRequiredPermission([PermissionCode.VEHICLE_VIEW], previewPermissions)).toBe(true);
    expect(hasAnyRequiredPermission([PermissionCode.REPORT_ASSET], previewPermissions)).toBe(true);
  });

  it("requires capital_structure:manage to create, update, and cancel capital events", () => {
    for (const permissions of [
      createEventPermissions,
      updateEventPermissions,
      cancelEventPermissions
    ]) {
      expect(permissions).toEqual([CAPITAL_STRUCTURE_MANAGE_PERMISSION]);
      expect(hasRequiredPermissions([CAPITAL_STRUCTURE_VIEW_PERMISSION], permissions)).toBe(false);
      expect(hasRequiredPermissions([CAPITAL_STRUCTURE_MANAGE_PERMISSION], permissions)).toBe(true);
    }
  });
});

describe("financing instrument permissions", () => {
  it("requires financing:view for financing instrument reads", () => {
    for (const handler of [
      FinancingController.prototype.listInstruments,
      FinancingController.prototype.getInstrument
    ]) {
      expect(Reflect.getMetadata(REQUIRED_PERMISSIONS_KEY, handler)).toEqual([
        FINANCING_VIEW_PERMISSION
      ]);
    }
  });

  it("requires financing:manage for financing mutations", () => {
    for (const handler of [
      FinancingController.prototype.createInstrument,
      FinancingController.prototype.updateInstrument,
      FinancingController.prototype.settleInstrument,
      FinancingController.prototype.allocateVehicle,
      FinancingController.prototype.releaseAllocation,
      FinancingController.prototype.previewVehiclePoolAllocation,
      FinancingController.prototype.executeVehiclePoolAllocation
    ]) {
      expect(Reflect.getMetadata(REQUIRED_PERMISSIONS_KEY, handler)).toEqual([
        FINANCING_MANAGE_PERMISSION
      ]);
    }
  });
});

describe("vehicle asset pool permissions", () => {
  it("requires vehicle_asset_pool:view for pool reads", () => {
    for (const handler of [
      VehicleAssetPoolController.prototype.listPools,
      VehicleAssetPoolController.prototype.getPool
    ]) {
      expect(Reflect.getMetadata(REQUIRED_PERMISSIONS_KEY, handler)).toEqual([
        VEHICLE_ASSET_POOL_VIEW_PERMISSION
      ]);
    }
  });

  it("requires vehicle_asset_pool:manage for pool mutations", () => {
    for (const handler of [
      VehicleAssetPoolController.prototype.createPool,
      VehicleAssetPoolController.prototype.updatePool,
      VehicleAssetPoolController.prototype.archivePool,
      VehicleAssetPoolController.prototype.addVehicleToPool,
      VehicleAssetPoolController.prototype.batchAddVehiclesToPool,
      VehicleAssetPoolController.prototype.removeVehicleFromPool
    ]) {
      expect(Reflect.getMetadata(REQUIRED_PERMISSIONS_KEY, handler)).toEqual([
        VEHICLE_ASSET_POOL_MANAGE_PERMISSION
      ]);
    }
  });
});

describe("revenue right and sharing permissions", () => {
  it("requires revenue_right:view for assignment reads", () => {
    for (const handler of [
      RevenueRightController.prototype.listAssignments,
      RevenueRightController.prototype.getAssignment
    ]) {
      expect(Reflect.getMetadata(REQUIRED_PERMISSIONS_KEY, handler)).toEqual([
        REVENUE_RIGHT_VIEW_PERMISSION
      ]);
    }
  });

  it("requires revenue_right:manage for assignment mutations", () => {
    for (const handler of [
      RevenueRightController.prototype.createAssignment,
      RevenueRightController.prototype.releaseAssignment
    ]) {
      expect(Reflect.getMetadata(REQUIRED_PERMISSIONS_KEY, handler)).toEqual([
        REVENUE_RIGHT_MANAGE_PERMISSION
      ]);
    }
  });

  it("allows revenue_share:view or vehicle/report permissions for share rule reads and preview", () => {
    expect(
      Reflect.getMetadata(
        REQUIRED_ANY_PERMISSIONS_KEY,
        RevenueRightController.prototype.listVehicleRevenueShareRules
      )
    ).toEqual([REVENUE_SHARE_VIEW_PERMISSION, PermissionCode.VEHICLE_VIEW]);
    expect(
      Reflect.getMetadata(
        REQUIRED_ANY_PERMISSIONS_KEY,
        RevenueRightController.prototype.getVehicleRevenueSharePreview
      )
    ).toEqual([REVENUE_SHARE_VIEW_PERMISSION, PermissionCode.REPORT_ASSET]);
  });

  it("requires revenue_share:manage for share rule mutations", () => {
    for (const handler of [
      RevenueRightController.prototype.createVehicleRevenueShareRule,
      RevenueRightController.prototype.deactivateVehicleRevenueShareRule
    ]) {
      expect(Reflect.getMetadata(REQUIRED_PERMISSIONS_KEY, handler)).toEqual([
        REVENUE_SHARE_MANAGE_PERMISSION
      ]);
    }
  });
});

describe("residual market permissions", () => {
  it("requires residual_market:view for observation and import batch reads", () => {
    for (const handler of [
      ResidualMarketController.prototype.listObservations,
      ResidualMarketController.prototype.getObservation,
      ResidualMarketController.prototype.listImportBatches,
      ResidualMarketController.prototype.getImportBatch
    ]) {
      expect(Reflect.getMetadata(REQUIRED_PERMISSIONS_KEY, handler)).toEqual([
        RESIDUAL_MARKET_VIEW_PERMISSION
      ]);
    }
  });

  it("requires residual_market:manage for manual mutation and void actions", () => {
    for (const handler of [
      ResidualMarketController.prototype.createObservation,
      ResidualMarketController.prototype.voidObservation
    ]) {
      expect(Reflect.getMetadata(REQUIRED_PERMISSIONS_KEY, handler)).toEqual([
        RESIDUAL_MARKET_MANAGE_PERMISSION
      ]);
    }
  });

  it("requires residual_market:import for CSV imports", () => {
    expect(
      Reflect.getMetadata(REQUIRED_PERMISSIONS_KEY, ResidualMarketController.prototype.importCsv)
    ).toEqual([RESIDUAL_MARKET_IMPORT_PERMISSION]);
  });
});

describe("residual curve permissions", () => {
  it("requires residual_curve:view for curve reads", () => {
    for (const handler of [
      ResidualMarketController.prototype.listCurves,
      ResidualMarketController.prototype.getCurve
    ]) {
      expect(Reflect.getMetadata(REQUIRED_PERMISSIONS_KEY, handler)).toEqual([
        RESIDUAL_CURVE_VIEW_PERMISSION
      ]);
    }
  });

  it("requires residual_curve:generate for curve generation", () => {
    expect(
      Reflect.getMetadata(
        REQUIRED_PERMISSIONS_KEY,
        ResidualMarketController.prototype.generateCurve
      )
    ).toEqual([RESIDUAL_CURVE_GENERATE_PERMISSION]);
  });

  it("requires residual_curve:manage for curve activation and archive", () => {
    for (const handler of [
      ResidualMarketController.prototype.activateCurve,
      ResidualMarketController.prototype.archiveCurve
    ]) {
      expect(Reflect.getMetadata(REQUIRED_PERMISSIONS_KEY, handler)).toEqual([
        RESIDUAL_CURVE_MANAGE_PERMISSION
      ]);
    }
  });
});

describe("vehicle residual forecast permissions", () => {
  it("requires residual_forecast:view for forecast reads", () => {
    for (const handler of [
      VehicleResidualForecastController.prototype.listVehicleForecasts,
      VehicleResidualForecastController.prototype.getLatestVehicleForecast,
      ResidualMarketController.prototype.getVehicleForecast
    ]) {
      expect(Reflect.getMetadata(REQUIRED_PERMISSIONS_KEY, handler)).toEqual([
        RESIDUAL_FORECAST_VIEW_PERMISSION
      ]);
    }
  });

  it("requires residual_forecast:generate for forecast generation", () => {
    expect(
      Reflect.getMetadata(
        REQUIRED_PERMISSIONS_KEY,
        VehicleResidualForecastController.prototype.generateVehicleForecast
      )
    ).toEqual([RESIDUAL_FORECAST_GENERATE_PERMISSION]);
  });

  it("requires residual_forecast:manage for forecast adoption and void", () => {
    for (const handler of [
      ResidualMarketController.prototype.adoptVehicleForecastPoint,
      ResidualMarketController.prototype.voidVehicleForecast
    ]) {
      expect(Reflect.getMetadata(REQUIRED_PERMISSIONS_KEY, handler)).toEqual([
        RESIDUAL_FORECAST_MANAGE_PERMISSION
      ]);
    }
  });
});

describe("residual model run permissions", () => {
  it("requires residual_model_run:view for model run reads", () => {
    for (const handler of [
      ResidualMarketController.prototype.listModelRuns,
      ResidualMarketController.prototype.getModelRun
    ]) {
      expect(Reflect.getMetadata(REQUIRED_PERMISSIONS_KEY, handler)).toEqual([
        RESIDUAL_MODEL_RUN_VIEW_PERMISSION
      ]);
    }
  });

  it("requires residual_model_run:manage for model run mutations", () => {
    for (const handler of [
      ResidualMarketController.prototype.createModelRun,
      ResidualMarketController.prototype.completeModelRun,
      ResidualMarketController.prototype.failModelRun,
      ResidualMarketController.prototype.cancelModelRun
    ]) {
      expect(Reflect.getMetadata(REQUIRED_PERMISSIONS_KEY, handler)).toEqual([
        RESIDUAL_MODEL_RUN_MANAGE_PERMISSION
      ]);
    }
  });
});

describe("vehicle valuation review permissions", () => {
  it("requires vehicle_valuation_review:view for review reads", () => {
    for (const handler of [
      VehicleValuationReviewController.prototype.listVehicleReviews,
      VehicleValuationReviewController.prototype.listReviews,
      VehicleValuationReviewController.prototype.getReview
    ]) {
      const requiredPermissions = Reflect.getMetadata(REQUIRED_PERMISSIONS_KEY, handler);
      expect(requiredPermissions).toEqual([VEHICLE_VALUATION_REVIEW_VIEW_PERMISSION]);
      expect(hasRequiredPermissions([], requiredPermissions)).toBe(false);
      expect(
        hasRequiredPermissions([VEHICLE_VALUATION_REVIEW_VIEW_PERMISSION], requiredPermissions)
      ).toBe(true);
    }
  });

  it("requires vehicle_valuation_review:create for review creation and cancellation", () => {
    for (const handler of [
      VehicleValuationReviewController.prototype.createFromResidualForecast,
      VehicleValuationReviewController.prototype.cancelReview
    ]) {
      const requiredPermissions = Reflect.getMetadata(REQUIRED_PERMISSIONS_KEY, handler);
      expect(requiredPermissions).toEqual([VEHICLE_VALUATION_REVIEW_CREATE_PERMISSION]);
      expect(
        hasRequiredPermissions([VEHICLE_VALUATION_REVIEW_VIEW_PERMISSION], requiredPermissions)
      ).toBe(false);
      expect(
        hasRequiredPermissions([VEHICLE_VALUATION_REVIEW_CREATE_PERMISSION], requiredPermissions)
      ).toBe(true);
    }
  });

  it("requires vehicle_valuation_review:approve for review approval and rejection", () => {
    for (const handler of [
      VehicleValuationReviewController.prototype.approveReview,
      VehicleValuationReviewController.prototype.rejectReview
    ]) {
      const requiredPermissions = Reflect.getMetadata(REQUIRED_PERMISSIONS_KEY, handler);
      expect(requiredPermissions).toEqual([VEHICLE_VALUATION_REVIEW_APPROVE_PERMISSION]);
      expect(
        hasRequiredPermissions([VEHICLE_VALUATION_REVIEW_VIEW_PERMISSION], requiredPermissions)
      ).toBe(false);
      expect(
        hasRequiredPermissions([VEHICLE_VALUATION_REVIEW_APPROVE_PERMISSION], requiredPermissions)
      ).toBe(true);
    }
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

describe("order workspace permissions", () => {
  it("exposes workspace detail as an order-view GET endpoint", () => {
    const handler = (
      OrderController.prototype as unknown as Record<string, (...args: unknown[]) => unknown>
    ).getOrderWorkspaceDetail;

    expect(handler).toBeTypeOf("function");
    if (!handler) {
      throw new Error("workspace detail handler is missing");
    }
    expect(Reflect.getMetadata(PATH_METADATA, handler)).toBe("orders/:id/workspace/detail");
    expect(Reflect.getMetadata(METHOD_METADATA, handler)).toBe(RequestMethod.GET);
    expect(Reflect.getMetadata(REQUIRED_PERMISSIONS_KEY, handler)).toEqual([
      PermissionCode.ORDER_VIEW
    ]);
  });

  it("requires order and service-case view for scoped workspace service details", () => {
    const handler = (
      OrderController.prototype as unknown as Record<string, (...args: unknown[]) => unknown>
    ).getOrderWorkspaceServiceCase;

    expect(handler).toBeTypeOf("function");
    if (!handler) {
      throw new Error("workspace service-case handler is missing");
    }
    expect(Reflect.getMetadata(PATH_METADATA, handler)).toBe(
      "orders/:id/workspace/service-cases/:serviceCaseId"
    );
    expect(Reflect.getMetadata(METHOD_METADATA, handler)).toBe(RequestMethod.GET);
    expect(Reflect.getMetadata(REQUIRED_PERMISSIONS_KEY, handler)).toEqual([
      PermissionCode.ORDER_VIEW,
      PermissionCode.SERVICE_CASE_VIEW
    ]);
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

describe("service case permissions", () => {
  it("gates service-case view and management APIs behind service-case permissions", () => {
    const listPermissions = Reflect.getMetadata(
      REQUIRED_PERMISSIONS_KEY,
      ServiceCaseController.prototype.listServiceCases
    );
    const detailPermissions = Reflect.getMetadata(
      REQUIRED_PERMISSIONS_KEY,
      ServiceCaseController.prototype.getServiceCase
    );
    const acceptPermissions = Reflect.getMetadata(
      REQUIRED_PERMISSIONS_KEY,
      ServiceCaseController.prototype.acceptServiceCase
    );
    const statusPermissions = Reflect.getMetadata(
      REQUIRED_PERMISSIONS_KEY,
      ServiceCaseController.prototype.updateServiceCaseStatus
    );
    const actionPermissions = Reflect.getMetadata(
      REQUIRED_PERMISSIONS_KEY,
      ServiceCaseController.prototype.addServiceCaseAction
    );
    const closePermissions = Reflect.getMetadata(
      REQUIRED_PERMISSIONS_KEY,
      ServiceCaseController.prototype.closeServiceCase
    );

    expect(listPermissions).toEqual([PermissionCode.SERVICE_CASE_VIEW]);
    expect(detailPermissions).toEqual([PermissionCode.SERVICE_CASE_VIEW]);
    expect(acceptPermissions).toEqual([PermissionCode.SERVICE_CASE_MANAGE]);
    expect(statusPermissions).toEqual([PermissionCode.SERVICE_CASE_MANAGE]);
    expect(actionPermissions).toEqual([PermissionCode.SERVICE_CASE_MANAGE]);
    expect(closePermissions).toEqual([PermissionCode.SERVICE_CASE_MANAGE]);
    expect(hasRequiredPermissions([PermissionCode.SERVICE_CASE_VIEW], acceptPermissions)).toBe(
      false
    );
    expect(hasRequiredPermissions([PermissionCode.SERVICE_CASE_MANAGE], acceptPermissions)).toBe(
      true
    );
  });
});

describe("vehicle insurance, document, and claim permissions", () => {
  it("gates vehicle insurance APIs behind vehicle insurance permissions", () => {
    const listPermissions = Reflect.getMetadata(
      REQUIRED_PERMISSIONS_KEY,
      VehicleInsuranceController.prototype.listPolicies
    );
    const detailPermissions = Reflect.getMetadata(
      REQUIRED_PERMISSIONS_KEY,
      VehicleInsuranceController.prototype.getPolicy
    );
    const createPermissions = Reflect.getMetadata(
      REQUIRED_PERMISSIONS_KEY,
      VehicleInsuranceController.prototype.createPolicy
    );
    const updatePermissions = Reflect.getMetadata(
      REQUIRED_PERMISSIONS_KEY,
      VehicleInsuranceController.prototype.updatePolicy
    );
    const archivePermissions = Reflect.getMetadata(
      REQUIRED_PERMISSIONS_KEY,
      VehicleInsuranceController.prototype.archivePolicy
    );
    const deletePermissions = Reflect.getMetadata(
      REQUIRED_PERMISSIONS_KEY,
      VehicleInsuranceController.prototype.deletePolicy
    );

    expect(listPermissions).toEqual([VEHICLE_INSURANCE_VIEW_PERMISSION]);
    expect(detailPermissions).toEqual([VEHICLE_INSURANCE_VIEW_PERMISSION]);
    expect(createPermissions).toEqual([VEHICLE_INSURANCE_MANAGE_PERMISSION]);
    expect(updatePermissions).toEqual([VEHICLE_INSURANCE_MANAGE_PERMISSION]);
    expect(archivePermissions).toEqual([VEHICLE_INSURANCE_MANAGE_PERMISSION]);
    expect(deletePermissions).toEqual([VEHICLE_INSURANCE_MANAGE_PERMISSION]);
    expect(hasRequiredPermissions([VEHICLE_INSURANCE_VIEW_PERMISSION], createPermissions)).toBe(
      false
    );
    expect(hasRequiredPermissions([VEHICLE_INSURANCE_MANAGE_PERMISSION], createPermissions)).toBe(
      true
    );
  });

  it("gates vehicle document APIs behind vehicle document permissions", () => {
    const listPermissions = Reflect.getMetadata(
      REQUIRED_PERMISSIONS_KEY,
      VehicleInsuranceController.prototype.listDocuments
    );
    const uploadPermissions = Reflect.getMetadata(
      REQUIRED_PERMISSIONS_KEY,
      VehicleInsuranceController.prototype.uploadDocument
    );
    const policyUploadPermissions = Reflect.getMetadata(
      REQUIRED_PERMISSIONS_KEY,
      VehicleInsuranceController.prototype.uploadPolicyDocuments
    );
    const deletePermissions = Reflect.getMetadata(
      REQUIRED_PERMISSIONS_KEY,
      VehicleInsuranceController.prototype.deleteDocument
    );
    const previewPermissions = Reflect.getMetadata(
      REQUIRED_PERMISSIONS_KEY,
      VehicleInsuranceController.prototype.previewDocument
    );

    expect(listPermissions).toEqual([VEHICLE_DOCUMENT_VIEW_PERMISSION]);
    expect(previewPermissions).toEqual([VEHICLE_DOCUMENT_VIEW_PERMISSION]);
    expect(uploadPermissions).toEqual([VEHICLE_DOCUMENT_MANAGE_PERMISSION]);
    expect(policyUploadPermissions).toEqual([VEHICLE_INSURANCE_MANAGE_PERMISSION]);
    expect(deletePermissions).toEqual([VEHICLE_DOCUMENT_MANAGE_PERMISSION]);
    expect(hasRequiredPermissions([VEHICLE_DOCUMENT_VIEW_PERMISSION], uploadPermissions)).toBe(
      false
    );
    expect(hasRequiredPermissions([VEHICLE_DOCUMENT_MANAGE_PERMISSION], uploadPermissions)).toBe(
      true
    );
  });

  it("gates insurance claim APIs behind claim permissions", () => {
    const listPermissions = Reflect.getMetadata(
      REQUIRED_PERMISSIONS_KEY,
      VehicleInsuranceController.prototype.listClaims
    );
    const detailPermissions = Reflect.getMetadata(
      REQUIRED_PERMISSIONS_KEY,
      VehicleInsuranceController.prototype.getClaim
    );
    const createPermissions = Reflect.getMetadata(
      REQUIRED_PERMISSIONS_KEY,
      VehicleInsuranceController.prototype.createClaim
    );
    const updatePermissions = Reflect.getMetadata(
      REQUIRED_PERMISSIONS_KEY,
      VehicleInsuranceController.prototype.updateClaim
    );

    expect(listPermissions).toEqual([INSURANCE_CLAIM_VIEW_PERMISSION]);
    expect(detailPermissions).toEqual([INSURANCE_CLAIM_VIEW_PERMISSION]);
    expect(createPermissions).toEqual([INSURANCE_CLAIM_MANAGE_PERMISSION]);
    expect(updatePermissions).toEqual([INSURANCE_CLAIM_MANAGE_PERMISSION]);
    expect(hasRequiredPermissions([INSURANCE_CLAIM_VIEW_PERMISSION], createPermissions)).toBe(
      false
    );
    expect(hasRequiredPermissions([INSURANCE_CLAIM_MANAGE_PERMISSION], createPermissions)).toBe(
      true
    );
  });
});

describe("vehicle baas permissions", () => {
  it("gates BaaS contract, attachment, and cost APIs behind vehicle_baas permissions", () => {
    const viewHandlers = [
      VehicleBaasController.prototype.listContracts,
      VehicleBaasController.prototype.getContract,
      VehicleBaasController.prototype.getVehicleBaasSummary,
      VehicleBaasController.prototype.listAttachments,
      VehicleBaasController.prototype.previewAttachment,
      VehicleBaasController.prototype.listCostRecords,
      VehicleBaasController.prototype.listContractCostRecords
    ];
    const manageHandlers = [
      VehicleBaasController.prototype.createContract,
      VehicleBaasController.prototype.updateContract,
      VehicleBaasController.prototype.activateContract,
      VehicleBaasController.prototype.suspendContract,
      VehicleBaasController.prototype.terminateContract,
      VehicleBaasController.prototype.archiveContract,
      VehicleBaasController.prototype.uploadAttachment,
      VehicleBaasController.prototype.deleteAttachment,
      VehicleBaasController.prototype.generateCostRecords,
      VehicleBaasController.prototype.createCostRecord,
      VehicleBaasController.prototype.updateCostRecord,
      VehicleBaasController.prototype.confirmCostRecord,
      VehicleBaasController.prototype.markCostRecordPaid,
      VehicleBaasController.prototype.voidCostRecord
    ];

    for (const handler of viewHandlers) {
      expect(Reflect.getMetadata(REQUIRED_PERMISSIONS_KEY, handler)).toEqual([
        VEHICLE_BAAS_VIEW_PERMISSION
      ]);
    }
    for (const handler of manageHandlers) {
      const permissions = Reflect.getMetadata(REQUIRED_PERMISSIONS_KEY, handler);
      expect(permissions).toEqual([VEHICLE_BAAS_MANAGE_PERMISSION]);
      expect(hasRequiredPermissions([VEHICLE_BAAS_VIEW_PERMISSION], permissions)).toBe(false);
      expect(hasRequiredPermissions([VEHICLE_BAAS_MANAGE_PERMISSION], permissions)).toBe(true);
    }
  });
});

describe("vehicle depreciation permissions", () => {
  it("gates policy, schedule, record, and summary APIs behind vehicle_depreciation permissions", () => {
    const viewHandlers = [
      VehicleDepreciationController.prototype.listPolicies,
      VehicleDepreciationController.prototype.getPolicy,
      VehicleDepreciationController.prototype.listVehiclePolicies,
      VehicleDepreciationController.prototype.getVehicleDepreciationSummary,
      VehicleDepreciationController.prototype.listPolicySchedules,
      VehicleDepreciationController.prototype.listRecords,
      VehicleDepreciationController.prototype.listPolicyRecords
    ];
    const manageHandlers = [
      VehicleDepreciationController.prototype.createPolicy,
      VehicleDepreciationController.prototype.updatePolicy,
      VehicleDepreciationController.prototype.activatePolicy,
      VehicleDepreciationController.prototype.suspendPolicy,
      VehicleDepreciationController.prototype.terminatePolicy,
      VehicleDepreciationController.prototype.archivePolicy,
      VehicleDepreciationController.prototype.generateSchedules,
      VehicleDepreciationController.prototype.confirmSchedule,
      VehicleDepreciationController.prototype.voidSchedule,
      VehicleDepreciationController.prototype.lockSchedule,
      VehicleDepreciationController.prototype.createRecord,
      VehicleDepreciationController.prototype.updateRecord,
      VehicleDepreciationController.prototype.confirmRecord,
      VehicleDepreciationController.prototype.voidRecord,
      VehicleDepreciationController.prototype.lockRecord
    ];

    for (const handler of viewHandlers) {
      expect(Reflect.getMetadata(REQUIRED_PERMISSIONS_KEY, handler)).toEqual([
        VEHICLE_DEPRECIATION_VIEW_PERMISSION
      ]);
    }
    for (const handler of manageHandlers) {
      const permissions = Reflect.getMetadata(REQUIRED_PERMISSIONS_KEY, handler);
      expect(permissions).toEqual([VEHICLE_DEPRECIATION_MANAGE_PERMISSION]);
      expect(hasRequiredPermissions([VEHICLE_DEPRECIATION_VIEW_PERMISSION], permissions)).toBe(
        false
      );
      expect(hasRequiredPermissions([VEHICLE_DEPRECIATION_MANAGE_PERMISSION], permissions)).toBe(
        true
      );
    }
  });
});

describe("vehicle model definition permissions", () => {
  it("gates model definition APIs behind vehicle_model permissions", () => {
    const viewHandlers = [
      VehicleModelDefinitionController.prototype.listDefinitions,
      VehicleModelDefinitionController.prototype.getDefinition
    ];
    const manageHandlers = [
      VehicleModelDefinitionController.prototype.createDefinition,
      VehicleModelDefinitionController.prototype.updateDefinition,
      VehicleModelDefinitionController.prototype.enableDefinition,
      VehicleModelDefinitionController.prototype.disableDefinition,
      VehicleModelDefinitionController.prototype.deleteDefinition
    ];

    for (const handler of viewHandlers) {
      expect(Reflect.getMetadata(REQUIRED_PERMISSIONS_KEY, handler)).toEqual([
        VEHICLE_MODEL_VIEW_PERMISSION
      ]);
    }
    for (const handler of manageHandlers) {
      const permissions = Reflect.getMetadata(REQUIRED_PERMISSIONS_KEY, handler);
      expect(permissions).toEqual([VEHICLE_MODEL_MANAGE_PERMISSION]);
      expect(hasRequiredPermissions([VEHICLE_MODEL_VIEW_PERMISSION], permissions)).toBe(false);
      expect(hasRequiredPermissions([VEHICLE_MODEL_MANAGE_PERMISSION], permissions)).toBe(true);
    }
  });
});

describe("notification permissions", () => {
  it("gates back-office notification center APIs behind notification:view", () => {
    for (const handler of [
      NotificationAdminController.prototype.listTemplates,
      NotificationAdminController.prototype.listRecords,
      NotificationAdminController.prototype.listEvents
    ]) {
      const permissions = Reflect.getMetadata(REQUIRED_PERMISSIONS_KEY, handler);
      expect(permissions).toEqual([PermissionCode.NOTIFICATION_VIEW]);
      expect(hasRequiredPermissions([PermissionCode.NOTIFICATION_MANAGE], permissions)).toBe(false);
      expect(hasRequiredPermissions([PermissionCode.NOTIFICATION_VIEW], permissions)).toBe(true);
    }
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
    const assetReturnTrialSummaryPermissions = Reflect.getMetadata(
      REQUIRED_PERMISSIONS_KEY,
      ReportController.prototype.getAssetReturnTrialSummary
    );
    const assetReturnTrialVehiclesPermissions = Reflect.getMetadata(
      REQUIRED_PERMISSIONS_KEY,
      ReportController.prototype.getAssetReturnTrialVehicles
    );
    const assetReturnTrialVehicleDetailPermissions = Reflect.getMetadata(
      REQUIRED_PERMISSIONS_KEY,
      ReportController.prototype.getAssetReturnTrialVehicleDetail
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
    expect(assetProfitabilityVehicleDetailExportPermissions).toEqual([PermissionCode.REPORT_ASSET]);
    expect(assetReturnTrialSummaryPermissions).toEqual([PermissionCode.REPORT_ASSET]);
    expect(assetReturnTrialVehiclesPermissions).toEqual([PermissionCode.REPORT_ASSET]);
    expect(assetReturnTrialVehicleDetailPermissions).toEqual([PermissionCode.REPORT_ASSET]);
    expect(
      hasRequiredPermissions([PermissionCode.REPORT_VIEW], assetReturnTrialSummaryPermissions)
    ).toBe(false);
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
  const fleetOpsAccessSyncPath = path.resolve(__dirname, "../prisma/sync-fleet-ops-access.mjs");
  const sharedAuthSource = fs.readFileSync(
    path.resolve(__dirname, "../../../packages/shared/src/auth.ts"),
    "utf8"
  );
  const fleetOpsApiTypesSource = fs.readFileSync(
    path.resolve(__dirname, "../src/fleet-ops/fleet-ops.api.types.ts"),
    "utf8"
  );
  const apiPackageJson = JSON.parse(
    fs.readFileSync(path.resolve(__dirname, "../package.json"), "utf8")
  ) as { scripts?: Record<string, string> };

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

  it("assigns the governed asset fact permissions to the approved role matrix", () => {
    const assetFactPermissions = [
      "asset_facts:view",
      "asset_owner:manage",
      "vehicle_period:manage"
    ];
    expect(PermissionCode.ASSET_FACTS_VIEW).toBe("asset_facts:view");
    expect(PermissionCode.ASSET_OWNER_MANAGE).toBe("asset_owner:manage");
    expect(PermissionCode.VEHICLE_PERIOD_MANAGE).toBe("vehicle_period:manage");

    for (const permission of assetFactPermissions) {
      expect(seedSource).toContain(`"${permission}"`);
    }

    expectSeedSourceToContain(
      '...(roleCode === "AS" ? assetFactManagementPermissions : assetFactViewPermissions)'
    );
    const sharedLoopRoles = assetFactSharedLoopRoles();
    expect(sharedLoopRoles).toEqual(["FI", "AS"]);
    expect(effectiveAssetFactPermissions(assetFactPermissions, sharedLoopRoles)).toEqual({
      AS: ["asset_facts:view", "asset_owner:manage", "vehicle_period:manage"],
      CS: [],
      FI: ["asset_facts:view"],
      GM: ["asset_facts:view"],
      OP: ["asset_facts:view", "vehicle_period:manage"],
      RC: [],
      SA: []
    });
  });

  it("assigns the exact asset-operations matrix without widening SA or CS", () => {
    const permissionCodes = [
      "asset_operations:view",
      "asset_work_order:manage",
      "vehicle_restriction:manage",
      "vehicle_restriction:release",
      "vehicle_restriction:approve_release"
    ];

    for (const permissionCode of permissionCodes) {
      expect(seedSource).toContain(`"${permissionCode}"`);
    }
    expectSeedSourceToContain("...assetOperationsOperationsPermissions");
    expectSeedSourceToContain("...assetOperationsViewPermissions");
    expectSeedSourceToContain("...assetOperationsApprovalPermissions");
    expectSeedSourceToContain(
      '...(roleCode === "AS" ? assetOperationsManagementPermissions : assetOperationsViewPermissions)'
    );
    expect(seedSource).toContain("allPermissions.map((permission)");

    expect(effectiveAssetOperationsPermissions(permissionCodes)).toEqual({
      ADMIN: permissionCodes,
      AS: permissionCodes,
      CS: [],
      FI: ["asset_operations:view"],
      GM: ["asset_operations:view", "vehicle_restriction:approve_release"],
      OP: [
        "asset_operations:view",
        "asset_work_order:manage",
        "vehicle_restriction:manage",
        "vehicle_restriction:release"
      ],
      RC: ["asset_operations:view"],
      SA: []
    });
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
      "vehicle_valuation_review:view",
      "vehicle_valuation_review:create",
      "vehicle_valuation_review:approve",
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
      "report:asset",
      "capital_structure:view",
      "capital_structure:manage",
      "financing:view",
      "financing:manage",
      "vehicle_asset_pool:view",
      "vehicle_asset_pool:manage",
      "vehicle_model:view",
      "vehicle_model:manage",
      "vehicle_depreciation:view",
      "vehicle_depreciation:manage",
      "revenue_right:view",
      "revenue_right:manage",
      "revenue_share:view",
      "revenue_share:manage",
      "residual_market:view",
      "residual_market:manage",
      "residual_market:import",
      "residual_curve:view",
      "residual_curve:generate",
      "residual_curve:manage",
      "residual_forecast:view",
      "residual_forecast:generate",
      "residual_forecast:manage",
      "residual_model_run:view",
      "residual_model_run:manage"
    ]) {
      expect(seedSource).toContain(`"${permission}"`);
    }
    expect(seedSource).toContain("const allPermissions = await prisma.permission.findMany()");
    expect(seedSource).toContain("allPermissions.map((permission)");
  });

  it("provisions Fleet Ops as a read-only internal vehicle operations menu", () => {
    expect(sharedAuthSource).toContain(`FLEET_OPS_READ = "${FLEET_OPS_READ_PERMISSION}"`);
    expect(fleetOpsApiTypesSource).toContain(
      `FLEET_OPS_READ_PERMISSION = "${FLEET_OPS_READ_PERMISSION}"`
    );
    expect(seedSource).toContain(
      `["${FLEET_OPS_READ_PERMISSION}", "车队运营查看", "fleet_ops", "read"]`
    );
    expect(seedSource).toContain(
      `["${FLEET_OPS_MENU_CODE}", "车队运营", "/fleet-ops", "dashboard", 45, "${FLEET_OPS_READ_PERMISSION}", "vehicles"]`
    );
    expect(seedSource).toContain(
      `const fleetOpsReadPermissions = ["${FLEET_OPS_READ_PERMISSION}"]`
    );
    expect(seedSource).toContain(`const fleetOpsMenuCodes = ["${FLEET_OPS_MENU_CODE}"]`);
    expectRolePermissions("OP", [FLEET_OPS_READ_PERMISSION]);
    expectRolePermissions("GM", [FLEET_OPS_READ_PERMISSION]);
    expect(roleHasMenu(roleMenuArray("OP"), FLEET_OPS_MENU_CODE)).toBe(true);
    expect(roleHasMenu(roleMenuArray("GM"), FLEET_OPS_MENU_CODE)).toBe(true);

    for (const roleCode of ["SA", "RC"]) {
      expect(roleHasPermission(rolePermissionArray(roleCode), FLEET_OPS_READ_PERMISSION)).toBe(
        false
      );
      expect(roleHasMenu(roleMenuArray(roleCode), FLEET_OPS_MENU_CODE)).toBe(false);
    }
    expect(roleLoopSource(["FI", "AS"])).not.toContain("fleetOpsReadPermissions");
    expect(roleLoopSource(["FI", "AS"])).not.toContain("fleetOpsMenuCodes");

    for (const forbiddenPermission of [
      "fleet_ops:write",
      "fleet_ops:execute",
      "fleet_ops:admin",
      "fleet_ops:allocate",
      "fleet_ops:collect",
      "fleet_ops:action"
    ]) {
      expect(seedSource).not.toContain(forbiddenPermission);
    }
  });

  it("provides a narrow idempotent Fleet Ops access sync command for existing databases", () => {
    expect(fs.existsSync(fleetOpsAccessSyncPath)).toBe(true);
    expect(apiPackageJson.scripts?.["prisma:sync:fleet-ops-access"]).toBe(
      "node prisma/sync-fleet-ops-access.mjs"
    );

    const syncSource = fs.readFileSync(fleetOpsAccessSyncPath, "utf8");

    expect(syncSource).toContain(FLEET_OPS_READ_PERMISSION);
    expect(syncSource).toContain(FLEET_OPS_MENU_CODE);
    expect(syncSource).toContain("/fleet-ops");
    expect(syncSource).toContain("车队运营");
    expect(syncSource).toContain("车队运营查看");
    expect(syncSource).toContain("upsert");
    expect(syncSource).toContain("rolePermission.upsert");
    expect(syncSource).toContain("roleMenu.upsert");
    expect(syncSource).toContain("deletedAt: null");
    expect(syncSource).not.toContain('import "./seed.mjs"');
    expect(syncSource).not.toContain('from "./seed.mjs"');
    expect(syncSource).not.toContain("seedDefaultUsers");

    for (const roleCode of ["ADMIN", "OP", "GM"]) {
      expect(syncSource).toContain(`"${roleCode}"`);
    }

    for (const forbiddenRoleCode of [
      "AS",
      "FI",
      "SA",
      "RC",
      "CS",
      "CUSTOMER",
      "PUBLIC",
      "PORTAL"
    ]) {
      expect(syncSource).not.toContain(`"${forbiddenRoleCode}"`);
    }

    for (const forbiddenPermission of [
      "fleet_ops:write",
      "fleet_ops:execute",
      "fleet_ops:admin",
      "fleet_ops:allocate",
      "fleet_ops:collect",
      "fleet_ops:action"
    ]) {
      expect(syncSource).not.toContain(forbiddenPermission);
    }
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

  it("calibrates vehicle insurance permissions and menu by role", () => {
    for (const permission of ["vehicle_insurance:view", "vehicle_insurance:manage"]) {
      expect(seedSource).toContain(`"${permission}"`);
    }

    expect(seedSource).toContain(
      'const vehicleInsuranceViewPermissions = ["vehicle_insurance:view"]'
    );
    expectSeedSourceToContain(
      'const vehicleInsuranceManagementPermissions = ["vehicle_insurance:view", "vehicle_insurance:manage"]'
    );
    expect(seedSource).toContain('["vehicles.insurance_policies"');
    expect(seedSource).toContain('"/vehicle-insurance-policies"');
    expect(seedSource).toContain('"vehicle_insurance:view"');
    expect(seedSource).toContain(
      'const vehicleInsuranceMenuCodes = ["vehicles.insurance_policies"]'
    );
    expectRolePermissions("OP", ["vehicle_insurance:view", "vehicle_insurance:manage"]);
    expectRolePermissions("SA", ["vehicle_insurance:view"]);
    expectRolePermissions("GM", ["vehicle_insurance:view"]);
    expect(roleHasPermission(rolePermissionArray("SA"), "vehicle_insurance:manage")).toBe(false);
    expect(roleHasPermission(rolePermissionArray("GM"), "vehicle_insurance:manage")).toBe(false);
    expect(roleHasMenu(roleMenuArray("OP"), "vehicles.insurance_policies")).toBe(true);
    expect(roleHasMenu(roleMenuArray("SA"), "vehicles.insurance_policies")).toBe(true);
    expect(roleHasMenu(roleMenuArray("GM"), "vehicles.insurance_policies")).toBe(true);
  });

  it("calibrates vehicle depreciation permissions by role", () => {
    for (const permission of ["vehicle_depreciation:view", "vehicle_depreciation:manage"]) {
      expect(seedSource).toContain(`"${permission}"`);
    }

    expect(seedSource).toContain(
      'const vehicleDepreciationViewPermissions = ["vehicle_depreciation:view"]'
    );
    expectSeedSourceToContain(
      'const vehicleDepreciationManagementPermissions = ["vehicle_depreciation:view", "vehicle_depreciation:manage"]'
    );
    expectSeedSourceToContain(
      '["vehicles.depreciation_policies", "折旧管理", "/vehicle-depreciation-policies", "money", 29, "vehicle_depreciation:view", "vehicles"]'
    );
    expect(seedSource).toContain(
      'const vehicleDepreciationMenuCodes = ["vehicles.depreciation_policies"]'
    );
    expect(seedSource).toContain(
      '...(roleCode === "FI" ? vehicleDepreciationManagementPermissions : [])'
    );
    expect(seedSource).toContain('...(roleCode === "FI" ? vehicleDepreciationMenuCodes : [])');
    expectRolePermissions("OP", ["vehicle_depreciation:view", "vehicle_depreciation:manage"]);
    expectRolePermissions("SA", ["vehicle_depreciation:view"]);
    expectRolePermissions("GM", ["vehicle_depreciation:view"]);
    expect(roleHasPermission(rolePermissionArray("SA"), "vehicle_depreciation:manage")).toBe(false);
    expect(roleHasPermission(rolePermissionArray("GM"), "vehicle_depreciation:manage")).toBe(false);
    expect(roleHasMenu(roleMenuArray("OP"), "vehicles.depreciation_policies")).toBe(true);
    expect(roleHasMenu(roleMenuArray("SA"), "vehicles.depreciation_policies")).toBe(true);
    expect(roleHasMenu(roleMenuArray("GM"), "vehicles.depreciation_policies")).toBe(true);
  });

  it("calibrates vehicle model definition permissions by role", () => {
    for (const permission of ["vehicle_model:view", "vehicle_model:manage"]) {
      expect(seedSource).toContain(`"${permission}"`);
    }

    expect(seedSource).toContain('const vehicleModelViewPermissions = ["vehicle_model:view"]');
    expect(seedSource).toContain(
      'const vehicleModelManagementPermissions = ["vehicle_model:view", "vehicle_model:manage"]'
    );
    expectSeedSourceToContain(
      '["vehicles.model_definitions", "车型代码", "/vehicle-model-definitions", "car", 15, "vehicle_model:view", "vehicles"]'
    );
    expect(seedSource).toContain('const vehicleModelMenuCodes = ["vehicles.model_definitions"]');
    expect(seedSource).toContain('...(roleCode === "FI" ? vehicleModelManagementPermissions : [])');
    expect(seedSource).toContain('...(roleCode === "FI" ? vehicleModelMenuCodes : [])');
    expectRolePermissions("OP", ["vehicle_model:view", "vehicle_model:manage"]);
    expectRolePermissions("SA", ["vehicle_model:view"]);
    expectRolePermissions("GM", ["vehicle_model:view"]);
    expect(roleHasPermission(rolePermissionArray("SA"), "vehicle_model:manage")).toBe(false);
    expect(roleHasPermission(rolePermissionArray("GM"), "vehicle_model:manage")).toBe(false);
    expect(roleHasMenu(roleMenuArray("OP"), "vehicles.model_definitions")).toBe(true);
    expect(roleHasMenu(roleMenuArray("SA"), "vehicles.model_definitions")).toBe(true);
    expect(roleHasMenu(roleMenuArray("GM"), "vehicles.model_definitions")).toBe(true);
  });

  it("calibrates vehicle valuation review permissions by role", () => {
    for (const permission of [
      "vehicle_valuation_review:view",
      "vehicle_valuation_review:create",
      "vehicle_valuation_review:approve"
    ]) {
      expect(seedSource).toContain(`"${permission}"`);
    }

    expect(seedSource).toContain(
      'const vehicleValuationReviewViewPermissions = ["vehicle_valuation_review:view"]'
    );
    expect(seedSource).toContain("const vehicleValuationReviewCreatePermissions = [");
    expect(seedSource).toContain("const vehicleValuationReviewApprovePermissions = [");
    expect(seedSource).toContain("const vehicleValuationReviewManagementPermissions = [");
    expectSeedSourceToContain(
      '["vehicles.valuation_reviews", "估值复核", "/vehicle-valuation-reviews", "audit", 40, "vehicle_valuation_review:view", "vehicles"]'
    );
    expect(seedSource).toContain(
      'const vehicleValuationReviewMenuCodes = ["vehicles.valuation_reviews"]'
    );
    expect(seedSource).toContain('...(roleCode === "AS"');
    expect(seedSource).toContain("? vehicleValuationReviewCreatePermissions");
    expect(seedSource).toContain(": vehicleValuationReviewViewPermissions)");
    expectRolePermissions("OP", [
      "vehicle_valuation_review:view",
      "vehicle_valuation_review:create",
      "vehicle_valuation_review:approve"
    ]);
    expectRolePermissions("GM", [
      "vehicle_valuation_review:view",
      "vehicle_valuation_review:approve"
    ]);
    expect(
      roleHasPermission(
        permissionConstantSource("vehicleValuationReviewCreatePermissions"),
        "vehicle_valuation_review:create"
      )
    ).toBe(true);
    expect(
      roleHasPermission(
        permissionConstantSource("vehicleValuationReviewCreatePermissions"),
        "vehicle_valuation_review:approve"
      )
    ).toBe(false);
    expect(
      roleHasPermission(
        permissionConstantSource("vehicleValuationReviewViewPermissions"),
        "vehicle_valuation_review:view"
      )
    ).toBe(true);
    expect(seedSource).toContain("...vehicleValuationReviewMenuCodes");
    for (const roleCode of ["OP", "GM"]) {
      expect(roleHasMenu(roleMenuArray(roleCode), "vehicles.valuation_reviews")).toBe(true);
    }
    expect(roleHasPermission(rolePermissionArray("SA"), "vehicle_valuation_review:view")).toBe(
      false
    );
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

  it("calibrates service case permissions and menu by role", () => {
    for (const permission of ["service_case:view", "service_case:manage"]) {
      expect(seedSource).toContain(`"${permission}"`);
    }

    expectSeedSourceToContain(
      '["orders.service_cases", "服务工单", "/service-cases", "audit", 40, "service_case:view", "orders"]'
    );
    expect(seedSource).toContain('const serviceCaseViewPermissions = ["service_case:view"]');
    expect(seedSource).toContain(
      'const serviceCaseManagePermissions = ["service_case:view", "service_case:manage"]'
    );
    expectRolePermissions("OP", ["service_case:view", "service_case:manage"]);
    expectRolePermissions("SA", ["service_case:view"]);
    expectRolePermissions("GM", ["service_case:view"]);
    expect(roleHasPermission(rolePermissionArray("SA"), "service_case:manage")).toBe(false);
    expect(roleHasMenu(roleMenuArray("OP"), "orders.service_cases")).toBe(true);
    expect(roleHasMenu(roleMenuArray("SA"), "orders.service_cases")).toBe(true);
    expect(roleHasMenu(roleMenuArray("GM"), "orders.service_cases")).toBe(true);
  });

  it("calibrates notification center permissions and menu by role", () => {
    for (const permission of ["notification:view", "notification:manage"]) {
      expect(seedSource).toContain(`"${permission}"`);
    }

    expectSeedSourceToContain(
      '["orders.notifications", "通知中心", "/notifications", "message", 50, "notification:view", "orders"]'
    );
    expect(seedSource).toContain('const notificationViewPermissions = ["notification:view"]');
    expect(seedSource).toContain(
      'const notificationManagePermissions = ["notification:view", "notification:manage"]'
    );
    expectRolePermissions("OP", ["notification:view", "notification:manage"]);
    expectRolePermissions("SA", ["notification:view"]);
    expectRolePermissions("GM", ["notification:view"]);
    expect(roleHasPermission(rolePermissionArray("SA"), "notification:manage")).toBe(false);
    expect(roleHasMenu(roleMenuArray("OP"), "orders.notifications")).toBe(true);
    expect(roleHasMenu(roleMenuArray("SA"), "orders.notifications")).toBe(true);
    expect(roleHasMenu(roleMenuArray("GM"), "orders.notifications")).toBe(true);
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
    expectSeedSourceToContain(
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
    expectSeedSourceToContain(
      '...(roleCode === "FI" ? [...reportFinancePermissions, ...reportAssetPermissions] : reportAssetPermissions)'
    );
    expect(seedSource).toContain('const reportOverviewMenuCodes = ["reports", "reports.overview"]');
    expect(seedSource).toContain(
      'const reportAssetMenuCodes = ["reports", "reports.asset_profitability"]'
    );
    expect(seedSource).toContain(
      '["reports", "经营看板", "/reports", "dashboard", 75, null, null]'
    );
    expectSeedSourceToContain(
      '["reports.overview", "经营总览", "/reports", "dashboard", 10, "report:view", "reports"]'
    );
    expectSeedSourceToContain(
      '["reports.asset_profitability", "资产经营分析", "/reports/asset-profitability", "car", 20, "report:asset", "reports"]'
    );
    for (const handler of [
      ReportController.prototype.exportAssetReturnTrialSummary,
      ReportController.prototype.exportAssetReturnTrialVehicles,
      ReportController.prototype.exportAssetReturnTrialVehicleDetail
    ]) {
      const requiredPermissions = Reflect.getMetadata(REQUIRED_PERMISSIONS_KEY, handler);
      expect(requiredPermissions).toEqual([PermissionCode.REPORT_ASSET]);
      expect(hasRequiredPermissions([PermissionCode.REPORT_VIEW], requiredPermissions)).toBe(false);
      expect(hasRequiredPermissions([PermissionCode.REPORT_ASSET], requiredPermissions)).toBe(true);
    }
    expect(roleHasMenu(roleMenuArray("OP"), "reports")).toBe(true);
    expect(roleHasMenu(roleMenuArray("OP"), "reports.overview")).toBe(true);
    expect(roleHasMenu(roleMenuArray("OP"), "reports.asset_profitability")).toBe(true);
    expect(roleHasMenu(roleMenuArray("GM"), "reports")).toBe(true);
    expect(roleHasMenu(roleMenuArray("GM"), "reports.overview")).toBe(true);
    expect(roleHasMenu(roleMenuArray("GM"), "reports.asset_profitability")).toBe(true);
    expectSeedSourceToContain(
      '...(roleCode === "FI" ? [...reportOverviewMenuCodes, ...reportAssetMenuCodes, ...financeMenuCodes] : [])'
    );
    expect(seedSource).toContain('...(roleCode === "AS" ? reportAssetMenuCodes : [])');
    expect(roleHasPermission(rolePermissionArray("SA"), "report:view")).toBe(false);
    expect(roleHasPermission(rolePermissionArray("SA"), "report:finance")).toBe(false);
    expect(
      roleHasPermission(permissionConstantSource("reportAssetPermissions"), "report:asset")
    ).toBe(true);
    expect(roleHasPermission(rolePermissionArray("OP"), "report:finance")).toBe(false);
    expect(
      roleHasPermission(permissionConstantSource("reportAssetPermissions"), "report:view")
    ).toBe(false);
  });

  it("calibrates capital structure and financing permissions by role", () => {
    for (const permission of [
      "capital_structure:view",
      "capital_structure:manage",
      "financing:view",
      "financing:manage",
      "vehicle_asset_pool:view",
      "vehicle_asset_pool:manage",
      "revenue_right:view",
      "revenue_right:manage",
      "revenue_share:view",
      "revenue_share:manage"
    ]) {
      expect(seedSource).toContain(`"${permission}"`);
    }

    expect(seedSource).toContain(
      'const capitalStructureViewPermissions = ["capital_structure:view"]'
    );
    expect(seedSource).toContain("const capitalStructureManagementPermissions = [");
    expect(seedSource).toContain('const financingViewPermissions = ["financing:view"]');
    expect(seedSource).toContain(
      'const financingManagementPermissions = ["financing:view", "financing:manage"]'
    );
    expect(seedSource).toContain(
      'const vehicleAssetPoolViewPermissions = ["vehicle_asset_pool:view"]'
    );
    expectSeedSourceToContain(
      'const vehicleAssetPoolManagementPermissions = ["vehicle_asset_pool:view", "vehicle_asset_pool:manage"]'
    );
    expect(seedSource).toContain('const revenueRightViewPermissions = ["revenue_right:view"]');
    expect(seedSource).toContain("const revenueRightManagementPermissions = [");
    expect(seedSource).toContain('const revenueShareViewPermissions = ["revenue_share:view"]');
    expect(seedSource).toContain(
      'const revenueShareManagementPermissions = ["revenue_share:view", "revenue_share:manage"]'
    );
    expect(seedSource).toContain(
      '["vehicles.assets", "车辆资产台账", "/vehicles", "car", 10, "vehicle:view", "vehicles"]'
    );
    expectSeedSourceToContain(
      '["vehicles.asset_pools", "车辆资产池", "/vehicle-asset-pools", "car", 20, "vehicle_asset_pool:view", "vehicles"]'
    );
    expectSeedSourceToContain(
      '["billing.financing_instruments", "融资工具", "/financing-instruments", "money", 30, "financing:view", "billing"]'
    );
    expectSeedSourceToContain(
      '["billing.revenue_rights", "收益权管理", "/revenue-rights", "file", 40, "revenue_right:view", "billing"]'
    );
    expect(seedSource).toContain('const vehicleMenuCodes = ["vehicles", "vehicles.assets"]');
    expect(seedSource).toContain('const vehicleAssetPoolMenuCodes = ["vehicles.asset_pools"]');
    expect(seedSource).toContain('const financingMenuCodes = ["billing.financing_instruments"]');
    expect(seedSource).toContain('const revenueRightMenuCodes = ["billing.revenue_rights"]');
    expectSeedSourceToContain(
      '...(roleCode === "FI" ? capitalStructureManagementPermissions : capitalStructureViewPermissions)'
    );
    expectSeedSourceToContain(
      '...(roleCode === "FI" ? financingManagementPermissions : financingViewPermissions)'
    );
    expectSeedSourceToContain(
      '...(roleCode === "FI" ? revenueRightManagementPermissions : revenueRightViewPermissions)'
    );
    expectSeedSourceToContain(
      '...(roleCode === "FI" ? revenueShareManagementPermissions : revenueShareViewPermissions)'
    );
    expectRolePermissions("OP", [
      "capital_structure:view",
      "financing:view",
      "vehicle_asset_pool:view",
      "revenue_right:view",
      "revenue_share:view"
    ]);
    expectRolePermissions("GM", [
      "capital_structure:view",
      "financing:view",
      "vehicle_asset_pool:view",
      "revenue_right:view",
      "revenue_share:view"
    ]);
    for (const roleCode of ["OP", "GM"]) {
      expect(roleHasMenu(roleMenuArray(roleCode), "billing.financing_instruments")).toBe(true);
      expect(roleHasMenu(roleMenuArray(roleCode), "vehicles.asset_pools")).toBe(true);
      expect(roleHasMenu(roleMenuArray(roleCode), "billing.revenue_rights")).toBe(true);
    }
    expect(
      roleHasPermission(
        permissionConstantSource("capitalStructureManagementPermissions"),
        "capital_structure:manage"
      )
    ).toBe(true);
    expect(
      roleHasPermission(
        permissionConstantSource("financingManagementPermissions"),
        "financing:manage"
      )
    ).toBe(true);
    expect(
      roleHasPermission(
        permissionConstantSource("vehicleAssetPoolManagementPermissions"),
        "vehicle_asset_pool:manage"
      )
    ).toBe(true);
    expect(
      roleHasPermission(
        permissionConstantSource("revenueRightManagementPermissions"),
        "revenue_right:manage"
      )
    ).toBe(true);
    expect(
      roleHasPermission(
        permissionConstantSource("revenueShareManagementPermissions"),
        "revenue_share:manage"
      )
    ).toBe(true);
    expect(roleHasPermission(rolePermissionArray("OP"), "capital_structure:manage")).toBe(false);
    expect(roleHasPermission(rolePermissionArray("OP"), "financing:manage")).toBe(false);
    expect(roleHasPermission(rolePermissionArray("OP"), "vehicle_asset_pool:manage")).toBe(false);
    expect(roleHasPermission(rolePermissionArray("OP"), "revenue_right:manage")).toBe(false);
    expect(roleHasPermission(rolePermissionArray("OP"), "revenue_share:manage")).toBe(false);
    expect(roleHasPermission(rolePermissionArray("GM"), "capital_structure:manage")).toBe(false);
    expect(roleHasPermission(rolePermissionArray("GM"), "vehicle_asset_pool:manage")).toBe(false);
    expect(roleHasPermission(rolePermissionArray("GM"), "revenue_right:manage")).toBe(false);
  });

  it("calibrates residual market permissions by role", () => {
    for (const permission of [
      "residual_market:view",
      "residual_market:manage",
      "residual_market:import"
    ]) {
      expect(seedSource).toContain(`"${permission}"`);
    }

    expect(seedSource).toContain('const residualMarketViewPermissions = ["residual_market:view"]');
    expect(seedSource).toContain("const residualMarketImportPermissions = [");
    expect(seedSource).toContain("const residualMarketManagementPermissions = [");
    expectSeedSourceToContain(
      '["vehicles.residual_market", "市场残值样本", "/residual-market", "car", 30, "residual_market:view", "vehicles"]'
    );
    expect(seedSource).toContain('const residualMarketMenuCodes = ["vehicles.residual_market"]');
    expectSeedSourceToContain(
      '...(roleCode === "AS" ? residualMarketManagementPermissions : residualMarketViewPermissions)'
    );
    expect(seedSource).toContain("...residualMarketMenuCodes");
    expectRolePermissions("OP", ["residual_market:view", "residual_market:import"]);
    expectRolePermissions("GM", ["residual_market:view"]);
    expect(roleHasMenu(roleMenuArray("OP"), "vehicles.residual_market")).toBe(true);
    expect(roleHasMenu(roleMenuArray("GM"), "vehicles.residual_market")).toBe(true);
    expect(
      roleHasPermission(
        permissionConstantSource("residualMarketViewPermissions"),
        "residual_market:view"
      )
    ).toBe(true);
    expect(
      roleHasPermission(
        permissionConstantSource("residualMarketImportPermissions"),
        "residual_market:import"
      )
    ).toBe(true);
    expect(
      roleHasPermission(
        permissionConstantSource("residualMarketManagementPermissions"),
        "residual_market:manage"
      )
    ).toBe(true);
    expect(roleHasPermission(rolePermissionArray("OP"), "residual_market:manage")).toBe(false);
    expect(roleHasPermission(rolePermissionArray("GM"), "residual_market:manage")).toBe(false);
  });

  it("calibrates residual curve permissions by role", () => {
    for (const permission of [
      "residual_curve:view",
      "residual_curve:generate",
      "residual_curve:manage"
    ]) {
      expect(seedSource).toContain(`"${permission}"`);
    }

    expect(seedSource).toContain('const residualCurveViewPermissions = ["residual_curve:view"]');
    expectSeedSourceToContain(
      'const residualCurveGeneratePermissions = ["residual_curve:view", "residual_curve:generate"]'
    );
    expect(seedSource).toContain("const residualCurveManagementPermissions = [");
    expect(seedSource).toContain(
      '...(roleCode === "AS" ? residualCurveManagementPermissions : residualCurveViewPermissions)'
    );
    expectRolePermissions("OP", ["residual_curve:view", "residual_curve:generate"]);
    expectRolePermissions("GM", ["residual_curve:view"]);
    expect(
      roleHasPermission(
        permissionConstantSource("residualCurveViewPermissions"),
        "residual_curve:view"
      )
    ).toBe(true);
    expect(
      roleHasPermission(
        permissionConstantSource("residualCurveGeneratePermissions"),
        "residual_curve:generate"
      )
    ).toBe(true);
    expect(
      roleHasPermission(
        permissionConstantSource("residualCurveManagementPermissions"),
        "residual_curve:manage"
      )
    ).toBe(true);
    expect(roleHasPermission(rolePermissionArray("OP"), "residual_curve:manage")).toBe(false);
    expect(roleHasPermission(rolePermissionArray("GM"), "residual_curve:generate")).toBe(false);
  });

  it("calibrates vehicle residual forecast permissions by role", () => {
    for (const permission of [
      "residual_forecast:view",
      "residual_forecast:generate",
      "residual_forecast:manage"
    ]) {
      expect(seedSource).toContain(`"${permission}"`);
    }

    expect(seedSource).toContain(
      'const residualForecastViewPermissions = ["residual_forecast:view"]'
    );
    expectSeedSourceToContain(
      'const residualForecastGeneratePermissions = ["residual_forecast:view", "residual_forecast:generate"]'
    );
    expect(seedSource).toContain("const residualForecastManagementPermissions = [");
    expectSeedSourceToContain(
      '...(roleCode === "AS" ? residualForecastManagementPermissions : residualForecastViewPermissions)'
    );
    expectRolePermissions("OP", ["residual_forecast:view", "residual_forecast:generate"]);
    expectRolePermissions("GM", ["residual_forecast:view"]);
    expect(
      roleHasPermission(
        permissionConstantSource("residualForecastViewPermissions"),
        "residual_forecast:view"
      )
    ).toBe(true);
    expect(
      roleHasPermission(
        permissionConstantSource("residualForecastGeneratePermissions"),
        "residual_forecast:generate"
      )
    ).toBe(true);
    expect(
      roleHasPermission(
        permissionConstantSource("residualForecastManagementPermissions"),
        "residual_forecast:manage"
      )
    ).toBe(true);
    expect(roleHasPermission(rolePermissionArray("OP"), "residual_forecast:manage")).toBe(false);
    expect(roleHasPermission(rolePermissionArray("GM"), "residual_forecast:generate")).toBe(false);
  });

  it("calibrates residual model run permissions by role", () => {
    for (const permission of ["residual_model_run:view", "residual_model_run:manage"]) {
      expect(seedSource).toContain(`"${permission}"`);
    }

    expect(seedSource).toContain(
      'const residualModelRunViewPermissions = ["residual_model_run:view"]'
    );
    expect(seedSource).toContain("const residualModelRunManagementPermissions = [");
    expectSeedSourceToContain(
      '...(roleCode === "AS" ? residualModelRunManagementPermissions : residualModelRunViewPermissions)'
    );
    expectRolePermissions("OP", ["residual_model_run:view"]);
    expectRolePermissions("GM", ["residual_model_run:view"]);
    expect(
      roleHasPermission(
        permissionConstantSource("residualModelRunViewPermissions"),
        "residual_model_run:view"
      )
    ).toBe(true);
    expect(
      roleHasPermission(
        permissionConstantSource("residualModelRunManagementPermissions"),
        "residual_model_run:manage"
      )
    ).toBe(true);
    expect(roleHasPermission(rolePermissionArray("OP"), "residual_model_run:manage")).toBe(false);
    expect(roleHasPermission(rolePermissionArray("GM"), "residual_model_run:manage")).toBe(false);
  });

  function expectSeedSourceToContain(fragment: string) {
    expect(seedSource.replace(/\s+/g, "")).toContain(fragment.replace(/\s+/g, ""));
  }

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

  function optionalRolePermissionArray(roleCode: string) {
    const pattern = new RegExp(
      `await\\s+assignRoleAccess\\(\\s*["']${escapeRegExp(roleCode)}["']\\s*,\\s*\\[([\\s\\S]*?)\\]\\s*,`
    );
    return seedSource.match(pattern)?.[1] ?? "";
  }

  function assetFactSharedLoopRoles() {
    for (const match of seedSource.matchAll(
      /for \(const roleCode of \[([^\]]+)\]\) \{([\s\S]*?)\n {2}\}/g
    )) {
      const body = match[2] ?? "";
      if (!body.includes("assetFactManagementPermissions")) continue;
      return [...(match[1] ?? "").matchAll(/["']([^"']+)["']/g)].map((roleMatch) => roleMatch[1]!);
    }
    return [];
  }

  function effectiveAssetFactPermissions(permissionCodes: string[], sharedLoopRoles: string[]) {
    const roleCodes = ["SA", "OP", "RC", "FI", "AS", "CS", "GM"];
    const viewSource = permissionConstantSource("assetFactViewPermissions");
    const managementSource = permissionConstantSource("assetFactManagementPermissions");

    return Object.fromEntries(
      roleCodes.map((roleCode) => {
        const directSource = optionalRolePermissionArray(roleCode);
        const loopSource = sharedLoopRoles.includes(roleCode)
          ? roleCode === "AS"
            ? managementSource
            : viewSource
          : "";
        const effectiveSource = `${directSource}\n${loopSource}`;
        return [
          roleCode,
          permissionCodes.filter((permission) => roleHasPermission(effectiveSource, permission))
        ];
      })
    );
  }

  function effectiveAssetOperationsPermissions(permissionCodes: string[]) {
    const sourceByRole: Record<string, string> = {
      ADMIN: permissionCodes.map((code) => `"${code}"`).join(","),
      AS: permissionConstantSource("assetOperationsManagementPermissions"),
      CS: optionalRolePermissionArray("CS"),
      FI: permissionConstantSource("assetOperationsViewPermissions"),
      GM: optionalRolePermissionArray("GM"),
      OP: optionalRolePermissionArray("OP"),
      RC: optionalRolePermissionArray("RC"),
      SA: optionalRolePermissionArray("SA")
    };

    return Object.fromEntries(
      Object.entries(sourceByRole).map(([roleCode, source]) => [
        roleCode,
        permissionCodes.filter((permissionCode) => roleHasPermission(source, permissionCode))
      ])
    );
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

  function roleLoopSource(roleCodes: string[]) {
    const roles = roleCodes.map((roleCode) => `"${escapeRegExp(roleCode)}"`).join(", ");
    const pattern = new RegExp(
      `for \\(const roleCode of \\[${roles}\\]\\) \\{([\\s\\S]*?)\\n  \\}`
    );
    const match = seedSource.match(pattern);
    const source = match?.[1];

    expect(source).toBeDefined();
    return source ?? "";
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

  it("assigns the approved subscription change permissions and menu by role", () => {
    const view = "subscription_change:view";
    const operational = [
      view,
      "subscription_change:create",
      "subscription_change:quote",
      "subscription_change:submit",
      "subscription_change:esign_retry",
      "subscription_change:execute",
      "subscription_change:cancel"
    ];
    const adminOnly = [
      "subscription_change:price_override_approve",
      "subscription_change:manual_takeover"
    ];

    for (const permission of [...operational, ...adminOnly]) {
      expect(seedSource).toContain(`"${permission}"`);
    }
    for (const permission of operational) {
      expect(roleHasPermission(rolePermissionArray("OP"), permission)).toBe(true);
    }
    for (const permission of adminOnly) {
      expect(roleHasPermission(rolePermissionArray("OP"), permission)).toBe(false);
    }
    expect(roleHasPermission(rolePermissionArray("SA"), view)).toBe(true);
    expect(roleHasPermission(roleLoopSource(["FI", "AS"]), view)).toBe(true);
    expect(roleHasMenu(roleMenuArray("OP"), "orders.subscription_changes")).toBe(true);
    expect(roleHasMenu(roleMenuArray("SA"), "orders.subscription_changes")).toBe(true);
  });

  it("assigns the approved subscription journey permissions and exception filter by role", () => {
    const view = "subscription_journey:view";
    const operational = [
      view,
      "subscription_journey:plan_decide",
      "subscription_journey:vehicle_allocate",
      "subscription_journey:delivery_evidence_decide",
      "subscription_journey:recover"
    ];
    const cancel = "subscription_journey:cancel";

    expect(PermissionCode.SUBSCRIPTION_JOURNEY_VIEW).toBe(view);
    expect(PermissionCode.SUBSCRIPTION_JOURNEY_PLAN_DECIDE).toBe(
      "subscription_journey:plan_decide"
    );
    expect(PermissionCode.SUBSCRIPTION_JOURNEY_VEHICLE_ALLOCATE).toBe(
      "subscription_journey:vehicle_allocate"
    );
    expect(PermissionCode.SUBSCRIPTION_JOURNEY_DELIVERY_EVIDENCE_DECIDE).toBe(
      "subscription_journey:delivery_evidence_decide"
    );
    expect(PermissionCode.SUBSCRIPTION_JOURNEY_RECOVER).toBe("subscription_journey:recover");
    expect(PermissionCode.SUBSCRIPTION_JOURNEY_CANCEL).toBe(cancel);

    const orders = SYSTEM_MENUS.find((menu) => menu.code === "orders");
    const exceptionEntry = orders?.children?.find(
      (menu) => menu.code === "orders.journey_exceptions"
    );

    expect(exceptionEntry).toMatchObject({
      path: "/orders?journeyStatus=EXCEPTION",
      permissionCode: PermissionCode.SUBSCRIPTION_JOURNEY_VIEW
    });
    expect(SYSTEM_MENUS.some((menu) => menu.code === "orders.journey_exceptions")).toBe(false);
    expect(operational).toHaveLength(5);
    expect(cancel).toBe("subscription_journey:cancel");
  });

  it("gates every subscription journey administration route with its exact permission", () => {
    const routes = [
      [
        SubscriptionJourneyController.prototype.getByApplication,
        PermissionCode.SUBSCRIPTION_JOURNEY_VIEW
      ],
      [
        SubscriptionJourneyController.prototype.getByOrder,
        PermissionCode.SUBSCRIPTION_JOURNEY_VIEW
      ],
      [SubscriptionJourneyController.prototype.list, PermissionCode.SUBSCRIPTION_JOURNEY_VIEW],
      [SubscriptionJourneyController.prototype.metrics, PermissionCode.SUBSCRIPTION_JOURNEY_VIEW],
      [
        SubscriptionJourneyController.prototype.decideFinalPlan,
        PermissionCode.SUBSCRIPTION_JOURNEY_PLAN_DECIDE
      ],
      [
        SubscriptionJourneyController.prototype.allocateVehicle,
        PermissionCode.SUBSCRIPTION_JOURNEY_VEHICLE_ALLOCATE
      ],
      [
        SubscriptionJourneyController.prototype.decideDeliveryEvidence,
        PermissionCode.SUBSCRIPTION_JOURNEY_DELIVERY_EVIDENCE_DECIDE
      ],
      [SubscriptionJourneyController.prototype.retry, PermissionCode.SUBSCRIPTION_JOURNEY_RECOVER],
      [SubscriptionJourneyController.prototype.pause, PermissionCode.SUBSCRIPTION_JOURNEY_RECOVER],
      [SubscriptionJourneyController.prototype.resume, PermissionCode.SUBSCRIPTION_JOURNEY_RECOVER],
      [SubscriptionJourneyController.prototype.cancel, PermissionCode.SUBSCRIPTION_JOURNEY_CANCEL]
    ] as const;

    for (const [handler, permission] of routes) {
      expect(Reflect.getMetadata(REQUIRED_PERMISSIONS_KEY, handler)).toEqual([permission]);
    }
  });
});
