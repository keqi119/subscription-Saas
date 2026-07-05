"use client";

import { SearchOutlined } from "@ant-design/icons";
import { AutoComplete, Button, Space, Spin, Typography } from "antd";
import { useMemo, useRef, useState } from "react";

import { ApiError } from "../../lib/api";
import { getFleetOpsVehicleLookup, type FleetOpsVehicleLookupItem } from "../../lib/fleet-ops-api";
import { buildFleetOpsLookupOptionLabel, validateFleetOpsLookupQuery } from "../../lib/fleet-ops-view-model";

const FLEET_OPS_LOOKUP_LIMIT = 10;

export interface FleetOpsVehicleLookupProps {
  disabled?: boolean;
  loading?: boolean;
  onChange: (value: string) => void;
  onError: (message: string | null) => void;
  onLoad: (vehicleId?: string) => Promise<void> | void;
  value: string;
}

export function FleetOpsVehicleLookup({
  disabled = false,
  loading = false,
  onChange,
  onError,
  onLoad,
  value
}: Readonly<FleetOpsVehicleLookupProps>) {
  const [items, setItems] = useState<FleetOpsVehicleLookupItem[]>([]);
  const [lookupLoading, setLookupLoading] = useState(false);
  const [lookupValid, setLookupValid] = useState(false);
  const requestIdRef = useRef(0);

  const options = useMemo(
    () =>
      items.map((item) => ({
        label: <FleetOpsVehicleLookupOption item={item} />,
        value: item.vehicleId
      })),
    [items]
  );

  async function handleSearch(nextValue: string) {
    onChange(nextValue);
    const validation = validateFleetOpsLookupQuery(nextValue);
    setLookupValid(validation.valid);

    if (!validation.valid || !validation.query || disabled) {
      setItems([]);
      return;
    }

    const requestId = requestIdRef.current + 1;
    requestIdRef.current = requestId;
    setLookupLoading(true);
    onError(null);

    try {
      const result = await getFleetOpsVehicleLookup({ limit: FLEET_OPS_LOOKUP_LIMIT, q: validation.query });
      if (requestIdRef.current === requestId) {
        setItems(result.data.items);
      }
    } catch (error) {
      if (requestIdRef.current === requestId) {
        setItems([]);
        onError(getLookupErrorMessage(error));
      }
    } finally {
      if (requestIdRef.current === requestId) {
        setLookupLoading(false);
      }
    }
  }

  function handleSelect(vehicleId: string) {
    onChange(vehicleId);
    void onLoad(vehicleId);
  }

  return (
    <Space wrap>
      <AutoComplete
        allowClear
        disabled={disabled}
        filterOption={false}
        notFoundContent={lookupLoading ? <Spin size="small" /> : lookupValid ? "未找到匹配车辆" : null}
        onChange={onChange}
        onSearch={(nextValue) => {
          void handleSearch(nextValue);
        }}
        onSelect={handleSelect}
        options={options}
        placeholder="输入车辆编号、VIN、车牌号或内部 ID"
        style={{ width: 360 }}
        value={value}
      />
      <Button disabled={disabled || !value.trim()} icon={<SearchOutlined />} loading={loading} onClick={() => void onLoad()} type="primary">
        加载快照
      </Button>
    </Space>
  );
}

function FleetOpsVehicleLookupOption({ item }: Readonly<{ item: FleetOpsVehicleLookupItem }>) {
  return (
    <Space direction="vertical" size={0}>
      <Typography.Text>{buildFleetOpsLookupOptionLabel(item)}</Typography.Text>
      <Typography.Text type="secondary">ID {item.vehicleId}</Typography.Text>
    </Space>
  );
}

function getLookupErrorMessage(error: unknown) {
  return error instanceof ApiError ? error.message : "车辆查询失败。";
}
