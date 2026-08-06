# Admin Self Password Change Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Allow every authenticated Back Office user to verify the current password, set a different password, and be signed out of the current browser with an atomic redacted audit trail.

**Architecture:** Add a guarded `POST /auth/change-password` boundary to the existing Admin authentication module. Keep credential verification and the old-hash conditional update in `AuthService`, reuse `AuditService` inside the same Prisma transaction, and expose the action through a focused modal launched from the protected shell header. No schema, seed, menu, or RBAC change is required.

**Tech Stack:** NestJS 11, Prisma 7, PostgreSQL, bcryptjs 3, class-validator, Next.js 16 App Router, React 19, Ant Design 6, Vitest 4, TypeScript 6.

## Global Constraints

- Work only in `D:/Projects/auto-subscription-platform/.worktrees/admin-self-password-change-20260806` on `feat/admin-self-password-change-20260806`.
- Follow `AGENTS.md` and `DEV_SPEC.md`; do not expose `RENT_TO_OWN` or change unrelated business flows.
- Use TDD for every production behavior: write the focused test, observe the expected failure, then implement the minimum change.
- Password hashes use bcrypt cost 12. Never log, audit, return, or commit plaintext passwords or password hashes.
- `currentPassword` remains compatible with historical bcrypt input; only `newPassword` is rejected above 72 UTF-8 bytes.
- The target user ID comes only from `request.user.id`; no request field may select another user.
- Password update and `AuditAction.UPDATE` creation must commit atomically.
- Successful change clears only the current `access_token` Cookie. Existing JWTs in other browsers remain valid until their current expiry.
- Do not add a Prisma migration, permission, menu, seed assignment, dependency, staging deployment, or environment-variable change.
- Keep unrelated files and the main checkout's pre-existing untracked directories out of the branch.

---

### Task 1: Authenticated Password Change API

**Files:**

- Create: `apps/api/src/auth/dto/change-password.dto.ts`
- Create: `apps/api/test/auth-password-change.spec.ts`
- Modify: `apps/api/src/auth/auth.service.ts`
- Modify: `apps/api/src/auth/auth.controller.ts`

**Interfaces:**

- Consumes: `AuthGuard`, `AuthenticatedRequest`, `RequestContext`, `AuditService.write`, `PrismaService.$transaction`, and the existing `User.passwordHash` field.
- Produces: `ChangePasswordDto { currentPassword: string; newPassword: string }`.
- Produces: `AuthService.changePassword(userId: string, dto: ChangePasswordDto, context: RequestContext): Promise<{ success: true }>`.
- Produces: guarded `POST /auth/change-password`, which clears `access_token` only after the service succeeds.
- Produces error codes: `CURRENT_PASSWORD_INCORRECT`, `PASSWORD_REUSE_NOT_ALLOWED`, `PASSWORD_TOO_LONG`, and `PASSWORD_CHANGE_CONFLICT`.

- [x] **Step 1: Write failing service behavior tests with a stateful transaction harness**

Create `apps/api/test/auth-password-change.spec.ts`. Use the real `AuthService`, real `AuditService`, and real bcrypt comparisons. The fake Prisma boundary must mutate an in-memory user and append audit rows so assertions observe business state rather than mock existence.

```typescript
import { BadRequestException, ConflictException, UnauthorizedException } from "@nestjs/common";
import { AuditAction, UserStatus } from "@prisma/client";
import bcrypt from "bcryptjs";
import { describe, expect, it } from "vitest";

import { AuditService } from "../src/audit/audit.service";
import { AuthService } from "../src/auth/auth.service";

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
  });

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
  });

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
  });

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
  });

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
  });

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
  });

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
  });
});
```

The harness must expose the complete user fields read by production code (`id`, `username`, `passwordHash`, `status`, `deletedAt`) and implement these exact effects:

```typescript
async function createHarness(options: { auditFails?: boolean; forceConflict?: boolean } = {}) {
  const user = {
    deletedAt: null as Date | null,
    id: "00000000-0000-4000-8000-000000000001",
    passwordHash: await bcrypt.hash("Current@123", 12),
    status: UserStatus.ACTIVE,
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
```

- [x] **Step 2: Run the service tests and confirm RED**

Run:

```powershell
pnpm --filter @subscription-saas/api exec vitest run --project unit test/auth-password-change.spec.ts
```

Expected: FAIL because `AuthService.changePassword` does not exist. Do not proceed on a syntax, fixture, or import failure; correct the test until the missing behavior is the reason for RED.

