import { Body, Controller, Delete, Get, Param, Patch, Post, Query, Req, UseGuards } from "@nestjs/common";
import { PermissionCode } from "@subscription-saas/shared";

import { RequirePermissions } from "../auth/auth.decorators";
import { AuthenticatedRequest, AuthGuard } from "../auth/auth.guard";
import { PermissionsGuard } from "../auth/permissions.guard";
import {
  CreateBenefitPackageDto,
  CreateEnergyPackageDto,
  CreateMileagePackageDto,
  CreatePriceRuleDto,
  CreateProductDto,
  CreateProductVersionDto,
  CreateQuoteDto,
  CreateSubscriptionPlanDto,
  CreateVehiclePackageDto,
  UpdateBenefitPackageDto,
  UpdateEnergyPackageDto,
  UpdateMileagePackageDto,
  UpdatePriceRuleDto,
  UpdateProductDto,
  UpdateProductVersionDto,
  UpdateVehiclePackageDto,
  UpdateQuoteDto,
  UpdateSubscriptionPlanDto
} from "./dto/product.dto";
import { ProductService } from "./product.service";

@Controller()
@UseGuards(AuthGuard, PermissionsGuard)
export class ProductController {
  constructor(private readonly productService: ProductService) {}

  @Get("products")
  @RequirePermissions(PermissionCode.PRODUCT_VIEW)
  listProducts() {
    return this.productService.listProducts();
  }

  @Post("products")
  @RequirePermissions(PermissionCode.PRODUCT_CREATE)
  createProduct(@Body() dto: CreateProductDto, @Req() request: AuthenticatedRequest) {
    return this.productService.createProduct(dto, request.user, requestContext(request));
  }

  @Get("products/:id")
  @RequirePermissions(PermissionCode.PRODUCT_VIEW)
  getProduct(@Param("id") id: string) {
    return this.productService.getProduct(id);
  }

  @Patch("products/:id")
  @RequirePermissions(PermissionCode.PRODUCT_UPDATE)
  updateProduct(
    @Param("id") id: string,
    @Body() dto: UpdateProductDto,
    @Req() request: AuthenticatedRequest
  ) {
    return this.productService.updateProduct(id, dto, request.user, requestContext(request));
  }

  @Post("products/:id/activate")
  @RequirePermissions(PermissionCode.PRODUCT_ACTIVATE)
  activateProduct(@Param("id") id: string, @Req() request: AuthenticatedRequest) {
    return this.productService.setProductStatus(id, "ACTIVE", request.user, requestContext(request));
  }

  @Post("products/:id/deactivate")
  @RequirePermissions(PermissionCode.PRODUCT_ACTIVATE)
  deactivateProduct(@Param("id") id: string, @Req() request: AuthenticatedRequest) {
    return this.productService.setProductStatus(
      id,
      "INACTIVE",
      request.user,
      requestContext(request)
    );
  }

  @Get("products/:productId/versions")
  @RequirePermissions(PermissionCode.PRODUCT_VERSION_VIEW)
  listVersions(@Param("productId") productId: string) {
    return this.productService.listVersions(productId);
  }

  @Post("products/:productId/versions")
  @RequirePermissions(PermissionCode.PRODUCT_VERSION_CREATE)
  createVersion(
    @Param("productId") productId: string,
    @Body() dto: CreateProductVersionDto,
    @Req() request: AuthenticatedRequest
  ) {
    return this.productService.createVersion(productId, dto, request.user, requestContext(request));
  }

  @Post("product-versions")
  @RequirePermissions(PermissionCode.PRODUCT_VERSION_CREATE)
  createVersionGlobal(@Body() dto: CreateProductVersionDto, @Req() request: AuthenticatedRequest) {
    return this.productService.createVersionGlobal(dto, request.user, requestContext(request));
  }

  @Get("product-versions/:id")
  @RequirePermissions(PermissionCode.PRODUCT_VERSION_VIEW)
  getVersion(@Param("id") id: string) {
    return this.productService.getVersion(id);
  }

