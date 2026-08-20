import "reflect-metadata";

import { INestApplication, Patch, Post, RequestMethod, ValidationPipe } from "@nestjs/common";
import { METHOD_METADATA, MODULE_METADATA, PATH_METADATA } from "@nestjs/common/constants";
import { Reflector } from "@nestjs/core";
import { Test } from "@nestjs/testing";
import {
  BusinessExceptionApprovalStatus,
  BusinessExceptionSubjectType,
  VehicleCostActionType,
  VehicleCostCategory,
  VehicleCostResponsiblePartyType
} from "@prisma/client";
import { PermissionCode } from "@subscription-saas/shared";
import { AddressInfo, createConnection } from "node:net";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

import { AppModule } from "../src/app.module";
import {
  ASSET_ACCOUNTING_API_CODE,
  AssetAccountingController
} from "../src/asset-accounting/asset-accounting.controller";
import { AssetAccountingModule } from "../src/asset-accounting/asset-accounting.module";
import { AssetAccountingRepository } from "../src/asset-accounting/asset-accounting.repository";
import { AssetAccountingService } from "../src/asset-accounting/asset-accounting.service";
import { AuditModule } from "../src/audit/audit.module";
import { REQUIRED_PERMISSIONS_KEY, RequirePermissions } from "../src/auth/auth.decorators";
import { type AuthenticatedRequest, AuthGuard } from "../src/auth/auth.guard";
import { AuthModule } from "../src/auth/auth.module";
import { AuthService } from "../src/auth/auth.service";
import { PermissionsGuard } from "../src/auth/permissions.guard";
import { PrismaModule } from "../src/prisma/prisma.module";

const IDS = {
  actor: "00000000-0000-4000-8000-000000000001",
  approval: "00000000-0000-4000-8000-000000000002",
  entry: "00000000-0000-4000-8000-000000000003",
  order: "00000000-0000-4000-8000-000000000004",
  source: "00000000-0000-4000-8000-000000000005",
  vehicle: "00000000-0000-4000-8000-000000000006",
  workOrder: "00000000-0000-4000-8000-000000000007"
} as const;
const SOURCE_KEY = "asset-accounting-controller:test:v1";

