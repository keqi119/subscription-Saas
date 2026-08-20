import "reflect-metadata";

import { ConflictException, INestApplication, RequestMethod, ValidationPipe } from "@nestjs/common";
import { METHOD_METADATA, MODULE_METADATA, PATH_METADATA } from "@nestjs/common/constants";
import { Reflector } from "@nestjs/core";
import { Test } from "@nestjs/testing";
import {
  VehicleOwnershipPeriodEndReason,
  VehicleOwnershipPeriodStartReason,
  VehicleSubscriptionPeriodEndReason,
  VehicleSubscriptionPeriodStartReason
} from "@prisma/client";
import { PermissionCode } from "@subscription-saas/shared";
import { AddressInfo, createConnection } from "node:net";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

import { REQUIRED_PERMISSIONS_KEY } from "../src/auth/auth.decorators";
import { AuthGuard } from "../src/auth/auth.guard";
import { AuthService } from "../src/auth/auth.service";
import { PermissionsGuard } from "../src/auth/permissions.guard";
import { AppModule } from "../src/app.module";
import { AssetFactsController } from "../src/asset-facts/asset-facts.controller";
import { AssetFactsModule } from "../src/asset-facts/asset-facts.module";
import { AssetFactsRepository } from "../src/asset-facts/asset-facts.repository";
import { AssetFactsService } from "../src/asset-facts/asset-facts.service";
import { AuditModule } from "../src/audit/audit.module";
import { AuthModule } from "../src/auth/auth.module";
import { PrismaModule } from "../src/prisma/prisma.module";

const ACTOR_ID = "00000000-0000-4000-8000-000000000001";
const VEHICLE_ID = "00000000-0000-4000-8000-000000000101";
const ORDER_ID = "00000000-0000-4000-8000-000000000102";
const CUSTOMER_ID = "00000000-0000-4000-8000-000000000103";
const CONTRACT_ID = "00000000-0000-4000-8000-000000000104";
const CONTRACT_SEGMENT_ID = "00000000-0000-4000-8000-000000000105";
const OWNER_ID = "00000000-0000-4000-8000-000000000106";
const SUBSCRIPTION_PERIOD_ID = "00000000-0000-4000-8000-000000000107";
const OWNERSHIP_PERIOD_ID = "00000000-0000-4000-8000-000000000108";
const SOURCE_ID = "00000000-0000-4000-8000-000000000109";
const SOURCE_KEY = "asset-facts-controller:test:v1";

