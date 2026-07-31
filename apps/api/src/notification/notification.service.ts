import { Inject, Injectable, Logger, NotFoundException } from "@nestjs/common";
import { ConfigService } from "@nestjs/config";
import { createHash } from "node:crypto";
import {
  CustomerAccountStatus,
  NotificationChannel,
  NotificationEventStatus,
  NotificationEventType,
  NotificationStatus,
  NotificationTemplateStatus,
  NotificationTemplateType,
  NotificationType,
  Prisma
} from "@prisma/client";

import { createBusinessNo, withUniqueBusinessNoRetry } from "../common/business-number";
import { PrismaService } from "../prisma/prisma.service";
import { CurrentCustomer } from "../portal/portal-auth.types";
import {
  AdminNotificationEventsQueryDto,
  AdminNotificationRecordsQueryDto,
  NotificationPageQueryDto,
  PortalNotificationsQueryDto
} from "./dto/notification.dto";
import {
  NOTIFICATION_PROVIDER_CLIENT,
  NotificationProvider,
  SendNotificationResult
} from "./notification.provider";

export interface NotifyCustomerInput {
  aggregateId?: string;
  aggregateType?: string;
  content: string;
  customerId: string;
  data?: Record<string, unknown>;
  eventType: NotificationEventType;
  notificationType: NotificationType;
  title: string;
  url?: string;
}

export interface NotifyStage2CustomerReadyInput {
  customerId: string;
  idempotencyKey: string;
  workOrderId: string;
}

export interface NotifyBillLifecycleInput extends NotifyCustomerInput {
  billId: string;
  idempotencyKey: string;
}

const TEMPLATE_CODE_BY_EVENT: Partial<
  Record<
    NotificationEventType,
    {
      inApp: string;
      wechat: string;
    }
  >
> = {
  [NotificationEventType.APPLICATION_SUBMITTED]: {
    inApp: "APPLICATION_SUBMITTED_IN_APP",
    wechat: "APPLICATION_SUBMITTED_WECHAT"
  },
  [NotificationEventType.FINAL_PLAN_READY]: {
    inApp: "FINAL_PLAN_READY_IN_APP",
    wechat: "FINAL_PLAN_READY_WECHAT"
  },
  [NotificationEventType.CONTRACT_PENDING]: {
    inApp: "CONTRACT_PENDING_IN_APP",
    wechat: "CONTRACT_PENDING_WECHAT"
  },
  [NotificationEventType.PAYMENT_PENDING]: {
    inApp: "PAYMENT_PENDING_IN_APP",
    wechat: "PAYMENT_PENDING_WECHAT"
  },
  [NotificationEventType.SERVICE_CASE_SUBMITTED]: {
    inApp: "SERVICE_CASE_UPDATE_IN_APP",
    wechat: "SERVICE_CASE_UPDATE_WECHAT"
  },
  [NotificationEventType.SERVICE_CASE_UPDATED]: {
    inApp: "SERVICE_CASE_UPDATE_IN_APP",
    wechat: "SERVICE_CASE_UPDATE_WECHAT"
  },
  [NotificationEventType.RESCUE_UPDATED]: {
    inApp: "SERVICE_CASE_UPDATE_IN_APP",
    wechat: "SERVICE_CASE_UPDATE_WECHAT"
  },
  [NotificationEventType.MATERIAL_REQUIRED]: {
    inApp: "APPLICATION_SUBMITTED_IN_APP",
    wechat: "APPLICATION_SUBMITTED_WECHAT"
  },
  [NotificationEventType.BILL_DUE]: {
    inApp: "PAYMENT_PENDING_IN_APP",
    wechat: "PAYMENT_PENDING_WECHAT"
  },
  [NotificationEventType.BILL_OVERDUE]: {
    inApp: "PAYMENT_PENDING_IN_APP",
    wechat: "PAYMENT_PENDING_WECHAT"
  }
};

const TEMPLATE_TYPE_BY_NOTIFICATION_TYPE: Partial<
  Record<NotificationType, NotificationTemplateType>
> = {
  [NotificationType.APPLICATION_PROGRESS]: NotificationTemplateType.APPLICATION_PROGRESS,
  [NotificationType.MATERIAL_REQUIRED]: NotificationTemplateType.MATERIAL_REQUIRED,
  [NotificationType.FINAL_PLAN_PENDING]: NotificationTemplateType.FINAL_PLAN_PENDING,
  [NotificationType.CONTRACT_PENDING]: NotificationTemplateType.CONTRACT_PENDING,
  [NotificationType.PAYMENT_PENDING]: NotificationTemplateType.PAYMENT_PENDING,
  [NotificationType.BILL_DUE]: NotificationTemplateType.BILL_DUE,
  [NotificationType.BILL_OVERDUE]: NotificationTemplateType.BILL_OVERDUE,
  [NotificationType.SERVICE_CASE_UPDATE]: NotificationTemplateType.SERVICE_CASE_UPDATE,
  [NotificationType.RESCUE_UPDATE]: NotificationTemplateType.RESCUE_UPDATE,
  [NotificationType.SYSTEM]: NotificationTemplateType.SYSTEM
};

