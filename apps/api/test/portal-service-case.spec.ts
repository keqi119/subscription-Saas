import {
  BadRequestException,
  NotFoundException
} from "@nestjs/common";
import {
  RescueType,
  ServiceCaseActorType,
  ServiceCaseStatus,
  ServiceCaseType
} from "@prisma/client";
import { Readable } from "node:stream";
import { describe, expect, it, vi } from "vitest";

import { ServiceCaseService } from "../src/service-case/service-case.service";

type AnyRecord = Record<string, any>; // eslint-disable-line @typescript-eslint/no-explicit-any

export interface ServiceCaseHarness {
  addAttachment(input: Partial<AnyRecord>): void;
  addCase(input: Partial<AnyRecord>): void;
  auditService: AnyRecord;
  cases: AnyRecord[];
  notificationService: AnyRecord;
  prisma: AnyRecord;
  service: ServiceCaseService;
  storageService: AnyRecord;
}

describe("portal service cases", () => {
  it("creates an accident report for the current customer without mutating vehicle or billing", async () => {
    const harness = createServiceCaseHarness();

    const result = await harness.service.createPortalServiceCase(
      {
        accidentHasInjury: false,
        accidentPoliceReported: true,
        caseType: ServiceCaseType.ACCIDENT_REPORT,
        description: "右前侧剐蹭",
        orderId: "order-a"
      },
      currentCustomer("customer-a"),
      requestContext()
    );

    expect(result).toMatchObject({
      caseStatus: ServiceCaseStatus.SUBMITTED,
      caseType: ServiceCaseType.ACCIDENT_REPORT,
      order: { orderNo: "ORD-A" },
      vehicle: { displayName: "NIO ES6" }
    });
    expect(harness.prisma.vehicle.update).not.toHaveBeenCalled();
    expect(harness.prisma.receivableBill.create).not.toHaveBeenCalled();
    expect(result.actions[0]).toMatchObject({
      actionType: "SUBMIT",
      actorType: ServiceCaseActorType.CUSTOMER
    });
    expect(harness.notificationService.notifyCustomer).toHaveBeenCalledWith(
      expect.objectContaining({
        aggregateId: result.id,
        eventType: "SERVICE_CASE_SUBMITTED",
        notificationType: "SERVICE_CASE_UPDATE"
      })
    );
  });

  it("creates a rescue request with rescue fields", async () => {
    const harness = createServiceCaseHarness();

    const result = await harness.service.createPortalServiceCase(
      {
        caseType: ServiceCaseType.RESCUE_REQUEST,
        description: "车辆无法启动",
        orderId: "order-a",
        rescueAddress: "上海市浦东新区",
        rescueType: RescueType.TOWING
      },
      currentCustomer("customer-a"),
      requestContext()
    );

    expect(result).toMatchObject({
      caseType: ServiceCaseType.RESCUE_REQUEST,
      rescueAddress: "上海市浦东新区",
      rescueType: RescueType.TOWING
    });
  });

  it("requires the order to belong to the current customer", async () => {
    const harness = createServiceCaseHarness();

    await expect(
      harness.service.createPortalServiceCase(
        {
          caseType: ServiceCaseType.RESCUE_REQUEST,
          orderId: "order-b",
          rescueAddress: "上海市",
          rescueType: RescueType.TOWING
        },
        currentCustomer("customer-a"),
        requestContext()
      )
    ).rejects.toBeInstanceOf(NotFoundException);
  });

  it("validates customer portal service-case type and required fields", async () => {
    const harness = createServiceCaseHarness();

    await expect(
      harness.service.createPortalServiceCase(
        {
          caseType: ServiceCaseType.CUSTOMER_SUPPORT,
          orderId: "order-a"
        },
        currentCustomer("customer-a"),
        requestContext()
      )
    ).rejects.toBeInstanceOf(BadRequestException);

    await expect(
      harness.service.createPortalServiceCase(
        {
          caseType: ServiceCaseType.RESCUE_REQUEST,
          orderId: "order-a"
        },
        currentCustomer("customer-a"),
        requestContext()
      )
    ).rejects.toBeInstanceOf(BadRequestException);
  });

  it("lists and reads only the current customer's service cases", async () => {
    const harness = createServiceCaseHarness();
    harness.addCase({ customerId: "customer-a", id: "case-a", orderId: "order-a" });
    harness.addCase({ customerId: "customer-b", id: "case-b", orderId: "order-b" });

    const list = await harness.service.listPortalServiceCases(currentCustomer("customer-a"), {});

    expect(list.total).toBe(1);
    expect(list.items[0]?.id).toBe("case-a");
    await expect(harness.service.getPortalServiceCase("case-b", currentCustomer("customer-a"))).rejects.toBeInstanceOf(
      NotFoundException
    );
  });

  it("puts waiting-customer cases before processing and history", async () => {
    const harness = createServiceCaseHarness();
    harness.addCase({ id: "closed", caseStatus: ServiceCaseStatus.CLOSED, updatedAt: new Date("2026-08-10T06:00:00Z") });
    harness.addCase({ id: "submitted", caseStatus: ServiceCaseStatus.SUBMITTED, updatedAt: new Date("2026-08-10T05:00:00Z") });
    harness.addCase({ id: "waiting-old", caseStatus: ServiceCaseStatus.WAITING_CUSTOMER, updatedAt: new Date("2026-08-10T03:00:00Z") });
    harness.addCase({ id: "waiting-new", caseStatus: ServiceCaseStatus.WAITING_CUSTOMER, updatedAt: new Date("2026-08-10T04:00:00Z") });
    harness.addCase({ id: "resolved", caseStatus: ServiceCaseStatus.RESOLVED, updatedAt: new Date("2026-08-10T07:00:00Z") });

    const first = await harness.service.listPortalServiceCases(
      currentCustomer("customer-a"),
      { page: 1, pageSize: 3 }
    );
    const second = await harness.service.listPortalServiceCases(
      currentCustomer("customer-a"),
      { page: 2, pageSize: 3 }
    );

    expect(first.items.map((item) => item.id)).toEqual([
      "waiting-new",
      "waiting-old",
      "submitted"
    ]);
    expect(second.items.map((item) => item.id)).toEqual(["resolved", "closed"]);
  });

  it("keeps caseStatus filtering exact", async () => {
    const harness = createServiceCaseHarness();
    harness.addCase({ id: "waiting", caseStatus: ServiceCaseStatus.WAITING_CUSTOMER });
    harness.addCase({ id: "closed", caseStatus: ServiceCaseStatus.CLOSED });

    const result = await harness.service.listPortalServiceCases(
      currentCustomer("customer-a"),
      { caseStatus: ServiceCaseStatus.CLOSED }
    );
    expect(result.items.map((item) => item.id)).toEqual(["closed"]);
  });

  it("uploads attachments through StorageService and hides object storage fields", async () => {
    const harness = createServiceCaseHarness();
    harness.addCase({ customerId: "customer-a", id: "case-a", orderId: "order-a" });

    const result = await harness.service.uploadPortalAttachments(
      "case-a",
      [
        {
          buffer: Buffer.from("hello"),
          mimetype: "image/png",
          originalname: "scene.png",
          size: 5
        }
      ],
      currentCustomer("customer-a"),
      requestContext()
    );

    expect(harness.storageService.putServiceCaseAttachment).toHaveBeenCalledWith(
      expect.objectContaining({ originalName: "scene.png", serviceCaseId: "case-a" })
    );
    expect(result.files[0]).toEqual(
      expect.objectContaining({
        fileName: "scene.png",
        previewUrl: "/api/portal/service-cases/case-a/attachments/attachment-1/preview"
      })
    );
    expect(result.files[0]).not.toHaveProperty("objectKey");
    expect(result.files[0]).not.toHaveProperty("bucket");
  });

  it("blocks attachment upload and preview for another customer's case", async () => {
    const harness = createServiceCaseHarness();
    harness.addCase({ customerId: "customer-b", id: "case-b", orderId: "order-b" });

    await expect(
      harness.service.uploadPortalAttachments(
        "case-b",
        [{ buffer: Buffer.from("hello"), mimetype: "image/png", originalname: "scene.png", size: 5 }],
        currentCustomer("customer-a"),
        requestContext()
      )
    ).rejects.toBeInstanceOf(NotFoundException);

    expect(harness.storageService.putServiceCaseAttachment).not.toHaveBeenCalled();
    await expect(
      harness.service.previewPortalAttachment("case-b", "attachment-b", currentCustomer("customer-a"))
    ).rejects.toBeInstanceOf(NotFoundException);
  });

  it("streams previews through the API for the owning customer", async () => {
    const harness = createServiceCaseHarness();
    harness.addCase({ customerId: "customer-a", id: "case-a", orderId: "order-a" });
    harness.addAttachment({ id: "attachment-a", serviceCaseId: "case-a" });

    const preview = await harness.service.previewPortalAttachment("case-a", "attachment-a", currentCustomer("customer-a"));

    expect(preview.filename).toBe("scene.png");
    expect(harness.storageService.getObject).toHaveBeenCalledWith("service-case-files", "service-cases/case-a/scene.png");
  });

  it("allows customer cancellation only for mutable owned cases", async () => {
    const harness = createServiceCaseHarness();
    harness.addCase({ customerId: "customer-a", id: "case-a", orderId: "order-a" });
    harness.addCase({
      caseStatus: ServiceCaseStatus.IN_PROGRESS,
      customerId: "customer-a",
      id: "case-progress",
      orderId: "order-a"
    });

    const cancelled = await harness.service.cancelPortalServiceCase(
      "case-a",
      { reason: "客户主动取消" },
      currentCustomer("customer-a"),
      requestContext()
    );

    expect(cancelled.caseStatus).toBe(ServiceCaseStatus.CANCELLED);
    await expect(
      harness.service.cancelPortalServiceCase(
        "case-progress",
        { reason: "客户主动取消" },
        currentCustomer("customer-a"),
        requestContext()
      )
    ).rejects.toBeInstanceOf(BadRequestException);
  });
});