describe("AssetAccountingController governed boundary", () => {
  let app: INestApplication;
  let baseUrl: string;
  const service = {
    appendCost: vi.fn().mockResolvedValue(publicCostEntry()),
    getEntry: vi.fn().mockResolvedValue(publicCostEntry()),
    getExceptionApproval: vi.fn().mockResolvedValue(publicApproval()),
    listExceptionApprovals: vi.fn().mockResolvedValue([publicApproval()]),
    listOrderEntries: vi.fn().mockResolvedValue([publicCostEntry()]),
    listVehicleEntries: vi.fn().mockResolvedValue([publicCostEntry()]),
    listWorkOrderEntries: vi.fn().mockResolvedValue([publicCostEntry()]),
    reverseCost: vi.fn().mockResolvedValue({ ...publicCostEntry(), amountCents: "-1250" })
  };

  beforeAll(async () => {
    const moduleRef = await Test.createTestingModule({
      controllers: [AssetAccountingController],
      providers: [
        { provide: AssetAccountingService, useValue: service },
        {
          provide: AuthService,
          useValue: { validateToken: vi.fn(async (token: string) => testUser(token)) }
        },
        AuthGuard,
        PermissionsGuard,
        Reflector
      ]
    }).compile();
    app = moduleRef.createNestApplication();
    app.setGlobalPrefix("api");
    app.useGlobalPipes(new ValidationPipe({ transform: true, whitelist: true }));
    await app.listen(0, "127.0.0.1");
    const address = app.getHttpServer().address() as AddressInfo;
    baseUrl = `http://127.0.0.1:${address.port}`;
  });

  beforeEach(() => vi.clearAllMocks());
  afterAll(async () => app.close());

  it("requires authentication and the exact route permission", async () => {
    expect((await get(`/api/asset-accounting/cost-entries/${IDS.entry}`)).status).toBe(401);

    const cases = [
      ["GET", `/api/asset-accounting/cost-entries/${IDS.entry}`, "none", undefined],
      ["GET", `/api/asset-accounting/vehicles/${IDS.vehicle}/cost-entries`, "none", undefined],
      ["GET", `/api/asset-accounting/orders/${IDS.order}/cost-entries`, "none", undefined],
      ["GET", `/api/asset-accounting/work-orders/${IDS.workOrder}/cost-entries`, "none", undefined],
      ["GET", `/api/asset-accounting/exception-approvals/${IDS.approval}`, "cost-view", undefined],
      ["GET", "/api/asset-accounting/exception-approvals", "cost-view", undefined],
      ["POST", "/api/asset-accounting/cost-entries", "cost-view", appendBody()],
      [
        "POST",
        `/api/asset-accounting/cost-entries/${IDS.entry}/reverse`,
        "cost-view",
        reverseBody()
      ]
    ] as const;

    for (const [method, path, token, body] of cases) {
      const response =
        method === "GET" ? await get(path, token) : await post(path, body!, token, SOURCE_KEY);
      expect(response.status, `${method} ${path}`).toBe(403);
    }
  });

  it("rejects unsafe amount, UUID, date, period, source, and snapshot values before delegation", async () => {
    const invalidBodies = [
      { ...appendBody(), amountCents: Number.MAX_SAFE_INTEGER + 1 },
      { ...appendBody(), amountCents: "0" },
      { ...appendBody(), amountCents: "01" },
      { ...appendBody(), vehicleId: "not-a-uuid" },
      { ...appendBody(), confirmedAt: "not-a-date" },
      { ...appendBody(), occurredOn: "not-a-date" },
      { ...appendBody(), accountingPeriod: "2026-13" },
      { ...appendBody(), source: undefined },
      { ...appendBody(), source: { ...source(), id: "not-a-uuid" } },
      { ...appendBody(), source: { ...source(), key: " " } },
      { ...appendBody(), source: { ...source(), type: " " } },
      { ...appendBody(), responsibilitySnapshot: [] },
      {
        ...appendBody(),
        responsibilitySnapshot: { unsafeInteger: Number.MAX_SAFE_INTEGER + 1 }
      },
      { ...appendBody(), evidenceSnapshot: "not-an-object" }
    ];

    for (const body of invalidBodies) {
      const response = await post(
        "/api/asset-accounting/cost-entries",
        body,
        "confirm",
        SOURCE_KEY
      );
      expect(response.status, JSON.stringify(body)).toBe(400);
    }
    expect(service.appendCost).not.toHaveBeenCalled();
  });

  it("rejects every financial write boundary before append or reverse service delegation", async () => {
    const invalidOptionalUuidFields = [
      "assetOwnerId",
      "contractId",
      "customerId",
      "evidenceId",
      "orderId",
      "responsiblePartyId",
      "workOrderId"
    ] as const;
    const appendCases: Array<{
      body: Record<string, unknown>;
      idempotencyKey?: string;
      label: string;
    }> = [
      {
        body: { ...appendBody(), amountCents: "9223372036854775808" },
        label: "amount above signed int64"
      },
      { body: { ...appendBody(), reason: " " }, label: "blank append reason" },
      {
        body: { ...appendBody(), reason: "x".repeat(2001) },
        label: "overlong append reason"
      },
      {
        body: { ...appendBody(), source: { ...source(), type: " " } },
        label: "blank append source type"
      },
      {
        body: { ...appendBody(), source: { ...source(), type: "x".repeat(65) } },
        label: "overlong append source type"
      },
      {
        body: { ...appendBody(), source: { ...source(), key: " " } },
        idempotencyKey: " ",
        label: "blank append source key"
      },
      {
        body: { ...appendBody(), source: { ...source(), key: "x".repeat(256) } },
        idempotencyKey: "x".repeat(256),
        label: "overlong append source key"
      },
      {
        body: { ...appendBody(), actionType: "UNKNOWN_ACTION" },
        label: "invalid action type"
      },
      {
        body: { ...appendBody(), costCategory: "UNKNOWN_CATEGORY" },
        label: "invalid cost category"
      },
      {
        body: { ...appendBody(), responsiblePartyType: "UNKNOWN_PARTY" },
        label: "invalid responsible party type"
      },
      {
        body: { ...appendBody(), responsibilitySnapshot: nestedSnapshot(33) },
        label: "snapshot above maximum depth"
      },
      ...invalidOptionalUuidFields.map((field) => ({
        body: { ...appendBody(), [field]: "not-a-uuid" },
        label: `invalid optional UUID ${field}`
      }))
    ];

    for (const { body, idempotencyKey = SOURCE_KEY, label } of appendCases) {
      const response = await post(
        "/api/asset-accounting/cost-entries",
        body,
        "confirm",
        idempotencyKey
      );
      expect(response.status, label).toBe(400);
    }

    const nonFiniteJson = JSON.stringify({
      ...appendBody(),
      responsibilitySnapshot: { nonFinite: "__NON_FINITE__" }
    }).replace('"__NON_FINITE__"', "1e400");
    expect(
      (await postRaw("/api/asset-accounting/cost-entries", nonFiniteJson, "confirm", SOURCE_KEY))
        .status,
      "non-finite JSON number"
    ).toBe(400);

    const reverseCases: Array<{
      body: Record<string, unknown>;
      idempotencyKey?: string;
      label: string;
    }> = [
      { body: { ...reverseBody(), confirmedAt: "not-a-date" }, label: "reverse date" },
      { body: { ...reverseBody(), reason: " " }, label: "blank reverse reason" },
      {
        body: { ...reverseBody(), reason: "x".repeat(2001) },
        label: "overlong reverse reason"
      },
      {
        body: { ...reverseBody(), source: { ...source(), id: "not-a-uuid" } },
        label: "reverse source UUID"
      },
      {
        body: { ...reverseBody(), source: { ...source(), type: " " } },
        label: "blank reverse source type"
      },
      {
        body: { ...reverseBody(), source: { ...source(), type: "x".repeat(65) } },
        label: "overlong reverse source type"
      },
      {
        body: { ...reverseBody(), source: { ...source(), key: " " } },
        idempotencyKey: " ",
        label: "blank reverse source key"
      },
      {
        body: { ...reverseBody(), source: { ...source(), key: "x".repeat(256) } },
        idempotencyKey: "x".repeat(256),
        label: "overlong reverse source key"
      }
    ];
    for (const { body, idempotencyKey = SOURCE_KEY, label } of reverseCases) {
      const response = await post(
        `/api/asset-accounting/cost-entries/${IDS.entry}/reverse`,
        body,
        "reverse",
        idempotencyKey
      );
      expect(response.status, label).toBe(400);
    }

    expect(service.appendCost).not.toHaveBeenCalled();
    expect(service.reverseCost).not.toHaveBeenCalled();
  });

  it("requires one scalar Idempotency-Key that exactly matches nested source.key", async () => {
    const path = "/api/asset-accounting/cost-entries";
    for (const key of [undefined, "   "]) {
      const response = await post(path, appendBody(), "confirm", key);
      expect(response.status).toBe(400);
      expect(await response.json()).toMatchObject({
        code: ASSET_ACCOUNTING_API_CODE.IDEMPOTENCY_KEY_REQUIRED
      });
    }

    const mismatch = await post(path, appendBody(), "confirm", `${SOURCE_KEY}:other`);
    expect(mismatch.status).toBe(400);
    expect(await mismatch.json()).toMatchObject({
      code: ASSET_ACCOUNTING_API_CODE.IDEMPOTENCY_KEY_MISMATCH
    });

    const duplicate = await postWithRawHeaders(path, appendBody(), [
      "Idempotency-Key",
      `${SOURCE_KEY}:one`,
      "iDeMpOtEnCy-KeY",
      `${SOURCE_KEY}:two`
    ]);
    expect(duplicate.status).toBe(400);
    expect(duplicate.body).toMatchObject({
      code: ASSET_ACCOUNTING_API_CODE.IDEMPOTENCY_KEY_MULTIPLE
    });

    const controller = new AssetAccountingController(service as never);
    const request = {
      headers: { "idempotency-key": [SOURCE_KEY] },
      rawHeaders: ["Idempotency-Key", SOURCE_KEY],
      user: testUser("confirm")
    } as unknown as AuthenticatedRequest;
    expect(() => controller.appendCostEntry(appendBody(), request)).toThrow();
    const whitespaceDriftRequest = {
      ...request,
      headers: { "idempotency-key": `${SOURCE_KEY} ` },
      rawHeaders: ["Idempotency-Key", `${SOURCE_KEY} `]
    } as unknown as AuthenticatedRequest;
    expect(() => controller.appendCostEntry(appendBody(), whitespaceDriftRequest)).toThrow();
    expect(service.appendCost).not.toHaveBeenCalled();
  });

  it("delegates cost writes with exact converted values and authenticated context", async () => {
    const append = await post(
      "/api/asset-accounting/cost-entries",
      appendBody(),
      "confirm",
      SOURCE_KEY
    );
    const reverse = await post(
      `/api/asset-accounting/cost-entries/${IDS.entry}/reverse`,
      reverseBody(),
      "reverse",
      SOURCE_KEY
    );

    expect(append.status).toBe(201);
    expect(reverse.status).toBe(201);
    expect(await append.json()).toEqual(publicCostEntry());
    expect(service.appendCost).toHaveBeenCalledWith(
      expect.objectContaining({
        amountCents: 1250n,
        confirmedAt: new Date("2026-08-20T10:00:00.000Z"),
        occurredOn: new Date("2026-08-19T00:00:00.000Z"),
        reason: "inspection confirmed cost",
        source: source()
      }),
      expect.objectContaining({
        actorId: IDS.actor,
        idempotencyKey: SOURCE_KEY,
        permissions: [PermissionCode.VEHICLE_COST_LEDGER_CONFIRM],
        userAgent: "asset-accounting-controller-test"
      })
    );
    expect(service.reverseCost).toHaveBeenCalledWith(
      expect.objectContaining({
        confirmedAt: new Date("2026-08-20T11:00:00.000Z"),
        originalEntryId: IDS.entry,
        reason: "duplicate cost",
        source: source()
      }),
      expect.objectContaining({
        actorId: IDS.actor,
        idempotencyKey: SOURCE_KEY,
        permissions: [PermissionCode.VEHICLE_COST_LEDGER_REVERSE]
      })
    );
  });

  it("validates read IDs and approval filters then delegates JSON-safe read projections", async () => {
    const invalidId = await get("/api/asset-accounting/cost-entries/not-a-uuid", "cost-view");
    const invalidFilters = ["subjectType=UNKNOWN", "subjectId=not-a-uuid", "status=UNKNOWN"];
    expect(invalidId.status).toBe(400);
    for (const query of invalidFilters) {
      expect(
        (await get(`/api/asset-accounting/exception-approvals?${query}`, "exception-view")).status
      ).toBe(400);
    }

    expect((await get(`/api/asset-accounting/cost-entries/${IDS.entry}`, "cost-view")).status).toBe(
      200
    );
    expect(
      (await get(`/api/asset-accounting/vehicles/${IDS.vehicle}/cost-entries`, "cost-view")).status
    ).toBe(200);
    expect(
      (await get(`/api/asset-accounting/orders/${IDS.order}/cost-entries`, "cost-view")).status
    ).toBe(200);
    expect(
      (await get(`/api/asset-accounting/work-orders/${IDS.workOrder}/cost-entries`, "cost-view"))
        .status
    ).toBe(200);
    expect(
      (await get(`/api/asset-accounting/exception-approvals/${IDS.approval}`, "exception-view"))
        .status
    ).toBe(200);
    const list = await get(
      `/api/asset-accounting/exception-approvals?subjectType=${BusinessExceptionSubjectType.VEHICLE}&subjectId=${IDS.vehicle}&status=${BusinessExceptionApprovalStatus.PENDING}`,
      "exception-view"
    );
    expect(list.status).toBe(200);
    expect(await list.json()).toEqual([publicApproval()]);
    expect(service.listExceptionApprovals).toHaveBeenCalledWith(
      {
        status: BusinessExceptionApprovalStatus.PENDING,
        subjectId: IDS.vehicle,
        subjectType: BusinessExceptionSubjectType.VEHICLE
      },
      expect.objectContaining({
        actorId: IDS.actor,
        permissions: [PermissionCode.BUSINESS_EXCEPTION_VIEW]
      })
    );
  });

  it.each(routeMetadata())(
    "registers %s with the exact route and permission contract",
    (method, path, verb, permission) => {
      const handler = AssetAccountingController.prototype[method];
      expect(Reflect.getMetadata(PATH_METADATA, handler)).toBe(path);
      expect(Reflect.getMetadata(METHOD_METADATA, handler)).toBe(verb);
      expect(Reflect.getMetadata(REQUIRED_PERMISSIONS_KEY, handler)).toEqual([permission]);
    }
  );

  it("exposes exactly the approved eight-route inventory and keeps every approval route read-only", () => {
    expect(controllerRouteInventory()).toEqual(expectedRouteInventory());
    expect(
      controllerRouteInventory()
        .filter(([, path]) => path.includes("exception-approvals"))
        .every(([, , verb]) => verb === RequestMethod.GET)
    ).toBe(true);
  });

  it.each([
    ["arbitraryPostMutation", Post("exception-approvals/:id/arbitrary")],
    ["arbitraryPatchMutation", Patch("exception-approvals/:id/arbitrary")]
  ] as const)(
    "mutation probe rejects an arbitrary decorated approval handler: %s",
    (name, route) => {
      const prototype = AssetAccountingController.prototype as unknown as Record<string, unknown>;
      const handler = () => undefined;
      Object.defineProperty(prototype, name, { configurable: true, value: handler });
      route(prototype, name, Object.getOwnPropertyDescriptor(prototype, name)!);
      RequirePermissions(PermissionCode.BUSINESS_EXCEPTION_APPROVE)(
        prototype,
        name,
        Object.getOwnPropertyDescriptor(prototype, name)!
      );
      try {
        expect(() =>
          expect(controllerRouteInventory()).toEqual(expectedRouteInventory())
        ).toThrow();
      } finally {
        delete prototype[name];
      }
    }
  );

  function get(path: string, token?: string) {
    return fetch(`${baseUrl}${path}`, {
      headers: token ? { authorization: `Bearer ${token}` } : undefined
    });
  }

  function post(path: string, body: object, token: string, idempotencyKey?: string) {
    return postRaw(path, JSON.stringify(body), token, idempotencyKey);
  }

  function postRaw(path: string, body: string, token: string, idempotencyKey?: string) {
    return fetch(`${baseUrl}${path}`, {
      body,
      headers: {
        authorization: `Bearer ${token}`,
        "content-type": "application/json",
        ...(idempotencyKey === undefined ? {} : { "idempotency-key": idempotencyKey }),
        "user-agent": "asset-accounting-controller-test"
      },
      method: "POST"
    });
  }

  function postWithRawHeaders(path: string, body: object, headers: string[]) {
    return new Promise<{ body: unknown; status: number }>((resolve, reject) => {
      const payload = JSON.stringify(body);
      const endpoint = new URL(baseUrl);
      const rawRequest = [
        `POST ${path} HTTP/1.1`,
        `Host: ${endpoint.host}`,
        "Authorization: Bearer confirm",
        "Content-Type: application/json",
        `Content-Length: ${Buffer.byteLength(payload)}`,
        ...headers.reduce<string[]>((lines, value, index) => {
          if (index % 2 === 0) lines.push(`${value}: ${headers[index + 1]}`);
          return lines;
        }, []),
        "Connection: close",
        "",
        payload
      ].join("\r\n");
      const chunks: Buffer[] = [];
      const socket = createConnection(Number(endpoint.port), endpoint.hostname, () =>
        socket.write(rawRequest)
      );
      socket.on("data", (chunk: Buffer) => chunks.push(chunk));
      socket.on("error", reject);
      socket.on("end", () => {
        const rawResponse = Buffer.concat(chunks).toString("utf8");
        const [head = "", responseBody = ""] = rawResponse.split("\r\n\r\n", 2);
        resolve({
          body: responseBody ? (JSON.parse(responseBody) as unknown) : null,
          status: Number(head.match(/^HTTP\/1\.1 (\d{3})/)?.[1] ?? 0)
        });
      });
    });
  }
});

