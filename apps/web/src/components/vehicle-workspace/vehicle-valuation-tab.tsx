"use client";

import { EyeOutlined, PlusOutlined } from "@ant-design/icons";
import {
  Alert,
  App,
  Button,
  Card,
  Col,
  DatePicker,
  Descriptions,
  Drawer,
  Empty,
  Flex,
  Form,
  Input,
  InputNumber,
  Modal,
  Row,
  Select,
  Space,
  Spin,
  Table,
  Tabs,
  Tag,
  Typography
} from "antd";
import type { FormInstance } from "antd";
import type { ColumnsType } from "antd/es/table";
import dayjs, { type Dayjs } from "dayjs";
import { useCallback, useEffect, useState } from "react";

import {
  RESIDUAL_FORECAST_INTERPOLATION_METHOD_LABELS,
  SALE_PRICE_REVIEW_TYPE_LABELS,
  VEHICLE_ASSET_COST_PROFILE_STATUS_LABELS,
  VEHICLE_DEPRECIATION_METHOD_LABELS,
  VEHICLE_DEPRECIATION_POLICY_STATUS_LABELS,
  VEHICLE_RESIDUAL_FORECAST_METHOD_LABELS,
  VEHICLE_RESIDUAL_FORECAST_POINT_STATUS_LABELS,
  VEHICLE_VALUATION_REVIEW_SOURCE_LABELS,
  labelOf
} from "../../constants/labels";
import { apiFetch } from "../../lib/api";
import {
  formatDate,
  formatDateTime,
  formatYuan,
  getErrorMessage,
  optionsFromLabels,
  toCentAmount,
  yuanFromCents
} from "../../lib/capital-format";
import {
  VEHICLE_VALUATION_SECTIONS,
  getForecastTrend,
  getValuationActions,
  presentResidualForecastStatus,
  presentValuationReviewStatus,
  type VehicleValuationSectionKey
} from "../../lib/vehicle-valuation-workspace";
import type { VehicleWorkspaceTabProps } from "./vehicle-workspace-types";

interface ResidualCurveSummary {
  confidenceScore?: number | null;
  curveNo?: string | null;
  id: string;
}

interface VehicleResidualForecastPoint {
  adoptedAt?: string | null;
  adoptedResidualAmount?: number | null;
  adoptRemark?: string | null;
  confidenceScore?: number | null;
  horizonMonth: number;
  id?: string | null;
  interpolationMethod?: string | null;
  lowerBoundAmount?: number | null;
  pointStatus: string;
  predictedResidualAmount?: number | null;
  predictedResidualRateBps?: number | null;
  targetDate: string;
  upperBoundAmount?: number | null;
}

interface VehicleResidualForecast {
  asOfDate: string;
  createdAt?: string | null;
  currentMileageKm?: number | null;
  currentSalePriceAmount?: number | null;
  curve?: ResidualCurveSummary | null;
  forecastMethod: string;
  forecastNo?: string | null;
  forecastStatus: string;
  id?: string | null;
  points?: VehicleResidualForecastPoint[];
  purchasePriceAmount?: number | null;
  remark?: string | null;
  vehicleAgeMonths?: number | null;
}

interface VehicleResidualForecastListResponse {
  items: VehicleResidualForecast[];
  page: number;
  pageSize: number;
  total: number;
}

interface VehicleResidualForecastGenerationResult {
  dryRun: boolean;
  forecast: VehicleResidualForecast;
  pointCount?: number | null;
  points?: VehicleResidualForecastPoint[];
}

interface VehicleValuationReview {
  adoptedResidualAmount?: number | null;
  approvedSalePriceAmount?: number | null;
  cancelReason?: string | null;
  cancelledAt?: string | null;
  createdAt?: string | null;
  forecastAmountSource?: string | null;
  forecastConfidenceScore?: number | null;
  forecastHorizonMonth?: number | null;
  forecastPointId?: string | null;
  forecastResidualAmount?: number | null;
  forecastTargetDate?: string | null;
  id: string;
  originalSalePriceAmount?: number | null;
  reason?: string | null;
  rejectReason?: string | null;
  requestedAt?: string | null;
  requestedSalePriceAmount: number;
  reviewedAt?: string | null;
  reviewNo: string;
  reviewRemark?: string | null;
  reviewSource: string;
  reviewStatus: string;
  vehicleId: string;
}

interface VehicleValuationReviewListResponse {
  items: VehicleValuationReview[];
  page: number;
  pageSize: number;
  total: number;
}

interface SalePriceHistory {
  afterSalePriceAmount: number;
  beforeSalePriceAmount?: number | null;
  createdAt: string;
  effectiveFrom: string;
  effectiveTo?: string | null;
  id: string;
  reason: string;
  remark?: string | null;
  reviewQuarter?: string | null;
  reviewType: string;
}

interface VehicleDepreciationRecordSummary {
  depreciationAmount: number;
  id: string;
  recordStatus: string;
}

interface VehicleDepreciationPolicySummary {
  depreciationBasisAmount: number;
  depreciationMethod: string;
  depreciationStartDate: string;
  id: string;
  monthlyDepreciationAmount?: number | null;
  policyNo: string;
  policyStatus: string;
  records: VehicleDepreciationRecordSummary[];
  residualValueAmount: number;
  scheduleCount: number;
  usefulLifeMonths?: number | null;
}

interface VehicleDepreciationSummary {
  activePolicy?: VehicleDepreciationPolicySummary | null;
  confirmedRecordCount: number;
  lockedRecordCount: number;
  policies: VehicleDepreciationPolicySummary[];
  policyCount: number;
  scheduleCount: number;
}

interface VehicleAssetCostProfile {
  annualInsuranceCostAmount?: number | null;
  annualMaintenanceReserveAmount?: number | null;
  capitalCostRateBps?: number | null;
  depreciationMethod: string;
  depreciationStartDate?: string | null;
  id: string;
  otherMonthlyCostAmount?: number | null;
  profileStatus: string;
  remark?: string | null;
  residualValueAmount: number;
  usefulLifeMonths: number;
}

interface VehicleAssetCostPreview {
  annualCapitalCostAmount: number;
  depreciableAmount: number;
  estimatedMonthlyCostAmount?: number | null;
  monthlyCapitalCostAmount: number;
  monthlyDepreciationAmount?: number | null;
  monthlyInsuranceCostAmount: number;
  monthlyMaintenanceReserveAmount: number;
  otherMonthlyCostAmount: number;
  purchasePriceAmount: number;
  residualValueAmount: number;
}

interface VehicleAssetCostPreviewResponse {
  preview: VehicleAssetCostPreview | null;
  profile: VehicleAssetCostProfile | null;
}

interface GenerateForecastFormValues {
  asOfDate: Dayjs;
  horizonMonthsText: string;
  remark?: string | null;
}

interface AdoptPointFormValues {
  adoptedResidualAmountYuan: number;
  adoptRemark?: string | null;
}

interface CreateReviewFormValues {
  reason?: string | null;
  requestedSalePriceAmountYuan: number;
  reviewRemark?: string | null;
}

interface CancelReviewFormValues {
  cancelReason: string;
}

interface InitializePriceFormValues {
  currentSalePriceAmountYuan: number;
  effectiveFrom: Dayjs;
  reason: string;
  remark?: string | null;
  reviewType: "INITIAL_POOL" | "RETURN_REINIT";
}

interface ReviewPriceFormValues {
  effectiveFrom: Dayjs;
  newSalePriceAmountYuan: number;
  reason: string;
  remark?: string | null;
  reviewQuarter: string;
}

