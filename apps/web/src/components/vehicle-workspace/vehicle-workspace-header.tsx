import { CarOutlined, DollarOutlined, IdcardOutlined } from "@ant-design/icons";
import { Flex, Tag, Typography } from "antd";
import type { ReactNode } from "react";

import type { VehicleWorkspaceVehicle } from "./vehicle-workspace-types";

export interface VehicleWorkspaceHeaderProps {
  actions?: ReactNode;
  vehicle: VehicleWorkspaceVehicle;
}

export function VehicleWorkspaceHeader({
  actions,
  vehicle
}: Readonly<VehicleWorkspaceHeaderProps>) {
  const vehicleDisplayName = [
    vehicle.brand,
    vehicle.series,
    vehicle.modelDisplayName ?? vehicle.model
  ]
    .filter(Boolean)
    .join(" ");

  return (
    <header
      data-vehicle-workspace-header="true"
      style={{
        background: "#fff",
        border: "1px solid #f0f0f0",
        borderRadius: 8,
        insetBlockStart: 0,
        padding: 16,
        position: "sticky",
        zIndex: 10
      }}
    >
      <Flex align="flex-start" gap={16} justify="space-between" wrap>
        <div
          style={{
            display: "grid",
            flex: "1 1 760px",
            gap: "12px 24px",
            gridTemplateColumns: "repeat(auto-fit, minmax(220px, 1fr))",
            minWidth: 0
          }}
        >
          <HeaderFact icon={<CarOutlined />} label="车辆编号" value={vehicle.vehicleNo} />
          <HeaderFact
            icon={<IdcardOutlined />}
            label="车牌 / VIN"
            value={vehicle.plateNo || vehicle.vin || "-"}
          />
          <HeaderFact label="品牌 / 车系 / 车型" value={vehicleDisplayName || "-"} />
          <HeaderFact
            icon={<DollarOutlined />}
            label="当前销售价"
            value={formatCentAmount(vehicle.currentSalePriceAmount)}
          />
          <HeaderFact label="销售价状态" value={vehicle.salePriceStatus || "-"} />
          <Flex align="center" gap={8}>
            <Typography.Text type="secondary">车辆状态</Typography.Text>
            <Tag bordered={false} color="blue">
              {vehicle.status}
            </Tag>
          </Flex>
        </div>
        {actions ? <div data-vehicle-workspace-actions="true">{actions}</div> : null}
      </Flex>
    </header>
  );
}

function HeaderFact({
  icon,
  label,
  value
}: Readonly<{ icon?: ReactNode; label: string; value: string }>) {
  return (
    <Flex align="center" gap={6} style={{ minWidth: 0 }}>
      {icon}
      <Typography.Text type="secondary">{label}</Typography.Text>
      <Typography.Text ellipsis={{ tooltip: value }} strong style={{ minWidth: 0 }}>
        {value}
      </Typography.Text>
    </Flex>
  );
}

function formatCentAmount(amount: number | null) {
  if (amount === null || !Number.isFinite(amount)) {
    return "-";
  }
  return `¥${(amount / 100).toLocaleString("en-US", {
    maximumFractionDigits: 2,
    minimumFractionDigits: 2
  })}`;
}
