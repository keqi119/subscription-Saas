import "reflect-metadata";

import {
  BadRequestException,
  ConflictException,
  ForbiddenException,
  INestApplication,
  NotFoundException,
  RequestMethod,
  ValidationPipe
} from "@nestjs/common";
import { METHOD_METADATA, MODULE_METADATA, PATH_METADATA } from "@nestjs/common/constants";
import { Reflector } from "@nestjs/core";
import { Test } from "@nestjs/testing";
import {
  AssetWorkOrderEvidenceAction,
  AssetWorkOrderEvidenceType,
  AssetWorkOrderPriority,
  AssetWorkOrderStatus,
  AssetWorkOrderType,
  VehicleOperationalRestrictionScope,
  VehicleOperationalRestrictionSeverity,
  VehicleOperationalRestrictionStatus,
  VehicleOperationalRestrictionType
} from "@prisma/client";
import { PermissionCode } from "@subscription-saas/shared";
import { AddressInfo, createConnection } from "node:net";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

import {
  REQUIRED_ANY_PERMISSIONS_KEY,
  REQUIRED_PERMISSIONS_KEY
} from "../src/auth/auth.decorators";
import { AuthGuard, type AuthenticatedRequest } from "../src/auth/auth.guard";
import { AuthService } from "../src/auth/auth.service";
import { PermissionsGuard } from "../src/auth/permissions.guard";
import { AppModule } from "../src/app.module";
import {
  ASSET_OPERATION_API_CODE,
  AssetOperationsController
} from "../src/asset-operations/asset-operations.controller";
import { AssetOperationsModule } from "../src/asset-operations/asset-operations.module";
import { AssetOperationsRepository } from "../src/asset-operations/asset-operations.repository";
import { AssetOperationsService } from "../src/asset-operations/asset-operations.service";
import { AuditModule } from "../src/audit/audit.module";
import { AuthModule } from "../src/auth/auth.module";
import { PrismaModule } from "../src/prisma/prisma.module";

const ACTOR_ID = "00000000-0000-4000-8000-000000000001";
const VEHICLE_ID = "00000000-0000-4000-8000-000000000101";
const WORK_ORDER_ID = "00000000-0000-4000-8000-000000000102";
const RESTRICTION_ID = "00000000-0000-4000-8000-000000000103";
const USER_ID = "00000000-0000-4000-8000-000000000104";
const FILE_ID = "00000000-0000-4000-8000-000000000105";
const EVIDENCE_ID = "00000000-0000-4000-8000-000000000106";
const SOURCE_ID = "00000000-0000-4000-8000-000000000107";
const SOURCE_KEY = "asset-operations-controller:test:v1";

