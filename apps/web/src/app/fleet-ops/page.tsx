"use client";

import { ReloadOutlined } from "@ant-design/icons";
import { Alert, Button, Card, DatePicker, Empty, Space, Spin, Typography } from "antd";
import type { Dayjs } from "dayjs";
import dayjs from "dayjs";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";

import { FleetOpsEconomicsCard } from "../../components/fleet-ops/fleet-ops-economics-card";
import { FleetOpsEvidencePanel } from "../../components/fleet-ops/fleet-ops-evidence-panel";
import { FleetOpsOverview } from "../../components/fleet-ops/fleet-ops-overview";
import { FleetOpsRiskCard } from "../../components/fleet-ops/fleet-ops-risk-card";
import { FleetOpsStateCard } from "../../components/fleet-ops/fleet-ops-state-card";
import { FleetOpsTimelineCard } from "../../components/fleet-ops/fleet-ops-timeline-card";
import { FleetOpsVehicleLookup } from "../../components/fleet-ops/fleet-ops-vehicle-lookup";
import { ProtectedShell } from "../../components/protected-shell";
import { ApiError } from "../../lib/api";
import {
  getFleetOpsHealth,
  getFleetOpsSnapshot,
  isFleetOpsApiDisabled,
  isFleetOpsPermissionDenied,
  type FleetOpsApiHealth,
  type FleetOpsApiQuery,
  type FleetOpsSnapshot
} from "../../lib/fleet-ops-api";
import {
  groupFleetOpsEvidenceBySource,
  summarizeFleetOpsSnapshot,
  validateFleetOpsDateRange
} from "../../lib/fleet-ops-view-model";

