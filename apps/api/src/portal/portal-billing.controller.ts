import {
  Body,
  Controller,
  Get,
  Header,
  Optional,
  Param,
  Post,
  Query,
  ServiceUnavailableException,
  StreamableFile,
  UploadedFiles,
  UseInterceptors,
  UseGuards
} from "@nestjs/common";
import { AnyFilesInterceptor } from "@nestjs/platform-express";

import type { UploadedMaterialFile } from "../customer/customer.service";
import { createUtf8MultipartOptions } from "../upload/multipart-upload-options";
import { CustomerAuthGuard } from "./portal-auth.guard";
import { CurrentCustomer } from "./portal-auth.types";
import { CurrentPortalCustomer } from "./portal-current-customer.decorator";
import { PortalBillingService } from "./portal-billing.service";
import { SubscriptionClosureProjectionService } from "../subscription-closure/subscription-closure.projection";
import { ClosureCustomerResponseDto } from "../subscription-closure/subscription-closure.dto";
import { SubscriptionReturnGovernanceService } from "../subscription-closure/subscription-return-governance.service";
import { ReturnManifestESignService } from "../esign/return-manifest-esign.service";
import {
  PortalBillsQueryDto,
  PortalClosureDisputeEvidenceDto,
  PortalDepositTransactionsQueryDto,
  PortalEntitlementsQueryDto,
  PortalEntitlementUsagesQueryDto,
  PortalOrdersQueryDto
} from "./portal-billing.dto";

@Controller("portal")
@UseGuards(CustomerAuthGuard)
export class PortalBillingController {
  constructor(
    private readonly portalBillingService: PortalBillingService,
    private readonly subscriptionClosureProjection: SubscriptionClosureProjectionService,
    @Optional() private readonly returnGovernance?: SubscriptionReturnGovernanceService,
    @Optional() private readonly returnManifestESign?: ReturnManifestESignService
  ) {}

  @Get("orders")
  listOrders(
    @CurrentPortalCustomer() currentCustomer: CurrentCustomer,
    @Query() query: PortalOrdersQueryDto
  ) {
    return this.portalBillingService.listOrders(currentCustomer, query);
  }

  @Get("orders/:id")
  getOrder(
    @Param("id") id: string,
    @CurrentPortalCustomer() currentCustomer: CurrentCustomer
  ) {
    return this.portalBillingService.getOrder(id, currentCustomer);
  }

  @Get("orders/:id/subscription-closure")
  getSubscriptionClosure(
    @Param("id") id: string,
    @CurrentPortalCustomer() currentCustomer: CurrentCustomer
  ) {
    return this.subscriptionClosureProjection.getCustomerByOrder(id, currentCustomer.customerId);
  }

  @Post("orders/:id/subscription-closure/responses")
  respondToSubscriptionClosure(
    @Param("id") id: string,
    @Body() dto: ClosureCustomerResponseDto,
    @CurrentPortalCustomer() currentCustomer: CurrentCustomer
  ) {
    return this.governance().recordCustomerResponse(id, currentCustomer.customerId, dto);
  }

  @Post("orders/:id/subscription-closure/dispute-evidence")
  @UseInterceptors(
    AnyFilesInterceptor(createUtf8MultipartOptions({ limits: { files: 1, fileSize: 20 * 1024 * 1024 } }))
  )
  async uploadSubscriptionClosureDisputeEvidence(
    @Param("id") id: string,
    @Body() dto: PortalClosureDisputeEvidenceDto,
    @UploadedFiles() files: UploadedMaterialFile[] | undefined,
    @CurrentPortalCustomer() currentCustomer: CurrentCustomer
  ) {
    const closure = await this.subscriptionClosureProjection.getCustomerByOrder(
      id,
      currentCustomer.customerId
    );
    if (!closure || typeof closure.closureCaseId !== "string") {
      throw new ServiceUnavailableException("Subscription closure unavailable.");
    }
    const uploaded = (files ?? [])[0];
    const file =
      uploaded?.buffer && uploaded.mimetype && uploaded.originalname && uploaded.size !== undefined
        ? {
            buffer: uploaded.buffer,
            mimetype: uploaded.mimetype,
            originalname: uploaded.originalname,
            size: uploaded.size
          }
        : undefined;
    return this.governance().uploadEvidence(
      closure.closureCaseId,
      {
        capturedAt: new Date(dto.capturedAt),
        evidenceType: uploaded?.mimetype?.startsWith("video/")
          ? "VIDEO"
          : uploaded?.mimetype === "application/pdf"
            ? "DOCUMENT"
            : "PHOTO",
        idempotencyKey: dto.idempotencyKey,
        supersedesEvidenceId: null,
        targetId: dto.chargeLineId,
        targetType: "CUSTOMER_DISPUTE",
        visibility: "CUSTOMER_VISIBLE"
      },
      file,
      null,
      currentCustomer.customerId
    );
  }

