"use client";

import { ReloadOutlined, SearchOutlined } from "@ant-design/icons";
import { Alert, Button, Card, DatePicker, Empty, Input, Space, Spin, Typography } from "antd";
import type { Dayjs } from "dayjs";
import dayjs from "dayjs";
import { useCallback, useEffect, useMemo, useState } from "react";

import { FleetOpsEconomicsCard } from "../../components/fleet-ops/fleet-ops-economics-card";
import { FleetOpsEvidencePanel } from "../../components/fleet-ops/fleet-ops-evidence-panel";
import { FleetOpsOverview } from "../../components/fleet-ops/fleet-ops-overview";
import { FleetOpsRiskCard } from "../../components/fleet-ops/fleet-ops-risk-card";
import { FleetOpsStateCard } from "../../components/fleet-ops/fleet-ops-state-card";
import { FleetOpsTimelineCard } from "../../components/fleet-ops/fleet-ops-timeline-card";
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

  async function loadSnapshot() {
    const normalizedVehicleId = vehicleId.trim();
    if (!normalizedVehicleId || apiDisabled || permissionDenied) {
      return;
    }

    if (!rangeValidation.valid) {
      setErrorMessage(rangeValidation.reason ?? "Fleet Ops date range is invalid.");
      return;
    }

    setLoadingSnapshot(true);
    setErrorMessage(null);

    try {
      const result = await getFleetOpsSnapshot(normalizedVehicleId, query);
      setSnapshot(result.data);
      setApiDisabled(isFleetOpsApiDisabled(result));
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
  }

  return (
    <ProtectedShell>
      <Space direction="vertical" size={16} style={{ width: "100%" }}>
        <Space direction="vertical" size={4}>
          <Typography.Title level={4} style={{ margin: 0 }}>
            Fleet Ops
          </Typography.Title>
          <Typography.Text type="secondary">
            Internal read-only view for Fleet Ops snapshot, evidence, warnings, confidence, and collection diagnostics.
          </Typography.Text>
        </Space>

        <Card title="Lookup">
          <Space direction="vertical" size={12} style={{ width: "100%" }}>
            <Space wrap>
              <Input
                allowClear
                onChange={(event) => setVehicleId(event.target.value)}
                onPressEnter={loadSnapshot}
                placeholder="Vehicle ID"
                style={{ width: 280 }}
                value={vehicleId}
              />
              <DatePicker
                allowClear
                onChange={setAsOf}
                placeholder="As of"
                value={asOf}
              />
              <DatePicker
                allowClear
                onChange={setFrom}
                placeholder="From"
                value={from}
              />
              <DatePicker
                allowClear
                onChange={setTo}
                placeholder="To"
                value={to}
              />
              <Button icon={<SearchOutlined />} loading={loadingSnapshot} onClick={loadSnapshot} type="primary">
                Load snapshot
              </Button>
              <Button icon={<ReloadOutlined />} loading={loadingHealth} onClick={loadHealth}>
                Refresh health
              </Button>
            </Space>
            <Typography.Text type={rangeValidation.valid ? "secondary" : "danger"}>
              Timeline query range must be 366 days or less.
            </Typography.Text>
          </Space>
        </Card>

        {loadingHealth ? <Spin /> : null}

        {apiDisabled ? (
          <Alert
            message="Fleet Ops API is disabled"
            description="Set FLEET_OPS_API_ENABLED for internal admin access. Business data panels are hidden while disabled."
            showIcon
            type="warning"
          />
        ) : null}

        {permissionDenied ? (
          <Alert
            message="Permission denied"
            description="The current account needs fleet_ops:read for this internal view."
            showIcon
            type="error"
          />
        ) : null}

        {errorMessage ? <Alert message={errorMessage} showIcon type="error" /> : null}

        {health && !apiDisabled ? (
          <Alert
            message={`Fleet Ops API health: ${health.status ?? "available"}`}
            showIcon
            type="success"
          />
        ) : null}

        {!summary && !loadingSnapshot && !apiDisabled && !permissionDenied ? (
          <Empty description="Enter a vehicle ID to inspect the Fleet Ops snapshot." />
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
  return error instanceof ApiError ? error.message : "Fleet Ops request failed.";
}
