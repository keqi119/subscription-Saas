import { ArrowRightOutlined } from "@ant-design/icons";
import { Card, Col, Descriptions, Flex, Row, Tag, Timeline, Typography } from "antd";

import {
  buildVehicleWorkspaceHref,
  getVisibleVehicleWorkspaceTabs,
  VEHICLE_WORKSPACE_TAB_LABELS
} from "../../lib/admin-vehicle-workspace";
import type { VehicleWorkspaceTabProps } from "./vehicle-workspace-types";

export function VehicleOverviewTab({
  permissions,
  vehicle
}: Readonly<VehicleWorkspaceTabProps>) {
  const visibleTabs = getVisibleVehicleWorkspaceTabs(permissions);
  const shortcutTabs = visibleTabs.filter((tab) => tab !== "overview");
  const orderParams = new URLSearchParams({ vehicleId: vehicle.id });

  return (
    <Flex data-vehicle-overview="true" gap={16} vertical>
      <section aria-labelledby="vehicle-core-status-title">
        <Typography.Title id="vehicle-core-status-title" level={4}>
          核心状态
        </Typography.Title>
        <Row gutter={[12, 12]}>
          <StatusCard label="当前状态" value={vehicle.status} />
          <StatusCard label="当前里程" value={`${vehicle.currentMileageKm.toLocaleString("en-US")} 公里`} />
          <StatusCard
            label="保险覆盖"
            value={vehicle.insuranceCoverage.covered ? "保险覆盖正常" : "保险覆盖不足"}
          />
          <StatusCard label="下次销售价复核" value={vehicle.nextSalePriceReviewAt ?? "未安排"} />
        </Row>
      </section>

      <Row gutter={[16, 16]}>
        <Col lg={12} xs={24}>
          <Card title="身份与登记">
            <Descriptions column={1} size="small">
              <Descriptions.Item label="车辆编号">{vehicle.vehicleNo}</Descriptions.Item>
              <Descriptions.Item label="VIN">{vehicle.vin ?? "-"}</Descriptions.Item>
              <Descriptions.Item label="车牌号">{vehicle.plateNo ?? "-"}</Descriptions.Item>
              <Descriptions.Item label="注册日期">{vehicle.registrationDate ?? "-"}</Descriptions.Item>
              <Descriptions.Item label="最近登记日期">
                {vehicle.latestRegistrationDate ?? "-"}
              </Descriptions.Item>
              <Descriptions.Item label="采购日期">{vehicle.purchaseDate ?? "-"}</Descriptions.Item>
              <Descriptions.Item label="资产所在地">{vehicle.assetLocation ?? "-"}</Descriptions.Item>
            </Descriptions>
          </Card>
        </Col>
        <Col lg={12} xs={24}>
          <Card title="电池基础">
            <Descriptions column={1} size="small">
              <Descriptions.Item label="电池容量">
                {vehicle.batteryCapacityKwh === null ? "-" : `${vehicle.batteryCapacityKwh} kWh`}
              </Descriptions.Item>
              <Descriptions.Item label="电池模式">{vehicle.batteryUsageType ?? "-"}</Descriptions.Item>
              <Descriptions.Item label="保险评估时间">
                {formatDateTime(vehicle.insuranceCoverage.evaluatedAt)}
              </Descriptions.Item>
              <Descriptions.Item label="交强险">
                <CoverageTag covered={vehicle.insuranceCoverage.compulsoryTraffic.covered} />
              </Descriptions.Item>
              <Descriptions.Item label="商业险">
                <CoverageTag covered={vehicle.insuranceCoverage.commercial.covered} />
              </Descriptions.Item>
            </Descriptions>
          </Card>
        </Col>
      </Row>

      <Row gutter={[16, 16]}>
        <Col lg={12} xs={24}>
          <Card title="业务关联">
            <Flex gap={12} vertical>
              <a href={`/orders?${orderParams.toString()}`}>订单/租赁</a>
              <a href={buildVehicleWorkspaceHref({ tab: "listing", vehicleId: vehicle.id })}>
                商品展示
              </a>
            </Flex>
          </Card>
        </Col>
        <Col lg={12} xs={24}>
          <Card title="最近状态/里程事件">
            <Timeline
              items={[
                { children: `当前状态：${vehicle.status}` },
                { children: `累计里程：${vehicle.currentMileageKm.toLocaleString("en-US")} 公里` },
                { children: `车辆资料更新：${formatDateTime(vehicle.updatedAt)}` }
              ]}
            />
          </Card>
        </Col>
      </Row>

      <Card title="快捷入口">
        <Flex gap={16} wrap>
          {shortcutTabs.map((tab) => (
            <a href={buildVehicleWorkspaceHref({ tab, vehicleId: vehicle.id })} key={tab}>
              {VEHICLE_WORKSPACE_TAB_LABELS[tab]} <ArrowRightOutlined />
            </a>
          ))}
        </Flex>
      </Card>
    </Flex>
  );
}

function StatusCard({ label, value }: Readonly<{ label: string; value: string }>) {
  return (
    <Col lg={6} sm={12} xs={24}>
      <Card size="small">
        <Typography.Text type="secondary">{label}</Typography.Text>
        <Typography.Title level={5} style={{ marginBlock: 8 }}>
          {value}
        </Typography.Title>
      </Card>
    </Col>
  );
}

function CoverageTag({ covered }: Readonly<{ covered: boolean }>) {
  return <Tag color={covered ? "green" : "red"}>{covered ? "已覆盖" : "未覆盖"}</Tag>;
}

function formatDateTime(value: string) {
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? value : date.toLocaleString("zh-CN", { hour12: false });
}