const WECHAT_TEMPLATE_ENV_BY_TYPE: Partial<Record<NotificationTemplateType, string>> = {
  [NotificationTemplateType.APPLICATION_PROGRESS]: "WECHAT_TEMPLATE_APPLICATION_PROGRESS",
  [NotificationTemplateType.CONTRACT_PENDING]: "WECHAT_TEMPLATE_CONTRACT_PENDING",
  [NotificationTemplateType.FINAL_PLAN_PENDING]: "WECHAT_TEMPLATE_FINAL_PLAN_PENDING",
  [NotificationTemplateType.PAYMENT_PENDING]: "WECHAT_TEMPLATE_PAYMENT_PENDING",
  [NotificationTemplateType.RESCUE_UPDATE]: "WECHAT_TEMPLATE_SERVICE_CASE_UPDATE",
  [NotificationTemplateType.SERVICE_CASE_UPDATE]: "WECHAT_TEMPLATE_SERVICE_CASE_UPDATE"
};

const SERVICE_CASE_STATUS_TEXT: Record<string, string> = {
  ACCEPTED: "已受理",
  CANCELLED: "已取消",
  CLOSED: "已关闭",
  IN_PROGRESS: "处理中",
  RESOLVED: "已解决",
  SUBMITTED: "已提交",
  WAITING_CUSTOMER: "待客户补充"
};

const DEFAULT_WECHAT_SERVICE_CASE_STATUS_CONST4 = "处理中";

const SERVICE_CASE_NOTIFICATION_EVENTS = new Set<NotificationEventType>([
  NotificationEventType.SERVICE_CASE_SUBMITTED,
  NotificationEventType.SERVICE_CASE_UPDATED,
  NotificationEventType.RESCUE_UPDATED
]);

@Injectable()
export class NotificationService {
  private readonly logger = new Logger(NotificationService.name);

  constructor(
    private readonly configService: ConfigService,
    @Inject(NOTIFICATION_PROVIDER_CLIENT)
    private readonly provider: NotificationProvider,
    private readonly prisma: PrismaService
  ) {}

  async notifyCustomer(input: NotifyCustomerInput) {
    const event = await this.prisma.notificationEvent.create({
      data: {
        aggregateId: input.aggregateId,
        aggregateType: input.aggregateType,
        customerId: input.customerId,
        eventStatus: NotificationEventStatus.PROCESSING,
        eventType: input.eventType,
        payload: toJsonValue(input.data),
        attempts: 1
      }
    });

    try {
      const records = await this.createNotificationRecords(input);
      await this.prisma.notificationEvent.update({
        data: {
          eventStatus: NotificationEventStatus.PROCESSED,
          notificationId: records[0]?.id,
          processedAt: new Date()
        },
        where: { id: event.id }
      });
      return records;
    } catch (error) {
      await this.prisma.notificationEvent.update({
        data: {
          eventStatus: NotificationEventStatus.FAILED,
          lastError: errorMessage(error),
          processedAt: new Date()
        },
        where: { id: event.id }
      });
      this.logger.warn(`Notification event ${event.id} failed: ${errorMessage(error)}`);
      return [];
    }
  }

  async notifyBillLifecycle(input: NotifyBillLifecycleInput) {
    const records = await this.createNotificationRecords(input, input.idempotencyKey);
    if (records.length === 0) {
      return records;
    }

    const eventId = billNotificationEventId(input.idempotencyKey);
    const now = new Date();
    const incomplete = records.some(
      (record) =>
        record.notificationStatus !== NotificationStatus.SENT &&
        record.notificationStatus !== NotificationStatus.READ &&
        record.notificationStatus !== NotificationStatus.SKIPPED
    );
    const event = await this.prisma.notificationEvent.findUnique({
      where: { id: eventId }
    });
    const eventData = {
      aggregateId: input.billId,
      aggregateType: "ReceivableBill",
      customerId: input.customerId,
      eventStatus: incomplete ? NotificationEventStatus.FAILED : NotificationEventStatus.PROCESSED,
      eventType: input.eventType,
      lastError: incomplete ? "BILL_NOTIFICATION_INCOMPLETE" : null,
      notificationId: records[0]!.id,
      processedAt: now
    };
    if (event) {
      await this.prisma.notificationEvent.update({
        data: {
          ...eventData,
          attempts: { increment: 1 }
        },
        where: { id: event.id }
      });
    } else {
      await this.prisma.notificationEvent.create({
        data: {
          ...eventData,
          attempts: 1,
          id: eventId
        }
      });
    }

    if (incomplete) {
      throw new Error("BILL_NOTIFICATION_INCOMPLETE");
    }
    return records;
  }

  async notifyStage2CustomerReady(input: NotifyStage2CustomerReadyInput) {
    const notificationNo = stage2NotificationNo(input.idempotencyKey);
    const reconcile = () =>
      this.prisma.$transaction((tx) =>
        this.reconcileStage2CustomerReady(tx, input, notificationNo)
      );

    try {
      return await reconcile();
    } catch (error) {
      if (!isUniqueConflict(error)) {
        throw error;
      }
      return reconcile();
    }
  }

