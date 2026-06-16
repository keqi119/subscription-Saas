import {
  BadRequestException,
  ForbiddenException,
  Inject,
  Injectable,
  NotFoundException
} from "@nestjs/common";
import { ConfigService } from "@nestjs/config";
import {
  AuditAction,
  ContractStatus,
  ESignProviderType,
  ESignSignerStatus,
  ESignSignerType,
  ESignTaskStatus,
  OrderStatus,
  Prisma
} from "@prisma/client";

import { AuditService } from "../audit/audit.service";
import { RequestContext, RequestUser } from "../auth/auth.types";
import { createBusinessNo, withUniqueBusinessNoRetry } from "../common/business-number";
import { PrismaService } from "../prisma/prisma.service";
import { CurrentCustomer, PortalRequestContext } from "../portal/portal-auth.types";
import { ESIGN_PROVIDER_CLIENT, ESignProvider } from "./esign.provider";

const contractForESignInclude = {
  customer: { select: { id: true, mobile: true, name: true } },
  esignTasks: {
    include: {
      signers: {
        orderBy: { createdAt: "asc" as const },
        where: { deletedAt: null }
      }
    },
    orderBy: { createdAt: "desc" as const },
    where: { deletedAt: null }
  },
  order: {
    include: {
      application: { select: { applicationNo: true, id: true, salesUserId: true } },
      quote: { select: { id: true, quoteNo: true } },
      vehicle: true
    }
  }
} satisfies Prisma.ContractInclude;

const esignTaskInclude = {
  callbacks: {
    orderBy: { receivedAt: "desc" as const },
    take: 10
  },
  contract: {
    include: {
      customer: { select: { id: true, mobile: true, name: true } },
      order: {
        include: {
          application: { select: { applicationNo: true, id: true, salesUserId: true } },
          quote: { select: { id: true, quoteNo: true } },
          vehicle: true
        }
      }
    }
  },
  signers: {
    orderBy: { createdAt: "asc" as const },
    where: { deletedAt: null }
  }
} satisfies Prisma.ContractESignTaskInclude;

type ContractForESign = Prisma.ContractGetPayload<{ include: typeof contractForESignInclude }>;
type ESignTaskWithDetails = Prisma.ContractESignTaskGetPayload<{ include: typeof esignTaskInclude }>;

const ACTIVE_ESIGN_TASK_STATUSES: ESignTaskStatus[] = [
  ESignTaskStatus.CREATED,
  ESignTaskStatus.WAITING_CUSTOMER,
  ESignTaskStatus.SIGNING,
  ESignTaskStatus.COMPLETED
];

const SIGNABLE_CONTRACT_STATUSES: ContractStatus[] = [
  ContractStatus.GENERATED,
  ContractStatus.SIGNING
];

const BLOCKED_COMPLETE_ESIGN_TASK_STATUSES: ESignTaskStatus[] = [
  ESignTaskStatus.CANCELLED,
  ESignTaskStatus.FAILED,
  ESignTaskStatus.EXPIRED
];

const PORTAL_SIGNABLE_ESIGN_TASK_STATUSES: ESignTaskStatus[] = [
  ESignTaskStatus.CREATED,
  ESignTaskStatus.WAITING_CUSTOMER,
  ESignTaskStatus.SIGNING
];

const CALLBACK_COMPLETED_EVENTS = new Set([
  "COMPLETED",
  "SIGN_COMPLETED",
  "SIGNATURE_COMPLETED",
  "TASK_COMPLETED",
  "MOCK_SIGN_COMPLETED",
  "mock.sign.completed"
]);

@Injectable()
export class ESignService {
  constructor(
    private readonly auditService: AuditService,
    private readonly configService: ConfigService,
    @Inject(ESIGN_PROVIDER_CLIENT)
    private readonly provider: ESignProvider,
    private readonly prisma: PrismaService
  ) {}