export function createServiceCaseHarness(): ServiceCaseHarness {
  const now = new Date("2026-06-18T08:00:00Z");
  const customers = [
    { customerNo: "CUS-A", id: "customer-a", mobile: "13800000000", name: "张三" },
    { customerNo: "CUS-B", id: "customer-b", mobile: "13900000000", name: "李四" }
  ];
  const vehicles = [
    {
      assetLocation: "上海",
      batteryCapacityKwh: null,
      batteryUsageType: "BUYOUT",
      brand: "NIO",
      currentMileageKm: 1000,
      id: "vehicle-a",
      model: "ES6",
      modelDefinition: {
        displayName: "NIO ES6",
        modelCode: "NIO_ES6"
      },
      modelDefinitionId: "00000000-0000-4000-8000-000000000e60",
      modelYear: 2025,
      series: null
    },
    {
      assetLocation: "上海",
      batteryCapacityKwh: null,
      batteryUsageType: "BUYOUT",
      brand: "XPENG",
      currentMileageKm: 2000,
      id: "vehicle-b",
      model: "G6",
      modelDefinition: {
        displayName: "XPENG G6",
        modelCode: "XPENG_G6"
      },
      modelDefinitionId: "00000000-0000-4000-8000-000000000660",
      modelYear: 2025,
      series: null
    }
  ];
  const orders = [
    {
      customer: customers[0]!,
      customerId: "customer-a",
      deletedAt: null,
      id: "order-a",
      orderNo: "ORD-A",
      orderStatus: "ACTIVE",
      vehicle: vehicles[0]!,
      vehicleId: "vehicle-a"
    },
    {
      customer: customers[1]!,
      customerId: "customer-b",
      deletedAt: null,
      id: "order-b",
      orderNo: "ORD-B",
      orderStatus: "ACTIVE",
      vehicle: vehicles[1]!,
      vehicleId: "vehicle-b"
    }
  ];
  const cases: AnyRecord[] = [];
  const actions: AnyRecord[] = [];
  const attachments: AnyRecord[] = [];

  function decorateCase(row: AnyRecord) {
    const order = orders.find((item) => item.id === row.orderId);
    const customer = customers.find((item) => item.id === row.customerId);
    const vehicle = vehicles.find((item) => item.id === row.vehicleId);
    return {
      ...row,
      actions: actions.filter((item) => item.serviceCaseId === row.id),
      attachments: attachments.filter((item) => item.serviceCaseId === row.id && item.deletedAt === null),
      customer,
      order: order ? { id: order.id, orderNo: order.orderNo, orderStatus: order.orderStatus } : null,
      vehicle
    };
  }

  const prisma = {
    $transaction: vi.fn(async (input: unknown) => {
      if (Array.isArray(input)) {
        return Promise.all(input);
      }
      return (input as (tx: typeof prisma) => Promise<unknown>)(prisma);
    }),
    receivableBill: {
      create: vi.fn()
    },
    serviceCase: {
      count: vi.fn(async ({ where }: AnyRecord) => cases.filter((item) => matches(item, where)).length),
      create: vi.fn(async ({ data }: AnyRecord) => {
        const row = {
          ...data,
          acceptedAt: null,
          attachments: [],
          cancelledAt: null,
          closedAt: null,
          closeRemark: null,
          createdAt: now,
          id: `case-${cases.length + 1}`,
          resolvedAt: null,
          updatedAt: now
        };
        cases.push(row);
        return row;
      }),
      findFirst: vi.fn(async ({ where }: AnyRecord) => {
        const row = cases.find((item) => matches(item, where));
        return row ? decorateCase(row) : null;
      }),
      findMany: vi.fn(async ({ orderBy, skip = 0, take, where }: AnyRecord) => {
        const rows = cases.filter((item) => matches(item, where)).map(decorateCase);
        const sorted = applyOrderBy(rows, orderBy);
        return sorted.slice(skip, take === undefined ? undefined : skip + take);
      }),
      findUniqueOrThrow: vi.fn(async ({ where }: AnyRecord) => {
        const row = cases.find((item) => item.id === where.id);
        if (!row) {
          throw new Error("not found");
        }
        return decorateCase(row);
      }),
      update: vi.fn(async ({ data, where }: AnyRecord) => {
        const row = cases.find((item) => item.id === where.id);
        if (!row) {
          throw new Error("not found");
        }
        Object.assign(row, data, { updatedAt: now });
        return decorateCase(row);
      })
    },
    serviceCaseAction: {
      create: vi.fn(async ({ data }: AnyRecord) => {
        const row = { ...data, createdAt: now, id: `action-${actions.length + 1}` };
        actions.push(row);
        return row;
      })
    },
    serviceCaseAttachment: {
      create: vi.fn(async ({ data }: AnyRecord) => {
        const row = {
          ...data,
          createdAt: now,
          deletedAt: null,
          id: `attachment-${attachments.length + 1}`,
          updatedAt: now
        };
        attachments.push(row);
        return row;
      }),
      findFirst: vi.fn(async ({ where }: AnyRecord) => {
        const row = attachments.find(
          (item) =>
            item.id === where.id &&
            item.serviceCaseId === where.serviceCaseId &&
            item.deletedAt === where.deletedAt
        );
        if (!row) {
          return null;
        }
        const serviceCase = cases.find((item) => item.id === row.serviceCaseId);
        if (where.serviceCase && !matches(serviceCase, where.serviceCase)) {
          return null;
        }
        return row;
      })
    },
    subscriptionOrder: {
      findFirst: vi.fn(async ({ where }: AnyRecord) => orders.find((item) => matches(item, where)) ?? null)
    },
    vehicle: {
      update: vi.fn()
    }
  };

  const auditService = {
    write: vi.fn()
  };
  const storageService = {
    getObject: vi.fn(async () => ({
      contentLength: 5,
      contentType: "image/png",
      stream: Readable.from(Buffer.from("hello"))
    })),
    putServiceCaseAttachment: vi.fn(async ({ serviceCaseId }: AnyRecord) => ({
      bucket: "service-case-files",
      objectKey: `service-cases/${serviceCaseId}/scene.png`,
      stored: { driver: "local", key: `service-cases/${serviceCaseId}/scene.png`, size: 5 }
    }))
  };
  const notificationService = {
    notifyCustomer: vi.fn(async () => [])
  };

  return {
    addAttachment(input: Partial<AnyRecord>) {
      attachments.push({
        attachmentType: "IMAGE",
        bucket: "service-case-files",
        createdAt: now,
        deletedAt: null,
        fileName: "scene.png",
        fileSize: 5,
        id: input.id ?? `attachment-${attachments.length + 1}`,
        mimeType: "image/png",
        objectKey: `service-cases/${input.serviceCaseId ?? "case-a"}/scene.png`,
        serviceCaseId: input.serviceCaseId ?? "case-a",
        updatedAt: now,
        uploadedByType: "CUSTOMER"
      });
    },
    addCase(input: Partial<AnyRecord>) {
      const order = orders.find((item) => item.id === (input.orderId ?? "order-a"));
      cases.push({
        acceptedAt: null,
        accidentHasInjury: false,
        accidentPoliceReported: true,
        cancelReason: null,
        cancelledAt: null,
        caseNo: input.caseNo ?? `SC-${cases.length + 1}`,
        caseSource: "CUSTOMER_PORTAL",
        caseStatus: input.caseStatus ?? ServiceCaseStatus.SUBMITTED,
        caseType: input.caseType ?? ServiceCaseType.ACCIDENT_REPORT,
        closeRemark: null,
        closedAt: null,
        contactName: "张三",
        contactPhone: "13800000000",
        createdAt: input.createdAt ?? now,
        customerId: input.customerId ?? order?.customerId ?? "customer-a",
        deletedAt: null,
        description: "描述",
        id: input.id ?? `case-${cases.length + 1}`,
        insuranceReportNo: null,
        locationText: "上海",
        occurredAt: now,
        orderId: input.orderId ?? "order-a",
        priority: "NORMAL",
        rescueAddress: null,
        rescueType: null,
        resolvedAt: null,
        title: "事故报案",
        updatedAt: input.updatedAt ?? now,
        vehicleId: order?.vehicleId ?? "vehicle-a"
      });
    },
    auditService,
    cases,
    notificationService,
    prisma,
    service: new ServiceCaseService(
      auditService as never,
      prisma as never,
      storageService as never,
      notificationService as never
    ),
    storageService
  };
}