export default function FleetOpsPage() {
  const [vehicleId, setVehicleId] = useState("");
  const [asOf, setAsOf] = useState<Dayjs | null>(() => dayjs());
  const [from, setFrom] = useState<Dayjs | null>(null);
  const [to, setTo] = useState<Dayjs | null>(null);
  const [health, setHealth] = useState<FleetOpsApiHealth | null>(null);
  const [snapshot, setSnapshot] = useState<FleetOpsSnapshot | null>(null);
  const [loadingHealth, setLoadingHealth] = useState(true);
  const [loadingSnapshot, setLoadingSnapshot] = useState(false);
  const [apiDisabled, setApiDisabled] = useState(false);
  const [permissionDenied, setPermissionDenied] = useState(false);
  const [errorMessage, setErrorMessage] = useState<string | null>(null);
  const loadedQueryVehicleIdRef = useRef<string | null>(null);

  const loadHealth = useCallback(async () => {
    setLoadingHealth(true);
    setErrorMessage(null);
    setPermissionDenied(false);

    try {
      const result = await getFleetOpsHealth({ requestId: "fleet-ops-ui-health" });
      setHealth(result.data);
      setApiDisabled(isFleetOpsApiDisabled(result));
    } catch (error) {
      if (isFleetOpsPermissionDenied(error)) {
        setPermissionDenied(true);
        setSnapshot(null);
      } else {
        setErrorMessage(getErrorMessage(error));
      }
    } finally {
      setLoadingHealth(false);
    }
  }, []);

  useEffect(() => {
    void loadHealth();
  }, [loadHealth]);

  const query = useMemo<FleetOpsApiQuery>(
    () => ({
      asOf: asOf?.format("YYYY-MM-DD"),
      from: from?.format("YYYY-MM-DD"),
      includeDiagnostics: true,
      to: to?.format("YYYY-MM-DD")
    }),
    [asOf, from, to]
  );

  const rangeValidation = validateFleetOpsDateRange(query);
  const summary = useMemo(() => (snapshot ? summarizeFleetOpsSnapshot(snapshot) : null), [snapshot]);
  const evidenceGroups = useMemo(
    () => groupFleetOpsEvidenceBySource(Array.isArray(snapshot?.evidence) ? snapshot.evidence : []),
    [snapshot]
  );

  const loadSnapshot = useCallback(async (vehicleIdOverride?: string) => {
    const normalizedVehicleId = (vehicleIdOverride ?? vehicleId).trim();
    if (!normalizedVehicleId || apiDisabled || permissionDenied) {
      return;
    }

    if (!rangeValidation.valid) {
      setErrorMessage(rangeValidation.reason ?? "车队运营日期范围无效。");
      return;
    }

    setLoadingSnapshot(true);
    setErrorMessage(null);
    setVehicleId(normalizedVehicleId);

    try {
      const result = await getFleetOpsSnapshot(normalizedVehicleId, query);
      setSnapshot(result.data);
      setApiDisabled(isFleetOpsApiDisabled(result));
      setFleetOpsVehicleIdUrl(normalizedVehicleId);
    } catch (error) {
      if (isFleetOpsApiDisabled(error)) {
        setApiDisabled(true);
        setSnapshot(null);
      } else if (isFleetOpsPermissionDenied(error)) {
        setPermissionDenied(true);
        setSnapshot(null);
      } else {
        setErrorMessage(getErrorMessage(error));
      }
    } finally {
      setLoadingSnapshot(false);
    }
  }, [apiDisabled, permissionDenied, query, rangeValidation.reason, rangeValidation.valid, vehicleId]);

  useEffect(() => {
    if (typeof window === "undefined" || loadingHealth) {
      return;
    }

    const queryVehicleId = new URLSearchParams(window.location.search).get("vehicleId")?.trim();
    if (!queryVehicleId || apiDisabled || permissionDenied || loadedQueryVehicleIdRef.current === queryVehicleId) {
      return;
    }

    loadedQueryVehicleIdRef.current = queryVehicleId;
    setVehicleId(queryVehicleId);
    void loadSnapshot(queryVehicleId);
  }, [apiDisabled, loadSnapshot, loadingHealth, permissionDenied]);

  return (
    <ProtectedShell>
      <Space direction="vertical" size={16} style={{ width: "100%" }}>
        <Space direction="vertical" size={4}>
          <Typography.Title level={4} style={{ margin: 0 }}>
            车队运营
          </Typography.Title>
          <Typography.Text type="secondary">
            内部只读视图，用于查看车辆运营快照、证据、预警、置信度与逾期诊断信息。
          </Typography.Text>
        </Space>

        <Card title="查询条件">
          <Space direction="vertical" size={12} style={{ width: "100%" }}>
            <Space wrap>
              <FleetOpsVehicleLookup
                disabled={apiDisabled || permissionDenied}
                loading={loadingSnapshot}
                onChange={setVehicleId}
                onError={setErrorMessage}
                onLoad={loadSnapshot}
                value={vehicleId}
              />
              <DatePicker
                allowClear
                onChange={setAsOf}
                placeholder="快照日期"
                value={asOf}
              />
              <DatePicker
                allowClear
                onChange={setFrom}
                placeholder="开始日期"
                value={from}
              />
              <DatePicker
                allowClear
                onChange={setTo}
                placeholder="结束日期"
                value={to}
              />
              <Button icon={<ReloadOutlined />} loading={loadingHealth} onClick={loadHealth}>
                刷新服务状态
              </Button>
            </Space>
            <Typography.Text type={rangeValidation.valid ? "secondary" : "danger"}>
              时间线查询范围不能超过 366 天。
            </Typography.Text>
          </Space>
        </Card>

        {loadingHealth ? <Spin /> : null}

        {apiDisabled ? (
          <Alert
            message="车队运营 API 未启用"
            description="请为内部管理访问启用 FLEET_OPS_API_ENABLED。未启用时业务数据面板不会展示。"
            showIcon
            type="warning"
          />
        ) : null}

        {permissionDenied ? (
          <Alert
            message="无权访问"
            description="当前账号需要 fleet_ops:read 才能访问该内部只读视图。"
            showIcon
            type="error"
          />
        ) : null}

        {errorMessage ? <Alert message={errorMessage} showIcon type="error" /> : null}

        {health && !apiDisabled ? (
          <Alert
            message={`车队运营 API 服务状态：${health.status ?? "available"}`}
            showIcon
            type="success"
          />
        ) : null}

        {!summary && !loadingSnapshot && !apiDisabled && !permissionDenied ? (
          <Empty description="请选择车辆或输入车辆编号、VIN/车牌号" />
        ) : null}

        {summary ? (
          <Space direction="vertical" size={16} style={{ width: "100%" }}>
            <FleetOpsOverview summary={summary} />
            <FleetOpsStateCard state={summary.state} />
            <FleetOpsTimelineCard timeline={summary.timeline} />
            <FleetOpsEconomicsCard economics={summary.economics} />
            <FleetOpsRiskCard risk={summary.risk} />
            <FleetOpsEvidencePanel groups={evidenceGroups} />
          </Space>
        ) : null}
      </Space>
    </ProtectedShell>
  );
}

function getErrorMessage(error: unknown) {
  return error instanceof ApiError ? error.message : "车队运营请求失败。";
}

function setFleetOpsVehicleIdUrl(vehicleId: string) {
  if (typeof window === "undefined") {
    return;
  }

  const url = new URL(window.location.href);
  url.searchParams.set("vehicleId", vehicleId);
  window.history.replaceState(null, "", `${url.pathname}${url.search}${url.hash}`);
}
