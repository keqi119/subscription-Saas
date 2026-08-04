import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";

import { PortalAutoDebitStatusCard } from "../src/app/portal/auto-debit/auto-debit-status-card";

describe("PortalAutoDebitStatusCard", () => {
  it("renders customer actions without provider secrets or test controls", () => {
    const html = renderToStaticMarkup(
      <PortalAutoDebitStatusCard
        model={{
          canEnroll: false,
          canPay: true,
          canRevoke: true,
          description: "系统将在账单到期日发起扣款。",
          helper: "主动支付始终可用。",
          nextActionAt: "2026-09-02T00:00:00.000Z",
          state: "ACTIVE",
          title: "自动扣款已开通",
          tone: "success"
        }}
        onPay={vi.fn()}
        onRevoke={vi.fn()}
      />
    );

    expect(html).toContain('data-testid="portal-auto-debit-status"');
    expect(html).toContain("自动扣款已开通");
    expect(html).toContain("立即支付");
    expect(html).toContain("关闭自动扣款");
    expect(html).not.toMatch(/providerReference|providerSnapshot|nextResult|mock/i);
  });

  it("keeps the 390px journey mobile-safe and excludes provider control fields", () => {
    const css = readFileSync(
      fileURLToPath(
        new URL("../src/app/portal/auto-debit/auto-debit.module.css", import.meta.url)
      ),
      "utf8"
    );
    const page = readFileSync(
      fileURLToPath(new URL("../src/app/portal/auto-debit/page.tsx", import.meta.url)),
      "utf8"
    );

    expect(css).toContain("@media (max-width: 480px)");
    expect(css).toContain("min-width: 0");
    expect(css).toContain("overflow-wrap: anywhere");
    expect(page).toContain("确认自动扣款授权");
    expect(page).not.toMatch(/providerReference|providerSnapshot|nextResult/);
  });
});