function applyOrderBy(items: AnyRecord[], orderBy: AnyRecord | AnyRecord[] | undefined) {
  const entries = orderBy ? (Array.isArray(orderBy) ? orderBy : [orderBy]) : [];
  return [...items].sort((left, right) => {
    for (const entry of entries) {
      const [field, direction] = Object.entries(entry)[0] ?? [];
      if (!field || (direction !== "asc" && direction !== "desc")) continue;
      const leftValue = left[field] instanceof Date ? left[field].getTime() : String(left[field] ?? "");
      const rightValue = right[field] instanceof Date ? right[field].getTime() : String(right[field] ?? "");
      if (leftValue < rightValue) return direction === "asc" ? -1 : 1;
      if (leftValue > rightValue) return direction === "asc" ? 1 : -1;
    }
    return 0;
  });
}

export function currentCustomer(customerId = "customer-a") {
  return {
    accountStatus: "ACTIVE" as const,
    customerAccountId: "00000000-0000-4000-8000-000000000001",
    customerId,
    phone: "13800000000"
  };
}

export function requestContext() {
  return {
    ipAddress: "127.0.0.1",
    userAgent: "vitest"
  };
}

function matches(item: AnyRecord | undefined, where: AnyRecord = {}) {
  if (!item) {
    return false;
  }

  for (const [key, value] of Object.entries(where)) {
    if (value === undefined) {
      continue;
    }
    if (key === "serviceCase") {
      continue;
    }
    if (value && typeof value === "object" && "in" in value) {
      if (!(value.in as unknown[]).includes(item[key])) {
        return false;
      }
      continue;
    }
    if (item[key] !== value) {
      return false;
    }
  }

  return true;
}
