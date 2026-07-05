"use client";

import { ReloadOutlined } from "@ant-design/icons";
import { Alert, Button, Card, Descriptions, Space, Spin, Tag, Typography } from "antd";
import Link from "next/link";
import { useCallback, useEffect, useMemo, useState } from "react";

import { ApiError } from "../../lib/api";
import {
  getFleetOpsOverview,
  getFleetOpsOverviewVehicles,
  getFleetOpsPoolDetail,
  getFleetOpsPools,
  isFleetOpsApiDisabled,
  isFleetOpsPermissionDenied,
  type FleetOpsOverviewQuery,
  type FleetOpsOverviewReadModel,
  type FleetOpsPagination,
  type FleetOpsPoolIdentity,
  type FleetOpsScopedVehicleListReadModel
} from "../../lib/fleet-ops-api";
import { formatFleetOpsDepositTreatmentNote, summarizeFleetOpsWarnings } from "../../lib/fleet-ops-view-model";
import { FleetOpsAnomalyTable } from "./fleet-ops-anomaly-table";
import { FleetOpsDistributionPanel } from "./fleet-ops-distribution-panel";
import { FleetOpsKpiCards } from "./fleet-ops-kpi-cards";
import { FleetOpsScopeSelector } from "./fleet-ops-scope-selector";
import { FleetOpsScopedVehicleList } from "./fleet-ops-scoped-vehicle-list";

const defaultQuery: FleetOpsOverviewQuery = {
  page: 1,
  pageSize: 20,
  scopeType: "ALL",
  topN: 10
};

export interface FleetOpsPoolOverviewProps {
  fixedPoolId?: string;
}

