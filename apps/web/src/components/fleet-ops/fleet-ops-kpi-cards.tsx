"use client";

import { Card, Statistic, Typography } from "antd";

import type { FleetOpsOverviewReadModel } from "../../lib/fleet-ops-api";
import {
  formatFleetOpsCount,
  formatFleetOpsDepositTreatmentNote,
  formatFleetOpsMoney,
  formatFleetOpsRatio,
  formatFleetOpsRoeLabel,
  formatFleetOpsRoiLabel,
  formatFleetOpsScore
} from "../../lib/fleet-ops-view-model";

export function FleetOpsKpiCards({ overview }: Readonly<{ overview: FleetOpsOverviewReadModel }>) {
  const groups = [
    {
      items: [
        { title: "车辆总数", value: formatFleetOpsCount(overview.vehicleCounts.total) },
        { title: "营运中", value: formatFleetOpsCount(overview.vehicleCounts.activeOperating) },
        { title: "闲置可用", value: formatFleetOpsCount(overview.vehicleCounts.idleAvailable) },
        { title: "异常", value: formatFleetOpsCount(overview.vehicleCounts.abnormal) },
        { title: "逾期车辆", value: formatFleetOpsCount(overview.vehicleCounts.overdue) },
        { title: "低置信/缺数据", value: formatFleetOpsCount(readNumber(overview.vehicleCounts, "lowConfidence") + readNumber(overview.vehicleCounts, "missingData")) }
      ],
      title: "车辆状态"
    },
    {
      items: [
        { title: "经营收入", value: formatFleetOpsMoney(overview.kpis.revenue) },
        { title: "成本", value: formatFleetOpsMoney(overview.kpis.cost) },
        { title: "净收益", value: formatFleetOpsMoney(overview.kpis.netIncome) },
        { title: formatFleetOpsRoiLabel(), value: formatFleetOpsRatio(overview.kpis.roi) },
        { title: formatFleetOpsRoeLabel(), value: formatFleetOpsRatio(overview.kpis.roe) },
        { title: "分母证据", value: formatFleetOpsCount(overview.kpis.denominatorEvidenceCount) }
      ],
      title: "经营表现"
    },
    {
      extra: <Typography.Text type="secondary">{formatFleetOpsDepositTreatmentNote()}</Typography.Text>,
      items: [
        { title: "实际经营现金流", value: formatFleetOpsMoney(overview.cashflow.actualOperating) },
        { title: "实际押金现金流", value: formatFleetOpsMoney(overview.cashflow.actualDeposit) },
        { title: "计划经营现金流", value: formatFleetOpsMoney(overview.cashflow.plannedOperating) },
        { title: "计划押金现金流", value: formatFleetOpsMoney(overview.cashflow.plannedDeposit) },
        { title: "未分配现金流", value: formatFleetOpsMoney(overview.cashflow.unallocated) }
      ],
      title: "现金流与押金口径"
    },
    {
      items: [
        { title: "逾期金额", value: formatFleetOpsMoney(overview.risk.overdueAmount) },
        { title: "逾期车辆", value: formatFleetOpsCount(overview.risk.overdueVehicleCount) },
        { title: "逾期账单", value: formatFleetOpsCount(overview.risk.overdueBillCount) },
        { title: "最大逾期天数", value: formatFleetOpsCount(overview.risk.maxOverdueDays) },
        { title: "平均风险分", value: formatFleetOpsScore(overview.risk.averageRiskScore) },
        { title: "高风险车辆", value: formatFleetOpsCount(overview.risk.highRiskVehicleCount) }
      ],
      title: "逾期风险"
    },
    {
      items: [
        { title: "平均置信度", value: formatFleetOpsScore(overview.dataQuality.averageConfidence) },
        { title: "最低置信度", value: formatFleetOpsScore(overview.dataQuality.minConfidence) },
        { title: "低置信车辆", value: formatFleetOpsCount(overview.dataQuality.lowConfidenceVehicleCount) },
        { title: "预警数", value: formatFleetOpsCount(overview.dataQuality.warningCount) },
        { title: "缺证据车辆", value: formatFleetOpsCount(overview.dataQuality.missingEvidenceVehicleCount) },
        { title: "时间线回退", value: formatFleetOpsCount(overview.dataQuality.timelineFallbackVehicleCount) }
      ],
      title: "数据质量"
    }
  ];

  return (
    <>
      {groups.map((group) => (
        <Card extra={group.extra} key={group.title} title={group.title}>
          <div style={{ display: "grid", gap: 16, gridTemplateColumns: "repeat(auto-fit, minmax(160px, 1fr))" }}>
            {group.items.map((item) => (
              <Statistic key={item.title} title={item.title} value={item.value} />
            ))}
          </div>
        </Card>
      ))}
    </>
  );
}

function readNumber(source: Record<string, number>, key: string) {
  const value = source[key];
  return typeof value === "number" && Number.isFinite(value) ? value : 0;
}