- [x] **Step 3: Add DTO and minimal password-change service**

Create `apps/api/src/auth/dto/change-password.dto.ts`:

```typescript
import { IsString, MinLength } from "class-validator";

export class ChangePasswordDto {
  @IsString()
  @MinLength(8)
  currentPassword!: string;

  @IsString()
  @MinLength(8)
  newPassword!: string;
}
```

In `AuthService`, add `BadRequestException` and `ConflictException` imports, import `ChangePasswordDto`, and implement the exact sequence from the design:

```typescript
async changePassword(userId: string, dto: ChangePasswordDto, context: RequestContext) {
  if (Buffer.byteLength(dto.newPassword, "utf8") > 72) {
    throw new BadRequestException({
      code: "PASSWORD_TOO_LONG",
      message: "New password must not exceed 72 UTF-8 bytes."
    });
  }

  const user = await this.prisma.user.findUnique({
    select: { deletedAt: true, id: true, passwordHash: true, status: true, username: true },
    where: { id: userId }
  });
  if (!user || user.deletedAt || user.status !== UserStatus.ACTIVE) {
    throw new UnauthorizedException("Invalid access token.");
  }

  if (!(await bcrypt.compare(dto.currentPassword, user.passwordHash))) {
    throw new BadRequestException({
      code: "CURRENT_PASSWORD_INCORRECT",
      message: "Current password is incorrect."
    });
  }
  if (await bcrypt.compare(dto.newPassword, user.passwordHash)) {
    throw new BadRequestException({
      code: "PASSWORD_REUSE_NOT_ALLOWED",
      message: "New password must be different from the current password."
    });
  }

  const passwordHash = await bcrypt.hash(dto.newPassword, 12);
  await this.prisma.$transaction(async (transaction) => {
    const changed = await transaction.user.updateMany({
      data: { passwordHash, updatedBy: user.id },
      where: {
        deletedAt: null,
        id: user.id,
        passwordHash: user.passwordHash,
        status: UserStatus.ACTIVE
      }
    });
    if (changed.count !== 1) {
      throw new ConflictException({
        code: "PASSWORD_CHANGE_CONFLICT",
        message: "Password state changed. Sign in again and retry."
      });
    }
    await this.auditService.write(
      {
        action: AuditAction.UPDATE,
        after: { credential: "password", selfService: true },
        before: { credential: "password" },
        entityId: user.id,
        entityType: "user",
        ipAddress: context.ipAddress,
        module: "system",
        operatorId: user.id,
        userAgent: context.userAgent
      },
      transaction
    );
  });

  return { success: true as const };
}
```

- [x] **Step 4: Run the service tests and confirm GREEN**

Run the Step 2 command again.

Expected: all `AuthService.changePassword` cases PASS. If the conflict case leaks an audit row, fix the transaction harness or production ordering rather than weakening the assertion.

- [x] **Step 5: Add failing controller boundary tests**

Extend `apps/api/test/auth-password-change.spec.ts` with these imports and controller tests:

```typescript
import { GUARDS_METADATA } from "@nestjs/common/constants";
import { AuthController } from "../src/auth/auth.controller";
import { AuthGuard } from "../src/auth/auth.guard";

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
```

The production mutation caught by these tests is accepting a body-supplied user ID, clearing the Cookie before the service succeeds, or exposing the route without authentication.

- [x] **Step 6: Run controller tests and confirm RED**

Run the focused API test command again.

Expected: FAIL because `AuthController.changePassword` is missing.

- [x] **Step 7: Implement the guarded controller endpoint**

Import `ChangePasswordDto`, then add:

```typescript
@Post("change-password")
@UseGuards(AuthGuard)
async changePassword(
  @Body() dto: ChangePasswordDto,
  @Req() request: AuthenticatedRequest,
  @Res({ passthrough: true }) response: Response
) {
  const result = await this.authService.changePassword(request.user.id, dto, {
    ipAddress: request.ip,
    userAgent: request.headers["user-agent"]
  });
  response.clearCookie("access_token");
  return result;
}
```

Do not add `PermissionsGuard` or `RequirePermissions`: this is a self-service authentication operation.

- [x] **Step 8: Run API GREEN checks**

Run:

```powershell
pnpm --filter @subscription-saas/api exec vitest run --project unit test/auth-password-change.spec.ts test/auth-user.spec.ts test/auth-guard.spec.ts
pnpm --filter @subscription-saas/api exec eslint src/auth test/auth-password-change.spec.ts
pnpm --filter @subscription-saas/api typecheck
```

