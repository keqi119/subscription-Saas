"use client";

import { Space, Typography } from "antd";

import { ProtectedShell } from "../../../components/protected-shell";
import { FleetOpsPoolList } from "../../../components/fleet-ops/fleet-ops-pool-list";

export default function FleetOpsPoolsPage() {
  return (
    <ProtectedShell>
      <Space direction="vertical" size={16} style={{ width: "100%" }}>
        <Space direction="vertical" size={2}>
          <Typography.Title level={4} style={{ margin: 0 }}>
            车辆池
          </Typography.Title>
          <Typography.Text type="secondary">系统正式资产/管理口径的车辆池。</Typography.Text>
        </Space>
        <FleetOpsPoolList />
      </Space>
    </ProtectedShell>
  );
}
