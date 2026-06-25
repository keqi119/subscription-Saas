import { BadRequestException, ForbiddenException, NotFoundException } from "@nestjs/common";
import { ConfigService } from "@nestjs/config";
import {
  ContractStatus,
  CustomerAccountStatus,
  ESignProviderType,
  ESignSignerStatus,
  ESignSignerType,
  ESignTaskStatus,
  OrderStatus
} from "@prisma/client";
import { describe, expect, it, vi } from "vitest";

import { RequestUser } from "../src/auth/auth.types";
import { ESignProvider } from "../src/esign/esign.provider";
import { ESignService } from "../src/esign/esign.service";
import { MockESignProvider } from "../src/esign/mock-esign.provider";
import { CurrentCustomer } from "../src/portal/portal-auth.types";

describe("ESignService", () => {
  it("creates a mock e-sign task for a generated contract", async () => {
    const { service, state } = createESignFixture();

    const result = await service.createTaskForContract("contract-1", adminUser(), requestContext());

    expect(result).toMatchObject({
      contractId: "contract-1",
      provider: ESignProviderType.MOCK,
      taskStatus: ESignTaskStatus.WAITING_CUSTOMER
    });
    expect(result.providerTaskId).toMatch(/^mock_ESG/);
    expect(state.contracts[0]!.status).toBe(ContractStatus.SIGNING);
    expect(state.tasks).toHaveLength(1);
    expect(state.signers[0]).toMatchObject({
      signerStatus: ESignSignerStatus.SIGNING,
      signerType: ESignSignerType.CUSTOMER
    });
  });

  it("persists provider signer identifiers and sign URLs from a Fadada provider result", async () => {
    const signUrlExpiresAt = new Date("2026-01-02T03:34:05.000Z");
    const provider: ESignProvider = {
      createSignTask: vi.fn(async () => ({
        documentObjectKey: "contracts/contract-1.pdf",
        providerEnvelopeId: "ESG-1",
        providerTaskId: "ESG-1-1",
        rawResponse: { provider: "fadada" },
        signUrl: "https://sign.example.test/customer",
        signUrlExpiresAt,
        signers: [{
          customerId: "customer-1",
          providerSignerId: "ESG-1-1",
          signUrl: "https://sign.example.test/customer",
          signUrlExpiresAt,
          signerType: "CUSTOMER" as const
        }]
      })),
      getSignerUrl: vi.fn(),
      verifyCallback: vi.fn()
    };
    const { service, state } = createESignFixture({ ESIGN_PROVIDER: "fadada" }, provider);

    const result = await service.createTaskForContract("contract-1", adminUser(), requestContext());

    expect(result).toMatchObject({
      provider: ESignProviderType.FADADA,
      providerTaskId: "ESG-1-1",
      signUrl: "https://sign.example.test/customer"
    });
    expect(state.tasks[0]).toMatchObject({
      documentObjectKey: "contracts/contract-1.pdf",
      providerEnvelopeId: "ESG-1",
      providerTaskId: "ESG-1-1",
      signUrl: "https://sign.example.test/customer"
    });
    expect(state.signers[0]).toMatchObject({
      providerSignerId: "ESG-1-1",
      signerStatus: ESignSignerStatus.SIGNING,
      signUrl: "https://sign.example.test/customer"
    });
  });

  it("returns the existing active task instead of creating duplicates", async () => {
    const { service, state } = createESignFixture();

    const first = await service.createTaskForContract("contract-1", adminUser(), requestContext());
    const second = await service.createTaskForContract("contract-1", adminUser(), requestContext());

    expect(second.id).toBe(first.id);
    expect(state.tasks).toHaveLength(1);
  });

  it("lists and reads only contracts owned by the portal customer", async () => {
    const { service } = createESignFixture();

    const ownContracts = await service.listPortalContracts(currentCustomer("customer-1"));

    expect(ownContracts).toHaveLength(1);
    expect(ownContracts[0]).toMatchObject({ id: "contract-1", orderNo: "ORD-1" });
    await expect(service.getPortalContract("contract-2", currentCustomer("customer-1"))).rejects.toBeInstanceOf(
      NotFoundException
    );
  });

  it("returns a portal signing link for the current customer's active task", async () => {
    const { service } = createESignFixture();
    await service.createTaskForContract("contract-1", adminUser(), requestContext());

    const result = await service.startPortalSigning("contract-1", currentCustomer("customer-1"));

    expect(result.mock).toBe(true);
    expect(result.signUrl).toContain("/portal/contracts/contract-1/sign?taskId=");
    await expect(service.startPortalSigning("contract-1", currentCustomer("customer-2"))).rejects.toBeInstanceOf(
      NotFoundException
    );
  });

  it("mock-sign completes signer, task, contract, order and callback log", async () => {
    const { service, state } = createESignFixture();
    const task = await service.createTaskForContract("contract-1", adminUser(), requestContext());

    const result = await service.mockSignTask(task.id, currentCustomer("customer-1"), requestContext());

    expect(result.task.taskStatus).toBe(ESignTaskStatus.COMPLETED);
    expect(state.signers[0]!.signerStatus).toBe(ESignSignerStatus.SIGNED);
    expect(state.contracts[0]!.status).toBe(ContractStatus.SIGNED);
    expect(state.contracts[0]!.order.orderStatus).toBe(OrderStatus.PENDING_PAYMENT);
    expect(state.callbackLogs).toHaveLength(1);
    expect(state.callbackLogs[0]).toMatchObject({
      handled: true,
      verified: true
    });
  });

  it("rejects mock-sign when mock provider is not enabled", async () => {
    const { service } = createESignFixture({
      ESIGN_MOCK_ENABLED: "false",
      ESIGN_PROVIDER: "esign"
    });
    const task = await createESignFixture().service.createTaskForContract("contract-1", adminUser(), requestContext());

    await expect(service.mockSignTask(task.id, currentCustomer("customer-1"), requestContext())).rejects.toBeInstanceOf(
      ForbiddenException
    );
  });

  it("handles completed callbacks idempotently", async () => {
    const { service, state } = createESignFixture();
    const task = await service.createTaskForContract("contract-1", adminUser(), requestContext());

    const first = await service.handleCallback("mock", {
      eventType: "SIGN_COMPLETED",
      providerTaskId: task.providerTaskId
    });
    const second = await service.handleCallback("mock", {
      eventType: "SIGN_COMPLETED",
      providerTaskId: task.providerTaskId
    });

    expect(first).toMatchObject({ handled: true });
    expect(second).toMatchObject({ handled: true });
    expect(state.tasks[0]!.taskStatus).toBe(ESignTaskStatus.COMPLETED);
    expect(state.contracts[0]!.status).toBe(ContractStatus.SIGNED);
    expect(state.callbackLogs).toHaveLength(2);
    expect(state.callbackLogs.every((log) => log.handled)).toBe(true);
  });

  it("requires a signable contract status before creating a task", async () => {
    const { service, state } = createESignFixture();
    state.contracts[0]!.status = ContractStatus.SIGNED;

    await expect(service.createTaskForContract("contract-1", adminUser(), requestContext())).rejects.toBeInstanceOf(
      BadRequestException
    );
  });
});