describe("AssetAccountingModule registration", () => {
  it("registers the governed controller and is imported by AppModule", () => {
    expect(Reflect.getMetadata(MODULE_METADATA.CONTROLLERS, AssetAccountingModule)).toEqual([
      AssetAccountingController
    ]);
    expect(Reflect.getMetadata(MODULE_METADATA.PROVIDERS, AssetAccountingModule)).toEqual([
      AssetAccountingRepository,
      AssetAccountingService
    ]);
    expect(Reflect.getMetadata(MODULE_METADATA.IMPORTS, AssetAccountingModule)).toEqual([
      AuditModule,
      AuthModule,
      PrismaModule
    ]);
    expect(Reflect.getMetadata(MODULE_METADATA.IMPORTS, AppModule)).toContain(
      AssetAccountingModule
    );
  });
});

function testUser(token: string) {
  const permissionsByToken: Record<string, PermissionCode[]> = {
    confirm: [PermissionCode.VEHICLE_COST_LEDGER_CONFIRM],
    "cost-view": [PermissionCode.VEHICLE_COST_LEDGER_VIEW],
    "exception-view": [PermissionCode.BUSINESS_EXCEPTION_VIEW],
    none: [],
    reverse: [PermissionCode.VEHICLE_COST_LEDGER_REVERSE]
  };
  return {
    id: IDS.actor,
    menus: [],
    name: "Asset Accounting Tester",
    permissions: permissionsByToken[token] ?? [],
    roles: [],
    username: "asset-accounting-test"
  };
}