  async createTaskForContract(contractId: string, user: RequestUser, context: RequestContext) {
    const contract = await this.findContractForESign(contractId);
    this.assertContractCanStartESign(contract);

    const existingTask = contract.esignTasks.find((task) =>
      ACTIVE_ESIGN_TASK_STATUSES.includes(task.taskStatus)
    );
    if (existingTask) {
      const task = await this.findTaskOrThrow(existingTask.id);
      return toESignTaskView(task);
    }

    const documentName = contract.contractTitle || `合同 ${contract.contractNo}`;
    const requestSnapshot = toJsonValue({
      contractId: contract.id,
      contractNo: contract.contractNo,
      customerId: contract.customerId,
      documentName,
      orderId: contract.orderId,
      orderNo: contract.order.orderNo,
      provider: this.providerType
    });

    const task = await withUniqueBusinessNoRetry(() =>
      this.prisma.contractESignTask.create({
        data: {
          contractId: contract.id,
          createdBy: user.id,
          customerId: contract.customerId,
          documentName,
          orderId: contract.orderId,
          provider: this.providerType,
          requestSnapshot,
          signers: {
            create: [{
              customerId: contract.customerId,
              signerName: contract.customer.name,
              signerPhone: contract.customer.mobile,
              signerStatus: ESignSignerStatus.PENDING,
              signerType: ESignSignerType.CUSTOMER,
              snapshot: toJsonValue({
                customerId: contract.customerId,
                mobileMasked: maskPhone(contract.customer.mobile),
                name: contract.customer.name
              })
            }]
          },
          taskNo: createBusinessNo("ESG"),
          taskStatus: ESignTaskStatus.CREATED,
          updatedBy: user.id
        },
        include: esignTaskInclude
      })
    );

    try {
      const providerResult = await this.provider.createSignTask({
        callbackUrl: this.buildCallbackUrl(),
        contractId: contract.id,
        documentName,
        redirectUrl: this.buildPortalContractUrl(contract.id),
        signers: [{
          customerId: contract.customerId,
          name: contract.customer.name,
          phone: contract.customer.mobile,
          signerType: "CUSTOMER"
        }],
        taskId: task.id,
        taskNo: task.taskNo
      });

      const updated = await this.prisma.$transaction(async (tx) => {
        await tx.contractESignTask.update({
          data: {
            providerEnvelopeId: providerResult.providerEnvelopeId,
            providerTaskId: providerResult.providerTaskId,
            responseSnapshot: toJsonValue(providerResult.rawResponse ?? providerResult),
            signUrl: providerResult.signUrl,
            signUrlExpiresAt: providerResult.signUrlExpiresAt,
            startedAt: new Date(),
            taskStatus: ESignTaskStatus.WAITING_CUSTOMER,
            updatedBy: user.id
          },
          where: { id: task.id }
        });
        await tx.contractESignSigner.updateMany({
          data: {
            signUrl: providerResult.signUrl,
            signUrlExpiresAt: providerResult.signUrlExpiresAt,
            signerStatus: providerResult.signUrl ? ESignSignerStatus.SIGNING : ESignSignerStatus.PENDING
          },
          where: { deletedAt: null, signerType: ESignSignerType.CUSTOMER, taskId: task.id }
        });
        if (contract.status === ContractStatus.GENERATED) {
          await tx.contract.update({
            data: { status: ContractStatus.SIGNING, updatedBy: user.id },
            where: { id: contract.id }
          });
        }
        return tx.contractESignTask.findUniqueOrThrow({
          include: esignTaskInclude,
          where: { id: task.id }
        });
      });

      await this.auditService.write({
        action: AuditAction.CREATE,
        after: toESignTaskView(updated),
        entityId: updated.id,
        entityType: "contract_esign_task",
        ipAddress: context.ipAddress,
        module: "esign",
        operatorId: user.id,
        userAgent: context.userAgent
      });

      return toESignTaskView(updated);
    } catch (error) {
      await this.prisma.contractESignTask.update({
        data: {
          errorSnapshot: toJsonValue({ message: error instanceof Error ? error.message : String(error) }),
          failedAt: new Date(),
          taskStatus: ESignTaskStatus.FAILED,
          updatedBy: user.id
        },
        where: { id: task.id }
      });
      throw error;
    }
  }

  async listTasksForContract(contractId: string, user: RequestUser) {
    const contract = await this.findContractForESign(contractId);
    ensureCanAccessContractByOwner(contract, user);
    const tasks = await this.prisma.contractESignTask.findMany({
      include: esignTaskInclude,
      orderBy: { createdAt: "desc" },
      where: { contractId, deletedAt: null }
    });
    return tasks.map(toESignTaskView);
  }

  async getTask(id: string, user: RequestUser) {
    const task = await this.findTaskOrThrow(id);
    ensureCanAccessContractByOwner(task.contract, user);
    return toESignTaskView(task);
  }