function createESignFixture(env: Record<string, string> = {}, providerOverride?: ESignProvider) {
  const state = {
    callbackLogs: [] as FakeCallbackLog[],
    contracts: [
      createContract("contract-1", "customer-1", "order-1", "ORD-1"),
      createContract("contract-2", "customer-2", "order-2", "ORD-2")
    ],
    signers: [] as FakeSigner[],
    tasks: [] as FakeTask[]
  };

  const prisma = {
    $transaction: vi.fn(async (input: unknown) => {
      if (typeof input === "function") {
        return (input as (tx: typeof prisma) => unknown)(prisma);
      }
      return Promise.all(input as Array<Promise<unknown>>);
    }),
    contract: {
      findFirst: vi.fn(async ({ where }: { where: Record<string, unknown> }) => {
        const contract = state.contracts.find((item) =>
          matchesWhere(item, where) &&
          (where.customerId === undefined || item.customerId === where.customerId)
        );
        return contract ? hydrateContract(state, contract) : null;
      }),
      findMany: vi.fn(async ({ where }: { where: Record<string, unknown> }) =>
        state.contracts
          .filter((contract) =>
            matchesWhere(contract, where) &&
            (where.customerId === undefined || contract.customerId === where.customerId)
          )
          .map((contract) => hydrateContract(state, contract))
      ),
      update: vi.fn(async ({ data, where }: { data: Record<string, unknown>; where: { id: string } }) => {
        const contract = state.contracts.find((item) => item.id === where.id);
        if (!contract) {
          throw new Error("contract not found");
        }
        Object.assign(contract, data);
        return hydrateContract(state, contract);
      })
    },
    contractESignCallbackLog: {
      create: vi.fn(async ({ data }: { data: Record<string, unknown> }) => {
        const log: FakeCallbackLog = {
          errorMessage: null,
          eventType: (data.eventType as string | null | undefined) ?? null,
          handled: Boolean(data.handled),
          handledAt: (data.handledAt as Date | null | undefined) ?? null,
          id: `callback-${state.callbackLogs.length + 1}`,
          payload: data.payload,
          provider: data.provider as ESignProviderType,
          providerTaskId: (data.providerTaskId as string | null | undefined) ?? null,
          receivedAt: new Date(),
          taskId: (data.taskId as string | null | undefined) ?? null,
          verified: Boolean(data.verified)
        };
        state.callbackLogs.push(log);
        return log;
      }),
      update: vi.fn(async ({ data, where }: { data: Record<string, unknown>; where: { id: string } }) => {
        const log = state.callbackLogs.find((item) => item.id === where.id);
        if (!log) {
          throw new Error("callback log not found");
        }
        Object.assign(log, data);
        return log;
      })
    },
    contractESignSigner: {
      updateMany: vi.fn(async ({ data, where }: { data: Record<string, unknown>; where: Record<string, unknown> }) => {
        const rows = state.signers.filter((signer) => matchesWhere(signer, where));
        rows.forEach((signer) => Object.assign(signer, data));
        return { count: rows.length };
      })
    },
    contractESignTask: {
      create: vi.fn(async ({ data }: { data: Record<string, unknown> }) => {
        const task: FakeTask = {
          callbackSnapshot: null,
          cancelledAt: null,
          completedAt: null,
          contractId: data.contractId as string,
          createdAt: new Date(),
          customerId: (data.customerId as string | null | undefined) ?? null,
          deletedAt: null,
          documentName: (data.documentName as string | null | undefined) ?? null,
          errorSnapshot: null,
          evidenceObjectKey: null,
          failedAt: null,
          id: `task-${state.tasks.length + 1}`,
          orderId: (data.orderId as string | null | undefined) ?? null,
          provider: data.provider as ESignProviderType,
          providerEnvelopeId: null,
          providerTaskId: null,
          requestSnapshot: data.requestSnapshot,
          responseSnapshot: null,
          signUrl: null,
          signUrlExpiresAt: null,
          signedDocumentObjectKey: null,
          startedAt: null,
          taskNo: data.taskNo as string,
          taskStatus: data.taskStatus as ESignTaskStatus,
          updatedAt: new Date()
        };
        state.tasks.push(task);
        const signerInputs = ((data.signers as { create?: Array<Record<string, unknown>> } | undefined)?.create ?? []);
        signerInputs.forEach((signerInput) => {
          state.signers.push({
            customerId: (signerInput.customerId as string | null | undefined) ?? null,
            deletedAt: null,
            id: `signer-${state.signers.length + 1}`,
            providerSignerId: null,
            rejectReason: null,
            rejectedAt: null,
            signedAt: null,
            signerIdNoMasked: null,
            signerName: (signerInput.signerName as string | null | undefined) ?? null,
            signerPhone: (signerInput.signerPhone as string | null | undefined) ?? null,
            signerStatus: signerInput.signerStatus as ESignSignerStatus,
            signerType: signerInput.signerType as ESignSignerType,
            signUrl: null,
            signUrlExpiresAt: null,
            snapshot: signerInput.snapshot,
            taskId: task.id
          });
        });
        return hydrateTask(state, task);
      }),
      findFirst: vi.fn(async ({ where }: { where: Record<string, unknown> }) => {
        const task = state.tasks.find((item) => matchesWhere(item, where));
        return task ? hydrateTask(state, task) : null;
      }),
      findMany: vi.fn(async ({ where }: { where: Record<string, unknown> }) =>
        state.tasks.filter((task) => matchesWhere(task, where)).map((task) => hydrateTask(state, task))
      ),
      findUnique: vi.fn(async ({ where }: { where: { id: string } }) => {
        const task = state.tasks.find((item) => item.id === where.id);
        return task ? hydrateTask(state, task) : null;
      }),
      findUniqueOrThrow: vi.fn(async ({ where }: { where: { id: string } }) => {
        const task = state.tasks.find((item) => item.id === where.id);
        if (!task) {
          throw new Error("task not found");
        }
        return hydrateTask(state, task);
      }),
      update: vi.fn(async ({ data, where }: { data: Record<string, unknown>; where: { id: string } }) => {
        const task = state.tasks.find((item) => item.id === where.id);
        if (!task) {
          throw new Error("task not found");
        }
        Object.assign(task, data);
        return hydrateTask(state, task);
      })
    },
    subscriptionOrder: {
      updateMany: vi.fn(async ({ data, where }: { data: Record<string, unknown>; where: Record<string, unknown> }) => {
        const rows = state.contracts
          .map((contract) => contract.order)
          .filter((order) => matchesWhere(order, where));
        rows.forEach((order) => Object.assign(order, data));
        return { count: rows.length };
      })
    }
  };

  const configService = new ConfigService({
    API_BASE_URL: "http://localhost:3001/api",
    ESIGN_MOCK_ENABLED: "true",
    ESIGN_PROVIDER: "mock",
    ESIGN_SIGN_URL_EXPIRES_SECONDS: "1800",
    PORTAL_BASE_URL: "http://localhost:3000",
    ...env
  });
  const auditService = { write: vi.fn(async () => undefined) };
  const service = new ESignService(
    auditService as never,
    configService,
    providerOverride ?? new MockESignProvider(configService),
    prisma as never
  );

  return { auditService, prisma, service, state };
}

