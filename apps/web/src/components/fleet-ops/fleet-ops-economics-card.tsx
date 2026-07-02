"use client";

import { Card, Descriptions, Space, Tag } from "antd";

import type { FleetOpsEconomicsSummary } from "../../lib/fleet-ops-view-model";

export function FleetOpsEconomicsCard({ economics }: Readonly<{ economics: FleetOpsEconomicsSummary }>) {
  return (
    <Card title="经营指标">
      <Space direction="vertical" size={12} style={{ width: "100%" }}>
        <Descriptions bordered column={3} size="small">
          <Descriptions.Item label="收入">{formatMoney(economics.revenue)}</Descriptions.Item>
          <Descriptions.Item label="成本">{formatMoney(economics.cost)}</Descriptions.Item>
          <Descriptions.Item label="净收益">{formatMoney(economics.netIncome)}</Descriptions.Item>
          <Descriptions.Item label="ROI">{formatRatio(economics.roi)}</Descriptions.Item>
          <Descriptions.Item label="ROE">{formatRatio(economics.roe)}</Descriptions.Item>
          <Descriptions.Item label="分母证据">{economics.denominatorEvidenceCount}</Descriptions.Item>
          <Descriptions.Item label="实际经营现金流">
            {formatMoney(economics.actualOperatingCashflow)}
          </Descriptions.Item>
          <Descriptions.Item label="实际押金现金流">
            {formatMoney(economics.actualDepositCashflow)}
          </Descriptions.Item>
          <Descriptions.Item label="已排除押金">
            {formatMoney(economics.depositExcludedRevenue)}
          </Descriptions.Item>
          <Descriptions.Item label="计划经营现金流">
            {formatMoney(economics.plannedOperatingCashflow)}
          </Descriptions.Item>
          <Descriptions.Item label="计划押金现金流">
            {formatMoney(economics.plannedDepositCashflow)}
          </Descriptions.Item>
          <Descriptions.Item label="未分配现金流">
            {formatMoney(economics.unassignedPaymentCashflow)}
          </Descriptions.Item>
        </Descriptions>
        {economics.cashflowWarnings.length ? (
          <Space wrap>
            {economics.cashflowWarnings.map((warning) => (
              <Tag color="orange" key={warning}>
                {warning}
              </Tag>
            ))}
          </Space>
        ) : null}
      </Space>
    </Card>
  );
}

function formatMoney(value?: number | null) {
  return typeof value === "number" && Number.isFinite(value) ? `${value.toLocaleString("en-US")}` : "-";
}

function formatRatio(value?: number | null) {
  return typeof value === "number" && Number.isFinite(value) ? `${(value * 100).toFixed(2)}%` : "-";
}