  async listPortalContracts(currentCustomer: CurrentCustomer) {
    const contracts = await this.prisma.contract.findMany({
      include: contractForESignInclude,
      orderBy: { createdAt: "desc" },
      where: {
        customerId: currentCustomer.customerId,
        deletedAt: null
      }
    });

    return contracts.map(toPortalContractListItem);
  }

  async getPortalContract(id: string, currentCustomer: CurrentCustomer) {
    const contract = await this.findPortalContractOrThrow(id, currentCustomer.customerId);
    return toPortalContractDetail(contract);
  }

  async startPortalSigning(id: string, currentCustomer: CurrentCustomer) {
    const contract = await this.findPortalContractOrThrow(id, currentCustomer.customerId);
    const task = findCurrentPortalSigningTask(contract);

    if (!task) {
      throw new BadRequestException("合同尚未发起电子签，请等待平台处理。");
    }
    if (task.taskStatus === ESignTaskStatus.COMPLETED) {
      throw new BadRequestException("合同已签署完成。");
    }

    let signUrl = task.signUrl;
    let signUrlExpiresAt = task.signUrlExpiresAt;
    if (!signUrl || isExpired(signUrlExpiresAt)) {
      const refreshed = await this.provider.getSignerUrl({
        contractId: contract.id,
        providerTaskId: task.providerTaskId ?? task.taskNo,
        redirectUrl: this.buildPortalContractUrl(contract.id),
        taskId: task.id
      });
      signUrl = refreshed.signUrl;
      signUrlExpiresAt = refreshed.expiresAt ?? null;
      await this.prisma.$transaction([
        this.prisma.contractESignTask.update({
          data: {
            signUrl,
            signUrlExpiresAt,
            taskStatus: ESignTaskStatus.SIGNING
          },
          where: { id: task.id }
        }),
        this.prisma.contractESignSigner.updateMany({
          data: {
            signUrl,
            signUrlExpiresAt,
            signerStatus: ESignSignerStatus.SIGNING
          },
          where: { deletedAt: null, signerType: ESignSignerType.CUSTOMER, taskId: task.id }
        })
      ]);
    }

    return {
      expiresAt: signUrlExpiresAt,
      mock: task.provider === ESignProviderType.MOCK,
      provider: task.provider,
      signUrl,
      taskId: task.id,
      taskStatus: task.taskStatus
    };
  }

  async mockSignTask(taskId: string, currentCustomer: CurrentCustomer, context: PortalRequestContext) {
    if (this.providerType !== ESignProviderType.MOCK || !this.isMockEnabled()) {
      throw new ForbiddenException("当前环境未开启 Mock 电子签署。");
    }

    const task = await this.findTaskOrThrow(taskId);
    ensureTaskOwnedByCustomer(task, currentCustomer.customerId);

    const completed = await this.completeTask(task.id, {
      actorId: currentCustomer.customerAccountId,
      callbackPayload: {
        eventType: "mock.sign.completed",
        providerTaskId: task.providerTaskId,
        taskId: task.id
      },
      context,
      eventType: "mock.sign.completed",
      providerTaskId: task.providerTaskId,
      source: "portal_mock"
    });

    return {
      contract: toPortalContractDetail(await this.findPortalContractOrThrow(completed.contractId, currentCustomer.customerId)),
      task: toESignTaskView(completed)
    };
  }

  async handleCallback(providerParam: string, payload: unknown, headers?: Record<string, unknown>) {
    const provider = parseProvider(providerParam);
    const verified = await this.provider.verifyCallback(payload, headers);
    const record = asRecord(verified.payload);
    const providerTaskId =
      verified.providerTaskId ??
      stringOrNull(record.providerTaskId) ??
      stringOrNull(record.taskNo);
    const eventType = verified.eventType ?? stringOrNull(record.eventType);
    const task = providerTaskId
      ? await this.prisma.contractESignTask.findFirst({
          include: esignTaskInclude,
          where: {
            deletedAt: null,
            provider,
            providerTaskId
          }
        })
      : null;

    const callbackLog = await this.prisma.contractESignCallbackLog.create({
      data: {
        eventType,
        payload: toJsonValue(verified.payload),
        provider,
        providerTaskId,
        taskId: task?.id,
        verified: verified.verified
      }
    });

    if (!verified.verified) {
      await this.prisma.contractESignCallbackLog.update({
        data: {
          errorMessage: "电子签回调验签失败。",
          handled: true,
          handledAt: new Date()
        },
        where: { id: callbackLog.id }
      });
      return { handled: false, reason: "UNVERIFIED" };
    }

    if (!task) {
      await this.prisma.contractESignCallbackLog.update({
        data: {
          errorMessage: "未找到对应电子签任务。",
          handled: true,
          handledAt: new Date()
        },
        where: { id: callbackLog.id }
      });
      return { handled: false, reason: "TASK_NOT_FOUND" };
    }

    if (eventType && CALLBACK_COMPLETED_EVENTS.has(eventType)) {
      const completed = await this.completeTask(task.id, {
        callbackLogId: callbackLog.id,
        callbackPayload: verified.payload,
        eventType,
        providerTaskId,
        source: "provider_callback"
      });
      return {
        handled: true,
        task: toESignTaskView(completed)
      };
    }

    await this.prisma.contractESignCallbackLog.update({
      data: {
        handled: true,
        handledAt: new Date()
      },
      where: { id: callbackLog.id }
    });

    return { handled: true };
  }