function source() {
  return { id: IDS.source, key: SOURCE_KEY, type: "ASSET_WORK_ORDER" };
}

function appendBody() {
  return {
    accountingPeriod: "2026-08",
    actionType: VehicleCostActionType.ACTUAL_COST,
    amountCents: "1250",
    assetOwnerId: null,
    assetOwnerSnapshot: null,
    confirmedAt: "2026-08-20T10:00:00.000Z",
    contractId: null,
    costCategory: VehicleCostCategory.REPAIR,
    customerId: null,
    evidenceId: null,
    evidenceSnapshot: null,
    occurredOn: "2026-08-19T00:00:00.000Z",
    orderId: IDS.order,
    reason: " inspection confirmed cost ",
    responsiblePartyId: null,
    responsiblePartyType: VehicleCostResponsiblePartyType.PLATFORM,
    responsibilitySnapshot: { basis: "inspection" },
    source: source(),
    vehicleId: IDS.vehicle,
    workOrderId: IDS.workOrder
  };
}

function reverseBody() {
  return {
    confirmedAt: "2026-08-20T11:00:00.000Z",
    reason: " duplicate cost ",
    source: source()
  };
}

function nestedSnapshot(depth: number): Record<string, unknown> {
  let snapshot: Record<string, unknown> = {};
  for (let index = 0; index < depth; index += 1) snapshot = { nested: snapshot };
  return snapshot;
}