  @Patch("product-versions/:id")
  @RequirePermissions(PermissionCode.PRODUCT_VERSION_UPDATE)
  updateVersion(
    @Param("id") id: string,
    @Body() dto: UpdateProductVersionDto,
    @Req() request: AuthenticatedRequest
  ) {
    return this.productService.updateVersion(id, dto, request.user, requestContext(request));
  }

  @Post("product-versions/:id/approve")
  @RequirePermissions(PermissionCode.PRODUCT_VERSION_APPROVE)
  approveVersion(@Param("id") id: string, @Req() request: AuthenticatedRequest) {
    return this.productService.approveVersion(id, request.user, requestContext(request));
  }

  @Post("product-versions/:id/activate")
  @RequirePermissions(PermissionCode.PRODUCT_VERSION_ACTIVATE)
  activateVersion(@Param("id") id: string, @Req() request: AuthenticatedRequest) {
    return this.productService.activateVersion(id, request.user, requestContext(request));
  }

  @Post("product-versions/:id/deactivate")
  @RequirePermissions(PermissionCode.PRODUCT_VERSION_ACTIVATE)
  deactivateVersion(@Param("id") id: string, @Req() request: AuthenticatedRequest) {
    return this.productService.deactivateVersion(id, request.user, requestContext(request));
  }

  @Get("product-versions/:versionId/price-rules")
  @RequirePermissions(PermissionCode.PRODUCT_PRICE_RULE_VIEW)
  listPriceRules(@Param("versionId") versionId: string) {
    return this.productService.listPriceRules(versionId);
  }

  @Get("product-versions/:versionId/packages")
  @RequirePermissions(PermissionCode.PRODUCT_VIEW)
  listVersionPackages(@Param("versionId") versionId: string) {
    return this.productService.listVersionPackages(versionId);
  }

  @Post("product-versions/:versionId/price-rules")
  @RequirePermissions(PermissionCode.PRODUCT_PRICE_RULE_CREATE)
  createPriceRule(
    @Param("versionId") versionId: string,
    @Body() dto: CreatePriceRuleDto,
    @Req() request: AuthenticatedRequest
  ) {
    return this.productService.createPriceRule(versionId, dto, request.user, requestContext(request));
  }

  @Patch("product-price-rules/:id")
  @RequirePermissions(PermissionCode.PRODUCT_PRICE_RULE_UPDATE)
  updatePriceRule(
    @Param("id") id: string,
    @Body() dto: UpdatePriceRuleDto,
    @Req() request: AuthenticatedRequest
  ) {
    return this.productService.updatePriceRule(id, dto, request.user, requestContext(request));
  }

  @Delete("product-price-rules/:id")
  @RequirePermissions(PermissionCode.PRODUCT_PRICE_RULE_DELETE)
  deletePriceRule(@Param("id") id: string, @Req() request: AuthenticatedRequest) {
    return this.productService.deletePriceRule(id, request.user, requestContext(request));
  }

  @Get("vehicle-packages")
  @RequirePermissions(PermissionCode.VEHICLE_PACKAGE_VIEW)
  listVehiclePackages() {
    return this.productService.listVehiclePackages();
  }

  @Post("vehicle-packages")
  @RequirePermissions(PermissionCode.VEHICLE_PACKAGE_CREATE)
  createVehiclePackage(@Body() dto: CreateVehiclePackageDto, @Req() request: AuthenticatedRequest) {
    return this.productService.createVehiclePackage(dto, request.user, requestContext(request));
  }

  @Patch("vehicle-packages/:id")
  @RequirePermissions(PermissionCode.VEHICLE_PACKAGE_UPDATE)
  updateVehiclePackage(@Param("id") id: string, @Body() dto: UpdateVehiclePackageDto, @Req() request: AuthenticatedRequest) {
    return this.productService.updateVehiclePackage(id, dto, request.user, requestContext(request));
  }