  private async completeTask(taskId: string, options: {
    actorId?: string;
    callbackLogId?: string;
    callbackPayload?: unknown;
    context?: PortalRequestContext;
    eventType?: string;
    providerTaskId?: string | null;
    source: "portal_mock" | "provider_callback";
  }) {
    const now = new Date();

    const result = await this.prisma.$transaction(async (tx) => {
      const task = await tx.contractESignTask.findUnique({
        include: esignTaskInclude,
        where: { id: taskId }
      });

      if (!task || task.deletedAt) {
        throw new NotFoundException("电子签任务不存在。");
      }

      if (task.taskStatus === ESignTaskStatus.COMPLETED) {
        if (options.callbackLogId) {
          await tx.contractESignCallbackLog.update({
            data: {
              handled: true,
              handledAt: now
            },
            where: { id: options.callbackLogId }
          });
        }
        return tx.contractESignTask.findUniqueOrThrow({
          include: esignTaskInclude,
          where: { id: task.id }
        });
      }

      if (BLOCKED_COMPLETE_ESIGN_TASK_STATUSES.includes(task.taskStatus)) {
        throw new BadRequestException("当前电子签任务状态不允许签署完成。");
      }

      await tx.contractESignSigner.updateMany({
        data: {
          signedAt: now,
          signerStatus: ESignSignerStatus.SIGNED
        },
        where: {
          deletedAt: null,
          signerType: ESignSignerType.CUSTOMER,
          taskId: task.id
        }
      });
      await tx.contractESignTask.update({
        data: {
          callbackSnapshot: options.callbackPayload === undefined ? undefined : toJsonValue(options.callbackPayload),
          completedAt: now,
          taskStatus: ESignTaskStatus.COMPLETED,
          updatedBy: options.actorId
        },
        where: { id: task.id }
      });
      await tx.contract.update({
        data: {
          signedAt: task.contract.signedAt ?? now,
          status: ContractStatus.SIGNED,
          updatedBy: options.actorId
        },
        where: { id: task.contractId }
      });
      await tx.subscriptionOrder.updateMany({
        data: {
          orderStatus: OrderStatus.PENDING_PAYMENT,
          updatedBy: options.actorId
        },
        where: {
          contractId: task.contractId,
          deletedAt: null,
          id: task.orderId ?? task.contract.orderId,
          orderStatus: OrderStatus.PENDING_SIGN
        }
      });
      if (options.callbackLogId) {
        await tx.contractESignCallbackLog.update({
          data: {
            handled: true,
            handledAt: now,
            taskId: task.id
          },
          where: { id: options.callbackLogId }
        });
      } else {
        await tx.contractESignCallbackLog.create({
          data: {
            eventType: options.eventType,
            handled: true,
            handledAt: now,
            payload: options.callbackPayload === undefined ? undefined : toJsonValue(options.callbackPayload),
            provider: task.provider,
            providerTaskId: options.providerTaskId ?? task.providerTaskId,
            taskId: task.id,
            verified: true
          }
        });
      }

      return tx.contractESignTask.findUniqueOrThrow({
        include: esignTaskInclude,
        where: { id: task.id }
      });
    });

    await this.auditService.write({
      action: AuditAction.APPROVE,
      after: toESignTaskView(result),
      entityId: result.id,
      entityType: "contract_esign_task",
      ipAddress: options.context?.ipAddress,
      module: "esign",
      operatorId: options.actorId,
      userAgent: options.context?.userAgent
    });

    return result;
  }