interface AssetCostProfileFormValues {
  annualInsuranceCostAmountYuan?: number | null;
  annualMaintenanceReserveAmountYuan?: number | null;
  capitalCostRatePercent?: number | null;
  depreciationMethod?: string;
  depreciationStartDate?: Dayjs | null;
  otherMonthlyCostAmountYuan?: number | null;
  remark?: string | null;
  residualValueAmountYuan?: number | null;
  usefulLifeMonths?: number | null;
}

const DEFAULT_HORIZONS = "12, 24, 36, 48, 60";

export function VehicleValuationTab({
  onVehicleChanged,
  permissions,
  vehicle
}: Readonly<VehicleWorkspaceTabProps>) {
  const { message } = App.useApp();
  const [generateForm] = Form.useForm<GenerateForecastFormValues>();
  const [adoptForm] = Form.useForm<AdoptPointFormValues>();
  const [createReviewForm] = Form.useForm<CreateReviewFormValues>();
  const [cancelReviewForm] = Form.useForm<CancelReviewFormValues>();
  const [initializePriceForm] = Form.useForm<InitializePriceFormValues>();
  const [reviewPriceForm] = Form.useForm<ReviewPriceFormValues>();
  const [costProfileForm] = Form.useForm<AssetCostProfileFormValues>();
  const [activeSection, setActiveSection] = useState<VehicleValuationSectionKey>("overview");
  const [latestForecast, setLatestForecast] = useState<VehicleResidualForecast | null>(null);
  const [forecasts, setForecasts] = useState<VehicleResidualForecast[]>([]);
  const [reviews, setReviews] = useState<VehicleValuationReview[]>([]);
  const [salePriceHistory, setSalePriceHistory] = useState<SalePriceHistory[]>([]);
  const [depreciationSummary, setDepreciationSummary] = useState<VehicleDepreciationSummary | null>(null);
  const [costProfile, setCostProfile] = useState<VehicleAssetCostProfile | null>(null);
  const [costPreview, setCostPreview] = useState<VehicleAssetCostPreview | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [generateOpen, setGenerateOpen] = useState(false);
  const [generatePreview, setGeneratePreview] = useState<VehicleResidualForecastGenerationResult | null>(null);
  const [generating, setGenerating] = useState(false);
  const [forecastDetail, setForecastDetail] = useState<VehicleResidualForecast | null>(null);
  const [adoptTarget, setAdoptTarget] = useState<VehicleResidualForecastPoint | null>(null);
  const [voidTarget, setVoidTarget] = useState<VehicleResidualForecast | null>(null);
  const [createReviewTarget, setCreateReviewTarget] = useState<VehicleResidualForecastPoint | null>(null);
  const [reviewDetail, setReviewDetail] = useState<VehicleValuationReview | null>(null);
  const [cancelReviewTarget, setCancelReviewTarget] = useState<VehicleValuationReview | null>(null);
  const [initializePriceOpen, setInitializePriceOpen] = useState(false);
  const [reviewPriceOpen, setReviewPriceOpen] = useState(false);
  const [savingCostProfile, setSavingCostProfile] = useState(false);
  const vehicleId = vehicle.id;
  const canManageVehicle = permissions.has("vehicle:manage");
  const canViewForecast = permissions.has("residual_forecast:view");
  const canViewReviews = permissions.has("vehicle_valuation_review:view");
  const canViewHistory = permissions.has("vehicle:history_view");
  const canViewDepreciation = permissions.has("vehicle_depreciation:view");

  const loadValuationDomain = useCallback(
    async (signal?: AbortSignal) => {
      setLoading(true);
      setError(null);
      try {
        const [latest, history, reviewResult, priceRows, depreciation, profile, preview] =
          await Promise.all([
            canViewForecast
              ? apiFetch<VehicleResidualForecast | null>(
                  `/vehicles/${encodeURIComponent(vehicleId)}/residual-forecasts/latest`,
                  { signal }
                )
              : Promise.resolve(null),
            canViewForecast
              ? apiFetch<VehicleResidualForecastListResponse>(
                  `/vehicles/${encodeURIComponent(vehicleId)}/residual-forecasts?page=1&pageSize=100`,
                  { signal }
                )
              : Promise.resolve({ items: [], page: 1, pageSize: 100, total: 0 }),
            canViewReviews
              ? apiFetch<VehicleValuationReviewListResponse>(
                  `/vehicles/${encodeURIComponent(vehicleId)}/valuation-reviews?page=1&pageSize=100`,
                  { signal }
                )
              : Promise.resolve({ items: [], page: 1, pageSize: 100, total: 0 }),
            canViewHistory
              ? apiFetch<SalePriceHistory[]>(
                  `/vehicles/${encodeURIComponent(vehicleId)}/sale-price-history`,
                  { signal }
                )
              : Promise.resolve([]),
            canViewDepreciation
              ? apiFetch<VehicleDepreciationSummary>(
                  `/vehicles/${encodeURIComponent(vehicleId)}/depreciation-summary`,
                  { signal }
                )
              : Promise.resolve(null),
            apiFetch<VehicleAssetCostProfile | null>(
              `/vehicles/${encodeURIComponent(vehicleId)}/asset-cost-profile`,
              { signal }
            ),
            apiFetch<VehicleAssetCostPreviewResponse>(
              `/vehicles/${encodeURIComponent(vehicleId)}/asset-cost-profile/preview`,
              { signal }
            )
          ]);

        setLatestForecast(latest);
        setForecasts(history.items);
        setReviews(reviewResult.items);
        setSalePriceHistory(priceRows);
        setDepreciationSummary(depreciation);
        setCostProfile(profile);
        setCostPreview(preview.preview);
        costProfileForm.setFieldsValue(costProfileToFormValues(profile));
      } catch (loadError) {
        if (!signal?.aborted) {
          setError(getErrorMessage(loadError));
        }
      } finally {
        if (!signal?.aborted) {
          setLoading(false);
        }
      }
    },
    [
      canViewDepreciation,
      canViewForecast,
      canViewHistory,
      canViewReviews,
      costProfileForm,
      vehicleId
    ]
  );

  useEffect(() => {
    const controller = new AbortController();
    void loadValuationDomain(controller.signal);
    return () => controller.abort();
  }, [loadValuationDomain]);

  const actions = getValuationActions({ latestForecast, permissions, vehicleStatus: vehicle.status });
  const currentBookValue = getCurrentBookValue(depreciationSummary?.activePolicy ?? null);
  const trendPoint = getComparableForecastPoint(latestForecast);
  const trend = getForecastTrend(
    trendPoint?.adoptedResidualAmount ?? trendPoint?.predictedResidualAmount,
    vehicle.currentSalePriceAmount
  );

  async function refreshForecasts() {
    if (!canViewForecast) {
      return;
    }
    const [latest, history] = await Promise.all([
      apiFetch<VehicleResidualForecast | null>(
        `/vehicles/${encodeURIComponent(vehicleId)}/residual-forecasts/latest`
      ),
      apiFetch<VehicleResidualForecastListResponse>(
        `/vehicles/${encodeURIComponent(vehicleId)}/residual-forecasts?page=1&pageSize=100`
      )
    ]);
    setLatestForecast(latest);
    setForecasts(history.items);
  }

  async function refreshReviews() {
    if (!canViewReviews) {
      return;
    }
    const result = await apiFetch<VehicleValuationReviewListResponse>(
      `/vehicles/${encodeURIComponent(vehicleId)}/valuation-reviews?page=1&pageSize=100`
    );
    setReviews(result.items);
  }

  async function refreshSalePriceHistory() {
    if (!canViewHistory) {
      return;
    }
    setSalePriceHistory(
      await apiFetch<SalePriceHistory[]>(
        `/vehicles/${encodeURIComponent(vehicleId)}/sale-price-history`
      )
    );
  }

  async function refreshCostProfile() {
    const [profile, preview] = await Promise.all([
      apiFetch<VehicleAssetCostProfile | null>(
        `/vehicles/${encodeURIComponent(vehicleId)}/asset-cost-profile`
      ),
      apiFetch<VehicleAssetCostPreviewResponse>(
        `/vehicles/${encodeURIComponent(vehicleId)}/asset-cost-profile/preview`
      )
    ]);
    setCostProfile(profile);
    setCostPreview(preview.preview);
    costProfileForm.setFieldsValue(costProfileToFormValues(profile));
  }

  function openGenerate() {
    generateForm.setFieldsValue({
      asOfDate: dayjs(),
      horizonMonthsText: DEFAULT_HORIZONS,
      remark: undefined
    });
    setGeneratePreview(null);
    setGenerateOpen(true);
  }

  async function runForecastGeneration(dryRun: boolean) {
    let values: GenerateForecastFormValues;
    try {
      values = await generateForm.validateFields();
    } catch {
      return;
    }
    let payload: ReturnType<typeof buildForecastPayload>;
    try {
      payload = buildForecastPayload(values, dryRun);
    } catch (payloadError) {
      void message.error(errorText(payloadError));
      return;
    }
    if (dryRun) {
      setGenerating(true);
      try {
        setGeneratePreview(
          await apiFetch<VehicleResidualForecastGenerationResult>(
            `/vehicles/${encodeURIComponent(vehicleId)}/residual-forecasts/generate`,
            { body: JSON.stringify(payload), method: "POST" }
          )
        );
        void message.success("预测试算已完成，尚未保存");
      } catch (generationError) {
        void message.error(errorText(generationError));
      } finally {
        setGenerating(false);
      }
      return;
    }

    Modal.confirm({
      content: "预测或采纳值不会直接改写当前销售价，也不会写入销售价历史。",
      okText: "确认生成",
      onOk: async () => {
        setGenerating(true);
        try {
          await apiFetch(
            `/vehicles/${encodeURIComponent(vehicleId)}/residual-forecasts/generate`,
            { body: JSON.stringify(payload), method: "POST" }
          );
          setGenerateOpen(false);
          setGeneratePreview(null);
          await refreshForecasts();
          void message.success("残值预测已生成");
        } catch (generationError) {
          void message.error(errorText(generationError));
        } finally {
          setGenerating(false);
        }
      },
      title: "正式生成残值预测？"
    });
  }

  async function openForecastDetail(forecast: VehicleResidualForecast) {
    if (!forecast.id) {
      return;
    }
    try {
      setForecastDetail(
        await apiFetch<VehicleResidualForecast>(
          `/residual-market/vehicle-forecasts/${forecast.id}`
        )
      );
    } catch (detailError) {
      void message.error(errorText(detailError));
    }
  }

  function openAdopt(point: VehicleResidualForecastPoint) {
    setAdoptTarget(point);
    adoptForm.setFieldsValue({
      adoptedResidualAmountYuan: yuanFromCents(point.predictedResidualAmount),
      adoptRemark: undefined
    });
  }

  async function adoptPoint(values: AdoptPointFormValues) {
    if (!adoptTarget?.id) {
      return;
    }
    try {
      await apiFetch(`/residual-market/vehicle-forecast-points/${adoptTarget.id}/adopt`, {
        body: JSON.stringify({
          adoptedResidualAmount: toCentAmount(values.adoptedResidualAmountYuan),
          adoptRemark: values.adoptRemark
        }),
        method: "POST"
      });
      setAdoptTarget(null);
      await refreshForecasts();
      if (forecastDetail?.id) {
        await openForecastDetail(forecastDetail);
      }
      void message.success("预测点采用值已记录，当前销售价未改变");
    } catch (adoptError) {
      void message.error(errorText(adoptError));
    }
  }

  async function voidForecast(remark?: string | null) {
    if (!voidTarget?.id) {
      return;
    }
    try {
      await apiFetch(`/residual-market/vehicle-forecasts/${voidTarget.id}/void`, {
        body: JSON.stringify({ remark }),
        method: "POST"
      });
      setVoidTarget(null);
      setForecastDetail(null);
      await refreshForecasts();
      void message.success("预测已作废");
    } catch (voidError) {
      void message.error(errorText(voidError));
    }
  }

  function openCreateReview(point: VehicleResidualForecastPoint) {
    const amount = point.adoptedResidualAmount ?? point.predictedResidualAmount;
    if (!point.id || !amount || point.pointStatus === "UNSUPPORTED") {
      void message.warning("该预测点没有可用于复核的金额");
      return;
    }
    setCreateReviewTarget(point);
    createReviewForm.setFieldsValue({
      reason: `采用 ${point.horizonMonth} 个月残值预测作为估值复核参考`,
      requestedSalePriceAmountYuan: amount / 100,
      reviewRemark: undefined
    });
  }

  async function createValuationReview(values: CreateReviewFormValues) {
    if (!createReviewTarget?.id) {
      return;
    }
    try {
      await apiFetch(
        `/vehicles/${encodeURIComponent(vehicleId)}/valuation-reviews/from-residual-forecast`,
        {
          body: JSON.stringify({
            forecastPointId: createReviewTarget.id,
            reason: values.reason,
            requestedSalePriceAmount: toCentAmount(values.requestedSalePriceAmountYuan),
            reviewRemark: values.reviewRemark
          }),
          method: "POST"
        }
      );
      setCreateReviewTarget(null);
      await refreshReviews();
      setActiveSection("reviews");
      void message.success("估值复核已发起，销售价保持不变");
    } catch (createError) {
      void message.error(errorText(createError));
    }
  }

  async function openReviewDetail(review: VehicleValuationReview) {
    try {
      setReviewDetail(
        await apiFetch<VehicleValuationReview>(`/vehicle-valuation-reviews/${review.id}`)
      );
    } catch (detailError) {
      void message.error(errorText(detailError));
    }
  }

  async function cancelReview(values: CancelReviewFormValues) {
    if (!cancelReviewTarget) {
      return;
    }
    try {
      await apiFetch(`/vehicle-valuation-reviews/${cancelReviewTarget.id}/cancel`, {
        body: JSON.stringify(values),
        method: "POST"
      });
      setCancelReviewTarget(null);
      setReviewDetail(null);
      await refreshReviews();
      void message.success("估值复核已取消");
    } catch (cancelError) {
      void message.error(errorText(cancelError));
    }
  }

  function openInitializePrice() {
    initializePriceForm.setFieldsValue({
      currentSalePriceAmountYuan: yuanFromCents(vehicle.currentSalePriceAmount),
      effectiveFrom: dayjs(),
      reason: "新入池初始化",
      reviewType: "INITIAL_POOL"
    });
    setInitializePriceOpen(true);
  }

  async function initializePrice(values: InitializePriceFormValues) {
    try {
      await apiFetch(`/vehicles/${encodeURIComponent(vehicleId)}/initialize-sale-price`, {
        body: JSON.stringify({
          currentSalePriceAmount: toCentAmount(values.currentSalePriceAmountYuan),
          effectiveFrom: values.effectiveFrom.format("YYYY-MM-DD"),
          reason: values.reason,
          remark: values.remark,
          reviewType: values.reviewType
        }),
        method: "POST"
      });
      setInitializePriceOpen(false);
      await Promise.all([refreshSalePriceHistory(), onVehicleChanged()]);
      void message.success("销售价已初始化");
    } catch (initializeError) {
      void message.error(errorText(initializeError));
    }
  }

  function openPriceReview() {
    const effectiveFrom = dayjs(vehicle.nextSalePriceReviewAt ?? undefined);
    reviewPriceForm.setFieldsValue({
      effectiveFrom,
      newSalePriceAmountYuan: yuanFromCents(vehicle.currentSalePriceAmount),
      reason: "季度市场价格复核",
      reviewQuarter: toReviewQuarter(effectiveFrom)
    });
    setReviewPriceOpen(true);
  }

  async function reviewPrice(values: ReviewPriceFormValues) {
    try {
      await apiFetch(`/vehicles/${encodeURIComponent(vehicleId)}/review-sale-price`, {
        body: JSON.stringify({
          effectiveFrom: values.effectiveFrom.format("YYYY-MM-DD"),
          newSalePriceAmount: toCentAmount(values.newSalePriceAmountYuan),
          reason: values.reason,
          remark: values.remark,
          reviewQuarter: values.reviewQuarter
        }),
        method: "POST"
      });
      setReviewPriceOpen(false);
      await Promise.all([refreshSalePriceHistory(), onVehicleChanged()]);
      void message.success("销售价复核已保存");
    } catch (reviewError) {
      void message.error(errorText(reviewError));
    }
  }

  async function saveCostProfile(values: AssetCostProfileFormValues) {
    setSavingCostProfile(true);
    try {
      await apiFetch(`/vehicles/${encodeURIComponent(vehicleId)}/asset-cost-profile`, {
        body: JSON.stringify({
          annualInsuranceCostAmount: toCentAmount(values.annualInsuranceCostAmountYuan) ?? null,
          annualMaintenanceReserveAmount:
            toCentAmount(values.annualMaintenanceReserveAmountYuan) ?? null,
          capitalCostRateBps:
            typeof values.capitalCostRatePercent === "number"
              ? Math.round(values.capitalCostRatePercent * 100)
              : null,
          depreciationMethod: values.depreciationMethod,
          depreciationStartDate: values.depreciationStartDate?.format("YYYY-MM-DD"),
          otherMonthlyCostAmount: toCentAmount(values.otherMonthlyCostAmountYuan) ?? null,
          remark: values.remark,
          residualValueAmount: toCentAmount(values.residualValueAmountYuan),
          usefulLifeMonths: values.usefulLifeMonths
        }),
        method: "PUT"
      });
      await refreshCostProfile();
      void message.success("资产成本参数已保存并重新试算");
    } catch (saveError) {
      void message.error(errorText(saveError));
    } finally {
      setSavingCostProfile(false);
    }
  }

  if (loading) {
    return (
      <Flex align="center" justify="center" style={{ minHeight: 320 }}>
        <Spin tip="正在加载估值与折旧工作区" />
      </Flex>
    );
  }

  return (
    <Flex data-vehicle-valuation-workspace="true" gap={16} vertical>
      {error ? <Alert message="估值与折旧数据加载失败" description={error} showIcon type="error" /> : null}
      <Alert
        message="销售价写入边界"
        description="预测或采纳值不会直接改写当前销售价；只有审批通过的估值复核才会写入销售价历史。"
        showIcon
        type="info"
      />
      <Tabs
        activeKey={activeSection}
        items={VEHICLE_VALUATION_SECTIONS.map((section) => ({
          children: renderSection(section.key),
          key: section.key,
          label: section.label
        }))}
        onChange={(key) => setActiveSection(key as VehicleValuationSectionKey)}
      />

      <GenerateForecastModal
        form={generateForm}
        generating={generating}
        onCancel={() => setGenerateOpen(false)}
        onGenerate={() => void runForecastGeneration(false)}
        onPreview={() => void runForecastGeneration(true)}
        open={generateOpen}
        preview={generatePreview}
      />
      <ForecastDetailDrawer
        actions={actions}
        forecast={forecastDetail}
        onAdopt={openAdopt}
        onClose={() => setForecastDetail(null)}
        onCreateReview={openCreateReview}
        onVoid={setVoidTarget}
      />
      <SimpleFormModal
        form={adoptForm}
        onCancel={() => setAdoptTarget(null)}
        onFinish={adoptPoint}
        open={Boolean(adoptTarget)}
        title="采用预测点"
      >
        <Form.Item label="采用残值（元）" name="adoptedResidualAmountYuan" rules={[{ required: true }]}>
          <InputNumber min={0.01} precision={2} style={{ width: "100%" }} />
        </Form.Item>
        <Form.Item label="采用备注" name="adoptRemark">
          <Input.TextArea rows={3} />
        </Form.Item>
      </SimpleFormModal>
      <SimpleTextModal
        label="作废备注"
        onCancel={() => setVoidTarget(null)}
        onConfirm={(remark) => void voidForecast(remark)}
        open={Boolean(voidTarget)}
        title="作废残值预测"
      />
      <SimpleFormModal
        form={createReviewForm}
        onCancel={() => setCreateReviewTarget(null)}
        onFinish={createValuationReview}
        open={Boolean(createReviewTarget)}
        title="发起估值复核"
      >
        <Form.Item label="请求销售价（元）" name="requestedSalePriceAmountYuan" rules={[{ required: true }]}>
          <InputNumber min={0.01} precision={2} style={{ width: "100%" }} />
        </Form.Item>
        <Form.Item label="原因" name="reason">
          <Input.TextArea rows={2} />
        </Form.Item>
        <Form.Item label="复核备注" name="reviewRemark">
          <Input.TextArea rows={2} />
        </Form.Item>
      </SimpleFormModal>
      <ReviewDetailDrawer
        canCancel={actions.canCancelValuationReview}
        onCancel={setCancelReviewTarget}
        onClose={() => setReviewDetail(null)}
        review={reviewDetail}
      />
      <SimpleFormModal
        form={cancelReviewForm}
        onCancel={() => setCancelReviewTarget(null)}
        onFinish={cancelReview}
        open={Boolean(cancelReviewTarget)}
        title="取消估值复核"
      >
        <Form.Item label="取消原因" name="cancelReason" rules={[{ required: true }]}>
          <Input.TextArea rows={3} />
        </Form.Item>
      </SimpleFormModal>
      <PriceInitializeModal
        form={initializePriceForm}
        onCancel={() => setInitializePriceOpen(false)}
        onFinish={initializePrice}
        open={initializePriceOpen}
      />
      <PriceReviewModal
        form={reviewPriceForm}
        onCancel={() => setReviewPriceOpen(false)}
        onFinish={reviewPrice}
        open={reviewPriceOpen}
      />
    </Flex>
  );

  function renderSection(section: VehicleValuationSectionKey) {
    if (section === "overview") {
      return (
        <ValuationOverview
          currentBookValue={currentBookValue}
          latestForecast={latestForecast}
          trend={trend}
          trendPoint={trendPoint}
          vehicle={vehicle}
        />
      );
    }
    if (section === "residual") {
      return (
        <ResidualForecastSection
          actions={actions}
          forecasts={forecasts}
          latest={latestForecast}
          onGenerate={openGenerate}
          onOpenDetail={(forecast) => void openForecastDetail(forecast)}
          onVoid={setVoidTarget}
        />
      );
    }
    if (section === "reviews") {
      return (
        <ValuationReviewsSection
          actions={actions}
          onCancel={setCancelReviewTarget}
          onOpen={(review) => void openReviewDetail(review)}
          reviews={reviews}
        />
      );
    }
    if (section === "sale-price-history") {
      return (
        <SalePriceHistorySection
          actions={actions}
          history={salePriceHistory}
          onInitialize={openInitializePrice}
          onReview={openPriceReview}
          salePriceStatus={vehicle.salePriceStatus}
        />
      );
    }
    return (
      <DepreciationSection
        canManage={canManageVehicle}
        canViewDepreciation={canViewDepreciation}
        costPreview={costPreview}
        costProfile={costProfile}
        form={costProfileForm}
        onSave={saveCostProfile}
        saving={savingCostProfile}
        summary={depreciationSummary}
        vehicleId={vehicleId}
      />
    );
  }
}