Expected: focused tests, lint, and API typecheck all PASS.

- [x] **Step 9: Commit the API boundary**

```powershell
git add apps/api/src/auth/dto/change-password.dto.ts apps/api/src/auth/auth.service.ts apps/api/src/auth/auth.controller.ts apps/api/test/auth-password-change.spec.ts
git commit -m "feat: add self service password API"
```

---

### Task 2: Header Entry and Password Modal

**Files:**

- Create: `apps/web/src/lib/change-password.ts`
- Create: `apps/web/src/components/account-actions.tsx`
- Create: `apps/web/src/components/change-password-modal.tsx`
- Create: `apps/web/test/admin-password-change.spec.tsx`
- Modify: `apps/web/src/components/protected-shell.tsx`

**Interfaces:**

- Consumes: `apiFetch`, `ApiError`, `AuthMeResponse`, Ant Design `Form`, `Input.Password`, `Modal`, and Next.js router.
- Produces: `ChangePasswordFormValues`, `ChangePasswordRequest`, `buildChangePasswordRequest(values)`, and `changeAdminPassword(request)`.
- Produces: `AccountActions({ userLabel, onChangePassword, onLogout })` visible to every authenticated user.
- Produces: `ChangePasswordModal({ open, onCancel, onChanged })` that calls the API and reports success only after the server clears the Cookie.

- [x] **Step 1: Write failing password-rule and request-boundary tests**

Create `apps/web/test/admin-password-change.spec.tsx`:

```typescript
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";

import { AccountActions } from "../src/components/account-actions";
import {
  buildChangePasswordRequest,
  changeAdminPassword,
  ChangePasswordValidationError
} from "../src/lib/change-password";

describe("admin self password change", () => {
  it("renders a self-service password action without requiring a business permission", () => {
    const html = renderToStaticMarkup(
      <AccountActions userLabel="系统管理员 (admin)" onChangePassword={() => undefined} onLogout={() => undefined} />
    );
    expect(html).toContain("系统管理员 (admin)");
    expect(html).toContain("修改密码");
    expect(html).toContain("退出登录");
  });

  it("builds an API request without sending confirmation password", () => {
    expect(
      buildChangePasswordRequest({
        confirmPassword: "NewSecret@123",
        currentPassword: "Current@123",
        newPassword: "NewSecret@123"
      })
    ).toEqual({ currentPassword: "Current@123", newPassword: "NewSecret@123" });
  });

  it.each([
    [
      { confirmPassword: "Different@123", currentPassword: "Current@123", newPassword: "NewSecret@123" },
      "PASSWORD_CONFIRMATION_MISMATCH"
    ],
    [
      { confirmPassword: "Current@123", currentPassword: "Current@123", newPassword: "Current@123" },
      "PASSWORD_REUSE_NOT_ALLOWED"
    ],
    [
      { confirmPassword: "密".repeat(25), currentPassword: "Current@123", newPassword: "密".repeat(25) },
      "PASSWORD_TOO_LONG"
    ]
  ] as const)("rejects invalid form values", (values, code) => {
    let caught: unknown;
    try {
      buildChangePasswordRequest(values);
    } catch (error) {
      caught = error;
    }
    expect(caught).toBeInstanceOf(ChangePasswordValidationError);
    expect(caught).toMatchObject({ code });
  });

  it("posts the exact password request to the authenticated API", async () => {
    const fetchMock = vi.spyOn(globalThis, "fetch").mockResolvedValue(
      new Response(JSON.stringify({ success: true }), {
        headers: { "Content-Type": "application/json" },
        status: 200
      })
    );

    await expect(
      changeAdminPassword({ currentPassword: "Current@123", newPassword: "NewSecret@123" })
    ).resolves.toEqual({ success: true });
    expect(fetchMock).toHaveBeenCalledWith(
      expect.stringMatching(/\/auth\/change-password$/),
      expect.objectContaining({
        body: JSON.stringify({ currentPassword: "Current@123", newPassword: "NewSecret@123" }),
        credentials: "include",
        method: "POST"
      })
    );
    fetchMock.mockRestore();
  });
});
```

If `apiFetch` merges headers into the second argument differently, keep the assertion focused on URL, method, credentials, and body rather than framework-owned header ordering.

- [x] **Step 2: Run Web tests and confirm RED**

Run:

```powershell
pnpm --filter @subscription-saas/web exec vitest run test/admin-password-change.spec.tsx
```