  @Get("orders/:id/subscription-closure/evidence/:linkId/preview")
  @Header("X-Content-Type-Options", "nosniff")
  async previewSubscriptionClosureEvidence(
    @Param("id") id: string,
    @Param("linkId") linkId: string,
    @CurrentPortalCustomer() currentCustomer: CurrentCustomer
  ) {
    const closure = await this.subscriptionClosureProjection.getCustomerByOrder(
      id,
      currentCustomer.customerId
    );
    if (!closure || typeof closure.closureCaseId !== "string") {
      throw new ServiceUnavailableException("Subscription closure unavailable.");
    }
    const file = await this.governance().getEvidenceObject(
      closure.closureCaseId,
      linkId,
      currentCustomer.customerId
    );
    return new StreamableFile(file.stream, {
      disposition: `inline; filename*=UTF-8''${encodeURIComponent(file.originalName)}`,
      length: file.contentLength,
      type: file.mimeType
    });
  }

  @Get("orders/:id/subscription-closure/return-manifest/signed-document/preview")
  @Header("X-Content-Type-Options", "nosniff")
  async previewSignedReturnManifest(
    @Param("id") id: string,
    @CurrentPortalCustomer() currentCustomer: CurrentCustomer
  ) {
    const closure = await this.subscriptionClosureProjection.getCustomerByOrder(
      id,
      currentCustomer.customerId
    );
    if (!closure || typeof closure.closureCaseId !== "string") {
      throw new ServiceUnavailableException("Subscription closure unavailable.");
    }
    const file = await this.governance().getSignedReturnManifestObject(
      closure.closureCaseId,
      currentCustomer.customerId
    );
    return new StreamableFile(file.stream, {
      disposition: `inline; filename*=UTF-8''${encodeURIComponent(file.originalName)}`,
      length: file.contentLength,
      type: file.mimeType
    });
  }

  @Post("orders/:id/subscription-closure/return-manifest-signing/:taskId/mock-sign")
  async mockSignReturnManifest(
    @Param("id") id: string,
    @Param("taskId") taskId: string,
    @CurrentPortalCustomer() currentCustomer: CurrentCustomer
  ) {
    const closure = await this.subscriptionClosureProjection.getCustomerByOrder(
      id,
      currentCustomer.customerId
    );
    if (!closure || typeof closure.closureCaseId !== "string") {
      throw new ServiceUnavailableException("Subscription closure unavailable.");
    }
    if (!this.returnManifestESign) {
      throw new ServiceUnavailableException("Return manifest e-sign unavailable.");
    }
    this.governance();
    return this.returnManifestESign.mockSignForPortal(
      closure.closureCaseId,
      taskId,
      currentCustomer.customerId
    );
  }

  @Get("bills")
  listBills(
    @CurrentPortalCustomer() currentCustomer: CurrentCustomer,
    @Query() query: PortalBillsQueryDto
  ) {
    return this.portalBillingService.listBills(currentCustomer, query);
  }

  @Get("bills/:id")
  getBill(
    @Param("id") id: string,
    @CurrentPortalCustomer() currentCustomer: CurrentCustomer
  ) {
    return this.portalBillingService.getBill(id, currentCustomer);
  }

  @Get("deposit")
  getDepositOverview(@CurrentPortalCustomer() currentCustomer: CurrentCustomer) {
    return this.portalBillingService.getDepositOverview(currentCustomer);
  }

  @Get("deposit/transactions")
  listDepositTransactions(
    @CurrentPortalCustomer() currentCustomer: CurrentCustomer,
    @Query() query: PortalDepositTransactionsQueryDto
  ) {
    return this.portalBillingService.listDepositTransactions(currentCustomer, query);
  }

  @Get("entitlements")
  listEntitlements(
    @CurrentPortalCustomer() currentCustomer: CurrentCustomer,
    @Query() query: PortalEntitlementsQueryDto
  ) {
    return this.portalBillingService.listEntitlements(currentCustomer, query);
  }

  @Get("entitlements/usages")
  listEntitlementUsages(
    @CurrentPortalCustomer() currentCustomer: CurrentCustomer,
    @Query() query: PortalEntitlementUsagesQueryDto
  ) {
    return this.portalBillingService.listEntitlementUsages(currentCustomer, query);
  }

  private governance() {
    if (!this.returnGovernance) {
      throw new ServiceUnavailableException("Subscription return governance unavailable.");
    }
    return this.returnGovernance;
  }
}