function ValuationOverview({
  currentBookValue,
  latestForecast,
  trend,
  trendPoint,
  vehicle
}: Readonly<{
  currentBookValue: number | null;
  latestForecast: VehicleResidualForecast | null;
  trend: ReturnType<typeof getForecastTrend>;
  trendPoint: VehicleResidualForecastPoint | null;
  vehicle: VehicleWorkspaceTabProps["vehicle"];
}>) {
  return (
    <Flex gap={16} vertical>
      <Row gutter={[16, 16]}>
        <ValueCard label="当前销售价" value={formatYuan(vehicle.currentSalePriceAmount)} />
        <ValueCard label="下次复核" value={formatDate(vehicle.nextSalePriceReviewAt)} />
        <ValueCard label="当前账面价值" value={formatYuan(currentBookValue)} />
        <ValueCard label="最新预测" value={latestForecast?.forecastNo ?? "暂无"} />
      </Row>
      <Card title="预测趋势对比">
        {trend && trendPoint ? (
          <Descriptions
            column={{ lg: 4, sm: 2, xs: 1 }}
            items={[
              { children: `${trendPoint.horizonMonth} 个月`, label: "预测周期" },
              {
                children: formatYuan(
                  trendPoint.adoptedResidualAmount ?? trendPoint.predictedResidualAmount
                ),
                label: "预测/采用残值"
              },
              { children: signedYuan(trend.deltaAmount), label: "相对当前销售价" },
              { children: signedPercent(trend.deltaRate), label: "变动比例" }
            ]}
          />
        ) : (
          <Empty description="暂无可比较的预测点" image={Empty.PRESENTED_IMAGE_SIMPLE} />
        )}
      </Card>
    </Flex>
  );
}