describe("AssetFactsController administrative boundary", () => {
  let app: INestApplication;
  let baseUrl: string;

  const service = {
    closeOwnershipPeriod: vi.fn().mockResolvedValue({ id: OWNERSHIP_PERIOD_ID }),
    closeSubscriptionPeriod: vi.fn().mockResolvedValue({ id: SUBSCRIPTION_PERIOD_ID }),
    getByOrder: vi.fn().mockResolvedValue({ order: { id: ORDER_ID } }),
    getByVehicle: vi.fn().mockResolvedValue({ vehicle: { id: VEHICLE_ID } }),
    openOwnershipPeriod: vi.fn().mockResolvedValue({ id: OWNERSHIP_PERIOD_ID }),
    openSubscriptionPeriod: vi.fn().mockResolvedValue({ id: SUBSCRIPTION_PERIOD_ID })
  };

  beforeAll(async () => {
    const authService = {
      validateToken: vi.fn(async (token: string) => testUser(token))
    };
    const moduleRef = await Test.createTestingModule({
      controllers: [AssetFactsController],
      providers: [
        { provide: AssetFactsService, useValue: service },
        { provide: AuthService, useValue: authService },
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

  beforeEach(() => {
    vi.clearAllMocks();
  });

  afterAll(async () => {
    await app.close();
  });

  it("requires authentication before vehicle fact history can be read", async () => {
    const response = await get(`/api/asset-facts/vehicles/${VEHICLE_ID}`);

    expect(response.status).toBe(401);
    expect(service.getByVehicle).not.toHaveBeenCalled();
  });

  it.each([
    ["vehicle history", `/api/asset-facts/vehicles/${VEHICLE_ID}`, "none"],
    ["order history", `/api/asset-facts/orders/${ORDER_ID}`, "none"]
  ])("denies %s without asset_facts:view", async (_case, path, token) => {
    const response = await get(path, token);

    expect(response.status).toBe(403);
  });

  it.each([
    [
      "ownership open",
      "/api/asset-facts/admin/ownership-periods/open",
      ownershipOpenBody(),
      "view"
    ],
    [
      "ownership close",
      "/api/asset-facts/admin/ownership-periods/close",
      ownershipCloseBody(),
      "view"
    ],
    [
      "subscription open",
      "/api/asset-facts/admin/subscription-periods/open",
      subscriptionOpenBody(),
      "owner"
    ],
    [
      "subscription close",
      "/api/asset-facts/admin/subscription-periods/close",
      subscriptionCloseBody(),
      "owner"
    ]
  ])("denies %s without its management permission", async (_case, path, body, token) => {
    const response = await post(path, body, token, SOURCE_KEY);

    expect(response.status).toBe(403);
  });

  it("delegates both read projections after the view guard succeeds", async () => {
    const vehicleResponse = await get(`/api/asset-facts/vehicles/${VEHICLE_ID}`, "view");
    const orderResponse = await get(`/api/asset-facts/orders/${ORDER_ID}`, "view");

    expect(vehicleResponse.status).toBe(200);
    expect(orderResponse.status).toBe(200);
    expect(service.getByVehicle).toHaveBeenCalledWith(VEHICLE_ID);
    expect(service.getByOrder).toHaveBeenCalledWith(ORDER_ID);
  });

  it.each([
    [
      "ownership open",
      "/api/asset-facts/admin/ownership-periods/open",
      ownershipOpenBody(),
      "owner"
    ],
    [
      "ownership close",
      "/api/asset-facts/admin/ownership-periods/close",
      ownershipCloseBody(),
      "owner"
    ],
    [
      "subscription open",
      "/api/asset-facts/admin/subscription-periods/open",
      subscriptionOpenBody(),
      "period"
    ],
    [
      "subscription close",
      "/api/asset-facts/admin/subscription-periods/close",
      subscriptionCloseBody(),
      "period"
    ]
  ])("requires a nonblank Idempotency-Key for %s", async (_case, path, body, token) => {
    const missing = await post(path, body, token);
    const blank = await post(path, body, token, "   ");

    expect(missing.status).toBe(400);
    expect(blank.status).toBe(400);
    expect(await missing.json()).toMatchObject({ code: "IDEMPOTENCY_KEY_REQUIRED" });
  });

  it("fails closed when the DTO source key differs from Idempotency-Key", async () => {
    const response = await post(
      "/api/asset-facts/admin/subscription-periods/open",
      subscriptionOpenBody(),
      "period",
      "different-command-key"
    );

    expect(response.status).toBe(400);
    expect(await response.json()).toMatchObject({ code: "IDEMPOTENCY_KEY_MISMATCH" });
    expect(service.openSubscriptionPeriod).not.toHaveBeenCalled();
  });

  it("exposes the stable authority-busy conflict as HTTP 409 without raw database details", async () => {
    service.openSubscriptionPeriod.mockRejectedValueOnce(
      new ConflictException({
        code: "ASSET_FACT_AUTHORITY_BUSY",
        message: "Asset fact authority is being updated. Review the current state and retry."
      })
    );

    const response = await post(
      "/api/asset-facts/admin/subscription-periods/open",
      subscriptionOpenBody(),
      "period",
      SOURCE_KEY
    );

    expect(response.status).toBe(409);
    const body = await response.json();
    expect(body).toMatchObject({
      code: "ASSET_FACT_AUTHORITY_BUSY",
      message: "Asset fact authority is being updated. Review the current state and retry."
    });
    expect(JSON.stringify(body)).not.toContain("55P03");
    expect(JSON.stringify(body)).not.toContain("postgresql://");
  });

  it("rejects duplicate Idempotency-Key fields before normalized values can delegate", async () => {
    const firstKey = `${SOURCE_KEY}:first`;
    const secondKey = `${SOURCE_KEY}:second`;
    const body = subscriptionOpenBody();
    body.source.key = `${firstKey}, ${secondKey}`;

    const response = await postWithRawHeaders(
      "/api/asset-facts/admin/subscription-periods/open",
      body,
      ["Idempotency-Key", firstKey, "Idempotency-Key", secondKey]
    );

    expect(response.status).toBe(400);
    expect(response.body).toMatchObject({ code: "IDEMPOTENCY_KEY_MULTIPLE" });
    expect(service.openSubscriptionPeriod).not.toHaveBeenCalled();
  });

  it("rejects duplicate Idempotency-Key fields whose names use different casing", async () => {
    const firstKey = `${SOURCE_KEY}:mixed-first`;
    const secondKey = `${SOURCE_KEY}:mixed-second`;
    const body = subscriptionOpenBody();
    body.source.key = `${firstKey}, ${secondKey}`;

    const response = await postWithRawHeaders(
      "/api/asset-facts/admin/subscription-periods/open",
      body,
      ["IDEMPOTENCY-KEY", firstKey, "iDeMpOtEnCy-KeY", secondKey]
    );

    expect(response.status).toBe(400);
    expect(response.body).toMatchObject({ code: "IDEMPOTENCY_KEY_MULTIPLE" });
    expect(service.openSubscriptionPeriod).not.toHaveBeenCalled();
  });

  it("rejects a missing nested source at the controller DTO boundary", async () => {
    const body: Partial<ReturnType<typeof ownershipOpenBody>> = ownershipOpenBody();
    delete body.source;

    const response = await post(
      "/api/asset-facts/admin/ownership-periods/open",
      body,
      "owner",
      SOURCE_KEY
    );

    expect(response.status).toBe(400);
    expect(service.openOwnershipPeriod).not.toHaveBeenCalled();
  });

  it("rejects malformed command fields before service delegation", async () => {
    const response = await post(
      "/api/asset-facts/admin/subscription-periods/close",
      {
        ...subscriptionCloseBody(),
        confirmedAt: "not-a-date",
        periodId: "not-a-uuid",
        reason: "NOT_A_REASON"
      },
      "period",
      SOURCE_KEY
    );

    expect(response.status).toBe(400);
    expect(service.closeSubscriptionPeriod).not.toHaveBeenCalled();
  });

  it.each([
    [
      "openOwnershipPeriod",
      "/api/asset-facts/admin/ownership-periods/open",
      ownershipOpenBody(),
      "owner"
    ],
    [
      "closeOwnershipPeriod",
      "/api/asset-facts/admin/ownership-periods/close",
      ownershipCloseBody(),
      "owner"
    ],
    [
      "openSubscriptionPeriod",
      "/api/asset-facts/admin/subscription-periods/open",
      subscriptionOpenBody(),
      "period"
    ],
    [
      "closeSubscriptionPeriod",
      "/api/asset-facts/admin/subscription-periods/close",
      subscriptionCloseBody(),
      "period"
    ]
  ] as const)(
    "delegates %s with the header source key and authenticated audit context",
    async (method, path, body, token) => {
      const response = await post(
        path,
        {
          ...body,
          actorId: "spoofed-actor",
          ipAddress: "spoofed-ip",
          userAgent: "spoofed-user-agent"
        },
        token,
        SOURCE_KEY
      );

      expect(response.status).toBe(201);
      expect(service[method]).toHaveBeenCalledWith(
        expect.objectContaining({
          source: expect.objectContaining({ key: SOURCE_KEY })
        }),
        expect.objectContaining({
          actorId: ACTOR_ID,
          ipAddress: expect.any(String),
          userAgent: "asset-facts-controller-test"
        })
      );
      const [delegatedDto, delegatedContext] = service[method].mock.calls[0]!;
      expect(delegatedDto).not.toHaveProperty("actorId");
      expect(delegatedDto).not.toHaveProperty("ipAddress");
      expect(delegatedDto).not.toHaveProperty("userAgent");
      expect(delegatedContext).not.toMatchObject({
        actorId: "spoofed-actor",
        ipAddress: "spoofed-ip",
        userAgent: "spoofed-user-agent"
      });
    }
  );

  it.each([
    ["getByVehicle", "vehicles/:vehicleId", RequestMethod.GET, PermissionCode.ASSET_FACTS_VIEW],
    ["getByOrder", "orders/:orderId", RequestMethod.GET, PermissionCode.ASSET_FACTS_VIEW],
    [
      "openOwnershipPeriod",
      "admin/ownership-periods/open",
      RequestMethod.POST,
      PermissionCode.ASSET_OWNER_MANAGE
    ],
    [
      "closeOwnershipPeriod",
      "admin/ownership-periods/close",
      RequestMethod.POST,
      PermissionCode.ASSET_OWNER_MANAGE
    ],
    [
      "openSubscriptionPeriod",
      "admin/subscription-periods/open",
      RequestMethod.POST,
      PermissionCode.VEHICLE_PERIOD_MANAGE
    ],
    [
      "closeSubscriptionPeriod",
      "admin/subscription-periods/close",
      RequestMethod.POST,
      PermissionCode.VEHICLE_PERIOD_MANAGE
    ]
  ] as const)(
    "registers %s as an explicitly permissioned route",
    (method, path, verb, permission) => {
      const handler = AssetFactsController.prototype[method];

      expect(Reflect.getMetadata(PATH_METADATA, handler)).toBe(path);
      expect(Reflect.getMetadata(METHOD_METADATA, handler)).toBe(verb);
      expect(Reflect.getMetadata(REQUIRED_PERMISSIONS_KEY, handler)).toEqual([permission]);
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
        "user-agent": "asset-facts-controller-test"
      },
      method: "POST"
    });
  }

  function postWithRawHeaders(path: string, body: object, idempotencyHeaders: string[]) {
    return new Promise<{ body: unknown; status: number }>((resolve, reject) => {
      const payload = JSON.stringify(body);
      const endpoint = new URL(baseUrl);
      const headerLines: string[] = [];
      for (let index = 0; index + 1 < idempotencyHeaders.length; index += 2) {
        headerLines.push(`${idempotencyHeaders[index]}: ${idempotencyHeaders[index + 1]}`);
      }
      const rawRequest = [
        `POST ${path} HTTP/1.1`,
        `Host: ${endpoint.host}`,
        "Authorization: Bearer period",
        "Content-Type: application/json",
        `Content-Length: ${Buffer.byteLength(payload)}`,
        "User-Agent: asset-facts-controller-test",
        "Connection: close",
        ...headerLines,
        "",
        payload
      ].join("\r\n");
      const chunks: Buffer[] = [];
      const socket = createConnection(Number(endpoint.port), endpoint.hostname, () => {
        socket.write(rawRequest);
      });
      socket.on("data", (chunk: Buffer) => chunks.push(chunk));
      socket.on("error", reject);
      socket.on("end", () => {
        const rawResponse = Buffer.concat(chunks).toString("utf8");
        const [head = "", responseBody = ""] = rawResponse.split("\r\n\r\n", 2);
        const status = Number(head.match(/^HTTP\/1\.1 (\d{3})/)?.[1] ?? 0);
        resolve({
          body: responseBody ? (JSON.parse(responseBody) as unknown) : null,
          status
        });
      });
    });
  }
});

describe("AssetFactsModule registration", () => {
  it("registers the governed boundary and its command dependencies in AppModule", () => {
    expect(Reflect.getMetadata(MODULE_METADATA.CONTROLLERS, AssetFactsModule)).toEqual([
      AssetFactsController
    ]);
    expect(Reflect.getMetadata(MODULE_METADATA.PROVIDERS, AssetFactsModule)).toEqual([
      AssetFactsRepository,
      AssetFactsService
    ]);
    expect(Reflect.getMetadata(MODULE_METADATA.IMPORTS, AssetFactsModule)).toEqual([
      AuditModule,
      AuthModule,
      PrismaModule
    ]);
    expect(Reflect.getMetadata(MODULE_METADATA.IMPORTS, AppModule)).toContain(AssetFactsModule);
  });
});

function testUser(token: string) {
  const permissionsByToken: Record<string, PermissionCode[]> = {
    none: [],
    owner: [PermissionCode.ASSET_OWNER_MANAGE],
    period: [PermissionCode.VEHICLE_PERIOD_MANAGE],
    view: [PermissionCode.ASSET_FACTS_VIEW]
  };
  return {
    id: ACTOR_ID,
    menus: [],
    name: "Asset Facts Tester",
    permissions: permissionsByToken[token] ?? [],
    roles: [],
    username: "asset-facts-test"
  };
}

function source() {
  return {
    id: SOURCE_ID,
    key: SOURCE_KEY,
    type: "MANUAL_REPAIR"
  };
}

function subscriptionOpenBody() {
  return {
    confirmedAt: "2026-08-01T00:05:00.000Z",
    contractId: CONTRACT_ID,
    contractSegmentId: CONTRACT_SEGMENT_ID,
    customerId: CUSTOMER_ID,
    orderId: ORDER_ID,
    reason: VehicleSubscriptionPeriodStartReason.MANUAL_REPAIR,
    snapshot: { note: "repair subscription start" },
    source: source(),
    startedAt: "2026-08-01T00:00:00.000Z",
    vehicleId: VEHICLE_ID
  };
}

function subscriptionCloseBody() {
  return {
    confirmedAt: "2026-10-01T00:05:00.000Z",
    endedAt: "2026-10-01T00:00:00.000Z",
    periodId: SUBSCRIPTION_PERIOD_ID,
    reason: VehicleSubscriptionPeriodEndReason.MANUAL_REPAIR,
    snapshot: { note: "repair subscription close" },
    source: source()
  };
}

function ownershipOpenBody() {
  return {
    assetOwnerId: OWNER_ID,
    confirmedAt: "2026-08-01T00:05:00.000Z",
    reason: VehicleOwnershipPeriodStartReason.MANUAL_REPAIR,
    snapshot: { note: "repair ownership start" },
    source: source(),
    startedAt: "2026-08-01T00:00:00.000Z",
    vehicleId: VEHICLE_ID
  };
}

function ownershipCloseBody() {
  return {
    confirmedAt: "2026-10-01T00:05:00.000Z",
    endedAt: "2026-10-01T00:00:00.000Z",
    periodId: OWNERSHIP_PERIOD_ID,
    reason: VehicleOwnershipPeriodEndReason.MANUAL_REPAIR,
    snapshot: { note: "repair ownership close" },
    source: source()
  };
}
