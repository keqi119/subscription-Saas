import { BadRequestException, ConflictException, UnauthorizedException } from "@nestjs/common";
import { GUARDS_METADATA } from "@nestjs/common/constants";
import { AuditAction, UserStatus } from "@prisma/client";
import bcrypt from "bcryptjs";
import { describe, expect, it } from "vitest";

import { AuditService } from "../src/audit/audit.service";
import { AuthController } from "../src/auth/auth.controller";
import { AuthGuard } from "../src/auth/auth.guard";
import { AuthService } from "../src/auth/auth.service";

const BCRYPT_TEST_TIMEOUT_MS = 15_000;

describe("AuthService.changePassword", () => {
  it("rejects an incorrect current password without changing credentials or audit state", async () => {
    const harness = await createHarness();
    const originalHash = harness.user.passwordHash;

    await expect(
      harness.service.changePassword(
        harness.user.id,
        { currentPassword: "Wrong@123", newPassword: "NewSecret@123" },
        requestContext()
      )
    ).rejects.toMatchObject({
      response: { code: "CURRENT_PASSWORD_INCORRECT" },
      status: 400
    });

    expect(harness.user.passwordHash).toBe(originalHash);
    expect(harness.audits).toEqual([]);
  }, BCRYPT_TEST_TIMEOUT_MS);

  it("rejects reuse of the current password", async () => {
    const harness = await createHarness();

    await expect(
      harness.service.changePassword(
        harness.user.id,
        { currentPassword: "Current@123", newPassword: "Current@123" },
        requestContext()
      )
    ).rejects.toBeInstanceOf(BadRequestException);

    expect(harness.audits).toEqual([]);
  }, BCRYPT_TEST_TIMEOUT_MS);

  it.each([
    { deletedAt: new Date("2026-08-06T00:00:00.000Z"), status: UserStatus.ACTIVE },
    { deletedAt: null, status: UserStatus.DISABLED }
  ])("rejects password changes after the authenticated account becomes invalid", async (state) => {
    const harness = await createHarness();
    harness.user.deletedAt = state.deletedAt;
    harness.user.status = state.status;

    await expect(
      harness.service.changePassword(
        harness.user.id,
        { currentPassword: "Current@123", newPassword: "NewSecret@123" },
        requestContext()
      )
    ).rejects.toBeInstanceOf(UnauthorizedException);
    expect(harness.audits).toEqual([]);
  }, BCRYPT_TEST_TIMEOUT_MS);

  it("rejects a new password above 72 UTF-8 bytes while accepting the current password input", async () => {
    const harness = await createHarness();

    await expect(
      harness.service.changePassword(
        harness.user.id,
        { currentPassword: "Current@123", newPassword: "密".repeat(25) },
        requestContext()
      )
    ).rejects.toMatchObject({ response: { code: "PASSWORD_TOO_LONG" } });

    expect(harness.audits).toEqual([]);
  }, BCRYPT_TEST_TIMEOUT_MS);

  it("atomically installs a cost-12 hash and writes one redacted self-service audit", async () => {
    const harness = await createHarness();

    await expect(
      harness.service.changePassword(
        harness.user.id,
        { currentPassword: "Current@123", newPassword: "NewSecret@123" },
        requestContext()
      )
    ).resolves.toEqual({ success: true });

    expect(harness.user.passwordHash.startsWith("$2b$12$")).toBe(true);
    await expect(bcrypt.compare("NewSecret@123", harness.user.passwordHash)).resolves.toBe(true);
    expect(harness.audits).toHaveLength(1);
    expect(harness.audits[0]).toMatchObject({
      action: AuditAction.UPDATE,
      afterSnapshot: { credential: "password", selfService: true },
      beforeSnapshot: { credential: "password" },
      entityId: harness.user.id,
      entityType: "user",
      module: "system",
      operatorId: harness.user.id
    });
    expect(JSON.stringify(harness.audits)).not.toContain("Current@123");
    expect(JSON.stringify(harness.audits)).not.toContain("NewSecret@123");
    expect(JSON.stringify(harness.audits)).not.toContain("$2b$");
  }, BCRYPT_TEST_TIMEOUT_MS);

  it("rolls back the audit when the old-hash conditional update loses a race", async () => {
    const harness = await createHarness({ forceConflict: true });

    await expect(
      harness.service.changePassword(
        harness.user.id,
        { currentPassword: "Current@123", newPassword: "NewSecret@123" },
        requestContext()
      )
    ).rejects.toBeInstanceOf(ConflictException);

    expect(harness.audits).toEqual([]);
  }, BCRYPT_TEST_TIMEOUT_MS);

  it("rolls back the password update when the audit insert fails", async () => {
    const harness = await createHarness({ auditFails: true });
    const originalHash = harness.user.passwordHash;

    await expect(
      harness.service.changePassword(
        harness.user.id,
        { currentPassword: "Current@123", newPassword: "NewSecret@123" },
        requestContext()
      )
    ).rejects.toThrow("audit unavailable");

    expect(harness.user.passwordHash).toBe(originalHash);
    expect(harness.audits).toEqual([]);
  }, BCRYPT_TEST_TIMEOUT_MS);
});