function ValueCard({ label, value }: Readonly<{ label: string; value: string }>) {
  return (
    <Col lg={6} sm={12} xs={24}>
      <Card size="small">
        <Typography.Text type="secondary">{label}</Typography.Text>
        <Typography.Title level={5}>{value}</Typography.Title>
      </Card>
    </Col>
  );
}

function ResidualForecastSection({
  actions,
  forecasts,
  latest,
  onGenerate,
  onOpenDetail,
  onVoid
}: Readonly<{
  actions: ReturnType<typeof getValuationActions>;
  forecasts: VehicleResidualForecast[];
  latest: VehicleResidualForecast | null;
  onGenerate: () => void;
  onOpenDetail: (forecast: VehicleResidualForecast) => void;
  onVoid: (forecast: VehicleResidualForecast) => void;
}>) {
  if (!actions.canViewForecast) {
    return <Empty description="无残值预测查看权限" image={Empty.PRESENTED_IMAGE_SIMPLE} />;
  }
  return (
    <Flex gap={16} vertical>
      <Flex justify="flex-end">
        {actions.canGenerateForecast ? (
          <Button icon={<PlusOutlined />} onClick={onGenerate} type="primary">
            生成残值预测
          </Button>
        ) : null}
      </Flex>
      {latest ? (
        <Card title="最新预测">
          <Descriptions
            column={{ lg: 4, sm: 2, xs: 1 }}
            items={[
              { children: latest.forecastNo ?? "-", label: "预测编号" },
              { children: statusTag(presentResidualForecastStatus(latest.forecastStatus)), label: "状态" },
              {
                children: labelOf(VEHICLE_RESIDUAL_FORECAST_METHOD_LABELS, latest.forecastMethod),
                label: "方法"
              },
              { children: formatDate(latest.asOfDate), label: "基准日" }
            ]}
          />
          <ForecastPointTable actions={actions} points={latest.points ?? []} />
        </Card>
      ) : null}
      <Card title="预测历史">
        <Table
          columns={forecastColumns(actions, onOpenDetail, onVoid)}
          dataSource={forecasts}
          pagination={forecasts.length > 10 ? { pageSize: 10 } : false}
          rowKey={(row) => row.id ?? row.forecastNo ?? row.asOfDate}
          scroll={{ x: 900 }}
          size="small"
        />
      </Card>
    </Flex>
  );
}