export function FleetOpsPoolOverview({ fixedPoolId }: Readonly<FleetOpsPoolOverviewProps>) {
  const [query, setQuery] = useState<FleetOpsOverviewQuery>(() => ({
    ...defaultQuery,
    poolId: fixedPoolId,
    scopeType: fixedPoolId ? "POOL" : "ALL"
  }));
  const [pools, setPools] = useState<FleetOpsPoolIdentity[]>([]);
  const [pool, setPool] = useState<FleetOpsPoolIdentity | null>(null);
  const [overview, setOverview] = useState<FleetOpsOverviewReadModel | null>(null);
  const [vehicles, setVehicles] = useState<FleetOpsScopedVehicleListReadModel | null>(null);
  const [vehiclePagination, setVehiclePagination] = useState<FleetOpsPagination>({ page: 1, pageSize: 20, total: 0 });
  const [loading, setLoading] = useState(false);
  const [loadingPools, setLoadingPools] = useState(false);
  const [apiDisabled, setApiDisabled] = useState(false);
  const [permissionDenied, setPermissionDenied] = useState(false);
  const [errorMessage, setErrorMessage] = useState<string | null>(null);

  const effectiveQuery = useMemo(
    () => ({
      ...query,
      poolId: fixedPoolId ?? query.poolId,
      scopeType: fixedPoolId ? "POOL" as const : query.scopeType ?? "ALL" as const
    }),
    [fixedPoolId, query]
  );

  const loadPools = useCallback(async () => {
    setLoadingPools(true);
    try {
      const result = await getFleetOpsPools({ page: 1, pageSize: 100, poolStatus: "ACTIVE" });
      setPools(result.data.items);
    } catch {
      setPools([]);
    } finally {
      setLoadingPools(false);
    }
  }, []);

  const loadOverview = useCallback(
    async (nextQuery: FleetOpsOverviewQuery, page = 1, pageSize = 20) => {
      const requestQuery = {
        ...nextQuery,
        page,
        pageSize,
        poolId: fixedPoolId ?? nextQuery.poolId,
        scopeType: fixedPoolId ? "POOL" as const : nextQuery.scopeType ?? "ALL" as const
      };

      setLoading(true);
      setApiDisabled(false);
      setPermissionDenied(false);
      setErrorMessage(null);

      try {
        const [overviewResult, vehicleResult] = await Promise.all([
          fixedPoolId
            ? getFleetOpsPoolDetail(fixedPoolId, requestQuery)
            : getFleetOpsOverview(requestQuery),
          getFleetOpsOverviewVehicles(requestQuery)
        ]);

        if (fixedPoolId) {
          const detail = overviewResult.data as unknown as { overview: FleetOpsOverviewReadModel; pool: FleetOpsPoolIdentity };
          setOverview(detail.overview);
          setPool(detail.pool);
        } else {
          setOverview(overviewResult.data as FleetOpsOverviewReadModel);
          setPool((overviewResult.data as FleetOpsOverviewReadModel).scope.pool ?? null);
        }

        setVehicles(vehicleResult.data);
        setVehiclePagination(vehicleResult.data.pagination);
      } catch (error) {
        setOverview(null);
        setVehicles(null);
        if (isFleetOpsApiDisabled(error)) {
          setApiDisabled(true);
        } else if (isFleetOpsPermissionDenied(error)) {
          setPermissionDenied(true);
        } else {
          setErrorMessage(getErrorMessage(error));
        }
      } finally {
        setLoading(false);
      }
    },
    [fixedPoolId]
  );

  useEffect(() => {
    void loadPools();
  }, [loadPools]);

  useEffect(() => {
    const initialQuery = {
      ...defaultQuery,
      poolId: fixedPoolId,
      scopeType: fixedPoolId ? "POOL" as const : "ALL" as const
    };
    setQuery(initialQuery);
    void loadOverview(initialQuery, 1, 20);
  }, [fixedPoolId, loadOverview]);

  const warningCodes = useMemo(
    () => summarizeFleetOpsWarnings([...(overview?.warnings ?? []), ...(vehicles?.warnings ?? [])]),
    [overview?.warnings, vehicles?.warnings]
  );
  const confidenceDistribution = useMemo(
    () => (overview?.dataQuality as unknown as { confidenceDistribution?: Record<string, number> } | undefined)?.confidenceDistribution ?? {},
    [overview?.dataQuality]
  );

  function applyQuery() {
    void loadOverview(effectiveQuery, 1, vehiclePagination.pageSize);
  }

  function resetQuery() {
    const nextQuery = {
      ...defaultQuery,
      poolId: fixedPoolId,
      scopeType: fixedPoolId ? "POOL" as const : "ALL" as const
    };
    setQuery(nextQuery);
    void loadOverview(nextQuery, 1, 20);
  }

  return (
    <Space direction="vertical" size={16} style={{ width: "100%" }}>
      <Space style={{ justifyContent: "space-between", width: "100%" }}>
        <Space direction="vertical" size={2}>
          <Typography.Title level={4} style={{ margin: 0 }}>
            {fixedPoolId ? "车辆池详情" : "车队运营总览"}
          </Typography.Title>
          <Typography.Text type="secondary">基于车辆池或动态分群查看经营、风险、现金流与数据质量。</Typography.Text>
        </Space>
        <Space wrap>
          <Link href="/fleet-ops">
            <Button>单车诊断</Button>
          </Link>
          <Link href="/fleet-ops/pools">
            <Button>车辆池</Button>
          </Link>
          <Button icon={<ReloadOutlined />} loading={loading} onClick={() => void loadOverview(effectiveQuery, vehiclePagination.page, vehiclePagination.pageSize)}>
            刷新
          </Button>
        </Space>
      </Space>

      <FleetOpsScopeSelector
        fixedPoolId={fixedPoolId}
        loading={loading || loadingPools}
        onApply={applyQuery}
        onChange={setQuery}
        onReset={resetQuery}
        pools={pools}
        query={effectiveQuery}
      />

      {apiDisabled ? <Alert message="车队运营 API 未启用" showIcon type="warning" /> : null}
      {permissionDenied ? <Alert message="当前账号需要 fleet_ops:read 才能访问车队运营总览。" showIcon type="error" /> : null}
      {errorMessage ? <Alert message={errorMessage} showIcon type="error" /> : null}
      {warningCodes.length ? (
        <Alert
          message="部分指标为延后或降级口径"
          description={<Space wrap>{warningCodes.map((warning) => <Tag key={warning}>{warning}</Tag>)}</Space>}
          showIcon
          type="info"
        />
      ) : null}

      {loading && !overview ? <Spin /> : null}

      {pool ? (
        <Card title="车辆池身份">
          <Descriptions
            bordered
            column={3}
            items={[
              { label: "车辆池编号", children: pool.poolNo },
              { label: "车辆池名称", children: pool.poolName },
              { label: "类型", children: pool.poolType },
              { label: "状态", children: <Tag>{pool.poolStatus}</Tag> },
              { label: "生效车辆数", children: pool.activeVehicleCount }
            ]}
            size="small"
          />
        </Card>
      ) : null}

      {overview ? (
        <>
          <Alert message={formatFleetOpsDepositTreatmentNote()} showIcon type="info" />
          <FleetOpsKpiCards overview={overview} />
          <FleetOpsDistributionPanel
            distributions={{
              ...overview.distributions,
              confidence: confidenceDistribution
            }}
            risk={overview.risk}
          />
          <div style={{ display: "grid", gap: 16, gridTemplateColumns: "repeat(auto-fit, minmax(360px, 1fr))" }}>
            <FleetOpsAnomalyTable items={overview.anomalies.highestOverdue} title="最高逾期敞口" />
            <FleetOpsAnomalyTable items={overview.anomalies.highestRisk} title="最高风险" />
            <FleetOpsAnomalyTable items={overview.anomalies.lowestRoi} title="最低 ROI" />
            <FleetOpsAnomalyTable items={overview.anomalies.lowestConfidence} title="最低置信度" />
            <FleetOpsAnomalyTable items={overview.anomalies.missingEvidence} title="缺失证据" />
            <FleetOpsAnomalyTable items={overview.anomalies.cashflowAnomaly} title="现金流异常" />
            <FleetOpsAnomalyTable items={overview.anomalies.timelineFallback} title="时间线回退" />
          </div>
          <FleetOpsScopedVehicleList
            items={vehicles?.items}
            loading={loading}
            onPageChange={(page, pageSize) => {
              void loadOverview(effectiveQuery, page, pageSize);
            }}
            pagination={vehicles?.pagination ?? vehiclePagination}
          />
        </>
      ) : null}
    </Space>
  );
}

function getErrorMessage(error: unknown) {
  return error instanceof ApiError ? error.message : "车队运营总览加载失败。";
}