  private assertContractCanStartESign(contract: ContractForESign) {
    if (contract.deletedAt) {
      throw new NotFoundException("合同不存在。");
    }
    if (!SIGNABLE_CONTRACT_STATUSES.includes(contract.status)) {
      throw new BadRequestException("当前合同状态不允许发起电子签。");
    }
    if (!contract.order || contract.order.deletedAt) {
      throw new BadRequestException("合同所属订单无效。");
    }
    if (contract.order.contractId !== contract.id) {
      throw new BadRequestException("当前合同不是订单的当前有效合同。");
    }
  }

  private async findContractForESign(id: string) {
    const contract = await this.prisma.contract.findFirst({
      include: contractForESignInclude,
      where: {
        deletedAt: null,
        id
      }
    });

    if (!contract) {
      throw new NotFoundException("合同不存在。");
    }

    return contract;
  }

  private async findPortalContractOrThrow(id: string, customerId: string) {
    const contract = await this.prisma.contract.findFirst({
      include: contractForESignInclude,
      where: {
        customerId,
        deletedAt: null,
        id
      }
    });

    if (!contract) {
      throw new NotFoundException("合同不存在。");
    }

    return contract;
  }

  private async findTaskOrThrow(id: string) {
    const task = await this.prisma.contractESignTask.findFirst({
      include: esignTaskInclude,
      where: {
        deletedAt: null,
        id
      }
    });

    if (!task) {
      throw new NotFoundException("电子签任务不存在。");
    }

    return task;
  }

  private buildCallbackUrl() {
    const apiBaseUrl = trimTrailingSlash(
      this.configService.get<string>("API_BASE_URL") ?? "http://localhost:3001/api"
    );
    return `${apiBaseUrl}/esign/callback/${this.providerType.toLowerCase()}`;
  }

  private buildPortalContractUrl(contractId: string) {
    const portalBaseUrl = trimTrailingSlash(
      this.configService.get<string>("PORTAL_BASE_URL") ?? "http://localhost:3000"
    );
    return `${portalBaseUrl}/portal/contracts/${encodeURIComponent(contractId)}`;
  }

  private get providerType() {
    return parseProvider(this.configService.get<string>("ESIGN_PROVIDER") ?? "mock");
  }

  private isMockEnabled() {
    return (this.configService.get<string>("ESIGN_MOCK_ENABLED") ?? "true").toLowerCase() === "true";
  }
}

function findCurrentPortalSigningTask(contract: ContractForESign) {
  return contract.esignTasks.find((task) =>
    ACTIVE_ESIGN_TASK_STATUSES.includes(task.taskStatus)
  );
}

function ensureTaskOwnedByCustomer(task: ESignTaskWithDetails, customerId: string) {
  if (task.customerId !== customerId || task.contract.customerId !== customerId) {
    throw new NotFoundException("电子签任务不存在。");
  }
}

function ensureCanAccessContractByOwner(
  contract: ContractForESign | ESignTaskWithDetails["contract"],
  user: RequestUser
) {
  if (canViewAllOrders(user)) {
    return;
  }
  if (contract.order.application.salesUserId !== user.id) {
    throw new NotFoundException("合同不存在。");
  }
}

function canViewAllOrders(user: RequestUser) {
  return user.roles.includes("admin") || user.permissions.includes("order:view:all");
}

function toESignTaskView(task: ESignTaskWithDetails) {
  return {
    callbacks: task.callbacks.map((callback) => ({
      eventType: callback.eventType,
      handled: callback.handled,
      id: callback.id,
      providerTaskId: callback.providerTaskId,
      receivedAt: callback.receivedAt,
      verified: callback.verified
    })),
    completedAt: task.completedAt,
    contractId: task.contractId,
    contractNo: task.contract.contractNo,
    createdAt: task.createdAt,
    customerId: task.customerId,
    documentName: task.documentName,
    id: task.id,
    orderId: task.orderId,
    provider: task.provider,
    providerTaskId: task.providerTaskId,
    signUrl: task.signUrl,
    signUrlExpiresAt: task.signUrlExpiresAt,
    signers: task.signers.map((signer) => ({
      customerId: signer.customerId,
      id: signer.id,
      signedAt: signer.signedAt,
      signerName: signer.signerName,
      signerPhone: signer.signerPhone ? maskPhone(signer.signerPhone) : null,
      signerStatus: signer.signerStatus,
      signerType: signer.signerType
    })),
    startedAt: task.startedAt,
    taskNo: task.taskNo,
    taskStatus: task.taskStatus
  };
}