function ForecastPointTable({
  actions,
  onAdopt,
  onCreateReview,
  points
}: Readonly<{
  actions: ReturnType<typeof getValuationActions>;
  onAdopt?: (point: VehicleResidualForecastPoint) => void;
  onCreateReview?: (point: VehicleResidualForecastPoint) => void;
  points: VehicleResidualForecastPoint[];
}>) {
  return (
    <Table
      columns={forecastPointColumns(actions, onAdopt, onCreateReview)}
      dataSource={points}
      pagination={false}
      rowKey={(point) => point.id ?? `${point.horizonMonth}-${point.targetDate}`}
      scroll={{ x: 1100 }}
      size="small"
    />
  );
}

function ValuationReviewsSection({
  actions,
  onCancel,
  onOpen,
  reviews
}: Readonly<{
  actions: ReturnType<typeof getValuationActions>;
  onCancel: (review: VehicleValuationReview) => void;
  onOpen: (review: VehicleValuationReview) => void;
  reviews: VehicleValuationReview[];
}>) {
  if (!actions.canViewValuationReviews) {
    return <Empty description="无估值复核查看权限" image={Empty.PRESENTED_IMAGE_SIMPLE} />;
  }
  return (
    <Flex gap={12} vertical>
      <Alert
        message="只有审批通过的估值复核才会写入销售价历史"
        description="发起和取消复核都不会直接改变当前销售价。"
        showIcon
        type="info"
      />
      <Table
        columns={reviewColumns(permissionsForActions(actions), onOpen, onCancel)}
        dataSource={reviews}
        pagination={reviews.length > 10 ? { pageSize: 10 } : false}
        rowKey="id"
        scroll={{ x: 1300 }}
        size="small"
      />
    </Flex>
  );
}

function SalePriceHistorySection({
  actions,
  history,
  onInitialize,
  onReview,
  salePriceStatus
}: Readonly<{
  actions: ReturnType<typeof getValuationActions>;
  history: SalePriceHistory[];
  onInitialize: () => void;
  onReview: () => void;
  salePriceStatus: string;
}>) {
  if (!actions.canViewSalePriceHistory) {
    return <Empty description="无销售价历史查看权限" image={Empty.PRESENTED_IMAGE_SIMPLE} />;
  }
  return (
    <Card
      extra={
        <Space>
          {actions.canInitializeSalePrice && salePriceStatus === "PENDING_INITIALIZE" ? (
            <Button onClick={onInitialize} type="primary">初始化销售价</Button>
          ) : null}
          {actions.canReviewSalePrice && salePriceStatus !== "PENDING_INITIALIZE" ? (
            <Button onClick={onReview}>季度销售价复核</Button>
          ) : null}
        </Space>
      }
      title="本车辆销售价历史"
    >
      <Table
        columns={salePriceHistoryColumns}
        dataSource={history}
        pagination={false}
        rowKey="id"
        scroll={{ x: 1000 }}
        size="small"
      />
    </Card>
  );
}