function hydrateContract(state: FakeState, contract: FakeContract) {
  return {
    ...contract,
    esignTasks: state.tasks
      .filter((task) => task.contractId === contract.id && !task.deletedAt)
      .map((task) => ({
        ...task,
        signers: state.signers.filter((signer) => signer.taskId === task.id && !signer.deletedAt)
      }))
  };
}

function hydrateTask(state: FakeState, task: FakeTask) {
  const contract = state.contracts.find((item) => item.id === task.contractId);
  if (!contract) {
    throw new Error("contract not found");
  }

  return {
    ...task,
    callbacks: state.callbackLogs
      .filter((log) => log.taskId === task.id)
      .sort((left, right) => right.receivedAt.getTime() - left.receivedAt.getTime()),
    contract,
    signers: state.signers.filter((signer) => signer.taskId === task.id && !signer.deletedAt)
  };
}

function createContract(id: string, customerId: string, orderId: string, orderNo: string): FakeContract {
  return {
    archivedAt: null,
    businessType: "SUBSCRIPTION",
    contractNo: id === "contract-1" ? "CON-1" : "CON-2",
    contractSnapshot: {},
    contractTitle: "订阅合同",
    contractVersionId: "contract-version-1",
    createdAt: new Date(),
    customer: {
      id: customerId,
      mobile: customerId === "customer-1" ? "13800000000" : "13900000000",
      name: customerId === "customer-1" ? "张三" : "李四"
    },
    customerId,
    deletedAt: null,
    fileId: null,
    id,
    order: {
      application: { applicationNo: "APP-1", id: "application-1", salesUserId: "user-sales" },
      contractId: id,
      deletedAt: null,
      id: orderId,
      orderNo,
      orderStatus: OrderStatus.PENDING_SIGN,
      quote: { id: "quote-1", quoteNo: "QUO-1" },
      vehicle: {
        assetLocation: "上海",
        batteryCapacityKwh: 75,
        batteryUsageType: "BUYOUT",
        brand: "NIO",
        currentMileageKm: 1200,
        modelYear: 2025,
        series: "ES6",
        vehicleModel: "ES6"
      }
    },
    orderId,
    signedAt: null,
    status: ContractStatus.GENERATED,
    updatedAt: new Date()
  };
}