  async listTemplates(query: NotificationPageQueryDto) {
    const page = normalizePage(query.page);
    const pageSize = normalizePageSize(query.pageSize);
    const where: Prisma.NotificationTemplateWhereInput = { deletedAt: null };
    const [items, total] = await this.prisma.$transaction([
      this.prisma.notificationTemplate.findMany({
        orderBy: [{ channel: "asc" }, { templateCode: "asc" }],
        skip: (page - 1) * pageSize,
        take: pageSize,
        where
      }),
      this.prisma.notificationTemplate.count({ where })
    ]);

    return {
      items: items.map(toTemplateView),
      page,
      pageSize,
      total
    };
  }

  async listRecords(query: AdminNotificationRecordsQueryDto) {
    const page = normalizePage(query.page);
    const pageSize = normalizePageSize(query.pageSize);
    const where: Prisma.NotificationRecordWhereInput = {
      channel: query.channel,
      customerId: query.customerId,
      deletedAt: null,
      notificationStatus: query.notificationStatus,
      notificationType: query.notificationType
    };
    const [items, total] = await this.prisma.$transaction([
      this.prisma.notificationRecord.findMany({
        include: {
          customer: { select: { customerNo: true, mobile: true, name: true } },
          template: true
        },
        orderBy: { createdAt: "desc" },
        skip: (page - 1) * pageSize,
        take: pageSize,
        where
      }),
      this.prisma.notificationRecord.count({ where })
    ]);

    return {
      items: items.map(toRecordView),
      page,
      pageSize,
      total
    };
  }

  async listEvents(query: AdminNotificationEventsQueryDto) {
    const page = normalizePage(query.page);
    const pageSize = normalizePageSize(query.pageSize);
    const where: Prisma.NotificationEventWhereInput = {
      customerId: query.customerId,
      eventStatus: query.eventStatus
    };
    const [items, total] = await this.prisma.$transaction([
      this.prisma.notificationEvent.findMany({
        include: {
          customer: { select: { customerNo: true, mobile: true, name: true } },
          notification: true
        },
        orderBy: { createdAt: "desc" },
        skip: (page - 1) * pageSize,
        take: pageSize,
        where
      }),
      this.prisma.notificationEvent.count({ where })
    ]);

    return {
      items: items.map(toEventView),
      page,
      pageSize,
      total
    };
  }

  async listPortalNotifications(
    currentCustomer: CurrentCustomer,
    query: PortalNotificationsQueryDto
  ) {
    const page = normalizePage(query.page);
    const pageSize = normalizePageSize(query.pageSize);
    const where: Prisma.NotificationRecordWhereInput = {
      channel: NotificationChannel.IN_APP,
      customerId: currentCustomer.customerId,
      deletedAt: null,
      notificationStatus: query.notificationStatus
    };
    const unreadWhere: Prisma.NotificationRecordWhereInput = {
      channel: NotificationChannel.IN_APP,
      customerId: currentCustomer.customerId,
      deletedAt: null,
      readAt: null,
      notificationStatus: { not: NotificationStatus.CANCELLED }
    };
    const [items, total, unreadCount] = await this.prisma.$transaction([
      this.prisma.notificationRecord.findMany({
        orderBy: { createdAt: "desc" },
        skip: (page - 1) * pageSize,
        take: pageSize,
        where
      }),
      this.prisma.notificationRecord.count({ where }),
      this.prisma.notificationRecord.count({ where: unreadWhere })
    ]);

    return {
      items: items.map(toPortalRecordView),
      page,
      pageSize,
      total,
      unreadCount
    };
  }

  async getPortalNotification(id: string, currentCustomer: CurrentCustomer) {
    const record = await this.findPortalNotificationOrThrow(id, currentCustomer.customerId);
    return toPortalRecordView(record);
  }

  async markPortalNotificationRead(id: string, currentCustomer: CurrentCustomer) {
    const record = await this.findPortalNotificationOrThrow(id, currentCustomer.customerId);
    const updated = await this.prisma.notificationRecord.update({
      data: {
        notificationStatus: NotificationStatus.READ,
        readAt: record.readAt ?? new Date()
      },
      where: { id: record.id }
    });
    return toPortalRecordView(updated);
  }

  async markAllPortalNotificationsRead(currentCustomer: CurrentCustomer) {
    const now = new Date();
    const result = await this.prisma.notificationRecord.updateMany({
      data: {
        notificationStatus: NotificationStatus.READ,
        readAt: now
      },
      where: {
        channel: NotificationChannel.IN_APP,
        customerId: currentCustomer.customerId,
        deletedAt: null,
        readAt: null
      }
    });
    return { updatedCount: result.count };
  }