function publicCostEntry() {
  return {
    actionType: VehicleCostActionType.ACTUAL_COST,
    accountingPeriod: "2026-08",
    amountCents: "1250",
    confirmedAt: "2026-08-20T10:00:00.000Z",
    id: IDS.entry,
    occurredOn: "2026-08-19T00:00:00.000Z",
    responsibilitySnapshot: { basis: "inspection" },
    sourceId: IDS.source,
    sourceKey: SOURCE_KEY,
    sourceType: "ASSET_WORK_ORDER",
    vehicleId: IDS.vehicle
  };
}

function publicApproval() {
  return {
    approvalNo: "BEA-20260820-0001",
    decidedAt: null,
    id: IDS.approval,
    requestedAt: "2026-08-20T10:00:00.000Z",
    status: BusinessExceptionApprovalStatus.PENDING,
    subjectId: IDS.vehicle,
    subjectSnapshot: { revision: 1 },
    subjectType: BusinessExceptionSubjectType.VEHICLE
  };
}

function routeMetadata() {
  return [
    [
      "appendCostEntry",
      "cost-entries",
      RequestMethod.POST,
      PermissionCode.VEHICLE_COST_LEDGER_CONFIRM
    ],
    [
      "reverseCostEntry",
      "cost-entries/:id/reverse",
      RequestMethod.POST,
      PermissionCode.VEHICLE_COST_LEDGER_REVERSE
    ],
    [
      "getCostEntry",
      "cost-entries/:id",
      RequestMethod.GET,
      PermissionCode.VEHICLE_COST_LEDGER_VIEW
    ],
    [
      "listVehicleCostEntries",
      "vehicles/:vehicleId/cost-entries",
      RequestMethod.GET,
      PermissionCode.VEHICLE_COST_LEDGER_VIEW
    ],
    [
      "listOrderCostEntries",
      "orders/:orderId/cost-entries",
      RequestMethod.GET,
      PermissionCode.VEHICLE_COST_LEDGER_VIEW
    ],
    [
      "listWorkOrderCostEntries",
      "work-orders/:workOrderId/cost-entries",
      RequestMethod.GET,
      PermissionCode.VEHICLE_COST_LEDGER_VIEW
    ],
    [
      "getExceptionApproval",
      "exception-approvals/:id",
      RequestMethod.GET,
      PermissionCode.BUSINESS_EXCEPTION_VIEW
    ],
    [
      "listExceptionApprovals",
      "exception-approvals",
      RequestMethod.GET,
      PermissionCode.BUSINESS_EXCEPTION_VIEW
    ]
  ] as const;
}