Expected: FAIL because the change-password library and account component do not exist.

- [x] **Step 3: Implement pure validation and API request functions**

Create `apps/web/src/lib/change-password.ts`:

```typescript
import { apiFetch } from "./api";

export interface ChangePasswordFormValues {
  confirmPassword: string;
  currentPassword: string;
  newPassword: string;
}

export interface ChangePasswordRequest {
  currentPassword: string;
  newPassword: string;
}

export type ChangePasswordValidationCode =
  | "CURRENT_PASSWORD_TOO_SHORT"
  | "NEW_PASSWORD_TOO_SHORT"
  | "PASSWORD_CONFIRMATION_MISMATCH"
  | "PASSWORD_REUSE_NOT_ALLOWED"
  | "PASSWORD_TOO_LONG";

export class ChangePasswordValidationError extends Error {
  constructor(
    readonly code: ChangePasswordValidationCode,
    message: string
  ) {
    super(message);
  }
}

export function buildChangePasswordRequest(
  values: ChangePasswordFormValues
): ChangePasswordRequest {
  if (values.currentPassword.length < 8) {
    throw new ChangePasswordValidationError("CURRENT_PASSWORD_TOO_SHORT", "当前密码至少 8 位");
  }
  if (values.newPassword.length < 8) {
    throw new ChangePasswordValidationError("NEW_PASSWORD_TOO_SHORT", "新密码至少 8 位");
  }
  if (new TextEncoder().encode(values.newPassword).byteLength > 72) {
    throw new ChangePasswordValidationError("PASSWORD_TOO_LONG", "新密码最多 72 个 UTF-8 字节");
  }
  if (values.currentPassword === values.newPassword) {
    throw new ChangePasswordValidationError(
      "PASSWORD_REUSE_NOT_ALLOWED",
      "新密码不能与当前密码相同"
    );
  }
  if (values.newPassword !== values.confirmPassword) {
    throw new ChangePasswordValidationError(
      "PASSWORD_CONFIRMATION_MISMATCH",
      "两次输入的新密码不一致"
    );
  }
  return { currentPassword: values.currentPassword, newPassword: values.newPassword };
}

export function changeAdminPassword(request: ChangePasswordRequest) {
  return apiFetch<{ success: true }>("/auth/change-password", {
    body: JSON.stringify(request),
    method: "POST"
  });
}
```

- [x] **Step 4: Implement the account actions component and confirm its render test turns GREEN**

Create `apps/web/src/components/account-actions.tsx` with a visible user label and two real buttons:

```tsx
"use client";

import { KeyOutlined, LogoutOutlined } from "@ant-design/icons";
import { Button, Space, Typography } from "antd";

export function AccountActions({
  onChangePassword,
  onLogout,
  userLabel
}: Readonly<{ onChangePassword: () => void; onLogout: () => void; userLabel: string }>) {
  return (
    <Space>
      <Typography.Text>{userLabel}</Typography.Text>
      <Button icon={<KeyOutlined />} onClick={onChangePassword} type="text">
        修改密码
      </Button>
      <Button aria-label="退出登录" icon={<LogoutOutlined />} onClick={onLogout} type="text">
        退出登录
      </Button>
    </Space>
  );
}
```

Run the focused Web test. Expected: the account render and pure validation/request cases PASS; no modal behavior is claimed yet.

- [x] **Step 5: Add failing modal contract tests before creating the modal**

Extend the Web test with server rendering for an exported `ChangePasswordFormFields`:

```typescript
it("renders current, new and confirmation password fields", () => {
  const html = renderToStaticMarkup(<ChangePasswordFormFields />);
  expect(html).toContain("当前密码");
  expect(html).toContain("新密码");
  expect(html).toContain("确认新密码");
  expect(html.match(/type="password"/g)).toHaveLength(3);
});
```

Add exact behavioral tests for exported `submitPasswordChange(values, request)`:

```typescript
it("returns success only after the password API resolves", async () => {
  const requests: Array<{ currentPassword: string; newPassword: string }> = [];
  let release: ((value: { success: true }) => void) | undefined;
  const pending = new Promise<{ success: true }>((resolve) => {
    release = resolve;
  });
  const result = submitPasswordChange(
    {
      confirmPassword: "NewSecret@123",
      currentPassword: "Current@123",
      newPassword: "NewSecret@123"
    },
    async (request) => {
      requests.push(request);
      return pending;
    }
  );

  expect(requests).toEqual([{ currentPassword: "Current@123", newPassword: "NewSecret@123" }]);
  let settled = false;
  void result.finally(() => {
    settled = true;
  });
  await Promise.resolve();
  expect(settled).toBe(false);
  release?.({ success: true });
  await expect(result).resolves.toEqual({ success: true });
});

it("propagates the API error instead of reporting a successful password change", async () => {
  await expect(
    submitPasswordChange(
      {
        confirmPassword: "NewSecret@123",
        currentPassword: "Current@123",
        newPassword: "NewSecret@123"
      },
      async () => {
        throw new Error("request failed");
      }
    )
  ).rejects.toThrow("request failed");
});
```

These tests catch returning success before the server has cleared the Cookie or swallowing an API failure.

Run the focused Web test and confirm RED because `ChangePasswordFormFields` and `submitPasswordChange` are missing.

- [x] **Step 6: Implement the modal and submission boundary**

Create `apps/web/src/components/change-password-modal.tsx`:

```tsx
"use client";

import { App, Form, Input, Modal } from "antd";
import { useState } from "react";

import { ApiError } from "../lib/api";
import {
  buildChangePasswordRequest,
  changeAdminPassword,
  type ChangePasswordFormValues,
  type ChangePasswordRequest,
  ChangePasswordValidationError
} from "../lib/change-password";

type PasswordRequest = (payload: ChangePasswordRequest) => Promise<{ success: true }>;

export function submitPasswordChange(
  values: ChangePasswordFormValues,
  request: PasswordRequest = changeAdminPassword
) {
  return request(buildChangePasswordRequest(values));
}

export function ChangePasswordFormFields() {
  return (
    <>
      <Form.Item label="当前密码" name="currentPassword" rules={[{ min: 8, required: true }]}>
        <Input.Password autoComplete="current-password" />
      </Form.Item>
      <Form.Item label="新密码" name="newPassword" rules={[{ min: 8, required: true }]}>
        <Input.Password autoComplete="new-password" />
      </Form.Item>
      <Form.Item label="确认新密码" name="confirmPassword" rules={[{ min: 8, required: true }]}>
        <Input.Password autoComplete="new-password" />
      </Form.Item>
    </>
  );
}

export function ChangePasswordModal({
  onCancel,
  onChanged,
  open
}: Readonly<{ onCancel: () => void; onChanged: () => void; open: boolean }>) {
  const { message } = App.useApp();
  const [form] = Form.useForm<ChangePasswordFormValues>();
  const [submitting, setSubmitting] = useState(false);

  const cancel = () => {
    if (submitting) return;
    form.resetFields();
    onCancel();
  };

  const submit = async () => {
    setSubmitting(true);
    try {
      const values = await form.validateFields();
      await submitPasswordChange(values);
      form.resetFields();
      void message.success("密码已修改，请重新登录");
      onChanged();
    } catch (error) {
      if (error instanceof ChangePasswordValidationError || error instanceof ApiError) {
        void message.error(error.message);
      }
    } finally {
      setSubmitting(false);
    }
  };

  return (
    <Modal
      cancelText="取消"
      confirmLoading={submitting}
      destroyOnHidden
      okText="修改密码"
      onCancel={cancel}
      onOk={() => void submit()}
      open={open}
      title="修改密码"
    >
      <Form form={form} layout="vertical">
        <ChangePasswordFormFields />
      </Form>
    </Modal>
  );
}
```

Do not make a second logout request: the API already cleared the Cookie. Form validation rejections stay within the modal, while typed validation/API errors display their safe message.

The submit handler must preserve this ordering:

```typescript
setSubmitting(true);
try {
  const values = await form.validateFields();
  await submitPasswordChange(values);
  form.resetFields();
  void message.success("密码已修改，请重新登录");
  onChanged();
} catch (error) {
  if (error instanceof ChangePasswordValidationError || error instanceof ApiError) {
    void message.error(error.message);
  }
} finally {
  setSubmitting(false);
}
```

- [x] **Step 7: Integrate the modal into `ProtectedShell`**

Modify `apps/web/src/components/protected-shell.tsx`:

- Replace the inline logout button with `AccountActions` while retaining role tags.
- Add `const [changePasswordOpen, setChangePasswordOpen] = useState(false)`.
- Derive `userLabel` as `me.user.name ? `${me.user.name} (${me.user.username})` : me.user.username`.
- Open the modal from `AccountActions` for every authenticated user; do not inspect `permissions`.
- Render `ChangePasswordModal` beside the shell layout.
- On `onChanged`, set `cachedAuthMe = null`, close the modal, and call `router.replace("/login")`.
- Keep the existing logout function and its API call unchanged.