  private async createNotificationRecords(input: NotifyCustomerInput, idempotencyKey?: string) {
    const customer = await this.prisma.customer.findFirst({
      select: { id: true, mobile: true, name: true },
      where: { deletedAt: null, id: input.customerId }
    });
    if (!customer) {
      return [];
    }
    const account = await this.prisma.customerAccount.findFirst({
      orderBy: { updatedAt: "desc" },
      select: { id: true, phone: true, wechatOpenId: true },
      where: {
        accountStatus: CustomerAccountStatus.ACTIVE,
        customerId: input.customerId,
        deletedAt: null
      }
    });
    const templateCodes = TEMPLATE_CODE_BY_EVENT[input.eventType];
    if (!templateCodes) {
      throw new Error(`Notification event type ${input.eventType} is not configured.`);
    }
    const [inAppTemplate, wechatTemplate] = await Promise.all([
      this.findTemplate(templateCodes.inApp),
      this.findTemplate(templateCodes.wechat)
    ]);
    const data = {
      aggregateId: input.aggregateId,
      aggregateNo: input.data?.aggregateNo,
      content: input.content,
      customerName: customer.name,
      status: input.data?.status,
      time: new Date().toISOString(),
      title: input.title,
      ...(input.data ?? {})
    };
    Object.assign(data, this.buildWechatTemplateData(input, data));
    const inAppNotificationNo = idempotencyKey
      ? billNotificationNo(idempotencyKey, "IN_APP")
      : undefined;
    const existingInApp = inAppNotificationNo
      ? await this.prisma.notificationRecord.findUnique({
          where: { notificationNo: inAppNotificationNo }
        })
      : null;
    const inApp =
      existingInApp &&
      (existingInApp.notificationStatus === NotificationStatus.SENT ||
        existingInApp.notificationStatus === NotificationStatus.READ)
        ? existingInApp
        : await this.createRecord({
            channel: NotificationChannel.IN_APP,
            content: input.content,
            customerAccountId: account?.id,
            customerId: input.customerId,
            existingRecordId: existingInApp?.id,
            notificationNo: inAppNotificationNo,
            payload: data,
            recipientPhone: account?.phone ?? customer.mobile,
            result: {
              providerResponse: { inApp: true },
              success: true
            },
            status: NotificationStatus.SENT,
            template: inAppTemplate,
            templateCode: templateCodes.inApp,
            title: input.title,
            type: input.notificationType,
            url: normalizePortalUrl(input.url, this.portalBaseUrl)
          });
    const wechatNotificationNo = idempotencyKey
      ? billNotificationNo(idempotencyKey, "WECHAT")
      : undefined;
    const existingWechat = wechatNotificationNo
      ? await this.prisma.notificationRecord.findUnique({
          where: { notificationNo: wechatNotificationNo }
        })
      : null;
    const wechat =
      existingWechat &&
      (existingWechat.notificationStatus === NotificationStatus.SENT ||
        existingWechat.notificationStatus === NotificationStatus.READ ||
        existingWechat.notificationStatus === NotificationStatus.SKIPPED)
        ? existingWechat
        : await this.createWechatRecord({
            account,
            content: input.content,
            customerId: input.customerId,
            data,
            existingRecordId: existingWechat?.id,
            notificationNo: wechatNotificationNo,
            notificationType: input.notificationType,
            template: wechatTemplate,
            templateCode: templateCodes.wechat,
            title: input.title,
            url: normalizePortalUrl(input.url, this.portalBaseUrl)
          });

    return [inApp, wechat].filter(
      (record): record is NonNullable<typeof record> => record !== null
    );
  }

  private async reconcileStage2CustomerReady(
    tx: Prisma.TransactionClient,
    input: NotifyStage2CustomerReadyInput,
    notificationNo: string
  ) {
    await tx.$queryRaw(Prisma.sql`
      SELECT "id"
      FROM "notification_record"
      WHERE "notification_no" = ${notificationNo}
      FOR UPDATE
    `);
    const now = new Date();
    let record = await tx.notificationRecord.findUnique({
      where: { notificationNo }
    });
    if (!record) {
      record = await tx.notificationRecord.create({
        data: {
          channel: NotificationChannel.IN_APP,
          content: "Log in to Portal to review the handover signing request.",
          customerId: input.customerId,
          notificationNo,
          notificationStatus: NotificationStatus.SENT,
          notificationType: NotificationType.HANDOVER_ESIGN_READY,
          readAt: null,
          sentAt: now,
          templateCode: "HANDOVER_ESIGN_READY_IN_APP",
          title: "Handover signing is ready",
          url: normalizePortalUrl(
            `/portal/handover-reviews/${encodeURIComponent(input.workOrderId)}`,
            this.portalBaseUrl
          )
        }
      });
    } else if (
      record.notificationStatus !== NotificationStatus.SENT &&
      record.notificationStatus !== NotificationStatus.READ
    ) {
      record = await tx.notificationRecord.update({
        data: {
          errorMessage: null,
          failedAt: null,
          notificationStatus: NotificationStatus.SENT,
          sentAt: now
        },
        where: { id: record.id }
      });
    }

    const event = await tx.notificationEvent.findFirst({
      where: { notificationId: record.id }
    });
    if (!event) {
      await tx.notificationEvent.create({
        data: {
          aggregateId: input.workOrderId,
          aggregateType: "VehicleHandoverWorkOrder",
          attempts: 1,
          customerId: input.customerId,
          eventStatus: NotificationEventStatus.PROCESSED,
          eventType: NotificationEventType.HANDOVER_ESIGN_READY,
          notificationId: record.id,
          processedAt: now
        }
      });
    } else if (event.eventStatus !== NotificationEventStatus.PROCESSED) {
      await tx.notificationEvent.update({
        data: {
          eventStatus: NotificationEventStatus.PROCESSED,
          lastError: null,
          processedAt: now
        },
        where: { id: event.id }
      });
    }

    return record;
  }

