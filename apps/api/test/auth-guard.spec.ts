import { UnauthorizedException } from "@nestjs/common";
import { describe, expect, it, vi } from "vitest";

import { AuthGuard } from "../src/auth/auth.guard";
import { AuthService } from "../src/auth/auth.service";

describe("AuthGuard", () => {
  it("rejects malformed access_token cookies as unauthorized instead of surfacing token parser errors", async () => {
    const authService = new AuthService(
      {} as never,
      { get: vi.fn((key: string) => key === "JWT_SECRET" ? "admin-jwt-secret" : undefined) } as never,
      {} as never
    );
    const guard = new AuthGuard(authService);

    await expect(
      guard.canActivate(contextFor({ cookies: { access_token: "field-task-token" }, headers: {} }))
    ).rejects.toThrow(UnauthorizedException);
  });
});

function contextFor(request: { cookies?: Record<string, string>; headers?: Record<string, string> }) {
  return {
    switchToHttp: () => ({
      getRequest: () => request
    })
  } as never;
}