function matchesWhere(row: Record<string, unknown>, where: Record<string, unknown>) {
  return Object.entries(where).every(([key, expected]) => {
    if (expected === undefined) {
      return true;
    }
    if (key === "deletedAt" && expected === null) {
      return row.deletedAt === null;
    }
    if (key === "id" || key === "contractId" || key === "customerId" || key === "orderId" || key === "taskId") {
      return row[key] === expected;
    }
    if (key === "provider" || key === "providerTaskId" || key === "taskStatus" || key === "signerType") {
      return row[key] === expected;
    }
    if (key === "orderStatus") {
      return row[key] === expected;
    }
    if (key === "contractId" && row.contractId === expected) {
      return true;
    }
    return true;
  });
}

function adminUser(): RequestUser {
  return {
    id: "user-admin",
    menus: [],
    name: "Admin",
    permissions: ["contract:view", "contract:sign"],
    roles: ["admin"],
    username: "admin"
  };
}

function currentCustomer(customerId: string): CurrentCustomer {
  return {
    accountStatus: CustomerAccountStatus.ACTIVE,
    customerAccountId: customerId === "customer-1" ? "account-1" : "account-2",
    customerId,
    phone: customerId === "customer-1" ? "13800000000" : "13900000000"
  };
}

function requestContext() {
  return {
    ipAddress: "127.0.0.1",
    userAgent: "vitest"
  };
}