  private async createWechatRecord(input: {
    account: { id: string; phone: string; wechatOpenId: string | null } | null;
    content: string;
    customerId: string;
    data: Record<string, unknown>;
    existingRecordId?: string;
    notificationNo?: string;
    notificationType: NotificationType;
    template: Prisma.NotificationTemplateGetPayload<Record<string, never>> | null;
    templateCode: string;
    title: string;
    url: string | null;
  }) {
    const providerTemplateId =
      input.template?.providerTemplateId ?? this.envTemplateId(input.notificationType);
    if (!input.account?.wechatOpenId) {
      return this.createRecord({
        channel: NotificationChannel.WECHAT_OFFICIAL_ACCOUNT,
        content: input.content,
        customerAccountId: input.account?.id,
        customerId: input.customerId,
        errorMessage: "WECHAT_OPENID_MISSING",
        existingRecordId: input.existingRecordId,
        notificationNo: input.notificationNo,
        payload: input.data,
        recipientPhone: input.account?.phone,
        status: NotificationStatus.SKIPPED,
        template: input.template,
        templateCode: input.templateCode,
        title: input.title,
        type: input.notificationType,
        url: input.url
      });
    }

    const providerMode = this.providerMode;
    if (providerMode !== "mock") {
      const const4Error = this.serviceCaseWechatConst4Error(input);
      if (const4Error) {
        return this.createRecord({
          channel: NotificationChannel.WECHAT_OFFICIAL_ACCOUNT,
          content: input.content,
          customerAccountId: input.account.id,
          customerId: input.customerId,
          errorMessage: const4Error,
          existingRecordId: input.existingRecordId,
          notificationNo: input.notificationNo,
          payload: input.data,
          recipientOpenId: input.account.wechatOpenId,
          recipientPhone: input.account.phone,
          status: NotificationStatus.SKIPPED,
          template: input.template,
          templateCode: input.templateCode,
          title: input.title,
          type: input.notificationType,
          url: input.url
        });
      }
    }

    if (providerMode !== "mock" && !this.wechatEnabled) {
      return this.createRecord({
        channel: NotificationChannel.WECHAT_OFFICIAL_ACCOUNT,
        content: input.content,
        customerAccountId: input.account.id,
        customerId: input.customerId,
        errorMessage: "WECHAT_OFFICIAL_ACCOUNT_DISABLED",
        existingRecordId: input.existingRecordId,
        notificationNo: input.notificationNo,
        payload: input.data,
        recipientOpenId: input.account.wechatOpenId,
        recipientPhone: input.account.phone,
        status: NotificationStatus.SKIPPED,
        template: input.template,
        templateCode: input.templateCode,
        title: input.title,
        type: input.notificationType,
        url: input.url
      });
    }

    if (providerMode !== "mock" && !providerTemplateId) {
      return this.createRecord({
        channel: NotificationChannel.WECHAT_OFFICIAL_ACCOUNT,
        content: input.content,
        customerAccountId: input.account.id,
        customerId: input.customerId,
        errorMessage: "WECHAT_TEMPLATE_ID_MISSING",
        existingRecordId: input.existingRecordId,
        notificationNo: input.notificationNo,
        payload: input.data,
        recipientOpenId: input.account.wechatOpenId,
        recipientPhone: input.account.phone,
        status: NotificationStatus.SKIPPED,
        template: input.template,
        templateCode: input.templateCode,
        title: input.title,
        type: input.notificationType,
        url: input.url
      });
    }

    const claim = await this.claimWechatSend({
      ...input,
      account: input.account
    });
    if (!claim.claimed) {
      if (!claim.record) {
        throw new Error("Bill notification send claim is missing.");
      }
      return claim.record;
    }
    let result: SendNotificationResult;
    try {
      result = await this.provider.send({
        channel: NotificationChannel.WECHAT_OFFICIAL_ACCOUNT,
        content: input.content,
        data: input.data,
        providerTemplateId:
          providerTemplateId ?? input.templateCode,
        recipientOpenId: input.account.wechatOpenId,
        recipientPhone: input.account.phone,
        templateCode: input.templateCode,
        title: input.title,
        url: input.url
      });
    } catch (error) {
      await this.createRecord({
        channel: NotificationChannel.WECHAT_OFFICIAL_ACCOUNT,
        content: input.content,
        customerAccountId: input.account.id,
        customerId: input.customerId,
        errorMessage: "BILL_NOTIFICATION_PROVIDER_ERROR",
        existingRecordId: claim.record?.id,
        notificationNo: input.notificationNo,
        payload: input.data,
        recipientOpenId: input.account.wechatOpenId,
        recipientPhone: input.account.phone,
        status: NotificationStatus.FAILED,
        template: input.template,
        templateCode: input.templateCode,
        title: input.title,
        type: input.notificationType,
        url: input.url
      });
      throw error;
    }
    return this.createRecord({
      channel: NotificationChannel.WECHAT_OFFICIAL_ACCOUNT,
      content: input.content,
      customerAccountId: input.account.id,
      customerId: input.customerId,
      existingRecordId: claim.record?.id ?? input.existingRecordId,
      notificationNo: input.notificationNo,
      payload: input.data,
      recipientOpenId: input.account.wechatOpenId,
      recipientPhone: input.account.phone,
      result,
      status: result.success ? NotificationStatus.SENT : NotificationStatus.FAILED,
      template: input.template,
      templateCode: input.templateCode,
      title: input.title,
      type: input.notificationType,
      url: input.url
    });
  }

