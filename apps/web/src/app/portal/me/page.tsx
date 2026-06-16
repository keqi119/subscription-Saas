"use client";

import { App, Button, Descriptions, Skeleton, Typography } from "antd";
import { useRouter } from "next/navigation";
import { useEffect, useState } from "react";

import { CUSTOMER_ACCOUNT_STATUS_LABELS } from "../../../constants/labels";
import { PortalApiError, portalApiFetch } from "../../../lib/portal-api";

interface PortalMe {
  accountStatus: string;
  customerAccountId: string;
  customerId: string;
  phone: string;
}

export default function PortalMePage() {
  const router = useRouter();
  const { message } = App.useApp();
  const [me, setMe] = useState<PortalMe>();
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    portalApiFetch<PortalMe>("/portal/me")
      .then(setMe)
      .catch((error) => {
        if (error instanceof PortalApiError && error.status === 401) {
          router.replace("/portal/login");
          return;
        }

        void message.error(error instanceof PortalApiError ? error.message : "无法加载客户信息");
      })
      .finally(() => setLoading(false));
  }, [message, router]);

  return (
    <main style={{ background: "#f6f8fb", minHeight: "100vh", padding: "28px 18px" }}>
      <section style={{ margin: "0 auto", maxWidth: 560 }}>
        <Typography.Title level={2}>我的信息</Typography.Title>
        {loading ? (
          <Skeleton active />
        ) : (
          <Descriptions bordered column={1}>
            <Descriptions.Item label="手机号">{me?.phone ?? "-"}</Descriptions.Item>
            <Descriptions.Item label="账号状态">
              {CUSTOMER_ACCOUNT_STATUS_LABELS[me?.accountStatus ?? ""] ?? "-"}
            </Descriptions.Item>
            <Descriptions.Item label="客户 ID">{me?.customerId ?? "-"}</Descriptions.Item>
            <Descriptions.Item label="账号 ID">{me?.customerAccountId ?? "-"}</Descriptions.Item>
          </Descriptions>
        )}
        <Button onClick={() => router.push("/portal")} style={{ marginTop: 16 }} type="primary">
          返回首页
        </Button>
      </section>
    </main>
  );
}
