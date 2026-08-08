"use client";

import { ArrowLeftOutlined, GiftOutlined } from "@ant-design/icons";
import { App, Button, Flex, Typography } from "antd";
import { useRouter, useSearchParams } from "next/navigation";
import { Suspense, useEffect, useMemo, useState } from "react";

import { PortalApiError, portalApiFetch } from "../../../lib/portal-api";
import {
  PortalEntitlementGrant,
  PortalEntitlementUsage,
  PortalPagedResponse
} from "../../../lib/portal-types";
import {
  PortalEntitlementGrantRecords,
  PortalEntitlementUsageRecords
} from "./entitlement-records";

function PortalEntitlementsContent() {
  const router = useRouter();
  const searchParams = useSearchParams();
  const { message } = App.useApp();
  const [grants, setGrants] = useState<PortalEntitlementGrant[]>([]);
  const [usages, setUsages] = useState<PortalEntitlementUsage[]>([]);
  const [loading, setLoading] = useState(true);
  const orderId = searchParams.get("orderId");
  const grantPath = useMemo(
    () => `/portal/entitlements${orderId ? `?orderId=${encodeURIComponent(orderId)}` : ""}`,
    [orderId]
  );
  const usagePath = useMemo(
    () => `/portal/entitlements/usages${orderId ? `?orderId=${encodeURIComponent(orderId)}` : ""}`,
    [orderId]
  );

  useEffect(() => {
    Promise.all([
      portalApiFetch<PortalPagedResponse<PortalEntitlementGrant>>(grantPath),
      portalApiFetch<PortalPagedResponse<PortalEntitlementUsage>>(usagePath)
    ])
      .then(([grantResult, usageResult]) => {
        setGrants(grantResult.items);
        setUsages(usageResult.items);
      })
      .catch((error) => {
        if (error instanceof PortalApiError && error.status === 401) {
          router.replace(`/portal/login?redirect=${encodeURIComponent("/portal/entitlements")}`);
          return;
        }
        void message.error(error instanceof PortalApiError ? error.message : "无法加载权益信息");
      })
      .finally(() => setLoading(false));
  }, [grantPath, message, router, usagePath]);

  return (
    <main style={{ background: "#f6f8fb", minHeight: "100vh", padding: "24px 16px 44px" }}>
      <section style={{ margin: "0 auto", maxWidth: 960 }}>
        <Flex align="center" justify="space-between" style={{ marginBottom: 18 }}>
          <div>
            <Button
              icon={<ArrowLeftOutlined />}
              onClick={() => router.push("/portal")}
              style={{ marginBottom: 12 }}
            >
              返回门户
            </Button>
            <Typography.Title level={2} style={{ margin: 0 }}>
              我的权益
            </Typography.Title>
            <Typography.Text type="secondary">查看权益余额、有效期和使用记录</Typography.Text>
          </div>
        </Flex>

        <section style={sectionStyle}>
          <Flex align="center" gap={12} style={{ marginBottom: 12 }}>
            <GiftOutlined style={{ color: "#1677ff", fontSize: 24 }} />
            <Typography.Title level={4} style={{ margin: 0 }}>
              权益余额
            </Typography.Title>
          </Flex>
          <PortalEntitlementGrantRecords loading={loading} rows={grants} />
        </section>

        <section style={sectionStyle}>
          <Typography.Title level={4} style={{ marginTop: 0 }}>
            使用记录
          </Typography.Title>
          <PortalEntitlementUsageRecords loading={loading} rows={usages} />
        </section>
      </section>
    </main>
  );
}

export default function PortalEntitlementsPage() {
  return (
    <Suspense
      fallback={
        <main style={{ background: "#f6f8fb", minHeight: "100vh", padding: "24px 16px 44px" }}>
          <section style={{ margin: "0 auto", maxWidth: 960 }}>
            <Typography.Text type="secondary">正在加载...</Typography.Text>
          </section>
        </main>
      }
    >
      <PortalEntitlementsContent />
    </Suspense>
  );
}

const sectionStyle = {
  background: "#ffffff",
  border: "1px solid #e5eaf2",
  borderRadius: 8,
  marginBottom: 14,
  padding: 18
};