  private async claimWechatSend(input: {
    account: { id: string; phone: string; wechatOpenId: string | null };
    content: string;
    customerId: string;
    data: Record<string, unknown>;
    existingRecordId?: string;
    notificationNo?: string;
    notificationType: NotificationType;
    template: Prisma.NotificationTemplateGetPayload<Record<string, never>> | null;
    templateCode: string;
    title: string;
    url: string | null;
  }) {
    if (!input.notificationNo) {
      return { claimed: true, record: null };
    }
    let record = input.existingRecordId
      ? await this.prisma.notificationRecord.findUnique({
          where: { id: input.existingRecordId }
        })
      : await this.prisma.notificationRecord.findUnique({
          where: { notificationNo: input.notificationNo }
        });
    if (!record) {
      record = await this.createRecord({
        channel: NotificationChannel.WECHAT_OFFICIAL_ACCOUNT,
        content: input.content,
        customerAccountId: input.account.id,
        customerId: input.customerId,
        notificationNo: input.notificationNo,
        payload: input.data,
        recipientOpenId: input.account.wechatOpenId,
        recipientPhone: input.account.phone,
        status: NotificationStatus.PENDING,
        template: input.template,
        templateCode: input.templateCode,
        title: input.title,
        type: input.notificationType,
        url: input.url
      });
    }
    if (
      record.notificationStatus === NotificationStatus.SENT ||
      record.notificationStatus === NotificationStatus.READ ||
      record.notificationStatus === NotificationStatus.SKIPPED ||
      record.notificationStatus === NotificationStatus.PROCESSING
    ) {
      return { claimed: false, record };
    }
    const claimed = await this.prisma.notificationRecord.updateMany({
      data: {
        errorMessage: null,
        failedAt: null,
        notificationStatus: NotificationStatus.PROCESSING,
        scheduledAt: new Date()
      },
      where: {
        id: record.id,
        notificationStatus: {
          in: [NotificationStatus.PENDING, NotificationStatus.FAILED]
        }
      }
    });
    if (claimed.count !== 1) {
      return {
        claimed: false,
        record:
          (await this.prisma.notificationRecord.findUnique({
            where: { id: record.id }
          })) ?? record
      };
    }
    return {
      claimed: true,
      record: {
        ...record,
        notificationStatus: NotificationStatus.PROCESSING
      }
    };
  }

  private async createRecord(input: {
    channel: NotificationChannel;
    content: string;
    customerAccountId?: string | null;
    customerId: string;
    errorMessage?: string;
    existingRecordId?: string;
    notificationNo?: string;
    payload?: unknown;
    recipientOpenId?: string | null;
    recipientPhone?: string | null;
    result?: SendNotificationResult;
    status: NotificationStatus;
    template: Prisma.NotificationTemplateGetPayload<Record<string, never>> | null;
    templateCode: string;
    title: string;
    type: NotificationType;
    url: string | null;
  }) {
    const now = new Date();
    const data = {
      channel: input.channel,
      content: input.content,
      customerAccountId: input.customerAccountId,
      customerId: input.customerId,
      errorMessage: input.errorMessage ?? input.result?.errorMessage ?? null,
      failedAt: input.status === NotificationStatus.FAILED ? now : null,
      notificationStatus: input.status,
      notificationType: input.type,
      payload: toJsonValue(input.payload),
      providerMessageId: input.result?.providerMessageId,
      providerResponse:
        input.result?.providerResponse === undefined
          ? undefined
          : toJsonValue(input.result.providerResponse),
      recipientOpenId: input.recipientOpenId,
      recipientPhone: input.recipientPhone,
      sentAt: input.status === NotificationStatus.SENT ? now : null,
      templateCode: input.templateCode,
      templateId: input.template?.id,
      title: input.title,
      url: input.url
    };
    if (input.existingRecordId) {
      return this.prisma.notificationRecord.update({
        data,
        where: { id: input.existingRecordId }
      });
    }
    try {
      return await withUniqueBusinessNoRetry(() =>
        this.prisma.notificationRecord.create({
          data: {
            ...data,
            notificationNo: input.notificationNo ?? createBusinessNo("NTF"),
            readAt: null
          }
        })
      );
    } catch (error) {
      if (!input.notificationNo || !isUniqueConflict(error)) {
        throw error;
      }
      const existing = await this.prisma.notificationRecord.findUnique({
        where: { notificationNo: input.notificationNo }
      });
      if (!existing) {
        throw error;
      }
      return existing;
    }
  }