  @Post("vehicle-packages/:id/activate")
  @RequirePermissions(PermissionCode.VEHICLE_PACKAGE_ACTIVATE)
  activateVehiclePackage(@Param("id") id: string, @Req() request: AuthenticatedRequest) {
    return this.productService.setVehiclePackageStatus(id, "ACTIVE", request.user, requestContext(request));
  }

  @Post("vehicle-packages/:id/deactivate")
  @RequirePermissions(PermissionCode.VEHICLE_PACKAGE_ACTIVATE)
  deactivateVehiclePackage(@Param("id") id: string, @Req() request: AuthenticatedRequest) {
    return this.productService.setVehiclePackageStatus(id, "INACTIVE", request.user, requestContext(request));
  }

  @Delete("vehicle-packages/:id")
  @RequirePermissions(PermissionCode.VEHICLE_PACKAGE_DELETE)
  deleteVehiclePackage(@Param("id") id: string, @Req() request: AuthenticatedRequest) {
    return this.productService.deleteVehiclePackage(id, request.user, requestContext(request));
  }

  @Get("mileage-packages")
  @RequirePermissions(PermissionCode.MILEAGE_PACKAGE_VIEW)
  listMileagePackages() {
    return this.productService.listMileagePackages();
  }

  @Post("mileage-packages")
  @RequirePermissions(PermissionCode.MILEAGE_PACKAGE_CREATE)
  createMileagePackage(@Body() dto: CreateMileagePackageDto, @Req() request: AuthenticatedRequest) {
    return this.productService.createMileagePackage(dto, request.user, requestContext(request));
  }

  @Patch("mileage-packages/:id")
  @RequirePermissions(PermissionCode.MILEAGE_PACKAGE_UPDATE)
  updateMileagePackage(@Param("id") id: string, @Body() dto: UpdateMileagePackageDto, @Req() request: AuthenticatedRequest) {
    return this.productService.updateMileagePackage(id, dto, request.user, requestContext(request));
  }

  @Post("mileage-packages/:id/activate")
  @RequirePermissions(PermissionCode.MILEAGE_PACKAGE_ACTIVATE)
  activateMileagePackage(@Param("id") id: string, @Req() request: AuthenticatedRequest) {
    return this.productService.setMileagePackageStatus(id, "ACTIVE", request.user, requestContext(request));
  }

  @Post("mileage-packages/:id/deactivate")
  @RequirePermissions(PermissionCode.MILEAGE_PACKAGE_ACTIVATE)
  deactivateMileagePackage(@Param("id") id: string, @Req() request: AuthenticatedRequest) {
    return this.productService.setMileagePackageStatus(id, "INACTIVE", request.user, requestContext(request));
  }

  @Delete("mileage-packages/:id")
  @RequirePermissions(PermissionCode.MILEAGE_PACKAGE_DELETE)
  deleteMileagePackage(@Param("id") id: string, @Req() request: AuthenticatedRequest) {
    return this.productService.deleteMileagePackage(id, request.user, requestContext(request));
  }

  @Get("energy-packages")
  @RequirePermissions(PermissionCode.ENERGY_PACKAGE_VIEW)
  listEnergyPackages() {
    return this.productService.listEnergyPackages();
  }

  @Post("energy-packages")
  @RequirePermissions(PermissionCode.ENERGY_PACKAGE_CREATE)
  createEnergyPackage(@Body() dto: CreateEnergyPackageDto, @Req() request: AuthenticatedRequest) {
    return this.productService.createEnergyPackage(dto, request.user, requestContext(request));
  }

  @Patch("energy-packages/:id")
  @RequirePermissions(PermissionCode.ENERGY_PACKAGE_UPDATE)
  updateEnergyPackage(@Param("id") id: string, @Body() dto: UpdateEnergyPackageDto, @Req() request: AuthenticatedRequest) {
    return this.productService.updateEnergyPackage(id, dto, request.user, requestContext(request));
  }

