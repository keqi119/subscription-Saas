import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

const schema = readFileSync(resolve(__dirname, "../prisma/schema.prisma"), "utf8");
const migrationPath = resolve(
  __dirname,
  "../prisma/migrations/20260805120000_stage1b_contract_extension_renewal/migration.sql"
);
const activeTermMigrationPath = resolve(
  __dirname,
  "../prisma/migrations/20260826020000_stage1_active_term_change_center/migration.sql"
);

function block(kind: "enum" | "model", name: string) {
  return schema.match(new RegExp(`${kind} ${name} \\{[\\s\\S]*?\\n\\}`))?.[0] ?? "";
}

function migrationSql() {
  try {
    return readFileSync(migrationPath, "utf8");
  } catch {
    return "";
  }
}

function activeTermMigrationSql() {
  try {
    return readFileSync(activeTermMigrationPath, "utf8");
  } catch {
    return "";
  }
}

describe("Stage 1B contract extension persistence contract", () => {
  it("defines the approved extension, quote, segment, consideration, and reminder enums", () => {
    expect(block("enum", "SubscriptionChangeType")).toMatch(
      /EXTENSION[\s\S]*VEHICLE_SWAP[\s\S]*EARLY_TERMINATION[\s\S]*MANAGED_OTHER/
    );
    expect(block("enum", "SubscriptionChangeStatus")).toMatch(
      /DRAFT[\s\S]*QUOTED[\s\S]*CUSTOMER_CONFIRMED[\s\S]*SIGNING_OR_PAYMENT[\s\S]*SCHEDULED[\s\S]*EXECUTING[\s\S]*COMPLETED[\s\S]*CANCELLED[\s\S]*FAILED[\s\S]*MANUAL_TAKEOVER/
    );
    expect(block("enum", "SubscriptionChangePricingMode")).toMatch(
      /CURRENT_VERSION[\s\S]*ORIGINAL_PRICE[\s\S]*APPROVED_DISCOUNT/
    );
    expect(block("enum", "SubscriptionChangeQuoteStatus")).toMatch(
      /DRAFT[\s\S]*FORMAL[\s\S]*SUPERSEDED[\s\S]*CUSTOMER_CONFIRMED[\s\S]*CUSTOMER_REJECTED[\s\S]*EXPIRED/
    );
    expect(block("enum", "ContractSegmentType")).toMatch(/BASE[\s\S]*EXTENSION/);
    expect(block("enum", "ContractSegmentStatus")).toMatch(
      /SCHEDULED[\s\S]*ACTIVE[\s\S]*COMPLETED[\s\S]*CANCELLED/
    );
    expect(block("enum", "RenewalConsiderationStatus")).toMatch(
      /PENDING_DECISION[\s\S]*RENEWAL_REQUESTED[\s\S]*EXPIRY_CONFIRMED[\s\S]*EXTENSION_IN_PROGRESS[\s\S]*EXTENDED[\s\S]*EXPIRED[\s\S]*CANCELLED/
    );
    expect(block("enum", "RenewalDecision")).toMatch(/RENEW[\s\S]*EXPIRE/);
    expect(block("enum", "RenewalReminderSlot")).toMatch(/D30[\s\S]*D14[\s\S]*D3/);
    expect(block("enum", "RenewalReminderStatus")).toMatch(
      /PENDING[\s\S]*SENT[\s\S]*FAILED[\s\S]*SKIPPED_DECIDED[\s\S]*SKIPPED_EXTENDED[\s\S]*SKIPPED_LATE_ENROLLMENT[\s\S]*CANCELLED/
    );
  });

  it("adds the V2 change order and append-only quote models", () => {
    const change = block("model", "SubscriptionChangeOrder");
    const quote = block("model", "SubscriptionChangeQuote");

    expect(change).toMatch(/orderId\s+String\s+@map\("order_id"\)\s+@db\.Uuid/);
    expect(change).toContain("sourceSegmentId");
    expect(change).toContain("renewalConsiderationId");
    expect(change).toContain("confirmedQuoteId");
    expect(change).toContain("completionDeadlineAt");
    expect(change).toContain("priceOverrideApprovedBy");
    expect(change).toContain("manualTakeoverReason");
    expect(change).toMatch(/version\s+Int\s+@default\(0\)/);

    expect(quote).toContain("changeOrderId");
    expect(quote).toMatch(/revision\s+Int/);
    expect(quote).toMatch(/monthlyFeeAmount\s+BigInt/);
    expect(quote).toContain("planSnapshot");
    expect(quote).toContain("priceRuleSnapshot");
    expect(quote).toContain("validUntil");
    expect(quote).toContain("@@unique([changeOrderId, revision])");
  });

  it("stores one typed detail for each active-term change kind", () => {
    const root = block("model", "SubscriptionChangeOrder");
    const extension = block("model", "SubscriptionExtensionChangeDetail");
    const swap = block("model", "SubscriptionVehicleSwapChangeDetail");
    const termination = block("model", "SubscriptionEarlyTerminationChangeDetail");
    const managedOther = block("model", "SubscriptionManagedOtherChangeDetail");

    expect(root).toContain("extensionDetail");
    expect(root).toContain("vehicleSwapDetail");
    expect(root).toContain("earlyTerminationDetail");
    expect(root).toContain("managedOtherDetail");
    expect(root).toMatch(/extensionMonths\s+Int\?/);
    expect(root).toMatch(/pricingMode\s+SubscriptionChangePricingMode\?/);
    expect(root).toMatch(/sourceSegmentId\s+String\?/);
    expect(root).toMatch(/targetStartDate\s+DateTime\?/);
    expect(root).toMatch(/targetEndDate\s+DateTime\?/);

    expect(extension).toMatch(/changeOrderId\s+String\s+@unique/);
    expect(extension).toContain("sourceSegmentId");
    expect(extension).toContain("extensionMonths");
    expect(extension).toContain("pricingMode");
    expect(extension).toContain("targetStartDate");
    expect(extension).toContain("targetEndDate");
    expect(extension).toContain("priceOverrideReason");

    expect(swap).toMatch(/changeOrderId\s+String\s+@unique/);
    expect(swap).toContain("sourceVehicleId");
    expect(swap).toContain("targetVehicleId");
    expect(swap).toContain("targetSubscriptionPlanId");
    expect(swap).toContain("targetVehiclePackageId");
    expect(swap).toContain("plannedSwapAt");
    expect(swap).toContain("inboundWorkOrderId");
    expect(swap).toContain("outboundWorkOrderId");
    expect(swap).toContain("commercialSnapshot");
    expect(swap).toContain("commercialSnapshotHash");

    expect(termination).toMatch(/changeOrderId\s+String\s+@unique/);
    expect(termination).toContain("effectiveDate");
    expect(termination).toContain("reasonSnapshot");
    expect(termination).toContain("estimatedSettlementRevision");
    expect(termination).toContain("agreementContractId");
    expect(termination).toContain("closureCaseId");

    expect(managedOther).toMatch(/changeOrderId\s+String\s+@unique/);
    expect(managedOther).toContain("effectiveDate");
    expect(managedOther).toContain("evidenceSnapshot");
    expect(managedOther).toContain("approvedOperationSnapshot");
    expect(managedOther).toContain("beforeSnapshot");
    expect(managedOther).toContain("afterSnapshot");
    expect(managedOther).toContain("supplementContractId");
  });

  it("backfills extension details and defers exact detail-shape validation until commit", () => {
    const sql = activeTermMigrationSql();

    expect(sql).toContain("ALTER TYPE \"subscription_change_type\" ADD VALUE 'VEHICLE_SWAP'");
    expect(sql).toContain("ALTER TYPE \"subscription_change_type\" ADD VALUE 'EARLY_TERMINATION'");
    expect(sql).toContain("ALTER TYPE \"subscription_change_type\" ADD VALUE 'MANAGED_OTHER'");
    expect(sql).toContain('CREATE TABLE "subscription_extension_change_detail"');
    expect(sql).toContain('CREATE TABLE "subscription_vehicle_swap_change_detail"');
    expect(sql).toContain('CREATE TABLE "subscription_early_termination_change_detail"');
    expect(sql).toContain('CREATE TABLE "subscription_managed_other_change_detail"');
    expect(sql).toContain('INSERT INTO "subscription_extension_change_detail"');
    expect(sql).toContain("CREATE CONSTRAINT TRIGGER");
    expect(sql).toContain("DEFERRABLE INITIALLY DEFERRED");
    expect(sql).toContain("subscription_change_detail_shape");
  });

  it("adds immutable contract segments and renewal consideration records", () => {
    const segment = block("model", "SubscriptionContractSegment");
    const consideration = block("model", "RenewalConsideration");
    const reminder = block("model", "RenewalReminder");

    expect(segment).toContain("sourceChangeOrderId");
    expect(segment).toContain("sourceContractId");
    expect(segment).toMatch(/startDate\s+DateTime[\s\S]*@db\.Date/);
    expect(segment).toMatch(/endDate\s+DateTime[\s\S]*@db\.Date/);
    expect(segment).toContain("monthlyFeeAmount");
    expect(segment).toContain("planSnapshot");
    expect(segment).toContain("@@unique([orderId, sequenceNo])");

    expect(consideration).toContain("segmentId");
    expect(consideration).toContain("changeOrderId");
    expect(consideration).toContain("considerationStartAt");
    expect(consideration).toContain("completionDeadlineAt");
    expect(reminder).toContain("notificationEventId");
    expect(reminder).toContain("smsSendLogId");
    expect(reminder).toContain("templateCodeSnapshot");
    expect(reminder).toContain("@@unique([renewalConsiderationId, slot])");
  });

  it("adds return-due, dedicated template/e-sign, jobs, and renewal notification enums", () => {
    expect(block("enum", "OrderStatus")).toContain("PENDING_RETURN");
    expect(block("enum", "LeaseStatus")).toContain("RETURN_DUE");
    expect(block("enum", "LeaseStatus")).toContain("COMPLETED");
    expect(block("enum", "ContractTemplateType")).toContain("SUBSCRIPTION_EXTENSION");
    expect(block("enum", "ESignSigningStage")).toContain("STAGE3_SUBSCRIPTION_EXTENSION");
    expect(block("enum", "ESignDocumentType")).toContain(
      "SUBSCRIPTION_EXTENSION_AGREEMENT"
    );
    expect(block("enum", "SubscriptionAutomationJobType")).toMatch(
      /RENEWAL_CONSIDERATION_ENROLL[\s\S]*RENEWAL_REMINDER_D30[\s\S]*RENEWAL_REMINDER_D14[\s\S]*RENEWAL_REMINDER_D3[\s\S]*RENEWAL_EXPIRY_PROCESS[\s\S]*RENEWAL_RETURN_OVERDUE_D1[\s\S]*EXTENSION_SEGMENT_ACTIVATE[\s\S]*EXTENSION_BILLING_RESUME[\s\S]*EXTENSION_ENTITLEMENT_RENEW[\s\S]*EXTENSION_INSURANCE_VALIDATION[\s\S]*EXTENSION_EFFECTIVE_NOTICE/
    );
    expect(block("enum", "NotificationType")).toMatch(
      /RENEWAL_REMINDER[\s\S]*RENEWAL_EXPIRY_RETURN[\s\S]*RENEWAL_RETURN_OVERDUE/
    );
    expect(block("enum", "NotificationTemplateType")).toMatch(
      /RENEWAL_REMINDER[\s\S]*RENEWAL_EXPIRY_RETURN[\s\S]*RENEWAL_RETURN_OVERDUE/
    );
    expect(block("enum", "NotificationEventType")).toMatch(
      /RENEWAL_REMINDER_D30[\s\S]*RENEWAL_REMINDER_D14[\s\S]*RENEWAL_REMINDER_D3[\s\S]*RENEWAL_EXPIRED[\s\S]*RENEWAL_RETURN_OVERDUE_D1/
    );

    const job = block("model", "SubscriptionAutomationJob");
    expect(job).toContain("changeOrderId");
    expect(job).toContain("contractSegmentId");
    expect(job).toContain("renewalConsiderationId");
  });

  it("enforces active-change, BASE, active-segment, date, and revision constraints in SQL", () => {
    const sql = migrationSql();

    expect(sql).toContain('CREATE UNIQUE INDEX "subscription_change_order_one_active_per_order"');
    expect(sql).toContain('CREATE UNIQUE INDEX "subscription_contract_segment_one_base_per_order"');
    expect(sql).toContain('CREATE UNIQUE INDEX "subscription_contract_segment_one_active_per_order"');
    expect(sql).toContain(
      'CREATE UNIQUE INDEX "subscription_change_quote_change_order_id_revision_key"'
    );
    expect(sql).toContain("subscription_change_order_extension_months_positive");
    expect(sql).toContain("subscription_contract_segment_dates_valid");
  });
});