interface FakeState {
  callbackLogs: FakeCallbackLog[];
  contracts: FakeContract[];
  signers: FakeSigner[];
  tasks: FakeTask[];
}

interface FakeContract extends Record<string, unknown> {
  archivedAt: Date | null;
  businessType: string;
  contractNo: string;
  contractSnapshot: Record<string, unknown>;
  contractTitle: string;
  contractVersionId: string;
  createdAt: Date;
  customer: { id: string; mobile: string; name: string };
  customerId: string;
  deletedAt: Date | null;
  fileId: string | null;
  id: string;
  order: Record<string, unknown> & {
    contractId: string;
    deletedAt: Date | null;
    id: string;
    orderNo: string;
    orderStatus: OrderStatus;
  };
  orderId: string;
  signedAt: Date | null;
  status: ContractStatus;
  updatedAt: Date;
}

interface FakeTask extends Record<string, unknown> {
  callbackSnapshot: unknown;
  cancelledAt: Date | null;
  completedAt: Date | null;
  contractId: string;
  createdAt: Date;
  customerId: string | null;
  deletedAt: Date | null;
  documentName: string | null;
  errorSnapshot: unknown;
  evidenceObjectKey: string | null;
  failedAt: Date | null;
  id: string;
  orderId: string | null;
  provider: ESignProviderType;
  providerEnvelopeId: string | null;
  providerTaskId: string | null;
  requestSnapshot: unknown;
  responseSnapshot: unknown;
  signUrl: string | null;
  signUrlExpiresAt: Date | null;
  signedDocumentObjectKey: string | null;
  startedAt: Date | null;
  taskNo: string;
  taskStatus: ESignTaskStatus;
  updatedAt: Date;
}

interface FakeSigner extends Record<string, unknown> {
  customerId: string | null;
  deletedAt: Date | null;
  id: string;
  providerSignerId: string | null;
  rejectReason: string | null;
  rejectedAt: Date | null;
  signedAt: Date | null;
  signerIdNoMasked: string | null;
  signerName: string | null;
  signerPhone: string | null;
  signerStatus: ESignSignerStatus;
  signerType: ESignSignerType;
  signUrl: string | null;
  signUrlExpiresAt: Date | null;
  snapshot: unknown;
  taskId: string;
}

interface FakeCallbackLog extends Record<string, unknown> {
  errorMessage: string | null;
  eventType: string | null;
  handled: boolean;
  handledAt: Date | null;
  id: string;
  payload: unknown;
  provider: ESignProviderType;
  providerTaskId: string | null;
  receivedAt: Date;
  taskId: string | null;
  verified: boolean;
}