function DepreciationSection({
  canManage,
  canViewDepreciation,
  costPreview,
  costProfile,
  form,
  onSave,
  saving,
  summary,
  vehicleId
}: Readonly<{
  canManage: boolean;
  canViewDepreciation: boolean;
  costPreview: VehicleAssetCostPreview | null;
  costProfile: VehicleAssetCostProfile | null;
  form: FormInstance<AssetCostProfileFormValues>;
  onSave: (values: AssetCostProfileFormValues) => Promise<void>;
  saving: boolean;
  summary: VehicleDepreciationSummary | null;
  vehicleId: string;
}>) {
  const active = summary?.activePolicy ?? null;
  return (
    <Flex gap={16} vertical>
      {canViewDepreciation ? (
        <Card
          extra={
            <Button href={`/vehicle-depreciation-policies?vehicleId=${encodeURIComponent(vehicleId)}`}>
              折旧策略与明细管理
            </Button>
          }
          title="当前折旧策略"
        >
          <Descriptions
            column={{ lg: 4, sm: 2, xs: 1 }}
            items={[
              { children: active?.policyNo ?? "-", label: "策略编号" },
              {
                children: labelOf(VEHICLE_DEPRECIATION_POLICY_STATUS_LABELS, active?.policyStatus),
                label: "策略状态"
              },
              {
                children: labelOf(VEHICLE_DEPRECIATION_METHOD_LABELS, active?.depreciationMethod),
                label: "方法"
              },
              { children: formatYuan(active?.depreciationBasisAmount), label: "折旧基数" },
              { children: formatYuan(active?.residualValueAmount), label: "残值" },
              { children: formatDate(active?.depreciationStartDate), label: "起算日" },
              { children: `${summary?.scheduleCount ?? 0} 条`, label: "计划" },
              { children: `${summary?.confirmedRecordCount ?? 0} 条`, label: "已确认记录" },
              { children: `${summary?.lockedRecordCount ?? 0} 条`, label: "已锁定记录" }
            ]}
          />
        </Card>
      ) : (
        <Alert message="无车辆折旧查看权限" showIcon type="warning" />
      )}

      <Row gutter={[16, 16]}>
        <Col lg={14} xs={24}>
          <Card title="资产成本 / 折旧参数">
            <Form form={form} layout="vertical" onFinish={(values) => void onSave(values)}>
              <Row gutter={16}>
                <Col sm={12} xs={24}>
                  <Form.Item label="折旧方法" name="depreciationMethod" rules={[{ required: true }]}>
                    <Select disabled={!canManage} options={optionsFromLabels(VEHICLE_DEPRECIATION_METHOD_LABELS)} />
                  </Form.Item>
                </Col>
                <Col sm={12} xs={24}>
                  <Form.Item label="折旧起算日" name="depreciationStartDate">
                    <DatePicker disabled={!canManage} style={{ width: "100%" }} />
                  </Form.Item>
                </Col>
              </Row>
              <Row gutter={16}>
                <Col sm={8} xs={24}>
                  <Form.Item label="预计使用月数" name="usefulLifeMonths" rules={[{ required: true }]}>
                    <InputNumber disabled={!canManage} min={1} style={{ width: "100%" }} />
                  </Form.Item>
                </Col>
                <Col sm={8} xs={24}>
                  <Form.Item label="预计残值（元）" name="residualValueAmountYuan" rules={[{ required: true }]}>
                    <InputNumber disabled={!canManage} min={0} precision={2} style={{ width: "100%" }} />
                  </Form.Item>
                </Col>
                <Col sm={8} xs={24}>
                  <Form.Item label="资金成本率（%）" name="capitalCostRatePercent">
                    <InputNumber disabled={!canManage} min={0} precision={2} style={{ width: "100%" }} />
                  </Form.Item>
                </Col>
              </Row>
              <Row gutter={16}>
                <Col sm={8} xs={24}>
                  <Form.Item label="年度保险成本（元）" name="annualInsuranceCostAmountYuan">
                    <InputNumber disabled={!canManage} min={0} precision={2} style={{ width: "100%" }} />
                  </Form.Item>
                </Col>
                <Col sm={8} xs={24}>
                  <Form.Item label="年度维修准备（元）" name="annualMaintenanceReserveAmountYuan">
                    <InputNumber disabled={!canManage} min={0} precision={2} style={{ width: "100%" }} />
                  </Form.Item>
                </Col>
                <Col sm={8} xs={24}>
                  <Form.Item label="其他月度成本（元）" name="otherMonthlyCostAmountYuan">
                    <InputNumber disabled={!canManage} min={0} precision={2} style={{ width: "100%" }} />
                  </Form.Item>
                </Col>
              </Row>
              <Form.Item label="备注" name="remark">
                <Input.TextArea disabled={!canManage} rows={2} />
              </Form.Item>
              {canManage ? (
                <Button htmlType="submit" loading={saving} type="primary">保存并试算</Button>
              ) : null}
            </Form>
          </Card>
        </Col>
        <Col lg={10} xs={24}>
          <Card title="成本试算预览">
            {costPreview ? (
              <Descriptions
                column={1}
                items={[
                  {
                    children: labelOf(VEHICLE_ASSET_COST_PROFILE_STATUS_LABELS, costProfile?.profileStatus),
                    label: "参数状态"
                  },
                  { children: formatYuan(costPreview.purchasePriceAmount), label: "采购成本" },
                  { children: formatYuan(costPreview.depreciableAmount), label: "可折旧金额" },
                  { children: formatYuan(costPreview.monthlyDepreciationAmount), label: "月折旧" },
                  { children: formatYuan(costPreview.monthlyCapitalCostAmount), label: "月资金成本" },
                  { children: formatYuan(costPreview.monthlyInsuranceCostAmount), label: "月保险成本" },
                  {
                    children: formatYuan(costPreview.monthlyMaintenanceReserveAmount),
                    label: "月维修准备"
                  },
                  { children: formatYuan(costPreview.estimatedMonthlyCostAmount), label: "预计月成本" }
                ]}
              />
            ) : (
              <Empty description="请先配置资产成本参数" image={Empty.PRESENTED_IMAGE_SIMPLE} />
            )}
          </Card>
        </Col>
      </Row>
    </Flex>
  );
}

function GenerateForecastModal({
  form,
  generating,
  onCancel,
  onGenerate,
  onPreview,
  open,
  preview
}: Readonly<{
  form: FormInstance<GenerateForecastFormValues>;
  generating: boolean;
  onCancel: () => void;
  onGenerate: () => void;
  onPreview: () => void;
  open: boolean;
  preview: VehicleResidualForecastGenerationResult | null;
}>) {
  return (
    <Modal
      footer={[
        <Button key="cancel" onClick={onCancel}>取消</Button>,
        <Button key="preview" loading={generating} onClick={onPreview}>试算</Button>,
        <Button key="generate" loading={generating} onClick={onGenerate} type="primary">正式生成</Button>
      ]}
      onCancel={onCancel}
      open={open}
      title="生成残值预测"
      width={900}
    >
      <Form form={form} layout="vertical">
        <Form.Item label="预测基准日" name="asOfDate" rules={[{ required: true }]}>
          <DatePicker style={{ width: "100%" }} />
        </Form.Item>
        <Form.Item label="预测周期（月）" name="horizonMonthsText" rules={[{ required: true }]}>
          <Input placeholder={DEFAULT_HORIZONS} />
        </Form.Item>
        <Form.Item label="备注" name="remark">
          <Input.TextArea rows={2} />
        </Form.Item>
      </Form>
      {preview ? (
        <Card title="未保存试算结果">
          <ForecastPointTable
            actions={getValuationActions({ latestForecast: preview.forecast, permissions: new Set(), vehicleStatus: "AVAILABLE" })}
            points={preview.points ?? preview.forecast.points ?? []}
          />
        </Card>
      ) : null}
    </Modal>
  );
}