function toPortalContractListItem(contract: ContractForESign) {
  const task = findCurrentPortalSigningTask(contract);
  return {
    contractNo: contract.contractNo,
    contractStatus: contract.status,
    createdAt: contract.createdAt,
    id: contract.id,
    orderNo: contract.order.orderNo,
    signedAt: contract.signedAt,
    signStatus: task?.taskStatus ?? null
  };
}

function toPortalContractDetail(contract: ContractForESign) {
  const task = findCurrentPortalSigningTask(contract);
  return {
    ...toPortalContractListItem(contract),
    canSign: Boolean(task && PORTAL_SIGNABLE_ESIGN_TASK_STATUSES.includes(task.taskStatus)),
    customer: {
      mobile: maskPhone(contract.customer.mobile),
      name: contract.customer.name
    },
    order: {
      id: contract.order.id,
      orderNo: contract.order.orderNo,
      orderStatus: contract.order.orderStatus
    },
    signTask: task
      ? {
          completedAt: task.completedAt,
          id: task.id,
          provider: task.provider,
          signers: task.signers.map((signer) => ({
            signedAt: signer.signedAt,
            signerName: signer.signerName,
            signerPhone: signer.signerPhone ? maskPhone(signer.signerPhone) : null,
            signerStatus: signer.signerStatus,
            signerType: signer.signerType
          })),
          signUrlExpiresAt: task.signUrlExpiresAt,
          taskNo: task.taskNo,
          taskStatus: task.taskStatus
        }
      : null,
    vehicle: toPortalVehicleSummary(contract.order.vehicle)
  };
}

function toPortalVehicleSummary(vehicle: ContractForESign["order"]["vehicle"]) {
  if (!vehicle) {
    return null;
  }

  return {
    batteryCapacityKwh: vehicle.batteryCapacityKwh === null ? null : Number(vehicle.batteryCapacityKwh),
    batteryUsageType: vehicle.batteryUsageType,
    brand: vehicle.brand,
    city: vehicle.assetLocation,
    currentMileageKm: vehicle.currentMileageKm,
    displayName: [vehicle.brand, vehicle.series, vehicle.vehicleModel, vehicle.modelYear ? `${vehicle.modelYear}款` : null]
      .filter(Boolean)
      .join(" "),
    model: vehicle.vehicleModel,
    modelYear: vehicle.modelYear,
    series: vehicle.series
  };
}

function isExpired(value?: Date | null) {
  return !value || value.getTime() <= Date.now();
}

function parseProvider(value: string) {
  const normalized = value.trim().toUpperCase();
  if (normalized === "MOCK") {
    return ESignProviderType.MOCK;
  }
  if (normalized === "FADADA") {
    return ESignProviderType.FADADA;
  }
  if (normalized === "ESIGN") {
    return ESignProviderType.ESIGN;
  }
  if (normalized === "TENCENT_ESIGN") {
    return ESignProviderType.TENCENT_ESIGN;
  }
  if (normalized === "OTHER") {
    return ESignProviderType.OTHER;
  }
  throw new BadRequestException("不支持的电子签 provider。");
}

function trimTrailingSlash(value: string) {
  return value.replace(/\/+$/, "");
}

function asRecord(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
}

function stringOrNull(value: unknown) {
  return typeof value === "string" && value.trim() ? value : null;
}

function maskPhone(phone: string) {
  return phone.replace(/^(\d{3})\d{4}(\d{4})$/, "$1****$2");
}

function toJsonValue(value: unknown): Prisma.InputJsonValue {
  return toPlain(value) as Prisma.InputJsonValue;
}

function toPlain(value: unknown): unknown {
  if (value === null || value === undefined) {
    return value;
  }
  if (typeof value === "bigint") {
    return Number(value);
  }
  if (value instanceof Date) {
    return value.toISOString();
  }
  if (value instanceof Prisma.Decimal) {
    return Number(value);
  }
  if (Array.isArray(value)) {
    return value.map(toPlain);
  }
  if (typeof value === "object") {
    return Object.fromEntries(Object.entries(value).map(([key, item]) => [key, toPlain(item)]));
  }
  return value;
}