- [x] **Step 8: Run Web GREEN checks**

Run:

```powershell
pnpm --filter @subscription-saas/web exec vitest run test/admin-password-change.spec.tsx
pnpm --filter @subscription-saas/web exec eslint src/components/protected-shell.tsx src/components/account-actions.tsx src/components/change-password-modal.tsx src/lib/change-password.ts test/admin-password-change.spec.tsx
pnpm --filter @subscription-saas/web typecheck
```

Expected: focused Web tests, lint, and typecheck all PASS.

- [x] **Step 9: Commit the Admin UI**

```powershell
git add apps/web/src/lib/change-password.ts apps/web/src/components/account-actions.tsx apps/web/src/components/change-password-modal.tsx apps/web/src/components/protected-shell.tsx apps/web/test/admin-password-change.spec.tsx
git commit -m "feat: add admin self password change"
```

---

### Task 3: Cross-Layer Verification and Handoff

**Files:**

- Modify: `docs/superpowers/plans/2026-08-06-admin-self-password-change-implementation-plan.md` (check completed steps)
- Verify only: `apps/api/prisma/schema.prisma`, migrations, auth API, and Admin Web build.

**Interfaces:**

- Consumes: Task 1 API and Task 2 Admin UI.
- Produces: evidence that the feature adds no migration/permission/seed change and preserves the existing authentication baseline.

- [x] **Step 1: Run focused cross-layer tests**

```powershell
pnpm --filter @subscription-saas/api exec vitest run --project unit test/auth-password-change.spec.ts test/auth-user.spec.ts test/auth-guard.spec.ts
pnpm --filter @subscription-saas/web exec vitest run test/admin-password-change.spec.tsx
```

Expected: all focused API and Web tests PASS.

- [x] **Step 2: Run the repository quality gate against the dedicated local PostgreSQL database**

```powershell
$env:DATABASE_URL="postgresql://subscription:subscription@127.0.0.1:55432/subscription_saas_codex?schema=public"
pnpm quality:gate
```

Expected: lint, Prisma validation/generation, API/Web typechecks, all API tests, and migration status PASS with 84 migrations up to date.

- [x] **Step 3: Run the production build**

```powershell
$env:DATABASE_URL="postgresql://subscription:subscription@127.0.0.1:55432/subscription_saas_codex?schema=public"
pnpm build
```

Expected: shared, Nest API, and Next.js Web builds all succeed. Restore `apps/web/next-env.d.ts` if Next.js rewrites only its generated route reference; do not commit that build artifact change.

- [x] **Step 4: Verify scope and security invariants**

```powershell
git diff --check origin/main..HEAD
git status --short
git diff --name-only origin/main..HEAD
git diff origin/main..HEAD -- apps/api/prisma apps/api/prisma/seed.mjs packages/shared/src/auth.ts packages/shared/src/menus.ts
```

Expected:

- no whitespace errors;
- no uncommitted feature files except the plan checkbox update;
- no Prisma schema/migration, seed, permission, or menu diff;
- no plaintext fixture password outside tests and no password/hash in audit assertions.

- [x] **Step 5: Request independent code review and address only evidence-backed findings**

Use `superpowers:requesting-code-review`. Review must explicitly examine:

- bcrypt 72-byte behavior;
- old-hash conditional update and audit atomicity;
- horizontal authorization boundary;
- Cookie clearing only after success;
- absence of password/hash leakage;
- UI accessibility and success/error ordering.

If a finding changes behavior, reproduce it with a failing test before editing production code.

- [x] **Step 6: Re-run completion verification after review changes**

Re-run Steps 1-4 after the last code change. Do not reuse earlier results.

- [x] **Step 7: Commit plan completion evidence**

Mark every completed checkbox in this plan, then run:

```powershell
git add docs/superpowers/plans/2026-08-06-admin-self-password-change-implementation-plan.md
git commit -m "docs: record password change verification"
git status -sb
git log --oneline --decorate -6
```

Expected: clean worktree on `feat/admin-self-password-change-20260806` with focused implementation commits after the design and plan commits.

- [x] **Step 8: Finish the branch without deploying staging**

Use `superpowers:finishing-a-development-branch` to offer local merge, Draft PR, or keep-as-is. Do not deploy to staging or rotate credentials again unless the user explicitly requests deployment after the branch is merged.