  @Post("energy-packages/:id/activate")
  @RequirePermissions(PermissionCode.ENERGY_PACKAGE_ACTIVATE)
  activateEnergyPackage(@Param("id") id: string, @Req() request: AuthenticatedRequest) {
    return this.productService.setEnergyPackageStatus(id, "ACTIVE", request.user, requestContext(request));
  }

  @Post("energy-packages/:id/deactivate")
  @RequirePermissions(PermissionCode.ENERGY_PACKAGE_ACTIVATE)
  deactivateEnergyPackage(@Param("id") id: string, @Req() request: AuthenticatedRequest) {
    return this.productService.setEnergyPackageStatus(id, "INACTIVE", request.user, requestContext(request));
  }

  @Delete("energy-packages/:id")
  @RequirePermissions(PermissionCode.ENERGY_PACKAGE_DELETE)
  deleteEnergyPackage(@Param("id") id: string, @Req() request: AuthenticatedRequest) {
    return this.productService.deleteEnergyPackage(id, request.user, requestContext(request));
  }

  @Get("benefit-packages")
  @RequirePermissions(PermissionCode.BENEFIT_PACKAGE_VIEW)
  listBenefitPackages() {
    return this.productService.listBenefitPackages();
  }

  @Post("benefit-packages")
  @RequirePermissions(PermissionCode.BENEFIT_PACKAGE_CREATE)
  createBenefitPackage(@Body() dto: CreateBenefitPackageDto, @Req() request: AuthenticatedRequest) {
    return this.productService.createBenefitPackage(dto, request.user, requestContext(request));
  }

  @Patch("benefit-packages/:id")
  @RequirePermissions(PermissionCode.BENEFIT_PACKAGE_UPDATE)
  updateBenefitPackage(@Param("id") id: string, @Body() dto: UpdateBenefitPackageDto, @Req() request: AuthenticatedRequest) {
    return this.productService.updateBenefitPackage(id, dto, request.user, requestContext(request));
  }

  @Post("benefit-packages/:id/activate")
  @RequirePermissions(PermissionCode.BENEFIT_PACKAGE_ACTIVATE)
  activateBenefitPackage(@Param("id") id: string, @Req() request: AuthenticatedRequest) {
    return this.productService.setBenefitPackageStatus(id, "ACTIVE", request.user, requestContext(request));
  }

  @Post("benefit-packages/:id/deactivate")
  @RequirePermissions(PermissionCode.BENEFIT_PACKAGE_ACTIVATE)
  deactivateBenefitPackage(@Param("id") id: string, @Req() request: AuthenticatedRequest) {
    return this.productService.setBenefitPackageStatus(id, "INACTIVE", request.user, requestContext(request));
  }

  @Delete("benefit-packages/:id")
  @RequirePermissions(PermissionCode.BENEFIT_PACKAGE_DELETE)
  deleteBenefitPackage(@Param("id") id: string, @Req() request: AuthenticatedRequest) {
    return this.productService.deleteBenefitPackage(id, request.user, requestContext(request));
  }

  @Get("subscription-plans")
  @RequirePermissions(PermissionCode.SUBSCRIPTION_PLAN_VIEW)
  listSubscriptionPlans() {
    return this.productService.listSubscriptionPlans();
  }

  @Post("subscription-plans")
  @RequirePermissions(PermissionCode.SUBSCRIPTION_PLAN_CREATE)
  createSubscriptionPlan(@Body() dto: CreateSubscriptionPlanDto, @Req() request: AuthenticatedRequest) {
    return this.productService.createSubscriptionPlan(dto, request.user, requestContext(request));
  }

  @Get("subscription-plans/:id")
  @RequirePermissions(PermissionCode.SUBSCRIPTION_PLAN_VIEW)
  getSubscriptionPlan(@Param("id") id: string) {
    return this.productService.getSubscriptionPlan(id);
  }