function ForecastDetailDrawer({
  actions,
  forecast,
  onAdopt,
  onClose,
  onCreateReview,
  onVoid
}: Readonly<{
  actions: ReturnType<typeof getValuationActions>;
  forecast: VehicleResidualForecast | null;
  onAdopt: (point: VehicleResidualForecastPoint) => void;
  onClose: () => void;
  onCreateReview: (point: VehicleResidualForecastPoint) => void;
  onVoid: (forecast: VehicleResidualForecast) => void;
}>) {
  return (
    <Drawer
      extra={
        forecast && actions.canAdoptForecastPoint && forecast.forecastStatus !== "VOIDED" ? (
          <Button danger onClick={() => onVoid(forecast)}>作废预测</Button>
        ) : null
      }
      onClose={onClose}
      open={Boolean(forecast)}
      title={forecast?.forecastNo ?? "残值预测详情"}
      width={1050}
    >
      {forecast ? (
        <Flex gap={16} vertical>
          <Descriptions
            column={3}
            items={[
              { children: statusTag(presentResidualForecastStatus(forecast.forecastStatus)), label: "状态" },
              { children: formatDate(forecast.asOfDate), label: "基准日" },
              {
                children: labelOf(VEHICLE_RESIDUAL_FORECAST_METHOD_LABELS, forecast.forecastMethod),
                label: "预测方法"
              },
              { children: forecast.curve?.curveNo ?? "自动匹配", label: "残值曲线" },
              { children: formatYuan(forecast.currentSalePriceAmount), label: "生成时销售价" },
              { children: forecast.remark ?? "-", label: "备注" }
            ]}
          />
          <ForecastPointTable
            actions={actions}
            onAdopt={onAdopt}
            onCreateReview={onCreateReview}
            points={forecast.points ?? []}
          />
        </Flex>
      ) : null}
    </Drawer>
  );
}

function ReviewDetailDrawer({
  canCancel,
  onCancel,
  onClose,
  review
}: Readonly<{
  canCancel: boolean;
  onCancel: (review: VehicleValuationReview) => void;
  onClose: () => void;
  review: VehicleValuationReview | null;
}>) {
  return (
    <Drawer
      extra={canCancel && review?.reviewStatus === "PENDING" ? <Button danger onClick={() => onCancel(review)}>取消复核</Button> : null}
      onClose={onClose}
      open={Boolean(review)}
      title={review?.reviewNo ?? "估值复核详情"}
      width={800}
    >
      {review ? (
        <Descriptions
          bordered
          column={2}
          items={[
            { children: statusTag(presentValuationReviewStatus(review.reviewStatus)), label: "状态" },
            { children: labelOf(VEHICLE_VALUATION_REVIEW_SOURCE_LABELS, review.reviewSource), label: "来源" },
            { children: formatYuan(review.originalSalePriceAmount), label: "原销售价" },
            { children: formatYuan(review.forecastResidualAmount), label: "预测残值" },
            { children: formatYuan(review.adoptedResidualAmount), label: "采用残值" },
            { children: formatYuan(review.requestedSalePriceAmount), label: "请求销售价" },
            { children: formatYuan(review.approvedSalePriceAmount), label: "审批销售价" },
            { children: formatDate(review.forecastTargetDate), label: "预测目标日" },
            { children: review.reason ?? "-", label: "原因" },
            { children: review.reviewRemark ?? "-", label: "备注" },
            { children: review.rejectReason ?? "-", label: "拒绝原因" },
            { children: review.cancelReason ?? "-", label: "取消原因" }
          ]}
        />
      ) : null}
    </Drawer>
  );
}

function SimpleFormModal<T extends object>({
  children,
  form,
  onCancel,
  onFinish,
  open,
  title
}: Readonly<{
  children: React.ReactNode;
  form: FormInstance<T>;
  onCancel: () => void;
  onFinish: (values: T) => Promise<void>;
  open: boolean;
  title: string;
}>) {
  return (
    <Modal
      okText="确认"
      onCancel={onCancel}
      onOk={() => form.submit()}
      open={open}
      title={title}
    >
      <Form form={form} layout="vertical" onFinish={(values) => void onFinish(values)}>
        {children}
      </Form>
    </Modal>
  );
}

function SimpleTextModal({
  label,
  onCancel,
  onConfirm,
  open,
  title
}: Readonly<{
  label: string;
  onCancel: () => void;
  onConfirm: (value: string) => void;
  open: boolean;
  title: string;
}>) {
  const [value, setValue] = useState("");
  useEffect(() => {
    if (!open) {
      setValue("");
    }
  }, [open]);
  return (
    <Modal onCancel={onCancel} onOk={() => onConfirm(value)} open={open} title={title}>
      <Typography.Text>{label}</Typography.Text>
      <Input.TextArea onChange={(event) => setValue(event.target.value)} rows={3} value={value} />
    </Modal>
  );
}

function PriceInitializeModal({
  form,
  onCancel,
  onFinish,
  open
}: Readonly<{
  form: FormInstance<InitializePriceFormValues>;
  onCancel: () => void;
  onFinish: (values: InitializePriceFormValues) => Promise<void>;
  open: boolean;
}>) {
  return (
    <Modal onCancel={onCancel} onOk={() => form.submit()} open={open} title="初始化销售价">
      <Form form={form} layout="vertical" onFinish={(values) => void onFinish(values)}>
        <Form.Item label="销售价（元）" name="currentSalePriceAmountYuan" rules={[{ required: true }]}>
          <InputNumber min={0.01} precision={2} style={{ width: "100%" }} />
        </Form.Item>
        <Form.Item label="生效日期" name="effectiveFrom" rules={[{ required: true }]}>
          <DatePicker style={{ width: "100%" }} />
        </Form.Item>
        <Form.Item label="类型" name="reviewType" rules={[{ required: true }]}>
          <Select options={[
            { label: "新入池初始化", value: "INITIAL_POOL" },
            { label: "退车再入池", value: "RETURN_REINIT" }
          ]} />
        </Form.Item>
        <Form.Item label="原因" name="reason" rules={[{ required: true }]}>
          <Input />
        </Form.Item>
        <Form.Item label="备注" name="remark"><Input.TextArea rows={2} /></Form.Item>
      </Form>
    </Modal>
  );
}

function PriceReviewModal({
  form,
  onCancel,
  onFinish,
  open
}: Readonly<{
  form: FormInstance<ReviewPriceFormValues>;
  onCancel: () => void;
  onFinish: (values: ReviewPriceFormValues) => Promise<void>;
  open: boolean;
}>) {
  return (
    <Modal onCancel={onCancel} onOk={() => form.submit()} open={open} title="季度销售价复核">
      <Form form={form} layout="vertical" onFinish={(values) => void onFinish(values)}>
        <Form.Item label="新销售价（元）" name="newSalePriceAmountYuan" rules={[{ required: true }]}>
          <InputNumber min={0.01} precision={2} style={{ width: "100%" }} />
        </Form.Item>
        <Form.Item label="生效日期" name="effectiveFrom" rules={[{ required: true }]}>
          <DatePicker style={{ width: "100%" }} />
        </Form.Item>
        <Form.Item label="复核季度" name="reviewQuarter" rules={[{ required: true }]}><Input /></Form.Item>
        <Form.Item label="原因" name="reason" rules={[{ required: true }]}><Input /></Form.Item>
        <Form.Item label="备注" name="remark"><Input.TextArea rows={2} /></Form.Item>
      </Form>
    </Modal>
  );
}

function forecastColumns(
  actions: ReturnType<typeof getValuationActions>,
  onOpen: (forecast: VehicleResidualForecast) => void,
  onVoid: (forecast: VehicleResidualForecast) => void
): ColumnsType<VehicleResidualForecast> {
  return [
    { dataIndex: "forecastNo", title: "预测编号" },
    {
      dataIndex: "forecastStatus",
      render: (value: string) => statusTag(presentResidualForecastStatus(value)),
      title: "状态"
    },
    {
      dataIndex: "forecastMethod",
      render: (value: string) => labelOf(VEHICLE_RESIDUAL_FORECAST_METHOD_LABELS, value),
      title: "方法"
    },
    { dataIndex: "asOfDate", render: formatDate, title: "基准日" },
    { render: (_: unknown, row) => row.points?.length ?? 0, title: "预测点" },
    { dataIndex: "createdAt", render: formatDateTime, title: "创建时间" },
    {
      render: (_: unknown, row) => (
        <Space>
          <Button icon={<EyeOutlined />} onClick={() => onOpen(row)} size="small">详情</Button>
          {actions.canAdoptForecastPoint && !["VOIDED", "ARCHIVED"].includes(row.forecastStatus) ? (
            <Button danger onClick={() => onVoid(row)} size="small">作废</Button>
          ) : null}
        </Space>
      ),
      title: "操作"
    }
  ];
}

