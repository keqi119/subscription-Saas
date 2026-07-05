"use client";

import { Button, Card, DatePicker, Input, InputNumber, Select, Space } from "antd";
import dayjs from "dayjs";

import type { FleetOpsOverviewQuery, FleetOpsPoolIdentity, FleetOpsScopeType } from "../../lib/fleet-ops-api";

export interface FleetOpsScopeSelectorProps {
  fixedPoolId?: string;
  loading?: boolean;
  onApply: () => void;
  onChange: (query: FleetOpsOverviewQuery) => void;
  onReset: () => void;
  pools?: FleetOpsPoolIdentity[];
  query: FleetOpsOverviewQuery;
}

const scopeOptions: Array<{ label: string; value: FleetOpsScopeType }> = [
  { label: "全部车辆", value: "ALL" },
  { label: "车辆池", value: "POOL" },
  { label: "车辆分群", value: "COHORT" }
];

const vehicleStatusOptions = ["AVAILABLE", "LEASED", "MAINTENANCE", "RESERVED", "RETIRED"].map((value) => ({
  label: value,
  value
}));

export function FleetOpsScopeSelector({
  fixedPoolId,
  loading = false,
  onApply,
  onChange,
  onReset,
  pools = [],
  query
}: Readonly<FleetOpsScopeSelectorProps>) {
  const poolOptions = pools.map((pool) => ({
    label: `${pool.poolNo} / ${pool.poolName}`,
    value: pool.poolId
  }));

  function update(next: Partial<FleetOpsOverviewQuery>) {
    onChange({ ...query, ...next });
  }

  function updateScope(scopeType: FleetOpsScopeType) {
    update({
      poolId: scopeType === "POOL" ? query.poolId : undefined,
      scopeType
    });
  }

  return (
    <Card title="范围与筛选">
      <Space direction="vertical" size={12} style={{ width: "100%" }}>
        <Space wrap>
          <Select
            disabled={Boolean(fixedPoolId)}
            onChange={updateScope}
            options={scopeOptions}
            style={{ width: 150 }}
            value={query.scopeType ?? "ALL"}
          />
          <Select
            allowClear
            disabled={Boolean(fixedPoolId) || query.scopeType !== "POOL"}
            onChange={(poolId) => update({ poolId })}
            options={poolOptions}
            placeholder="选择车辆池"
            style={{ width: 260 }}
            value={fixedPoolId ?? query.poolId}
          />
          <Input
            allowClear
            onChange={(event) => update({ brand: event.target.value || undefined })}
            placeholder="品牌"
            style={{ width: 140 }}
            value={query.brand}
          />
          <Input
            allowClear
            onChange={(event) => update({ model: event.target.value || undefined })}
            placeholder="车型"
            style={{ width: 140 }}
            value={query.model}
          />
          <InputNumber
            onChange={(modelYear) => update({ modelYear: typeof modelYear === "number" ? modelYear : undefined })}
            placeholder="年款"
            style={{ width: 110 }}
            value={query.modelYear}
          />
          <Select
            allowClear
            onChange={(vehicleStatus) => update({ vehicleStatus })}
            options={vehicleStatusOptions}
            placeholder="车辆状态"
            style={{ width: 150 }}
            value={query.vehicleStatus}
          />
          <Input
            allowClear
            onChange={(event) => update({ assetLocation: event.target.value || undefined })}
            placeholder="资产地点"
            style={{ width: 160 }}
            value={query.assetLocation}
          />
        </Space>
        <Space wrap>
          <DatePicker
            allowClear
            onChange={(value) => update({ registrationDateFrom: value?.format("YYYY-MM-DD") })}
            placeholder="上牌开始"
            value={query.registrationDateFrom ? dayjs(query.registrationDateFrom) : null}
          />
          <DatePicker
            allowClear
            onChange={(value) => update({ registrationDateTo: value?.format("YYYY-MM-DD") })}
            placeholder="上牌结束"
            value={query.registrationDateTo ? dayjs(query.registrationDateTo) : null}
          />
          <DatePicker
            allowClear
            onChange={(value) => update({ createdFrom: value?.format("YYYY-MM-DD") })}
            placeholder="创建开始"
            value={query.createdFrom ? dayjs(query.createdFrom) : null}
          />
          <DatePicker
            allowClear
            onChange={(value) => update({ createdTo: value?.format("YYYY-MM-DD") })}
            placeholder="创建结束"
            value={query.createdTo ? dayjs(query.createdTo) : null}
          />
          <InputNumber
            max={50}
            min={1}
            onChange={(topN) => update({ topN: typeof topN === "number" ? topN : undefined })}
            placeholder="Top N"
            style={{ width: 110 }}
            value={query.topN}
          />
          <Button loading={loading} onClick={onApply} type="primary">
            查询
          </Button>
          <Button onClick={onReset}>重置</Button>
        </Space>
      </Space>
    </Card>
  );
}
