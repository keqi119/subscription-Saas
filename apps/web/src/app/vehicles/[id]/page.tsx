"use client";

import { Alert, Button, Empty, Flex, Result, Spin } from "antd";
import { useParams, useRouter, useSearchParams } from "next/navigation";
import { useCallback, useEffect, useMemo, useState } from "react";

import { ProtectedShell } from "../../../components/protected-shell";
import {
  VehicleDetailActions,
  type VehicleDetailRecord
} from "../../../components/vehicle-workspace/vehicle-detail-actions";
import { VehicleWorkspaceContent } from "../../../components/vehicle-workspace/vehicle-workspace-content";
import { VehicleWorkspace } from "../../../components/vehicle-workspace/vehicle-workspace";
import { apiFetch, ApiError } from "../../../lib/api";
import type { AuthMeResponse } from "../../../lib/auth";
import {
  buildVehicleWorkspaceHref,
  getVisibleVehicleWorkspaceTabs,
  parseVehicleWorkspaceLocation,
  type VehicleWorkspaceLocation,
  type VehicleWorkspaceTabKey
} from "../../../lib/admin-vehicle-workspace";

type LoadFailure = "FORBIDDEN" | "NOT_FOUND" | "OTHER" | null;

export default function VehicleDetailPage() {
  const params = useParams<{ id: string }>();
  const router = useRouter();
  const searchParams = useSearchParams();
  const vehicleId = safeDecode(params.id);
  const [vehicle, setVehicle] = useState<VehicleDetailRecord | null>(null);
  const [me, setMe] = useState<AuthMeResponse | null>(null);
  const [loading, setLoading] = useState(true);
  const [failure, setFailure] = useState<LoadFailure>(null);
  const [errorMessage, setErrorMessage] = useState<string | null>(null);
  const permissions = useMemo(
    () => new Set(me?.user.permissions ?? []),
    [me?.user.permissions]
  );
  const visibleTabs = useMemo(
    () => getVisibleVehicleWorkspaceTabs(permissions),
    [permissions]
  );

  const refreshVehicle = useCallback(async () => {
    const next = await apiFetch<VehicleDetailRecord>(
      `/vehicles/${encodeURIComponent(vehicleId)}`
    );
    setVehicle(next);
  }, [vehicleId]);

  const loadPage = useCallback(
    async (signal?: AbortSignal) => {
      setLoading(true);
      setFailure(null);
      setErrorMessage(null);
      try {
        const profile = await apiFetch<AuthMeResponse>("/auth/me", { signal });
        if (!profile.user.permissions.includes("vehicle:view")) {
          setMe(profile);
          setFailure("FORBIDDEN");
          return;
        }
        const nextVehicle = await apiFetch<VehicleDetailRecord>(
          `/vehicles/${encodeURIComponent(vehicleId)}`,
          { signal }
        );
        setMe(profile);
        setVehicle(nextVehicle);
      } catch (error) {
        if (signal?.aborted) {
          return;
        }
        if (error instanceof ApiError && error.status === 403) {
          setFailure("FORBIDDEN");
        } else if (error instanceof ApiError && error.status === 404) {
          setFailure("NOT_FOUND");
        } else {
          setFailure("OTHER");
          setErrorMessage(error instanceof Error ? error.message : "车辆详情加载失败");
        }
      } finally {
        if (!signal?.aborted) {
          setLoading(false);
        }
      }
    },
    [vehicleId]
  );

  useEffect(() => {
    const controller = new AbortController();
    void loadPage(controller.signal);
    return () => controller.abort();
  }, [loadPage]);

  const location = useMemo<VehicleWorkspaceLocation | null>(() => {
    if (visibleTabs.length === 0) {
      return null;
    }
    return parseVehicleWorkspaceLocation(
      new URLSearchParams(searchParams.toString()),
      visibleTabs
    );
  }, [searchParams, visibleTabs]);

  useEffect(() => {
    if (!location || !vehicleId) {
      return;
    }
    const canonicalHref = buildVehicleWorkspaceHref({
      section: location.section,
      tab: location.tab,
      vehicleId
    });
    const query = searchParams.toString();
    const currentHref = `/vehicles/${encodeURIComponent(vehicleId)}${query ? `?${query}` : ""}`;
    if (currentHref !== canonicalHref) {
      router.replace(canonicalHref, { scroll: false });
    }
  }, [location, router, searchParams, vehicleId]);

  function navigateTab(tab: VehicleWorkspaceTabKey) {
    router.replace(buildVehicleWorkspaceHref({ tab, vehicleId }), { scroll: false });
  }

  function navigateSection(section: NonNullable<VehicleWorkspaceLocation["section"]>) {
    if (!location) {
      return;
    }
    router.replace(
      buildVehicleWorkspaceHref({ section, tab: location.tab, vehicleId }),
      { scroll: false }
    );
  }

  if (loading) {
    return (
      <ProtectedShell>
        <Flex align="center" gap={12} justify="center" style={{ minHeight: 280 }}>
          <Spin />
          <span>正在加载车辆详情</span>
        </Flex>
      </ProtectedShell>
    );
  }

  if (failure === "FORBIDDEN" || visibleTabs.length === 0) {
    return (
      <ProtectedShell>
        <Result
          extra={<Button href="/vehicles">返回车辆列表</Button>}
          status="403"
          subTitle="403：无权查看车辆详情"
          title="访问受限"
        />
      </ProtectedShell>
    );
  }

  if (failure === "NOT_FOUND") {
    return (
      <ProtectedShell>
        <Empty description="车辆不存在或已删除" />
      </ProtectedShell>
    );
  }

  if (failure === "OTHER" || !vehicle || !location) {
    return (
      <ProtectedShell>
        <Alert
          action={<Button onClick={() => void loadPage()}>重试</Button>}
          description={errorMessage ?? "车辆详情暂时不可用"}
          message="车辆详情加载失败"
          showIcon
          type="error"
        />
      </ProtectedShell>
    );
  }

  return (
    <ProtectedShell>
      <VehicleWorkspace
        actions={
          <VehicleDetailActions
            onVehicleChanged={refreshVehicle}
            permissions={permissions}
            vehicle={vehicle}
          />
        }
        activeTab={location.tab}
        onTabChange={navigateTab}
        vehicle={vehicle}
        visibleTabs={visibleTabs}
      >
        <VehicleWorkspaceContent
          activeTab={location.tab}
          onSectionChange={navigateSection}
          onVehicleChanged={refreshVehicle}
          permissions={permissions}
          section={location.section}
          vehicle={vehicle}
          visibleTabs={visibleTabs}
        />
      </VehicleWorkspace>
    </ProtectedShell>
  );
}

function safeDecode(value?: string) {
  if (!value) {
    return "";
  }
  try {
    return decodeURIComponent(value);
  } catch {
    return value;
  }
}