function forecastPointColumns(
  actions: ReturnType<typeof getValuationActions>,
  onAdopt?: (point: VehicleResidualForecastPoint) => void,
  onCreateReview?: (point: VehicleResidualForecastPoint) => void
): ColumnsType<VehicleResidualForecastPoint> {
  return [
    { dataIndex: "horizonMonth", render: (value: number) => `${value} 个月`, title: "周期" },
    { dataIndex: "targetDate", render: formatDate, title: "目标日" },
    {
      dataIndex: "pointStatus",
      render: (value: string) => labelOf(VEHICLE_RESIDUAL_FORECAST_POINT_STATUS_LABELS, value),
      title: "状态"
    },
    { dataIndex: "predictedResidualAmount", render: formatYuan, title: "预测残值" },
    { dataIndex: "adoptedResidualAmount", render: formatYuan, title: "采用残值" },
    {
      dataIndex: "interpolationMethod",
      render: (value?: string | null) => labelOf(RESIDUAL_FORECAST_INTERPOLATION_METHOD_LABELS, value),
      title: "插值方式"
    },
    {
      render: (_: unknown, point) => (
        <Space>
          {onAdopt && actions.canAdoptForecastPoint && point.id && point.pointStatus !== "UNSUPPORTED" ? (
            <Button onClick={() => onAdopt(point)} size="small">采用值</Button>
          ) : null}
          {onCreateReview && actions.canCreateValuationReview && point.id && point.pointStatus !== "UNSUPPORTED" ? (
            <Button onClick={() => onCreateReview(point)} size="small" type="primary">发起复核</Button>
          ) : null}
        </Space>
      ),
      title: "操作"
    }
  ];
}

function reviewColumns(
  actionPermissions: { canCancel: boolean },
  onOpen: (review: VehicleValuationReview) => void,
  onCancel: (review: VehicleValuationReview) => void
): ColumnsType<VehicleValuationReview> {
  return [
    { dataIndex: "reviewNo", title: "复核编号" },
    {
      dataIndex: "reviewSource",
      render: (value: string) => labelOf(VEHICLE_VALUATION_REVIEW_SOURCE_LABELS, value),
      title: "来源"
    },
    {
      dataIndex: "reviewStatus",
      render: (value: string) => statusTag(presentValuationReviewStatus(value)),
      title: "状态"
    },
    { dataIndex: "originalSalePriceAmount", render: formatYuan, title: "原销售价" },
    { dataIndex: "forecastResidualAmount", render: formatYuan, title: "预测残值" },
    { dataIndex: "requestedSalePriceAmount", render: formatYuan, title: "请求销售价" },
    { dataIndex: "approvedSalePriceAmount", render: formatYuan, title: "审批销售价" },
    { dataIndex: "requestedAt", render: formatDateTime, title: "发起时间" },
    {
      render: (_: unknown, row) => (
        <Space>
          <Button onClick={() => onOpen(row)} size="small">详情</Button>
          {actionPermissions.canCancel && row.reviewStatus === "PENDING" ? (
            <Button danger onClick={() => onCancel(row)} size="small">取消</Button>
          ) : null}
        </Space>
      ),
      title: "操作"
    }
  ];
}

const salePriceHistoryColumns: ColumnsType<SalePriceHistory> = [
  {
    dataIndex: "reviewType",
    render: (value: string) => labelOf(SALE_PRICE_REVIEW_TYPE_LABELS, value),
    title: "类型"
  },
  { dataIndex: "beforeSalePriceAmount", render: formatYuan, title: "调整前" },
  { dataIndex: "afterSalePriceAmount", render: formatYuan, title: "调整后" },
  { dataIndex: "effectiveFrom", render: formatDate, title: "生效日" },
  { dataIndex: "effectiveTo", render: formatDate, title: "失效日" },
  { dataIndex: "reviewQuarter", render: (value?: string | null) => value ?? "-", title: "季度" },
  { dataIndex: "reason", title: "原因" },
  { dataIndex: "createdAt", render: formatDateTime, title: "记录时间" }
];

function costProfileToFormValues(profile: VehicleAssetCostProfile | null): AssetCostProfileFormValues {
  return {
    annualInsuranceCostAmountYuan: yuanFromCents(profile?.annualInsuranceCostAmount),
    annualMaintenanceReserveAmountYuan: yuanFromCents(profile?.annualMaintenanceReserveAmount),
    capitalCostRatePercent:
      typeof profile?.capitalCostRateBps === "number" ? profile.capitalCostRateBps / 100 : undefined,
    depreciationMethod: profile?.depreciationMethod ?? "STRAIGHT_LINE",
    depreciationStartDate: profile?.depreciationStartDate ? dayjs(profile.depreciationStartDate) : null,
    otherMonthlyCostAmountYuan: yuanFromCents(profile?.otherMonthlyCostAmount),
    remark: profile?.remark,
    residualValueAmountYuan: yuanFromCents(profile?.residualValueAmount),
    usefulLifeMonths: profile?.usefulLifeMonths ?? 60
  };
}

function buildForecastPayload(values: GenerateForecastFormValues, dryRun: boolean) {
  const horizonMonths = Array.from(
    new Set(
      values.horizonMonthsText
        .split(/[\s,，]+/)
        .filter(Boolean)
        .map(Number)
    )
  );
  if (
    horizonMonths.length === 0 ||
    horizonMonths.length > 10 ||
    horizonMonths.some((value) => !Number.isSafeInteger(value) || value < 0)
  ) {
    throw new Error("预测周期必须为 1-10 个非负整数");
  }
  return {
    asOfDate: values.asOfDate.format("YYYY-MM-DD"),
    dryRun,
    horizonMonths,
    remark: values.remark
  };
}

function getComparableForecastPoint(forecast: VehicleResidualForecast | null) {
  return (
    forecast?.points
      ?.filter(
        (point) =>
          point.pointStatus !== "UNSUPPORTED" &&
          Boolean(point.adoptedResidualAmount ?? point.predictedResidualAmount)
      )
      .sort((left, right) => left.horizonMonth - right.horizonMonth)[0] ?? null
  );
}

function getCurrentBookValue(policy: VehicleDepreciationPolicySummary | null) {
  if (!policy) {
    return null;
  }
  const accumulated = policy.records
    .filter((record) => ["CONFIRMED", "LOCKED"].includes(record.recordStatus))
    .reduce((sum, record) => sum + record.depreciationAmount, 0);
  return Math.max(policy.depreciationBasisAmount - accumulated, policy.residualValueAmount);
}

function statusTag(presentation: { color: string; label: string }) {
  return <Tag color={presentation.color}>{presentation.label}</Tag>;
}

function signedYuan(value: number) {
  return `${value > 0 ? "+" : ""}${formatYuan(value)}`;
}

function signedPercent(value: number) {
  return `${value > 0 ? "+" : ""}${(value * 100).toLocaleString("zh-CN", {
    maximumFractionDigits: 2
  })}%`;
}

function permissionsForActions(actions: ReturnType<typeof getValuationActions>) {
  return { canCancel: actions.canCancelValuationReview };
}

function toReviewQuarter(value: Dayjs) {
  return `${value.year()}Q${Math.floor(value.month() / 3) + 1}`;
}

function errorText(error: unknown) {
  return error instanceof Error ? error.message : getErrorMessage(error);
}