  private findTemplate(templateCode: string) {
    return this.prisma.notificationTemplate.findFirst({
      where: {
        deletedAt: null,
        templateCode,
        templateStatus: NotificationTemplateStatus.ACTIVE
      }
    });
  }

  private async findPortalNotificationOrThrow(id: string, customerId: string) {
    const record = await this.prisma.notificationRecord.findFirst({
      where: {
        channel: NotificationChannel.IN_APP,
        customerId,
        deletedAt: null,
        id
      }
    });
    if (!record) {
      throw new NotFoundException("通知不存在。");
    }
    return record;
  }

  private envTemplateId(notificationType: NotificationType) {
    const templateType = TEMPLATE_TYPE_BY_NOTIFICATION_TYPE[notificationType];
    const envKey = templateType ? WECHAT_TEMPLATE_ENV_BY_TYPE[templateType] : undefined;
    const value = envKey ? this.configService.get<string>(envKey)?.trim() : undefined;
    if (!value || value === "<CHANGE_ME>") {
      return null;
    }
    return value;
  }

  private get providerMode() {
    return normalizeProvider(this.configService.get<string>("NOTIFICATION_PROVIDER") ?? "mock");
  }

  private get wechatEnabled() {
    return (
      (this.configService.get<string>("NOTIFICATION_WECHAT_ENABLED") ?? "false").toLowerCase() ===
      "true"
    );
  }

  private get portalBaseUrl() {
    return trimTrailingSlash(
      this.configService.get<string>("PORTAL_BASE_URL") ?? "http://localhost:3000"
    );
  }

  private get wechatServiceCaseStatusConst4Allowlist() {
    const configured = parseCsv(
      this.configService.get<string>("WECHAT_SERVICE_CASE_STATUS_CONST4_ALLOWLIST")
    );
    return configured.length > 0 ? configured : [DEFAULT_WECHAT_SERVICE_CASE_STATUS_CONST4];
  }

  private buildWechatTemplateData(input: NotifyCustomerInput, data: Record<string, unknown>) {
    if (!isServiceCaseNotification(input.eventType)) {
      return {};
    }

    const now = new Date();
    const statusText = serviceCaseStatusText(data.status);
    return {
      character_string2: stringValue(data.aggregateNo),
      const3: serviceCaseTypeText(input.notificationType),
      const4: statusText,
      thing1: truncateWechatThing(input.title || "服务工单更新"),
      time6: formatWechatTime(now)
    };
  }

  private serviceCaseWechatConst4Error(input: {
    data: Record<string, unknown>;
    notificationType: NotificationType;
  }) {
    if (
      input.notificationType !== NotificationType.SERVICE_CASE_UPDATE &&
      input.notificationType !== NotificationType.RESCUE_UPDATE
    ) {
      return null;
    }
    const value = stringValue(input.data.const4);
    if (!value || this.wechatServiceCaseStatusConst4Allowlist.includes(value)) {
      return null;
    }
    return `WECHAT_TEMPLATE_CONST4_NOT_APPROVED:${value}`;
  }
}

function toTemplateView(template: Prisma.NotificationTemplateGetPayload<Record<string, never>>) {
  return {
    channel: template.channel,
    content: template.content,
    createdAt: template.createdAt,
    description: template.description,
    providerTemplateId: template.providerTemplateId,
    templateCode: template.templateCode,
    templateId: template.id,
    templateStatus: template.templateStatus,
    templateType: template.templateType,
    title: template.title,
    updatedAt: template.updatedAt,
    variables: template.variables
  };
}

function toRecordView(
  record: Prisma.NotificationRecordGetPayload<{
    include: {
      customer: { select: { customerNo: true; mobile: true; name: true } };
      template: true;
    };
  }>
) {
  return {
    channel: record.channel,
    content: record.content,
    createdAt: record.createdAt,
    customer: record.customer,
    errorMessage: record.errorMessage,
    failedAt: record.failedAt,
    notificationId: record.id,
    notificationNo: record.notificationNo,
    notificationStatus: record.notificationStatus,
    notificationType: record.notificationType,
    providerMessageId: record.providerMessageId,
    readAt: record.readAt,
    recipientOpenIdMasked: record.recipientOpenId ? maskOpenId(record.recipientOpenId) : null,
    recipientPhone: record.recipientPhone,
    sentAt: record.sentAt,
    templateCode: record.templateCode,
    templateTitle: record.template?.title ?? null,
    title: record.title,
    url: record.url
  };
}

