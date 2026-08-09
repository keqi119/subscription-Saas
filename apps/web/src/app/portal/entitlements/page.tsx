"use client";

import { ArrowLeftOutlined } from "@ant-design/icons";
import { Button, Flex, Typography } from "antd";
import { useRouter, useSearchParams } from "next/navigation";
import { Suspense, useEffect, useState } from "react";

import { PortalApiError, portalApiFetch } from "../../../lib/portal-api";
import { PortalEntitlementGrant, PortalEntitlementUsage } from "../../../lib/portal-types";
import { PortalEntitlementPageContent } from "./entitlement-page-content";
import { loadPortalEntitlementPageData } from "./portal-paged-loader";

function PortalEntitlementsContent() {
  const router = useRouter();
  const searchParams = useSearchParams();
  const [grants, setGrants] = useState<PortalEntitlementGrant[]>([]);
  const [usages, setUsages] = useState<PortalEntitlementUsage[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [loadVersion, setLoadVersion] = useState(0);
  const orderId = searchParams.get("orderId");

  useEffect(() => {
    let active = true;
    setLoading(true);
    setError(null);

    loadPortalEntitlementPageData(orderId, portalApiFetch)
      .then((result) => {
        if (!active) {
          return;
        }
        setGrants(result.grants);
        setUsages(result.usages);
      })
      .catch((error) => {
        if (error instanceof PortalApiError && error.status === 401) {
          router.replace(`/portal/login?redirect=${encodeURIComponent("/portal/entitlements")}`);
          return;
        }

        if (active) {
          setError(error instanceof PortalApiError ? error.message : "无法加载权益信息");
        }
      })
      .finally(() => {
        if (active) {
          setLoading(false);
        }
      });

    return () => {
      active = false;
    };
  }, [loadVersion, orderId, router]);

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
        <PortalEntitlementPageContent
          error={error}
          grants={grants}
          loading={loading}
          onRetry={() => setLoadVersion((version) => version + 1)}
          usages={usages}
        />
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
