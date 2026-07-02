"use client";

import { Card, Descriptions, Space, Tag } from "antd";

import type { FleetOpsEconomicsSummary } from "../../lib/fleet-ops-view-model";

export function FleetOpsEconomicsCard({ economics }: Readonly<{ economics: FleetOpsEconomicsSummary }>) {
  return (
    <Card title="Economics">
      <Space direction="vertical" size={12} style={{ width: "100%" }}>
        <Descriptions bordered column={3} size="small">
          <Descriptions.Item label="Revenue">{formatMoney(economics.revenue)}</Descriptions.Item>
          <Descriptions.Item label="Cost">{formatMoney(economics.cost)}</Descriptions.Item>
          <Descriptions.Item label="Net income">{formatMoney(economics.netIncome)}</Descriptions.Item>
          <Descriptions.Item label="ROI">{formatRatio(economics.roi)}</Descriptions.Item>
          <Descriptions.Item label="ROE">{formatRatio(economics.roe)}</Descriptions.Item>
          <Descriptions.Item label="Denominator evidence">{economics.denominatorEvidenceCount}</Descriptions.Item>
          <Descriptions.Item label="Actual operating cashflow">
            {formatMoney(economics.actualOperatingCashflow)}
          </Descriptions.Item>
          <Descriptions.Item label="Actual deposit cashflow">
            {formatMoney(economics.actualDepositCashflow)}
          </Descriptions.Item>
          <Descriptions.Item label="Deposit excluded">
            {formatMoney(economics.depositExcludedRevenue)}
          </Descriptions.Item>
          <Descriptions.Item label="Planned operating cashflow">
            {formatMoney(economics.plannedOperatingCashflow)}
          </Descriptions.Item>
          <Descriptions.Item label="Planned deposit cashflow">
            {formatMoney(economics.plannedDepositCashflow)}
          </Descriptions.Item>
          <Descriptions.Item label="Unassigned cashflow">
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