function controllerRouteInventory() {
  const rootPath = Reflect.getMetadata(PATH_METADATA, AssetAccountingController) as string;
  const prototype = AssetAccountingController.prototype as unknown as Record<string, unknown>;
  return Object.getOwnPropertyNames(prototype)
    .flatMap((methodName) => {
      const handler = prototype[methodName];
      if (typeof handler !== "function") return [];
      const verb = Reflect.getMetadata(METHOD_METADATA, handler) as RequestMethod | undefined;
      if (verb === undefined) return [];
      const methodPath = Reflect.getMetadata(PATH_METADATA, handler) as string;
      const permissions = Reflect.getMetadata(REQUIRED_PERMISSIONS_KEY, handler) as
        | PermissionCode[]
        | undefined;
      return [[methodName, `${rootPath}/${methodPath}`, verb, permissions] as const];
    })
    .sort((left, right) => JSON.stringify(left).localeCompare(JSON.stringify(right)));
}

function expectedRouteInventory() {
  return [
    [
      "appendCostEntry",
      "asset-accounting/cost-entries",
      RequestMethod.POST,
      [PermissionCode.VEHICLE_COST_LEDGER_CONFIRM]
    ],
    [
      "getCostEntry",
      "asset-accounting/cost-entries/:id",
      RequestMethod.GET,
      [PermissionCode.VEHICLE_COST_LEDGER_VIEW]
    ],
    [
      "getExceptionApproval",
      "asset-accounting/exception-approvals/:id",
      RequestMethod.GET,
      [PermissionCode.BUSINESS_EXCEPTION_VIEW]
    ],
    [
      "listExceptionApprovals",
      "asset-accounting/exception-approvals",
      RequestMethod.GET,
      [PermissionCode.BUSINESS_EXCEPTION_VIEW]
    ],
    [
      "listOrderCostEntries",
      "asset-accounting/orders/:orderId/cost-entries",
      RequestMethod.GET,
      [PermissionCode.VEHICLE_COST_LEDGER_VIEW]
    ],
    [
      "listVehicleCostEntries",
      "asset-accounting/vehicles/:vehicleId/cost-entries",
      RequestMethod.GET,
      [PermissionCode.VEHICLE_COST_LEDGER_VIEW]
    ],
    [
      "listWorkOrderCostEntries",
      "asset-accounting/work-orders/:workOrderId/cost-entries",
      RequestMethod.GET,
      [PermissionCode.VEHICLE_COST_LEDGER_VIEW]
    ],
    [
      "reverseCostEntry",
      "asset-accounting/cost-entries/:id/reverse",
      RequestMethod.POST,
      [PermissionCode.VEHICLE_COST_LEDGER_REVERSE]
    ]
  ].sort((left, right) => JSON.stringify(left).localeCompare(JSON.stringify(right)));
}
