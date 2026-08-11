import { NotificationType } from "@prisma/client";
import { describe, expect, it } from "vitest";

import {
  buildGoldenPathWechatTemplateData,
  formatWechatAmountFromCents
} from "../src/notification/wechat-template-data";

const now = new Date(2026, 7, 10, 9, 8, 7);

describe("Golden Path WeChat template data", () => {
  it("maps application progress to the exact approved fields", () => {
    expect(
      buildGoldenPathWechatTemplateData({
        data: { applicationNo: "APP-20260810-001" },
        notificationType: NotificationType.APPLICATION_PROGRESS,
        now
      })
    ).toEqual({
      data: {
        character_string3: "APP-20260810-001",
        const4: "审核中",
        const5: "车辆订阅申请",
        time6: "2026-08-10 09:08"
      },
      error: null
    });
  });

  it("maps final plan to the exact approved fields", () => {
    expect(
      buildGoldenPathWechatTemplateData({
        data: { applicationNo: "APP-1", plateNo: "沪DGJ578" },
        notificationType: NotificationType.FINAL_PLAN_PENDING,
        now
      })
    ).toEqual({
      data: {
        car_number8: "沪DGJ578",
        character_string2: "APP-1",
        phrase5: "待确认",
        thing13: "车辆订阅最终方案",
        time9: "2026-08-10 09:08"
      },
      error: null
    });
  });

  it("maps contract and handover to their exact approved fields", () => {
    const common = {
      customerName: "验收客户",
      modelDisplayName: "NIO 蔚来 ES6 2024款",
      orderNo: "ORD-1",
      plateNo: "沪DGJ578"
    };

    expect(
      buildGoldenPathWechatTemplateData({
        data: common,
        notificationType: NotificationType.CONTRACT_PENDING,
        now
      })
    ).toEqual({
      data: {
        character_string2: "ORD-1",
        thing1: "验收客户",
        thing3: "NIO 蔚来 ES6 2024款",
        thing6: "车辆订阅主合同"
      },
      error: null
    });

    expect(
      buildGoldenPathWechatTemplateData({
        data: common,
        notificationType: NotificationType.HANDOVER_ESIGN_PENDING,
        now
      })
    ).toEqual({
      data: {
        car_number5: "沪DGJ578",
        character_string1: "ORD-1",
        thing11: "验收客户",
        thing9: "NIO 蔚来 ES6 2024款"
      },
      error: null
    });
  });

  it("maps payment amounts and due time without floating point arithmetic", () => {
    expect(
      buildGoldenPathWechatTemplateData({
        data: {
          hasDepositBill: true,
          initialBillAmountCents: "900719925474099301",
          initialBillDueAt: new Date(2026, 7, 12, 18, 30).toISOString(),
          initialBillRemainingCents: "1",
          plateNo: "沪DGJ578"
        },
        notificationType: NotificationType.PAYMENT_PENDING,
        now
      })
    ).toEqual({
      data: {
        amount4: "9007199254740993.01",
        amount7: "0.01",
        car_number1: "沪DGJ578",
        thing2: "押金及首期租金",
        time5: "2026-08-12 18:30"
      },
      error: null
    });

    expect(
      buildGoldenPathWechatTemplateData({
        data: {
          hasDepositBill: false,
          initialBillAmountCents: "540000",
          initialBillDueAt: new Date(2026, 7, 12, 18, 30),
          initialBillRemainingCents: "540000",
          plateNo: "沪DGJ578"
        },
        notificationType: NotificationType.PAYMENT_PENDING,
        now
      })?.data?.thing2
    ).toBe("首期租金");

    expect(formatWechatAmountFromCents("540000")).toBe("5400.00");
    expect(formatWechatAmountFromCents(1n)).toBe("0.01");
  });

  it("truncates identifiers and thing values by Unicode code point", () => {
    const result = buildGoldenPathWechatTemplateData({
      data: {
        customerName: "客户😀".repeat(12),
        modelDisplayName: "车型🚗".repeat(12),
        orderNo: "单😀".repeat(20),
        plateNo: "沪DGJ578"
      },
      notificationType: NotificationType.HANDOVER_ESIGN_PENDING,
      now
    });
    if (!result) throw new Error("Expected Golden Path template data.");

    expect(Array.from(result.data?.character_string1 ?? "")).toHaveLength(32);
    expect(Array.from(result.data?.thing9 ?? "")).toHaveLength(20);
    expect(Array.from(result.data?.thing11 ?? "")).toHaveLength(20);
    expect(result.data?.thing9).toContain("🚗");
  });

  it.each([
    [NotificationType.APPLICATION_PROGRESS, {}, "applicationNo"],
    [NotificationType.FINAL_PLAN_PENDING, { applicationNo: "APP-1" }, "plateNo"],
    [NotificationType.CONTRACT_PENDING, { orderNo: "ORD-1" }, "modelDisplayName"],
    [
      NotificationType.CONTRACT_PENDING,
      { modelDisplayName: "ES6", orderNo: "ORD-1" },
      "customerName"
    ],
    [NotificationType.PAYMENT_PENDING, { plateNo: "沪DGJ578" }, "initialBillAmountCents"],
    [
      NotificationType.PAYMENT_PENDING,
      { initialBillAmountCents: "100", plateNo: "沪DGJ578" },
      "initialBillRemainingCents"
    ],
    [
      NotificationType.PAYMENT_PENDING,
      {
        initialBillAmountCents: "100",
        initialBillRemainingCents: "100",
        plateNo: "沪DGJ578"
      },
      "initialBillDueAt"
    ],
    [NotificationType.HANDOVER_ESIGN_PENDING, { orderNo: "ORD-1" }, "modelDisplayName"]
  ])("fails closed for %s when %s is missing", (notificationType, data, field) => {
    expect(buildGoldenPathWechatTemplateData({ data, notificationType, now })).toEqual({
      data: null,
      error: `WECHAT_TEMPLATE_DATA_MISSING:${field}`
    });
  });

  it("returns null for notification types outside the five Golden Path templates", () => {
    expect(
      buildGoldenPathWechatTemplateData({
        data: {},
        notificationType: NotificationType.SYSTEM,
        now
      })
    ).toBeNull();
  });
});