describe("AssetOperationsController governed boundary", () => {
  let app: INestApplication;
  let baseUrl: string;

  const service = {
    appendEvidence: vi.fn().mockResolvedValue({ evidence: { id: EVIDENCE_ID } }),
    appendNote: vi.fn().mockResolvedValue({ workOrder: { id: WORK_ORDER_ID } }),
    assignWorkOrder: vi.fn().mockResolvedValue({ workOrder: { id: WORK_ORDER_ID } }),
    createRestriction: vi.fn().mockResolvedValue({ restriction: { id: RESTRICTION_ID } }),
    createWorkOrder: vi.fn().mockResolvedValue({ workOrder: { id: WORK_ORDER_ID } }),
    getVehicleAvailability: vi.fn().mockResolvedValue({ available: true }),
    getWorkOrderDetail: vi.fn().mockResolvedValue({ workOrder: { id: WORK_ORDER_ID } }),
    listVehicleRestrictions: vi.fn().mockResolvedValue([]),
    listVehicleWorkOrders: vi.fn().mockResolvedValue([]),
    releaseRestriction: vi.fn().mockResolvedValue({ restriction: { id: RESTRICTION_ID } }),
    transitionWorkOrder: vi.fn().mockResolvedValue({ workOrder: { id: WORK_ORDER_ID } })
  };

  beforeAll(async () => {
    const moduleRef = await Test.createTestingModule({
      controllers: [AssetOperationsController],
      providers: [
        { provide: AssetOperationsService, useValue: service },
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
    app.useGlobalPipes(
      new ValidationPipe({ forbidNonWhitelisted: false, transform: true, whitelist: true })
    );
    await app.listen(0, "127.0.0.1");
    const address = app.getHttpServer().address() as AddressInfo;
    baseUrl = `http://127.0.0.1:${address.port}`;
  });

  beforeEach(() => vi.clearAllMocks());
  afterAll(async () => app.close());

  it("requires authentication for the governed boundary", async () => {
    const response = await get(`/api/asset-operations/work-orders/${WORK_ORDER_ID}`);

    expect(response.status).toBe(401);
    expect(service.getWorkOrderDetail).not.toHaveBeenCalled();
  });

  it.each([
    ["work order detail", `/api/asset-operations/work-orders/${WORK_ORDER_ID}`],
    ["vehicle work orders", `/api/asset-operations/vehicles/${VEHICLE_ID}/work-orders`],
    ["vehicle restrictions", `/api/asset-operations/vehicles/${VEHICLE_ID}/restrictions`],
    [
      "vehicle availability",
      `/api/asset-operations/vehicles/${VEHICLE_ID}/availability?purpose=ALLOCATION`
    ]
  ])("denies %s without asset_operations:view", async (_case, path) => {
    expect((await get(path, "none")).status).toBe(403);
  });

  it.each([
    ["create", "/api/asset-operations/work-orders", createWorkOrderBody()],
    [
      "assignment",
      `/api/asset-operations/work-orders/${WORK_ORDER_ID}/assignment`,
      assignmentBody()
    ],
    [
      "transition",
      `/api/asset-operations/work-orders/${WORK_ORDER_ID}/transition`,
      transitionBody()
    ],
    ["note", `/api/asset-operations/work-orders/${WORK_ORDER_ID}/notes`, noteBody()],
    ["evidence", `/api/asset-operations/work-orders/${WORK_ORDER_ID}/evidence`, evidenceBody()]
  ])("denies work-order %s without asset_work_order:manage", async (_case, path, body) => {
    expect((await post(path, body, "view", SOURCE_KEY)).status).toBe(403);
  });

  it("denies restriction creation without vehicle_restriction:manage", async () => {
    const response = await post(
      `/api/asset-operations/vehicles/${VEHICLE_ID}/restrictions`,
      restrictionBody(),
      "view",
      SOURCE_KEY
    );
    expect(response.status).toBe(403);
  });

  it("allows either ordinary or approval release permission to reach type-specific service authorization", async () => {
    for (const token of ["release", "approve"]) {
      const response = await post(
        `/api/asset-operations/restrictions/${RESTRICTION_ID}/release`,
        releaseBody(),
        token,
        SOURCE_KEY
      );
      expect(response.status).toBe(201);
    }
    expect(service.releaseRestriction).toHaveBeenCalledTimes(2);
  });

  it.each(writeCases())(
    "requires exactly one nonblank Idempotency-Key for %s",
    async (_method, path, body, token) => {
      const missing = await post(path, body, token);
      const blank = await post(path, body, token, "   ");

      expect(missing.status).toBe(400);
      expect(blank.status).toBe(400);
      expect(await missing.json()).toMatchObject({
        code: ASSET_OPERATION_API_CODE.IDEMPOTENCY_KEY_REQUIRED
      });
    }
  );

  it("rejects duplicate and array-shaped Idempotency-Key values", async () => {
    const duplicate = await postWithRawHeaders(
      "/api/asset-operations/work-orders",
      createWorkOrderBody(),
      ["Idempotency-Key", `${SOURCE_KEY}:first`, "iDeMpOtEnCy-KeY", `${SOURCE_KEY}:second`]
    );
    expect(duplicate.status).toBe(400);
    expect(duplicate.body).toMatchObject({
      code: ASSET_OPERATION_API_CODE.IDEMPOTENCY_KEY_MULTIPLE
    });

    const controller = new AssetOperationsController(service as never);
    const request = {
      headers: { "idempotency-key": [SOURCE_KEY] },
      rawHeaders: ["Idempotency-Key", SOURCE_KEY],
      user: testUser("work")
    } as unknown as AuthenticatedRequest;
    expect(() => controller.createWorkOrder(createWorkOrderBody(), request)).toThrowError(
      BadRequestException
    );
  });

  it("rejects a header/body Idempotency-Key mismatch and a missing nested source", async () => {
    const mismatch = await post(
      "/api/asset-operations/work-orders",
      createWorkOrderBody(),
      "work",
      `${SOURCE_KEY}:different`
    );
    const missingSource = createWorkOrderBody() as Partial<ReturnType<typeof createWorkOrderBody>>;
    delete missingSource.source;
    const missing = await post(
      "/api/asset-operations/work-orders",
      missingSource,
      "work",
      SOURCE_KEY
    );

    expect(mismatch.status).toBe(400);
    expect(await mismatch.json()).toMatchObject({
      code: ASSET_OPERATION_API_CODE.IDEMPOTENCY_KEY_MISMATCH
    });
    expect(missing.status).toBe(400);
    expect(service.createWorkOrder).not.toHaveBeenCalled();
  });

  it("validates UUIDs, ISO dates, enums, hashes, and bounded trimmed strings before delegation", async () => {
    const malformedPath = await post(
      "/api/asset-operations/work-orders/not-a-uuid/notes",
      noteBody(),
      "work",
      SOURCE_KEY
    );
    const malformedBody = await post(
      `/api/asset-operations/work-orders/${WORK_ORDER_ID}/evidence`,
      {
        ...evidenceBody(),
        contentSha256: "A".repeat(64),
        fileId: "not-a-uuid",
        occurredAt: "not-a-date",
        source: { ...source(), type: "   " }
      },
      "work",
      SOURCE_KEY
    );
    const malformedQuery = await get(
      `/api/asset-operations/vehicles/${VEHICLE_ID}/availability?purpose=UNKNOWN&asOf=not-a-date`,
      "view"
    );

    expect(malformedPath.status).toBe(400);
    expect(malformedBody.status).toBe(400);
    expect(malformedQuery.status).toBe(400);
    expect(service.appendEvidence).not.toHaveBeenCalled();
    expect(service.getVehicleAvailability).not.toHaveBeenCalled();
  });

  it("rejects invalid evidence action/file/hash/supersession shapes at the DTO boundary", async () => {
    const attachMissingFile = await post(
      `/api/asset-operations/work-orders/${WORK_ORDER_ID}/evidence`,
      { ...evidenceBody(), contentSha256: null, fileId: null },
      "work",
      SOURCE_KEY
    );
    const removeWithFile = await post(
      `/api/asset-operations/work-orders/${WORK_ORDER_ID}/evidence`,
      {
        ...evidenceBody(),
        action: AssetWorkOrderEvidenceAction.REMOVE,
        supersedesEvidenceId: null
      },
      "work",
      SOURCE_KEY
    );

    expect(attachMissingFile.status).toBe(400);
    expect(removeWithFile.status).toBe(400);
    expect(service.appendEvidence).not.toHaveBeenCalled();
  });

  it("trims bounded operator strings before service delegation", async () => {
    const create = await post(
      "/api/asset-operations/work-orders",
      createWorkOrderBody(),
      "work",
      SOURCE_KEY
    );
    const note = await post(
      `/api/asset-operations/work-orders/${WORK_ORDER_ID}/notes`,
      noteBody(),
      "work",
      SOURCE_KEY
    );

    expect(create.status).toBe(201);
    expect(note.status).toBe(201);
    expect(service.createWorkOrder).toHaveBeenCalledWith(
      expect.objectContaining({ description: "inspect vehicle" }),
      expect.any(Object)
    );
    expect(service.appendNote).toHaveBeenCalledWith(
      expect.objectContaining({ note: "operator note" }),
      expect.any(Object)
    );
  });

  it("returns JSON-safe evidence outcomes without private replay envelopes", async () => {
    service.appendEvidence
      .mockResolvedValueOnce(evidenceCommandOutcome(true) as never)
      .mockResolvedValueOnce(evidenceCommandOutcome(false) as never);

    const firstResponse = await post(
      `/api/asset-operations/work-orders/${WORK_ORDER_ID}/evidence`,
      evidenceBody(),
      "work",
      SOURCE_KEY
    );
    const replayResponse = await post(
      `/api/asset-operations/work-orders/${WORK_ORDER_ID}/evidence`,
      evidenceBody(),
      "work",
      SOURCE_KEY
    );

    expect(firstResponse.status).toBe(201);
    expect(replayResponse.status).toBe(201);
    const first = await firstResponse.json();
    const replay = await replayResponse.json();
    expect(first).toMatchObject({
      evidence: {
        fileSizeBytes: "12",
        recordedAt: "2026-08-20T00:04:00.000Z"
      },
      event: { detailSnapshot: { evidenceType: "PHOTO" } }
    });
    expect(JSON.stringify(first)).not.toContain("__assetOperationCommandV1");
    expect(first).not.toHaveProperty("wrote");
    expect(replay).toEqual(first);
  });

  it("omits private replay envelopes from non-evidence write outcomes", async () => {
    service.createWorkOrder.mockResolvedValueOnce({
      event: {
        detailSnapshot: {
          __assetOperationCommandV1: { command: "private" },
          workOrderType: AssetWorkOrderType.MAINTENANCE
        },
        id: SOURCE_ID
      },
      workOrder: { id: WORK_ORDER_ID },
      wrote: true
    } as never);

    const response = await post(
      "/api/asset-operations/work-orders",
      createWorkOrderBody(),
      "work",
      SOURCE_KEY
    );

    expect(response.status).toBe(201);
    const body = await response.json();
    expect(body).toMatchObject({
      event: {
        detailSnapshot: { workOrderType: AssetWorkOrderType.MAINTENANCE },
        id: SOURCE_ID
      },
      workOrder: { id: WORK_ORDER_ID }
    });
    expect(JSON.stringify(body)).not.toContain("__assetOperationCommandV1");
    expect(body).not.toHaveProperty("wrote");
  });

  it.each(writeCases())(
    "returns an exact stable public %s outcome for first-write and replay",
    async (method, path, body, token) => {
      service[method]
        .mockResolvedValueOnce(commandOutcome(method, true) as never)
        .mockResolvedValueOnce(commandOutcome(method, false) as never);

      const firstResponse = await post(path, body, token, SOURCE_KEY);
      const replayResponse = await post(path, body, token, SOURCE_KEY);

      expect(firstResponse.status).toBe(201);
      expect(replayResponse.status).toBe(201);
      const first = await firstResponse.json();
      const replay = await replayResponse.json();
      expect(first).not.toHaveProperty("wrote");
      expect(replay).toEqual(first);
    }
  );

  it.each(writeCases())(
    "forwards %s with path authority, normalized dates, and authenticated request context",
    async (method, path, body, token) => {
      const response = await post(
        path,
        {
          ...body,
          actorId: "spoofed-actor",
          ipAddress: "spoofed-ip",
          permissions: ["spoofed:permission"],
          userAgent: "spoofed-agent"
        },
        token,
        SOURCE_KEY
      );

      expect(response.status).toBe(201);
      expect(service[method]).toHaveBeenCalledWith(
        expect.objectContaining({
          occurredAt: expect.any(Date),
          source: expect.objectContaining({ key: SOURCE_KEY })
        }),
        expect.objectContaining({
          actorId: ACTOR_ID,
          ipAddress: expect.any(String),
          permissions: testUser(token).permissions,
          userAgent: "asset-operations-controller-test"
        })
      );
      const [command, context] = service[method].mock.calls.at(-1)!;
      expect(command).not.toHaveProperty("actorId");
      expect(command).not.toHaveProperty("ipAddress");
      expect(command).not.toHaveProperty("permissions");
      expect(command).not.toHaveProperty("userAgent");
      expect(context.actorId).not.toBe("spoofed-actor");
    }
  );

  it("forwards path IDs and read query context without inventing command actors", async () => {
    expect((await get(`/api/asset-operations/work-orders/${WORK_ORDER_ID}`, "view")).status).toBe(
      200
    );
    expect(
      (await get(`/api/asset-operations/vehicles/${VEHICLE_ID}/work-orders`, "view")).status
    ).toBe(200);
    expect(
      (await get(`/api/asset-operations/vehicles/${VEHICLE_ID}/restrictions`, "view")).status
    ).toBe(200);
    expect(
      (
        await get(
          `/api/asset-operations/vehicles/${VEHICLE_ID}/availability?purpose=DELIVERY&asOf=2026-08-20T00:00:00.000Z`,
          "view"
        )
      ).status
    ).toBe(200);

    expect(service.getWorkOrderDetail).toHaveBeenCalledWith(WORK_ORDER_ID);
    expect(service.listVehicleWorkOrders).toHaveBeenCalledWith(VEHICLE_ID);
    expect(service.listVehicleRestrictions).toHaveBeenCalledWith(VEHICLE_ID);
    expect(service.getVehicleAvailability).toHaveBeenCalledWith(
      VEHICLE_ID,
      "DELIVERY",
      new Date("2026-08-20T00:00:00.000Z")
    );
  });

  it.each([
    [new NotFoundException({ code: "ASSET_OPERATION_WORK_ORDER_NOT_FOUND" }), 404],
    [new ConflictException({ code: "ASSET_OPERATION_SOURCE_CONFLICT" }), 409],
    [new ForbiddenException({ code: "VEHICLE_RESTRICTION_RELEASE_FORBIDDEN" }), 403]
  ])("preserves stable service error status and code", async (error, status) => {
    service.releaseRestriction.mockRejectedValueOnce(error);
    const response = await post(
      `/api/asset-operations/restrictions/${RESTRICTION_ID}/release`,
      releaseBody(),
      "approve",
      SOURCE_KEY
    );
    expect(response.status).toBe(status);
    expect(await response.json()).toHaveProperty("code");
  });

  it.each(routeMetadata())(
    "registers %s with the exact route and permission contract",
    (method, path, verb, metadataKey, permissions) => {
      const handler = AssetOperationsController.prototype[method];
      expect(Reflect.getMetadata(PATH_METADATA, handler)).toBe(path);
      expect(Reflect.getMetadata(METHOD_METADATA, handler)).toBe(verb);
      expect(Reflect.getMetadata(metadataKey, handler)).toEqual(permissions);
    }
  );

  function get(path: string, token?: string) {
    return fetch(`${baseUrl}${path}`, {
      headers: token ? { authorization: `Bearer ${token}` } : undefined
    });
  }

  function post(path: string, body: object, token: string, idempotencyKey?: string) {
    return fetch(`${baseUrl}${path}`, {
      body: JSON.stringify(body),
      headers: {
        authorization: `Bearer ${token}`,
        "content-type": "application/json",
        ...(idempotencyKey === undefined ? {} : { "idempotency-key": idempotencyKey }),
        "user-agent": "asset-operations-controller-test"
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
        "Authorization: Bearer work",
        "Content-Type: application/json",
        `Content-Length: ${Buffer.byteLength(payload)}`,
        "Connection: close",
        ...headers.reduce<string[]>((lines, value, index) => {
          if (index % 2 === 0) lines.push(`${value}: ${headers[index + 1]}`);
          return lines;
        }, []),
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

describe("AssetOperationsModule registration", () => {
  it("registers the governed boundary and imports it from AppModule", () => {
    expect(Reflect.getMetadata(MODULE_METADATA.CONTROLLERS, AssetOperationsModule)).toEqual([
      AssetOperationsController
    ]);
    expect(Reflect.getMetadata(MODULE_METADATA.PROVIDERS, AssetOperationsModule)).toEqual([
      AssetOperationsRepository,
      AssetOperationsService
    ]);
    expect(Reflect.getMetadata(MODULE_METADATA.IMPORTS, AssetOperationsModule)).toEqual([
      AuditModule,
      AuthModule,
      PrismaModule
    ]);
    expect(Reflect.getMetadata(MODULE_METADATA.IMPORTS, AppModule)).toContain(
      AssetOperationsModule
    );
  });
});

function testUser(token: string) {
  const permissionsByToken: Record<string, PermissionCode[]> = {
    approve: [PermissionCode.VEHICLE_RESTRICTION_APPROVE_RELEASE],
    none: [],
    release: [PermissionCode.VEHICLE_RESTRICTION_RELEASE],
    restriction: [PermissionCode.VEHICLE_RESTRICTION_MANAGE],
    view: [PermissionCode.ASSET_OPERATIONS_VIEW],
    work: [PermissionCode.ASSET_WORK_ORDER_MANAGE]
  };
  return {
    id: ACTOR_ID,
    menus: [],
    name: "Asset Operations Tester",
    permissions: permissionsByToken[token] ?? [],
    roles: [],
    username: "asset-operations-test"
  };
}

function source() {
  return { id: SOURCE_ID, key: SOURCE_KEY, type: "MANUAL_OPERATION" };
}

function createWorkOrderBody() {
  return {
    assetOwnerId: null,
    contractId: null,
    costConfirmationRequired: true,
    customerId: null,
    description: "  inspect vehicle  ",
    metadata: { channel: "manual" },
    occurredAt: "2026-08-20T00:00:00.000Z",
    orderId: null,
    priority: AssetWorkOrderPriority.HIGH,
    relatedWorkOrderId: null,
    source: source(),
    vehicleId: VEHICLE_ID,
    workOrderType: AssetWorkOrderType.MAINTENANCE
  };
}

function assignmentBody() {
  return {
    assignedUserId: USER_ID,
    detailSnapshot: { reason: "dispatch" },
    expectedVersion: 1,
    occurredAt: "2026-08-20T00:01:00.000Z",
    scheduledAt: "2026-08-21T00:00:00.000Z",
    slaDueAt: null,
    source: source()
  };
}

function transitionBody() {
  return {
    closeReason: null,
    detailSnapshot: { reason: "start" },
    expectedVersion: 2,
    occurredAt: "2026-08-20T00:02:00.000Z",
    solution: null,
    source: source(),
    targetStatus: AssetWorkOrderStatus.IN_PROGRESS
  };
}

function noteBody() {
  return {
    note: "  operator note  ",
    occurredAt: "2026-08-20T00:03:00.000Z",
    source: source()
  };
}

function evidenceBody() {
  return {
    action: AssetWorkOrderEvidenceAction.ATTACH,
    capturedAt: "2026-08-20T00:03:00.000Z",
    captureMetadata: { camera: "field" },
    contentSha256: "a".repeat(64),
    eventId: null,
    evidenceType: AssetWorkOrderEvidenceType.PHOTO,
    fileId: FILE_ID,
    occurredAt: "2026-08-20T00:04:00.000Z",
    source: source(),
    supersedesEvidenceId: null
  };
}

function evidenceCommandOutcome(wrote: boolean) {
  return {
    evidence: {
      action: AssetWorkOrderEvidenceAction.ATTACH,
      captureMetadata: { camera: "field" },
      contentSha256: "a".repeat(64),
      fileId: FILE_ID,
      fileSizeBytes: 12n,
      id: EVIDENCE_ID,
      recordedAt: new Date("2026-08-20T00:04:00.000Z"),
      workOrderId: WORK_ORDER_ID
    },
    event: {
      detailSnapshot: {
        __assetOperationCommandV1: { command: "private" },
        evidenceType: AssetWorkOrderEvidenceType.PHOTO
      },
      id: SOURCE_ID
    },
    workOrder: { id: WORK_ORDER_ID },
    wrote
  };
}

function commandOutcome(method: string, wrote: boolean) {
  if (method === "appendEvidence") return evidenceCommandOutcome(wrote);
  const common = {
    event: {
      detailSnapshot: {
        __assetOperationCommandV1: { command: "private" },
        operation: method
      },
      id: SOURCE_ID
    },
    workOrder: { id: WORK_ORDER_ID },
    wrote
  };
  if (method === "createRestriction" || method === "releaseRestriction") {
    return { ...common, restriction: { id: RESTRICTION_ID } };
  }
  return common;
}

function restrictionBody() {
  return {
    conditionsSnapshot: { condition: "inspection complete" },
    evidenceSnapshot: null,
    occurredAt: "2026-08-20T00:05:00.000Z",
    restrictionType: VehicleOperationalRestrictionType.REINSPECTION_PENDING,
    scopes: [VehicleOperationalRestrictionScope.ALLOCATION],
    severity: VehicleOperationalRestrictionSeverity.BLOCKING,
    source: source(),
    startedAt: "2026-08-20T00:05:00.000Z",
    workOrderId: WORK_ORDER_ID
  };
}

function releaseBody() {
  return {
    occurredAt: "2026-08-20T00:06:00.000Z",
    releaseReason: "  approved after inspection  ",
    releaseSnapshot: { approved: true },
    source: source(),
    targetStatus: VehicleOperationalRestrictionStatus.RELEASED
  };
}

function writeCases() {
  return [
    ["createWorkOrder", "/api/asset-operations/work-orders", createWorkOrderBody(), "work"],
    [
      "assignWorkOrder",
      `/api/asset-operations/work-orders/${WORK_ORDER_ID}/assignment`,
      assignmentBody(),
      "work"
    ],
    [
      "transitionWorkOrder",
      `/api/asset-operations/work-orders/${WORK_ORDER_ID}/transition`,
      transitionBody(),
      "work"
    ],
    ["appendNote", `/api/asset-operations/work-orders/${WORK_ORDER_ID}/notes`, noteBody(), "work"],
    [
      "appendEvidence",
      `/api/asset-operations/work-orders/${WORK_ORDER_ID}/evidence`,
      evidenceBody(),
      "work"
    ],
    [
      "createRestriction",
      `/api/asset-operations/vehicles/${VEHICLE_ID}/restrictions`,
      restrictionBody(),
      "restriction"
    ],
    [
      "releaseRestriction",
      `/api/asset-operations/restrictions/${RESTRICTION_ID}/release`,
      releaseBody(),
      "approve"
    ]
  ] as const;
}

function routeMetadata() {
  return [
    [
      "getWorkOrderDetail",
      "work-orders/:id",
      RequestMethod.GET,
      REQUIRED_PERMISSIONS_KEY,
      [PermissionCode.ASSET_OPERATIONS_VIEW]
    ],
    [
      "listVehicleWorkOrders",
      "vehicles/:vehicleId/work-orders",
      RequestMethod.GET,
      REQUIRED_PERMISSIONS_KEY,
      [PermissionCode.ASSET_OPERATIONS_VIEW]
    ],
    [
      "listVehicleRestrictions",
      "vehicles/:vehicleId/restrictions",
      RequestMethod.GET,
      REQUIRED_PERMISSIONS_KEY,
      [PermissionCode.ASSET_OPERATIONS_VIEW]
    ],
    [
      "getVehicleAvailability",
      "vehicles/:vehicleId/availability",
      RequestMethod.GET,
      REQUIRED_PERMISSIONS_KEY,
      [PermissionCode.ASSET_OPERATIONS_VIEW]
    ],
    [
      "createWorkOrder",
      "work-orders",
      RequestMethod.POST,
      REQUIRED_PERMISSIONS_KEY,
      [PermissionCode.ASSET_WORK_ORDER_MANAGE]
    ],
    [
      "assignWorkOrder",
      "work-orders/:id/assignment",
      RequestMethod.POST,
      REQUIRED_PERMISSIONS_KEY,
      [PermissionCode.ASSET_WORK_ORDER_MANAGE]
    ],
    [
      "transitionWorkOrder",
      "work-orders/:id/transition",
      RequestMethod.POST,
      REQUIRED_PERMISSIONS_KEY,
      [PermissionCode.ASSET_WORK_ORDER_MANAGE]
    ],
    [
      "appendNote",
      "work-orders/:id/notes",
      RequestMethod.POST,
      REQUIRED_PERMISSIONS_KEY,
      [PermissionCode.ASSET_WORK_ORDER_MANAGE]
    ],
    [
      "appendEvidence",
      "work-orders/:id/evidence",
      RequestMethod.POST,
      REQUIRED_PERMISSIONS_KEY,
      [PermissionCode.ASSET_WORK_ORDER_MANAGE]
    ],
    [
      "createRestriction",
      "vehicles/:vehicleId/restrictions",
      RequestMethod.POST,
      REQUIRED_PERMISSIONS_KEY,
      [PermissionCode.VEHICLE_RESTRICTION_MANAGE]
    ],
    [
      "releaseRestriction",
      "restrictions/:id/release",
      RequestMethod.POST,
      REQUIRED_ANY_PERMISSIONS_KEY,
      [
        PermissionCode.VEHICLE_RESTRICTION_RELEASE,
        PermissionCode.VEHICLE_RESTRICTION_APPROVE_RELEASE
      ]
    ]
  ] as const;
}