  @Patch("subscription-plans/:id")
  @RequirePermissions(PermissionCode.SUBSCRIPTION_PLAN_UPDATE)
  updateSubscriptionPlan(
    @Param("id") id: string,
    @Body() dto: UpdateSubscriptionPlanDto,
    @Req() request: AuthenticatedRequest
  ) {
    return this.productService.updateSubscriptionPlan(id, dto, request.user, requestContext(request));
  }

  @Post("subscription-plans/:id/activate")
  @RequirePermissions(PermissionCode.SUBSCRIPTION_PLAN_ACTIVATE)
  activateSubscriptionPlan(@Param("id") id: string, @Req() request: AuthenticatedRequest) {
    return this.productService.setSubscriptionPlanStatus(id, "ACTIVE", request.user, requestContext(request));
  }

  @Post("subscription-plans/:id/deactivate")
  @RequirePermissions(PermissionCode.SUBSCRIPTION_PLAN_DEACTIVATE)
  deactivateSubscriptionPlan(@Param("id") id: string, @Req() request: AuthenticatedRequest) {
    return this.productService.setSubscriptionPlanStatus(id, "INACTIVE", request.user, requestContext(request));
  }

  @Delete("subscription-plans/:id")
  @RequirePermissions(PermissionCode.SUBSCRIPTION_PLAN_DELETE)
  deleteSubscriptionPlan(@Param("id") id: string, @Req() request: AuthenticatedRequest) {
    return this.productService.deleteSubscriptionPlan(id, request.user, requestContext(request));
  }

  @Get("quotes")
  @RequirePermissions(PermissionCode.QUOTE_VIEW)
  listQuotes(@Req() request: AuthenticatedRequest) {
    return this.productService.listQuotes(request.user);
  }

  @Get("quotes/:id")
  @RequirePermissions(PermissionCode.QUOTE_VIEW)
  getQuote(@Param("id") id: string, @Req() request: AuthenticatedRequest) {
    return this.productService.getQuote(id, request.user);
  }

  @Patch("quotes/:id")
  @RequirePermissions(PermissionCode.QUOTE_UPDATE)
  updateQuote(
    @Param("id") id: string,
    @Body() dto: UpdateQuoteDto,
    @Req() request: AuthenticatedRequest
  ) {
    return this.productService.updateQuote(id, dto, request.user, requestContext(request));
  }

  @Post("quotes/:id/confirm")
  @RequirePermissions(PermissionCode.QUOTE_CONFIRM)
  confirmQuote(@Param("id") id: string, @Req() request: AuthenticatedRequest) {
    return this.productService.confirmQuote(id, request.user, requestContext(request));
  }

  @Post("quotes/:id/cancel")
  @RequirePermissions(PermissionCode.QUOTE_CANCEL)
  cancelQuote(@Param("id") id: string, @Req() request: AuthenticatedRequest) {
    return this.productService.cancelQuote(id, request.user, requestContext(request));
  }

  @Get("applications/:applicationId/available-subscription-plans")
  @RequirePermissions(PermissionCode.QUOTE_CREATE)
  listAvailableSubscriptionPlans(
    @Param("applicationId") applicationId: string,
    @Query("vehicleId") vehicleId: string | undefined,
    @Req() request: AuthenticatedRequest
  ) {
    return this.productService.listAvailableSubscriptionPlans(applicationId, request.user, vehicleId);
  }

  @Post("applications/:applicationId/quotes")
  @RequirePermissions(PermissionCode.QUOTE_CREATE)
  createApplicationQuote(
    @Param("applicationId") applicationId: string,
    @Body() dto: CreateQuoteDto,
    @Req() request: AuthenticatedRequest
  ) {
    return this.productService.createQuote(applicationId, dto, request.user, requestContext(request));
  }
}

function requestContext(request: AuthenticatedRequest) {
  return {
    ipAddress: request.ip,
    userAgent: request.headers["user-agent"]
  };
}
