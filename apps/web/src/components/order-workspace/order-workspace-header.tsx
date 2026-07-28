import {
  ArrowLeftOutlined,
  CarOutlined,
  MoreOutlined,
  ReloadOutlined,
  TeamOutlined,
  UserOutlined
} from "@ant-design/icons";
import { Button, Dropdown, Flex, Tag, Tooltip, Typography } from "antd";
import type { MenuProps } from "antd";
import type { ReactNode } from "react";

export interface OrderWorkspaceHeaderData {
  currentVehicleLabel: string | null;
  customerLabel: string;
  orderNo: string;
  orderStatus: string;
  orderStatusColor?: string;
  orderStatusLabel?: string;
  ownerLabel: string | null;
}

export interface OrderWorkspaceHeaderAction {
  danger?: boolean;
  disabled?: boolean;
  icon?: ReactNode;
  key: string;
  label: string;
  onClick: () => void;
}

export interface OrderWorkspaceHeaderProps {
  header: OrderWorkspaceHeaderData;
  onBack: () => void;
  onRefresh: () => void;
  overflowActions?: readonly OrderWorkspaceHeaderAction[];
  refreshing?: boolean;
}

export function OrderWorkspaceHeader({
  header,
  onBack,
  onRefresh,
  overflowActions = [],
  refreshing = false
}: Readonly<OrderWorkspaceHeaderProps>) {
  const overflowItems: MenuProps["items"] = overflowActions.map((action) => ({
    danger: action.danger,
    disabled: action.disabled,
    icon: action.icon,
    key: action.key,
    label: action.label
  }));
  const handleOverflowClick: MenuProps["onClick"] = ({ key }) => {
    overflowActions.find((action) => action.key === key)?.onClick();
  };

  return (
    <header
      data-workspace-header="true"
      style={{
        background: "#fafafa",
        borderBlock: "1px solid #f0f0f0",
        padding: "8px 12px"
      }}
    >
      <Flex align="center" gap={12} justify="space-between" wrap>
        <Flex align="center" gap={12} style={{ flex: "1 1 760px", minWidth: 0 }} wrap>
          <Tooltip title="返回订单列表">
            <Button
              aria-label="返回订单列表"
              icon={<ArrowLeftOutlined />}
              onClick={onBack}
              shape="circle"
              size="small"
            />
          </Tooltip>

          <HeaderFact label="订单号" value={header.orderNo} />
          <Tag bordered={false} color={header.orderStatusColor ?? "blue"}>
            {header.orderStatusLabel ?? header.orderStatus}
          </Tag>
          <HeaderFact icon={<UserOutlined />} label="客户" value={header.customerLabel} />
          <HeaderFact
            icon={<CarOutlined />}
            label="车辆"
            value={header.currentVehicleLabel ?? "-"}
          />
          <HeaderFact
            icon={<TeamOutlined />}
            label="负责人"
            value={header.ownerLabel ?? "-"}
          />
        </Flex>

        <Flex align="center" gap={4}>
          <Button
            aria-label="刷新订单工作台"
            icon={<ReloadOutlined />}
            loading={refreshing}
            onClick={onRefresh}
            size="small"
          >
            刷新
          </Button>
          <Dropdown
            disabled={overflowActions.length === 0}
            menu={{ items: overflowItems, onClick: handleOverflowClick }}
            placement="bottomRight"
            trigger={["click"]}
          >
            <Tooltip title="订单级更多操作">
              <Button
                aria-label="订单级更多操作"
                disabled={overflowActions.length === 0}
                icon={<MoreOutlined />}
                size="small"
              />
            </Tooltip>
          </Dropdown>
        </Flex>
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
    <Flex align="center" gap={4} style={{ minWidth: 0 }}>
      {icon}
      <Typography.Text style={{ fontSize: 12 }} type="secondary">
        {label}
      </Typography.Text>
      <Typography.Text
        strong
        style={{
          maxWidth: 220,
          overflow: "hidden",
          textOverflow: "ellipsis",
          whiteSpace: "nowrap"
        }}
        title={value}
      >
        {value}
      </Typography.Text>
    </Flex>
  );
}