function toEventView(
  event: Prisma.NotificationEventGetPayload<{
    include: {
      customer: { select: { customerNo: true; mobile: true; name: true } };
      notification: true;
    };
  }>
) {
  return {
    aggregateId: event.aggregateId,
    aggregateType: event.aggregateType,
    attempts: event.attempts,
    createdAt: event.createdAt,
    customer: event.customer,
    eventId: event.id,
    eventStatus: event.eventStatus,
    eventType: event.eventType,
    lastError: event.lastError,
    notificationNo: event.notification?.notificationNo ?? null,
    processedAt: event.processedAt
  };
}

function toPortalRecordView(record: Prisma.NotificationRecordGetPayload<Record<string, never>>) {
  return {
    channel: record.channel,
    content: record.content,
    createdAt: record.createdAt,
    notificationId: record.id,
    notificationNo: record.notificationNo,
    notificationStatus: record.notificationStatus,
    notificationType: record.notificationType,
    readAt: record.readAt,
    title: record.title,
    url: record.url
  };
}

function normalizePage(value: number | undefined) {
  return Number.isInteger(value) && value && value > 0 ? value : 1;
}

function normalizePageSize(value: number | undefined) {
  return Number.isInteger(value) && value && value > 0 ? Math.min(value, 100) : 20;
}

function normalizePortalUrl(value: string | undefined, portalBaseUrl: string) {
  if (!value?.trim()) {
    return null;
  }
  const trimmed = value.trim();
  if (trimmed.startsWith("http://") || trimmed.startsWith("https://")) {
    return trimmed;
  }
  if (trimmed.startsWith("/") && !trimmed.startsWith("//")) {
    return `${portalBaseUrl}${trimmed}`;
  }
  return `${portalBaseUrl}/portal`;
}

function normalizeProvider(value: string) {
  const normalized = value.toLowerCase().replace(/-/g, "_");
  if (
    normalized === "wechat" ||
    normalized === "wechat_official" ||
    normalized === "wechat_official_account"
  ) {
    return "wechat_official_account";
  }
  return "mock";
}

function trimTrailingSlash(value: string) {
  return value.replace(/\/+$/, "");
}

function parseCsv(value: string | undefined) {
  return (value ?? "")
    .split(/[,\n，]/)
    .map((item) => item.trim())
    .filter(Boolean);
}

function isServiceCaseNotification(eventType: NotificationEventType) {
  return SERVICE_CASE_NOTIFICATION_EVENTS.has(eventType);
}

function serviceCaseTypeText(notificationType: NotificationType) {
  return notificationType === NotificationType.RESCUE_UPDATE ? "救援申请" : "事故报案";
}

function serviceCaseStatusText(value: unknown) {
  const status = stringValue(value);
  return SERVICE_CASE_STATUS_TEXT[status] ?? (status || "已更新");
}

function stringValue(value: unknown) {
  return value === null || value === undefined ? "" : String(value);
}

function truncateWechatThing(value: string) {
  return Array.from(value).slice(0, 20).join("");
}

function formatWechatTime(value: Date) {
  const pad = (part: number) => String(part).padStart(2, "0");
  return `${value.getFullYear()}-${pad(value.getMonth() + 1)}-${pad(value.getDate())} ${pad(value.getHours())}:${pad(value.getMinutes())}`;
}

function toJsonValue(value: unknown): Prisma.InputJsonValue | undefined {
  if (value === undefined) {
    return undefined;
  }
  return JSON.parse(JSON.stringify(value)) as Prisma.InputJsonValue;
}

function errorMessage(error: unknown) {
  return error instanceof Error ? error.message : String(error);
}

function maskOpenId(value: string) {
  if (value.length <= 8) {
    return `${value.slice(0, 2)}****`;
  }
  return `${value.slice(0, 4)}****${value.slice(-4)}`;
}

function stage2NotificationNo(idempotencyKey: string) {
  return `HESR${createHash("sha256").update(idempotencyKey).digest("hex").slice(0, 60)}`;
}

function billNotificationNo(idempotencyKey: string, channel: "IN_APP" | "WECHAT") {
  return `BLN${createHash("sha256")
    .update(`${idempotencyKey}:${channel}`)
    .digest("hex")
    .slice(0, 61)}`;
}

function billNotificationEventId(idempotencyKey: string) {
  const hex = createHash("sha256")
    .update(`bill-notification-event:${idempotencyKey}`)
    .digest("hex")
    .slice(0, 32)
    .split("");
  hex[12] = "4";
  hex[16] = ((Number.parseInt(hex[16]!, 16) & 0x3) | 0x8).toString(16);
  const value = hex.join("");
  return `${value.slice(0, 8)}-${value.slice(8, 12)}-${value.slice(
    12,
    16
  )}-${value.slice(16, 20)}-${value.slice(20)}`;
}

function isUniqueConflict(error: unknown) {
  return (
    typeof error === "object" && error !== null && (error as { code?: unknown }).code === "P2002"
  );
}
