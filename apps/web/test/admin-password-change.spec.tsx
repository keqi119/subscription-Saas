import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";

import { AccountActions } from "../src/components/account-actions";
import {
  ChangePasswordFormFields,
  submitPasswordChange
} from "../src/components/change-password-modal";
import {
  buildChangePasswordRequest,
  changeAdminPassword,
  ChangePasswordValidationError
} from "../src/lib/change-password";

describe("admin self password change", () => {
  it("renders a self-service password action without requiring a business permission", () => {
    const html = renderToStaticMarkup(
      <AccountActions
        onChangePassword={() => undefined}
        onLogout={() => undefined}
        userLabel="系统管理员 (admin)"
      />
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
      {
        confirmPassword: "Different@123",
        currentPassword: "Current@123",
        newPassword: "NewSecret@123"
      },
      "PASSWORD_CONFIRMATION_MISMATCH"
    ],
    [
      {
        confirmPassword: "Current@123",
        currentPassword: "Current@123",
        newPassword: "Current@123"
      },
      "PASSWORD_REUSE_NOT_ALLOWED"
    ],
    [
      {
        confirmPassword: "密".repeat(25),
        currentPassword: "Current@123",
        newPassword: "密".repeat(25)
      },
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

  it("renders current, new and confirmation password fields", () => {
    const html = renderToStaticMarkup(<ChangePasswordFormFields />);
    expect(html).toContain("当前密码");
    expect(html).toContain("新密码");
    expect(html).toContain("确认新密码");
    expect(html.match(/type="password"/g)).toHaveLength(3);
  });

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

    expect(requests).toEqual([
      { currentPassword: "Current@123", newPassword: "NewSecret@123" }
    ]);
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
});
