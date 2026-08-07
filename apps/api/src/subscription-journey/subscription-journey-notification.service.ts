import { Injectable } from "@nestjs/common";
import { ConfigService } from "@nestjs/config";
import {
  NotificationChannel,
  NotificationEventType,
  NotificationStatus,
  NotificationType,
  SubscriptionJourneyJobType,
  SubscriptionJourneyStepCode
} from "@prisma/client";

import { NotificationService } from "../notification/notification.service";
import { PrismaService } from "../prisma/prisma.service";
import { journeyError } from "./subscription-journey.errors";
import { ClaimedJourneyJob } from "./subscription-journey.types";

interface JourneyNotificationDefinition {
  content: string;
  eventType: NotificationEventType;
  notificationType: NotificationType;
  template: string;
  title: string;
  url: string;
}

@Injectable()
export class SubscriptionJourneyNotificationService {
  constructor(
    private readonly config: ConfigService,
    private readonly notificationService: NotificationService,
    private readonly prisma: PrismaService
  ) {}

  async dispatch(job: ClaimedJourneyJob) {
    if (job.jobType !== SubscriptionJourneyJobType.DISPATCH_NOTIFICATION) {
      throw journeyError(
        "JOURNEY_INVALID_TRANSITION",
        "The journey notification handler received an invalid job."
      );
    }
    this.assertProductionProvider();
    const payload = readPayload(job.payload);
    const context = await this.prisma.subscriptionJourney.findUnique({
      select: {
        application: {
          select: {
            applicationNo: true,
            customerId: true,
            finalPlanRevision: true,
            id: true
          }
        },
        order: {
          select: { contractId: true, id: true, orderNo: true }
        }
      },
      where: { id: job.journeyId }
    });
    if (!context) {
      throw journeyError(
        "JOURNEY_NOT_FOUND",
        "The subscription journey notification context was not found."
      );
    }
    if (
      payload.finalPlanRevision !== context.application.finalPlanRevision
    ) {
      throw journeyError(
        "FINAL_PLAN_REVISION_STALE",
        "The journey notification targets a stale final-plan revision."
      );
    }

    const definition = notificationDefinition(payload.stepCode, context);
    const idempotencyKey = `${payload.eventKey}:${context.application.customerId}:${definition.template}`;
    const records = await this.notificationService.notifyCustomer({
      aggregateId: job.journeyId,
      aggregateType: "SubscriptionJourney",
      content: definition.content,
      customerId: context.application.customerId,
      data: {
        applicationNo: context.application.applicationNo,
        finalPlanRevision: context.application.finalPlanRevision,
        orderNo: context.order?.orderNo,
        status: "待客户处理"
      },
      eventType: definition.eventType,
      idempotencyKey,
      notificationType: definition.notificationType,
      requireWechatSuccess: true,
      title: definition.title,
      url: definition.url
    });
    const delivered = records.some(
      (record) =>
        record.channel === NotificationChannel.WECHAT_OFFICIAL_ACCOUNT &&
        (record.notificationStatus === NotificationStatus.SENT ||
          record.notificationStatus === NotificationStatus.READ)
    );
    if (!delivered) {
      throw journeyError(
        "JOURNEY_NOTIFICATION_DELIVERY_FAILED",
        "The customer action notification was not delivered.",
        true
      );
    }
    return { action: "NOTIFIED", eventType: definition.eventType };
  }

  private assertProductionProvider() {
    if (this.config.get<string>("NODE_ENV")?.trim().toLowerCase() !== "production") {
      return;
    }
    const provider = this.config
      .get<string>("NOTIFICATION_PROVIDER")
      ?.trim()
      .toLowerCase()
      .replace(/-/g, "_");
    if (provider !== "wechat_official_account") {
      throw journeyError(
        "JOURNEY_CONFIGURATION_ERROR",
        "Production journey notifications require the official-account provider."
      );
    }
  }
}

function readPayload(value: unknown): {
  eventKey: string;
  finalPlanRevision: number;
  stepCode: SubscriptionJourneyStepCode;
} {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw invalidPayload();
  }
  const payload = value as Record<string, unknown>;
  if (
    typeof payload.eventKey !== "string" ||
    typeof payload.finalPlanRevision !== "number" ||
    !Object.values(SubscriptionJourneyStepCode).includes(
      payload.stepCode as SubscriptionJourneyStepCode
    )
  ) {
    throw invalidPayload();
  }
  return {
    eventKey: payload.eventKey,
    finalPlanRevision: payload.finalPlanRevision,
    stepCode: payload.stepCode as SubscriptionJourneyStepCode
  };
}

function invalidPayload() {
  return journeyError(
    "JOURNEY_INVALID_TRANSITION",
    "The journey notification payload is invalid."
  );
}

function notificationDefinition(
  stepCode: SubscriptionJourneyStepCode,
  context: {
    application: { id: string };
    order: { contractId: string | null; id: string } | null;
  }
): JourneyNotificationDefinition {
  if (stepCode === SubscriptionJourneyStepCode.CUSTOMER_PLAN_CONFIRMATION) {
    return {
      content: "最终订阅方案已准备好，请登录客户门户核对并确认。",
      eventType: NotificationEventType.FINAL_PLAN_READY,
      notificationType: NotificationType.FINAL_PLAN_PENDING,
      template: "FINAL_PLAN_READY_WECHAT",
      title: "最终方案待确认",
      url: `/portal/applications/${encodeURIComponent(context.application.id)}`
    };
  }
  if (stepCode === SubscriptionJourneyStepCode.FADADA_SIGNING_AND_ARCHIVE) {
    if (!context.order?.contractId) throw invalidPayload();
    return {
      content: "订阅合同已准备好，请登录客户门户完成法大大电子签署。",
      eventType: NotificationEventType.CONTRACT_PENDING,
      notificationType: NotificationType.CONTRACT_PENDING,
      template: "CONTRACT_PENDING_WECHAT",
      title: "订阅合同待签署",
      url: `/portal/contracts/${encodeURIComponent(context.order.contractId)}/sign`
    };
  }
  if (stepCode === SubscriptionJourneyStepCode.CUSTOMER_JSAPI_PAYMENT) {
    if (!context.order) throw invalidPayload();
    return {
      content: "首期账单已生成，请登录客户门户核对并通过微信支付。",
      eventType: NotificationEventType.PAYMENT_PENDING,
      notificationType: NotificationType.PAYMENT_PENDING,
      template: "PAYMENT_PENDING_WECHAT",
      title: "首期账单待支付",
      url: `/portal/orders/${encodeURIComponent(context.order.id)}#bills`
    };
  }
  if (stepCode === SubscriptionJourneyStepCode.HANDOVER_AND_STAGE2_CREATION) {
    if (!context.order) throw invalidPayload();
    return {
      content: "车辆交付流程已开始，请登录客户门户配合预约和交付资料确认。",
      eventType: NotificationEventType.HANDOVER_ESIGN_PENDING,
      notificationType: NotificationType.HANDOVER_ESIGN_PENDING,
      template: "HANDOVER_ESIGN_PENDING_WECHAT",
      title: "车辆交付待配合",
      url: `/portal/orders/${encodeURIComponent(context.order.id)}`
    };
  }
  throw invalidPayload();
}