describe("AuthController.changePassword", () => {
  it("uses only the authenticated user id and clears the admin cookie after success", async () => {
    const calls: unknown[] = [];
    const controller = new AuthController({
      changePassword: async (...args: unknown[]) => {
        calls.push(args);
        return { success: true as const };
      }
    } as never);
    const response = { clearCookie: (name: string) => calls.push(["clearCookie", name]) };
    const request = {
      headers: { "user-agent": "controller-test" },
      ip: "127.0.0.1",
      user: { id: "user-self" }
    };
    const dto = { currentPassword: "Current@123", newPassword: "NewSecret@123" };

    await expect(
      controller.changePassword(dto, request as never, response as never)
    ).resolves.toEqual({ success: true });
    expect(calls).toEqual([
      ["user-self", dto, { ipAddress: "127.0.0.1", userAgent: "controller-test" }],
      ["clearCookie", "access_token"]
    ]);
  });

  it("does not clear the cookie when the password service rejects", async () => {
    const cleared: string[] = [];
    const controller = new AuthController({
      changePassword: async () => {
        throw new BadRequestException({ code: "CURRENT_PASSWORD_INCORRECT" });
      }
    } as never);

    await expect(
      controller.changePassword(
        { currentPassword: "Wrong@123", newPassword: "NewSecret@123" },
        { headers: {}, ip: "127.0.0.1", user: { id: "user-self" } } as never,
        { clearCookie: (name: string) => cleared.push(name) } as never
      )
    ).rejects.toBeInstanceOf(BadRequestException);
    expect(cleared).toEqual([]);
  });

  it("protects the password endpoint with AuthGuard", () => {
    const guards =
      Reflect.getMetadata(GUARDS_METADATA, AuthController.prototype.changePassword) ?? [];
    expect(guards).toContain(AuthGuard);
  });
});

async function createHarness(options: { auditFails?: boolean; forceConflict?: boolean } = {}) {
  const user = {
    deletedAt: null as Date | null,
    id: "00000000-0000-4000-8000-000000000001",
    passwordHash: await bcrypt.hash("Current@123", 12),
    status: UserStatus.ACTIVE as UserStatus,
    username: "admin"
  };
  const audits: Array<Record<string, unknown>> = [];
  const transaction = {
    auditLog: {
      create: async ({ data }: { data: Record<string, unknown> }) => {
        if (options.auditFails) throw new Error("audit unavailable");
        audits.push(structuredClone(data));
        return data;
      }
    },
    user: {
      updateMany: async ({
        data,
        where
      }: {
        data: { passwordHash: string; updatedBy: string };
        where: Record<string, unknown>;
      }) => {
        if (
          options.forceConflict ||
          where.id !== user.id ||
          where.passwordHash !== user.passwordHash ||
          where.status !== UserStatus.ACTIVE ||
          where.deletedAt !== null
        ) {
          return { count: 0 };
        }
        user.passwordHash = data.passwordHash;
        return { count: 1 };
      }
    }
  };
  const prisma = {
    $transaction: async (work: (client: typeof transaction) => Promise<unknown>) => {
      const passwordHashBefore = user.passwordHash;
      const auditCountBefore = audits.length;
      try {
        return await work(transaction);
      } catch (error) {
        user.passwordHash = passwordHashBefore;
        audits.splice(auditCountBefore);
        throw error;
      }
    },
    auditLog: transaction.auditLog,
    user: {
      findUnique: async () => ({ ...user })
    }
  };
  const auditService = new AuditService(prisma as never);
  return {
    audits,
    service: new AuthService(auditService, { get: () => "test-secret" } as never, prisma as never),
    user
  };
}

function requestContext() {
  return { ipAddress: "127.0.0.1", userAgent: "auth-password-change-test" };
}
