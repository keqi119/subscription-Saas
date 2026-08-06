import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";

import { AccountActions } from "../src/components/account-actions";
import {
  ChangePasswordFormFields,
  performPasswordChange,
  submitPasswordChange
} from "../src/components/change-password-modal";
import { finishPasswordChangeSession } from "../src/components/protected-shell";
import { ApiError } from "../src/lib/api";
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

  it("reports an API error without resetting or completing the modal flow", async () => {
    const events: string[] = [];

    await expect(
      performPasswordChange(
        {
          confirmPassword: "NewSecret@123",
          currentPassword: "Wrong@123",
          newPassword: "NewSecret@123"
        },
        passwordEffects(events),
        async () => {
          throw new ApiError("当前密码不正确", 400, "CURRENT_PASSWORD_INCORRECT");
        }
      )
    ).resolves.toBe(false);

    expect(events).toEqual(["error:当前密码不正确"]);
  });

  it("runs reset, success message and completion only after the API resolves", async () => {
    const events: string[] = [];
    let release: ((value: { success: true }) => void) | undefined;
    const pending = new Promise<{ success: true }>((resolve) => {
      release = resolve;
    });
    const result = performPasswordChange(
      {
        confirmPassword: "NewSecret@123",
        currentPassword: "Current@123",
        newPassword: "NewSecret@123"
      },
      passwordEffects(events),
      async () => pending
    );

    await Promise.resolve();
    expect(events).toEqual([]);
    release?.({ success: true });
    await expect(result).resolves.toBe(true);
    expect(events).toEqual([
      "reset",
      "success:密码已修改，请重新登录",
      "changed"
    ]);
  });

  it("closes the modal and redirects to login when the password flow completes", () => {
    const events: string[] = [];

    finishPasswordChangeSession(
      { replace: (target: string) => events.push(`redirect:${target}`) } as never,
      () => events.push("close")
    );

    expect(events).toEqual(["close", "redirect:/login"]);
  });
});

function passwordEffects(events: string[]) {
  return {
    onChanged: () => events.push("changed"),
    onError: (message: string) => events.push(`error:${message}`),
    onReset: () => events.push("reset"),
    onSuccess: (message: string) => events.push(`success:${message}`)
  };
}
