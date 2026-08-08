"use client";

import {
  DeleteOutlined,
  EyeOutlined,
  PlusOutlined,
  UploadOutlined
} from "@ant-design/icons";
import {
  Alert,
  App,
  Button,
  Card,
  Checkbox,
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
  Switch,
  Table,
  Tabs,
  Tag,
  Typography,
  Upload
} from "antd";
import type { FormInstance } from "antd";
import type { ColumnsType } from "antd/es/table";
import type { UploadFile } from "antd/es/upload/interface";
import dayjs, { type Dayjs } from "dayjs";
import { useCallback, useEffect, useMemo, useState } from "react";

import {
  VEHICLE_CONDITION_ITEM_AREA_LABELS,
  VEHICLE_CONDITION_ITEM_RESULT_LABELS,
  VEHICLE_CONDITION_ITEM_SEVERITY_LABELS,
  VEHICLE_CONDITION_ITEM_TYPE_LABELS,
  VEHICLE_CONDITION_REPORT_STATUS_LABELS,
  VEHICLE_LISTING_CONDITION_GRADE_LABELS,
  VEHICLE_LISTING_MEDIA_CATEGORY_LABELS,
  VEHICLE_LISTING_STATUS_LABELS,
  labelOf
} from "../../constants/labels";
import { API_BASE_URL, apiFetch } from "../../lib/api";
import {
  formatDateTime,
  getErrorMessage,
  optionsFromLabels,
  toCentAmount,
  yuanFromCents
} from "../../lib/capital-format";
import type { VehicleDocumentBatchView } from "../../lib/vehicle-document-workspace";
import {
  VEHICLE_LISTING_SECTIONS,
  VEHICLE_LISTING_SOURCE_SECTION_LABELS,
  getEligibleSourceDocuments,
  getPortalConditionPresentation,
  getSourceBindingPresentation,
  getVehicleListingReadiness,
  type PortalConditionPresentation,
  type VehicleListingSectionKey,
  type VehicleListingSourceBindingView,
  type VehicleListingSourceDocumentView,
  type VehicleListingSourceSection
} from "../../lib/vehicle-listing-workspace";
import type { VehicleWorkspaceTabProps } from "./vehicle-workspace-types";

interface VehicleListingProfile {
  applicationNotice?: string | null;
  customerTags?: unknown;
  displayName?: string | null;
  faqSnapshot?: unknown;
  feeDescription?: string | null;
  highlightSummary?: string | null;
  listingStatus?: string | null;
  portalVisible?: boolean;
  sellingPoints?: unknown;
  serviceHighlights?: unknown;
  shortTitle?: string | null;
  sortOrder?: number;
  subtitle?: string | null;
}

interface VehicleListingMedia {
  caption?: string | null;
  createdAt: string;
  customerVisible: boolean;
  fileName: string;
  id: string;
  isCover: boolean;
  mediaCategory: string;
  mimeType?: string | null;
  previewUrl: string;
  sortOrder: number;
}

interface VehicleListingAvailablePlan {
  packageSummary: string[];
  planId: string;
  planName: string;
  planNo: string;
  subscriptionPeriodRange: {
    max: number;
    min: number;
  };
}

interface VehicleListingPlanConfig {
  displayMonthlyFeeAmount?: number | null;
  displayRemark?: string | null;
  recommended: boolean;
  sortOrder: number;
  subscriptionPlanId: string;
  visible: boolean;
}

interface VehicleListingPlansResponse {
  availablePlans: VehicleListingAvailablePlan[];
  plans: VehicleListingPlanConfig[];
}

interface VehicleListingPlanDraft extends VehicleListingAvailablePlan {
  displayMonthlyFeeAmountYuan?: number | null;
  displayRemark?: string | null;
  enabled: boolean;
  recommended: boolean;
  sortOrder: number;
  visible: boolean;
}

interface VehicleListingProfileFormValues {
  applicationNotice?: string | null;
  customerTagsText?: string;
  displayName?: string | null;
  faqJson?: string;
  feeDescription?: string | null;
  highlightSummary?: string | null;
  portalVisible?: boolean;
  sellingPointsText?: string;
  serviceHighlightsText?: string;
  shortTitle?: string | null;
  sortOrder?: number;
  subtitle?: string | null;
}

interface VehicleListingMediaFormValues {
  caption?: string | null;
  customerVisible?: boolean;
  isCover?: boolean;
  mediaCategory?: string;
  sortOrder?: number;
}

interface VehicleConditionReport {
  archivedAt?: string | null;
  batteryCheckedAt?: string | null;
  batteryCycleCount?: number | null;
  batteryEstimatedRangeKm?: number | null;
  batteryHealthPercent?: number | null;
  batteryRemark?: string | null;
  batteryWarrantyUntil?: string | null;
  brakeSummary?: string | null;
  chassisSummary?: string | null;
  customerSummary?: string | null;
  exteriorSummary?: string | null;
  glassLightSummary?: string | null;
  hasFireDamage?: boolean | null;
  hasFloodDamage?: boolean | null;
  hasMajorAccident?: boolean | null;
  hasStructuralDamage?: boolean | null;
  id: string;
  inspectionDate?: string | null;
  inspectorName?: string | null;
  inspectorOrg?: string | null;
  interiorSummary?: string | null;
  items: VehicleConditionReportItem[];
  odometerKm?: number | null;
  overallGrade?: string | null;
  publishedAt?: string | null;
  repairSuggestion?: string | null;
  reportNo: string;
  reportStatus: string;
  safetyConclusion?: string | null;
  summary?: string | null;
  tireSummary?: string | null;
  updatedAt: string;
}

interface VehicleConditionReportItem {
  affectsSafety: boolean;
  area: string;
  customerVisible: boolean;
  description?: string | null;
  id: string;
  itemType: string;
  mediaIds: string[];
  partName?: string | null;
  repairRequired: boolean;
  result: string;
  severity: string;
  sortOrder: number;
  title?: string | null;
}

interface VehicleConditionReportFormValues {
  batteryCheckedAt?: Dayjs | null;
  batteryCycleCount?: number | null;
  batteryEstimatedRangeKm?: number | null;
  batteryHealthPercent?: number | null;
  batteryRemark?: string | null;
  batteryWarrantyUntil?: Dayjs | null;
  brakeSummary?: string | null;
  chassisSummary?: string | null;
  customerSummary?: string | null;
  exteriorSummary?: string | null;
  glassLightSummary?: string | null;
  hasFireDamage?: boolean | null;
  hasFloodDamage?: boolean | null;
  hasMajorAccident?: boolean | null;
  hasStructuralDamage?: boolean | null;
  inspectionDate?: Dayjs | null;
  inspectorName?: string | null;
  inspectorOrg?: string | null;
  interiorSummary?: string | null;
  odometerKm?: number | null;
  overallGrade?: string | null;
  repairSuggestion?: string | null;
  safetyConclusion?: string | null;
  summary?: string | null;
  tireSummary?: string | null;
}

interface VehicleConditionReportItemFormValues {
  affectsSafety?: boolean;
  area?: string;
  customerVisible?: boolean;
  description?: string | null;
  itemType?: string;
  mediaIds?: string[];
  partName?: string | null;
  repairRequired?: boolean;
  result?: string;
  severity?: string;
  sortOrder?: number;
  title?: string | null;
}

interface VehicleListingTabProps extends VehicleWorkspaceTabProps {
  activeSection?: VehicleListingSectionKey;
  onSectionChange?: (section: VehicleListingSectionKey) => void;
}

export function VehicleListingTab({
  activeSection: controlledSection,
  onSectionChange,
  permissions,
  vehicle
}: Readonly<VehicleListingTabProps>) {
  const { message } = App.useApp();
  const [profileForm] = Form.useForm<VehicleListingProfileFormValues>();
  const [mediaForm] = Form.useForm<VehicleListingMediaFormValues>();
  const [reportForm] = Form.useForm<VehicleConditionReportFormValues>();
  const [itemForm] = Form.useForm<VehicleConditionReportItemFormValues>();
  const [localSection, setLocalSection] = useState<VehicleListingSectionKey>("overview");
  const activeSection = controlledSection ?? localSection;
  const [profile, setProfile] = useState<VehicleListingProfile | null>(null);
  const [mediaRows, setMediaRows] = useState<VehicleListingMedia[]>([]);
  const [planDrafts, setPlanDrafts] = useState<VehicleListingPlanDraft[]>([]);
  const [bindings, setBindings] = useState<VehicleListingSourceBindingView[]>([]);
  const [sourceDocuments, setSourceDocuments] = useState<VehicleListingSourceDocumentView[]>([]);
  const [reports, setReports] = useState<VehicleConditionReport[]>([]);
  const [selectedReportId, setSelectedReportId] = useState<string>();
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [savingProfile, setSavingProfile] = useState(false);
  const [savingPlans, setSavingPlans] = useState(false);
  const [savingReport, setSavingReport] = useState(false);
  const [uploadingMedia, setUploadingMedia] = useState(false);
  const [mediaFileList, setMediaFileList] = useState<UploadFile[]>([]);
  const [itemDrawerOpen, setItemDrawerOpen] = useState(false);
  const [editingItem, setEditingItem] = useState<VehicleConditionReportItem | null>(null);
  const canManage = permissions.has("vehicle:manage");
  const canViewDocuments = permissions.has("vehicle_document:view");
  const vehicleId = vehicle.id;

  const loadListingDomain = useCallback(
    async (signal?: AbortSignal) => {
      setLoading(true);
      setError(null);
      try {
        const [nextProfile, nextMedia, nextPlans, nextBindings, nextBatches, nextReports] =
          await Promise.all([
            apiFetch<VehicleListingProfile | null>(
              `/vehicles/${encodeURIComponent(vehicleId)}/listing-profile`,
              { signal }
            ),
            apiFetch<VehicleListingMedia[]>(
              `/vehicles/${encodeURIComponent(vehicleId)}/listing-media`,
              { signal }
            ),
            apiFetch<VehicleListingPlansResponse>(
              `/vehicles/${encodeURIComponent(vehicleId)}/listing-plans`,
              { signal }
            ),
            apiFetch<VehicleListingSourceBindingView[]>(
              `/vehicles/${encodeURIComponent(vehicleId)}/listing-source-bindings`,
              { signal }
            ),
            canViewDocuments
              ? apiFetch<VehicleDocumentBatchView[]>(
                  `/vehicles/${encodeURIComponent(vehicleId)}/document-batches`,
                  { signal }
                )
              : Promise.resolve([]),
            apiFetch<VehicleConditionReport[]>(
              `/vehicles/${encodeURIComponent(vehicleId)}/condition-reports`,
              { signal }
            )
          ]);

        setProfile(nextProfile);
        setMediaRows(nextMedia);
        setPlanDrafts(buildPlanDrafts(nextPlans));
        setBindings(nextBindings);
        setSourceDocuments(flattenSourceDocuments(nextBatches));
        setReports(nextReports);
        setSelectedReportId((current) =>
          current && nextReports.some((report) => report.id === current)
            ? current
            : nextReports[0]?.id
        );
        profileForm.setFieldsValue(profileToFormValues(nextProfile, vehicle));
        mediaForm.setFieldsValue({
          customerVisible: true,
          isCover: false,
          mediaCategory: "EXTERIOR",
          sortOrder: nextMedia.length
        });
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
    [canViewDocuments, mediaForm, profileForm, vehicle, vehicleId]
  );

  useEffect(() => {
    const controller = new AbortController();
    void loadListingDomain(controller.signal);
    return () => controller.abort();
  }, [loadListingDomain]);

  const selectedReport = useMemo(
    () => reports.find((report) => report.id === selectedReportId) ?? reports[0] ?? null,
    [reports, selectedReportId]
  );
  const latestPublishedReport = useMemo(
    () =>
      reports
        .filter((report) => report.reportStatus === "PUBLISHED" && !report.archivedAt)
        .sort((left, right) => reportTime(right) - reportTime(left))[0] ?? null,
    [reports]
  );
  const conditionBinding =
    bindings.find((binding) => binding.section === "CONDITION_REPORT") ?? null;
  const portalConditionPresentation = getPortalConditionPresentation({
    binding: conditionBinding,
    latestPublishedReport
  });
  const readiness = getVehicleListingReadiness({
    bindings,
    media: mediaRows,
    plans: planDrafts.filter((plan) => plan.enabled),
    profile
  });

  useEffect(() => {
    reportForm.resetFields();
    reportForm.setFieldsValue(reportToFormValues(selectedReport));
  }, [reportForm, selectedReport]);

  async function refreshProfile() {
    const nextProfile = await apiFetch<VehicleListingProfile | null>(
      `/vehicles/${encodeURIComponent(vehicleId)}/listing-profile`
    );
    setProfile(nextProfile);
    profileForm.setFieldsValue(profileToFormValues(nextProfile, vehicle));
  }

  async function refreshMedia() {
    const nextMedia = await apiFetch<VehicleListingMedia[]>(
      `/vehicles/${encodeURIComponent(vehicleId)}/listing-media`
    );
    setMediaRows(nextMedia);
  }

  async function refreshPlans() {
    const nextPlans = await apiFetch<VehicleListingPlansResponse>(
      `/vehicles/${encodeURIComponent(vehicleId)}/listing-plans`
    );
    setPlanDrafts(buildPlanDrafts(nextPlans));
  }

  async function refreshReports(preferredReportId?: string) {
    const nextReports = await apiFetch<VehicleConditionReport[]>(
      `/vehicles/${encodeURIComponent(vehicleId)}/condition-reports`
    );
    setReports(nextReports);
    setSelectedReportId((current) => {
      const preferred = preferredReportId ?? current;
      return preferred && nextReports.some((report) => report.id === preferred)
        ? preferred
        : nextReports[0]?.id;
    });
  }

  async function saveProfile(values: VehicleListingProfileFormValues) {
    setSavingProfile(true);
    try {
      await apiFetch(`/vehicles/${encodeURIComponent(vehicleId)}/listing-profile`, {
        body: JSON.stringify(toProfilePayload(values)),
        method: "PUT"
      });
      await refreshProfile();
      void message.success("商品展示内容已保存");
    } catch (saveError) {
      void message.error(errorText(saveError));
    } finally {
      setSavingProfile(false);
    }
  }

  async function updatePublishStatus(action: "publish" | "unpublish") {
    try {
      await apiFetch(
        `/vehicles/${encodeURIComponent(vehicleId)}/listing-profile/${action}`,
        { method: "POST" }
      );
      await refreshProfile();
      void message.success(action === "publish" ? "商品已发布" : "商品已下架");
    } catch (statusError) {
      void message.error(errorText(statusError));
    }
  }

  async function uploadMedia(values: VehicleListingMediaFormValues) {
    const file = mediaFileList.find((item) => item.originFileObj);
    if (!file?.originFileObj) {
      void message.warning("请选择展示图片");
      return;
    }
    const body = new FormData();
    body.append("file", file.originFileObj, file.name);
    body.append("mediaCategory", values.mediaCategory ?? "EXTERIOR");
    body.append("sortOrder", String(values.sortOrder ?? 0));
    body.append("isCover", String(Boolean(values.isCover)));
    body.append("customerVisible", String(values.customerVisible ?? true));
    appendIfPresent(body, "caption", values.caption);

    setUploadingMedia(true);
    try {
      await apiFetch(`/vehicles/${encodeURIComponent(vehicleId)}/listing-media`, {
        body,
        method: "POST"
      });
      setMediaFileList([]);
      mediaForm.resetFields();
      mediaForm.setFieldsValue({
        customerVisible: true,
        isCover: false,
        mediaCategory: "EXTERIOR",
        sortOrder: mediaRows.length + 1
      });
      await refreshMedia();
      void message.success("展示图片已上传");
    } catch (uploadError) {
      void message.error(errorText(uploadError));
    } finally {
      setUploadingMedia(false);
    }
  }

  async function patchMedia(media: VehicleListingMedia, patch: Partial<VehicleListingMediaFormValues>) {
    try {
      await apiFetch(`/vehicles/${encodeURIComponent(vehicleId)}/listing-media/${media.id}`, {
        body: JSON.stringify(patch),
        method: "PATCH"
      });
      await refreshMedia();
    } catch (patchError) {
      void message.error(errorText(patchError));
    }
  }

  function deleteMedia(media: VehicleListingMedia) {
    Modal.confirm({
      content: `删除后 Portal 不再展示 ${media.fileName}。`,
      okButtonProps: { danger: true },
      okText: "删除",
      onOk: async () => {
        try {
          await apiFetch(
            `/vehicles/${encodeURIComponent(vehicleId)}/listing-media/${media.id}`,
            { method: "DELETE" }
          );
          await refreshMedia();
          void message.success("展示图片已删除");
        } catch (deleteError) {
          void message.error(errorText(deleteError));
        }
      },
      title: "确认删除展示图片？"
    });
  }

  async function savePlans() {
    setSavingPlans(true);
    try {
      await apiFetch(`/vehicles/${encodeURIComponent(vehicleId)}/listing-plans`, {
        body: JSON.stringify({
          plans: planDrafts
            .filter((plan) => plan.enabled)
            .map((plan) => ({
              displayMonthlyFeeAmount: toCentAmount(plan.displayMonthlyFeeAmountYuan) ?? null,
              displayRemark: plan.displayRemark ?? null,
              recommended: plan.recommended,
              sortOrder: plan.sortOrder,
              subscriptionPlanId: plan.planId,
              visible: plan.visible
            }))
        }),
        method: "PUT"
      });
      await refreshPlans();
      void message.success("订阅方案展示配置已保存");
    } catch (saveError) {
      void message.error(errorText(saveError));
    } finally {
      setSavingPlans(false);
    }
  }

  function updatePlanDraft(planId: string, patch: Partial<VehicleListingPlanDraft>) {
    setPlanDrafts((current) =>
      current.map((plan) => (plan.planId === planId ? { ...plan, ...patch } : plan))
    );
  }

  function confirmSourceBinding(
    section: VehicleListingSourceSection,
    candidate: VehicleListingSourceDocumentView
  ) {
    const current = bindings.find((binding) => binding.section === section) ?? null;
    const currentLabel = current ? getSourceBindingPresentation(current).versionLabel : "未引用";
    const targetLabel =
      typeof candidate.versionNo === "number" ? `V${candidate.versionNo}` : "历史资料";

    window.open(buildAdminAssetUrl(candidate.previewUrl), "_blank", "noopener,noreferrer");
    Modal.confirm({
      content: (
        <Flex gap={8} vertical>
          <Typography.Text>
            当前引用：{currentLabel} · {current?.document.fileName ?? "无"}
          </Typography.Text>
          <Typography.Text strong>
            目标引用：{targetLabel} · {candidate.fileName}
          </Typography.Text>
          <Typography.Text type="secondary">
            已在新窗口打开受控预览，请核对原件后确认。
          </Typography.Text>
        </Flex>
      ),
      okText: "确认引用目标版本",
      onOk: async () => {
        try {
          const nextBinding = await apiFetch<VehicleListingSourceBindingView>(
            `/vehicles/${encodeURIComponent(vehicleId)}/listing-source-bindings/${section}`,
            {
              body: JSON.stringify({ documentId: candidate.id }),
              method: "PUT"
            }
          );
          setBindings((currentBindings) => [
            ...currentBindings.filter((binding) => binding.section !== section),
            nextBinding
          ]);
          void message.success("商品原件引用已更新");
        } catch (bindError) {
          // Keep the previous binding in state when the request fails.
          void message.error(errorText(bindError));
        }
      },
      title: `确认切换${VEHICLE_LISTING_SOURCE_SECTION_LABELS[section]}？`
    });
  }

  function confirmSourceUnbind(section: VehicleListingSourceSection) {
    const current = bindings.find((binding) => binding.section === section);
    if (!current) {
      return;
    }
    Modal.confirm({
      content: `解除 ${getSourceBindingPresentation(current).versionLabel} · ${current.document.fileName} 后，Portal 将按回退规则展示。`,
      okButtonProps: { danger: true },
      okText: "解除引用",
      onOk: async () => {
        try {
          await apiFetch(
            `/vehicles/${encodeURIComponent(vehicleId)}/listing-source-bindings/${section}`,
            { method: "DELETE" }
          );
          setBindings((currentBindings) =>
            currentBindings.filter((binding) => binding.section !== section)
          );
          void message.success("商品原件引用已解除");
        } catch (unbindError) {
          void message.error(errorText(unbindError));
        }
      },
      title: `解除${VEHICLE_LISTING_SOURCE_SECTION_LABELS[section]}引用？`
    });
  }

  async function createConditionReport() {
    try {
      const report = await apiFetch<VehicleConditionReport>(
        `/vehicles/${encodeURIComponent(vehicleId)}/condition-reports`,
        {
          body: JSON.stringify({
            inspectionDate: dayjs().format("YYYY-MM-DD"),
            odometerKm: vehicle.currentMileageKm,
            overallGrade: "UNKNOWN"
          }),
          method: "POST"
        }
      );
      await refreshReports(report.id);
      void message.success("车况报告草稿已创建");
    } catch (createError) {
      void message.error(errorText(createError));
    }
  }

  async function saveConditionReport(values: VehicleConditionReportFormValues) {
    if (!selectedReport) {
      return;
    }
    setSavingReport(true);
    try {
      await apiFetch(`/vehicle-condition-reports/${selectedReport.id}`, {
        body: JSON.stringify(reportFormToPayload(values)),
        method: "PATCH"
      });
      await refreshReports(selectedReport.id);
      void message.success("结构化车况报告已保存");
    } catch (saveError) {
      void message.error(errorText(saveError));
    } finally {
      setSavingReport(false);
    }
  }

  async function updateConditionReportStatus(action: "archive" | "publish") {
    if (!selectedReport) {
      return;
    }
    try {
      const next = await apiFetch<VehicleConditionReport>(
        `/vehicle-condition-reports/${selectedReport.id}/${action}`,
        { method: "POST" }
      );
      await refreshReports(next.id);
      void message.success(action === "publish" ? "车况报告已发布" : "车况报告已归档");
    } catch (statusError) {
      void message.error(errorText(statusError));
    }
  }

  function openItemDrawer(item?: VehicleConditionReportItem) {
    setEditingItem(item ?? null);
    itemForm.setFieldsValue(itemToFormValues(item));
    setItemDrawerOpen(true);
  }

  async function saveConditionItem(values: VehicleConditionReportItemFormValues) {
    if (!selectedReport) {
      return;
    }
    try {
      const endpoint = editingItem
        ? `/vehicle-condition-report-items/${editingItem.id}`
        : `/vehicle-condition-reports/${selectedReport.id}/items`;
      await apiFetch(endpoint, {
        body: JSON.stringify(itemFormToPayload(values)),
        method: editingItem ? "PATCH" : "POST"
      });
      setItemDrawerOpen(false);
      setEditingItem(null);
      await refreshReports(selectedReport.id);
      void message.success("检测项已保存");
    } catch (saveError) {
      void message.error(errorText(saveError));
    }
  }

  function deleteConditionItem(item: VehicleConditionReportItem) {
    if (!selectedReport) {
      return;
    }
    Modal.confirm({
      content: `将删除检测项“${item.title || item.partName || item.id}”。`,
      okButtonProps: { danger: true },
      okText: "删除",
      onOk: async () => {
        try {
          await apiFetch(`/vehicle-condition-report-items/${item.id}`, { method: "DELETE" });
          await refreshReports(selectedReport.id);
          void message.success("检测项已删除");
        } catch (deleteError) {
          void message.error(errorText(deleteError));
        }
      },
      title: "确认删除检测项？"
    });
  }

  if (loading) {
    return (
      <Flex align="center" justify="center" style={{ minHeight: 320 }}>
        <Spin tip="正在加载商品展示工作区" />
      </Flex>
    );
  }

  return (
    <Flex data-vehicle-listing-workspace="true" gap={16} vertical>
      {error ? <Alert message="商品展示信息加载失败" description={error} showIcon type="error" /> : null}
      <Tabs
        activeKey={activeSection}
        items={VEHICLE_LISTING_SECTIONS.map((section) => ({
          children: renderSection(section.key),
          key: section.key,
          label: section.label
        }))}
        onChange={(key) => {
          const section = key as VehicleListingSectionKey;
          setLocalSection(section);
          onSectionChange?.(section);
        }}
        tabPosition="top"
      />

      <Drawer
        destroyOnClose
        onClose={() => setItemDrawerOpen(false)}
        open={itemDrawerOpen}
        title={editingItem ? "编辑检测项" : "新增检测项"}
        width={640}
      >
        <ConditionItemForm
          form={itemForm}
          mediaRows={mediaRows}
          onFinish={saveConditionItem}
        />
      </Drawer>
    </Flex>
  );

  function renderSection(section: VehicleListingSectionKey) {
    if (section === "overview") {
      return (
        <ListingOverview
          canManage={canManage}
          onPublish={() => void updatePublishStatus("publish")}
          onUnpublish={() => void updatePublishStatus("unpublish")}
          portalConditionPresentation={portalConditionPresentation}
          profile={profile}
          readiness={readiness}
          vehicleId={vehicleId}
        />
      );
    }
    if (section === "copy") {
      return (
        <ListingCopyAndMedia
          canManage={canManage}
          fileList={mediaFileList}
          mediaForm={mediaForm}
          mediaRows={mediaRows}
          onDeleteMedia={deleteMedia}
          onFileListChange={setMediaFileList}
          onPatchMedia={patchMedia}
          onSaveProfile={saveProfile}
          onUploadMedia={uploadMedia}
          profileForm={profileForm}
          savingProfile={savingProfile}
          uploadingMedia={uploadingMedia}
        />
      );
    }
    if (section === "source-media") {
      return (
        <SourceMediaSection
          bindings={bindings}
          canManage={canManage}
          canViewDocuments={canViewDocuments}
          documents={sourceDocuments}
          onBind={confirmSourceBinding}
          onUnbind={confirmSourceUnbind}
        />
      );
    }
    if (section === "plans") {
      return (
        <ListingPlansSection
          canManage={canManage}
          drafts={planDrafts}
          onChange={updatePlanDraft}
          onSave={() => void savePlans()}
          saving={savingPlans}
        />
      );
    }
    return (
      <ConditionReportSection
        canManage={canManage}
        onArchive={() => void updateConditionReportStatus("archive")}
        onCreate={() => void createConditionReport()}
        onDeleteItem={deleteConditionItem}
        onEditItem={openItemDrawer}
        onNewItem={() => openItemDrawer()}
        onPublish={() => void updateConditionReportStatus("publish")}
        onSave={saveConditionReport}
        onSelectReport={setSelectedReportId}
        portalPresentation={portalConditionPresentation}
        report={selectedReport}
        reportForm={reportForm}
        reports={reports}
        saving={savingReport}
      />
    );
  }
}

function ListingOverview({
  canManage,
  onPublish,
  onUnpublish,
  portalConditionPresentation,
  profile,
  readiness,
  vehicleId
}: Readonly<{
  canManage: boolean;
  onPublish: () => void;
  onUnpublish: () => void;
  portalConditionPresentation: PortalConditionPresentation;
  profile: VehicleListingProfile | null;
  readiness: ReturnType<typeof getVehicleListingReadiness>;
  vehicleId: string;
}>) {
  const published = profile?.listingStatus === "PUBLISHED" && profile.portalVisible;
  return (
    <Flex gap={16} vertical>
      <Row gutter={[16, 16]}>
        <Col lg={8} xs={24}>
          <Card title="发布状态">
            <Tag color={published ? "green" : "default"}>
              {labelOf(VEHICLE_LISTING_STATUS_LABELS, profile?.listingStatus)}
            </Tag>
          </Card>
        </Col>
        <Col lg={8} xs={24}>
          <Card title="发布就绪度">
            <Tag color={readiness.listingComplete ? "green" : "red"}>
              {readiness.listingComplete ? "已满足发布条件" : "尚未满足发布条件"}
            </Tag>
          </Card>
        </Col>
        <Col lg={8} xs={24}>
          <Card title="Portal 车况展示">
            <Tag color={portalConditionPresentation === "NONE" ? "default" : "blue"}>
              {portalConditionLabel(portalConditionPresentation)}
            </Tag>
          </Card>
        </Col>
      </Row>

      {readiness.missingRequirements.length > 0 ? (
        <Alert
          description={readiness.missingRequirements.join("；")}
          message="发布前仍需补齐"
          showIcon
          type="error"
        />
      ) : null}
      {readiness.warnings.length > 0 ? (
        <Alert
          description={`${readiness.warnings.join("；")}。这些提醒不阻塞发布。`}
          message="建议补充商品原件引用"
          showIcon
          type="warning"
        />
      ) : null}

      <Card title="发布操作">
        <Space wrap>
          {canManage && !published ? (
            <Button disabled={!readiness.listingComplete} onClick={onPublish} type="primary">
              发布到 Portal
            </Button>
          ) : null}
          {canManage && published ? (
            <Button danger onClick={onUnpublish}>
              下架商品
            </Button>
          ) : null}
          <Button href={`/portal/catalog/${encodeURIComponent(vehicleId)}`} target="_blank">
            Portal 预览
          </Button>
        </Space>
      </Card>
    </Flex>
  );
}

function ListingCopyAndMedia({
  canManage,
  fileList,
  mediaForm,
  mediaRows,
  onDeleteMedia,
  onFileListChange,
  onPatchMedia,
  onSaveProfile,
  onUploadMedia,
  profileForm,
  savingProfile,
  uploadingMedia
}: Readonly<{
  canManage: boolean;
  fileList: UploadFile[];
  mediaForm: FormInstance<VehicleListingMediaFormValues>;
  mediaRows: VehicleListingMedia[];
  onDeleteMedia: (media: VehicleListingMedia) => void;
  onFileListChange: (files: UploadFile[]) => void;
  onPatchMedia: (media: VehicleListingMedia, patch: Partial<VehicleListingMediaFormValues>) => Promise<void>;
  onSaveProfile: (values: VehicleListingProfileFormValues) => Promise<void>;
  onUploadMedia: (values: VehicleListingMediaFormValues) => Promise<void>;
  profileForm: FormInstance<VehicleListingProfileFormValues>;
  savingProfile: boolean;
  uploadingMedia: boolean;
}>) {
  return (
    <Flex gap={16} vertical>
      <Card title="客户侧文案与服务说明">
        <Form form={profileForm} layout="vertical" onFinish={(values) => void onSaveProfile(values)}>
          <Row gutter={16}>
            <Col lg={12} xs={24}>
              <Form.Item label="展示标题" name="displayName">
                <Input disabled={!canManage} maxLength={128} />
              </Form.Item>
            </Col>
            <Col lg={12} xs={24}>
              <Form.Item label="短标题" name="shortTitle">
                <Input disabled={!canManage} maxLength={128} />
              </Form.Item>
            </Col>
          </Row>
          <Form.Item label="副标题" name="subtitle">
            <Input disabled={!canManage} maxLength={256} />
          </Form.Item>
          <Row gutter={16}>
            <Col lg={12} xs={24}>
              <Form.Item label="卖点（每行一条）" name="sellingPointsText">
                <Input.TextArea disabled={!canManage} rows={4} />
              </Form.Item>
            </Col>
            <Col lg={12} xs={24}>
              <Form.Item label="客户标签（每行一条）" name="customerTagsText">
                <Input.TextArea disabled={!canManage} rows={4} />
              </Form.Item>
            </Col>
          </Row>
          <Form.Item label="一车一况摘要" name="highlightSummary">
            <Input.TextArea disabled={!canManage} rows={2} />
          </Form.Item>
          <Row gutter={16}>
            <Col lg={12} xs={24}>
              <Form.Item label="服务亮点（每行一条）" name="serviceHighlightsText">
                <Input.TextArea disabled={!canManage} rows={3} />
              </Form.Item>
            </Col>
            <Col lg={12} xs={24}>
              <Form.Item label="费用说明" name="feeDescription">
                <Input.TextArea disabled={!canManage} rows={3} />
              </Form.Item>
            </Col>
          </Row>
          <Form.Item label="申请须知" name="applicationNotice">
            <Input.TextArea disabled={!canManage} rows={3} />
          </Form.Item>
          <Form.Item label="FAQ JSON 数组" name="faqJson">
            <Input.TextArea disabled={!canManage} rows={4} />
          </Form.Item>
          <Space wrap>
            <Form.Item label="排序" name="sortOrder">
              <InputNumber disabled={!canManage} />
            </Form.Item>
            <Form.Item label="Portal 可见" name="portalVisible" valuePropName="checked">
              <Switch disabled={!canManage} />
            </Form.Item>
          </Space>
          {canManage ? (
            <Button htmlType="submit" loading={savingProfile} type="primary">
              保存展示内容
            </Button>
          ) : null}
        </Form>
      </Card>

      <Card title="商品图片与媒体字段">
        {canManage ? (
          <Form form={mediaForm} layout="inline" onFinish={(values) => void onUploadMedia(values)}>
            <Form.Item label="分类" name="mediaCategory">
              <Select options={optionsFromLabels(VEHICLE_LISTING_MEDIA_CATEGORY_LABELS)} style={{ width: 150 }} />
            </Form.Item>
            <Form.Item label="说明" name="caption">
              <Input style={{ width: 180 }} />
            </Form.Item>
            <Form.Item label="排序" name="sortOrder">
              <InputNumber style={{ width: 90 }} />
            </Form.Item>
            <Form.Item label="封面" name="isCover" valuePropName="checked">
              <Switch />
            </Form.Item>
            <Form.Item label="客户可见" name="customerVisible" valuePropName="checked">
              <Switch />
            </Form.Item>
            <Form.Item>
              <Upload
                beforeUpload={() => false}
                fileList={fileList}
                maxCount={1}
                onChange={({ fileList: next }) => onFileListChange(next.slice(-1))}
              >
                <Button icon={<UploadOutlined />}>选择图片</Button>
              </Upload>
            </Form.Item>
            <Form.Item>
              <Button htmlType="submit" loading={uploadingMedia} type="primary">
                上传
              </Button>
            </Form.Item>
          </Form>
        ) : null}
        <Table
          columns={mediaColumns(canManage, onPatchMedia, onDeleteMedia)}
          dataSource={mediaRows}
          pagination={false}
          rowKey="id"
          scroll={{ x: 950 }}
          size="small"
          style={{ marginTop: canManage ? 16 : 0 }}
        />
      </Card>
    </Flex>
  );
}

function SourceMediaSection({
  bindings,
  canManage,
  canViewDocuments,
  documents,
  onBind,
  onUnbind
}: Readonly<{
  bindings: VehicleListingSourceBindingView[];
  canManage: boolean;
  canViewDocuments: boolean;
  documents: VehicleListingSourceDocumentView[];
  onBind: (section: VehicleListingSourceSection, document: VehicleListingSourceDocumentView) => void;
  onUnbind: (section: VehicleListingSourceSection) => void;
}>) {
  return (
    <Flex gap={16} vertical>
      <Alert
        message="精确版本引用"
        description="上传新版本不会自动切换当前商品引用。切换前必须预览并明确确认目标版本。"
        showIcon
        type="info"
      />
      {!canViewDocuments ? (
        <Alert
          message="无权查看权证原件候选版本"
          description="当前商品引用仍可查看，但候选文件列表需要车辆权证查看权限。"
          showIcon
          type="warning"
        />
      ) : null}
      {(["CONFIGURATION_SHEET", "CONDITION_REPORT"] as const).map((section) => {
        const binding = bindings.find((row) => row.section === section) ?? null;
        const boundSource = binding ? documents.find((document) => document.id === binding.document.id) : null;
        const presentation = binding
          ? getSourceBindingPresentation({
              ...binding,
              document: {
                ...binding.document,
                createdAt: boundSource?.createdAt ?? binding.document.createdAt
              }
            })
          : null;
        const candidates = getEligibleSourceDocuments(section, documents);

        return (
          <Card
            extra={
              binding && canManage ? (
                <Button danger onClick={() => onUnbind(section)} size="small">
                  解除引用
                </Button>
              ) : null
            }
            key={section}
            title={VEHICLE_LISTING_SOURCE_SECTION_LABELS[section]}
          >
            {presentation ? (
              <Descriptions
                column={{ lg: 4, sm: 2, xs: 1 }}
                items={[
                  { children: presentation.versionLabel, label: "当前版本" },
                  { children: presentation.fileName, label: "文件名" },
                  { children: formatDateTime(presentation.uploadedAt), label: "上传时间" },
                  { children: "固定版本，不自动更新", label: "引用策略" },
                  {
                    children: (
                      <Button href={buildAdminAssetUrl(presentation.previewUrl)} target="_blank" type="link">
                        预览当前原件
                      </Button>
                    ),
                    label: "受控预览"
                  }
                ]}
                size="small"
              />
            ) : (
              <Empty description="尚未引用原件" image={Empty.PRESENTED_IMAGE_SIMPLE} />
            )}
            <Typography.Title level={5}>可引用版本</Typography.Title>
            <Table
              columns={[
                {
                  render: (_: unknown, document: VehicleListingSourceDocumentView) =>
                    typeof document.versionNo === "number" ? `V${document.versionNo}` : "历史资料",
                  title: "版本",
                  width: 90
                },
                { dataIndex: "fileName", title: "文件名" },
                {
                  dataIndex: "createdAt",
                  render: (value?: string | null) => formatDateTime(value),
                  title: "上传时间",
                  width: 170
                },
                {
                  render: (_: unknown, candidate: VehicleListingSourceDocumentView) => (
                    <Space>
                      <Button
                        href={buildAdminAssetUrl(candidate.previewUrl)}
                        icon={<EyeOutlined />}
                        target="_blank"
                        type="link"
                      >
                        预览
                      </Button>
                      <Button
                        disabled={!canManage || binding?.document.id === candidate.id}
                        onClick={() => onBind(section, candidate)}
                        size="small"
                        type="primary"
                      >
                        {binding?.document.id === candidate.id ? "当前引用" : "预览并引用"}
                      </Button>
                    </Space>
                  ),
                  title: "操作",
                  width: 210
                }
              ]}
              dataSource={candidates}
              pagination={false}
              rowKey="id"
              size="small"
            />
          </Card>
        );
      })}
    </Flex>
  );
}

function ListingPlansSection({
  canManage,
  drafts,
  onChange,
  onSave,
  saving
}: Readonly<{
  canManage: boolean;
  drafts: VehicleListingPlanDraft[];
  onChange: (planId: string, patch: Partial<VehicleListingPlanDraft>) => void;
  onSave: () => void;
  saving: boolean;
}>) {
  const columns: ColumnsType<VehicleListingPlanDraft> = [
    {
      render: (_: unknown, plan) => (
        <Switch
          checked={plan.enabled}
          disabled={!canManage}
          onChange={(checked) =>
            onChange(plan.planId, { enabled: checked, visible: checked ? plan.visible : false })
          }
        />
      ),
      title: "配置",
      width: 70
    },
    { dataIndex: "planName", title: "方案", width: 180 },
    { render: (_: unknown, plan) => plan.packageSummary.join(" / ") || "-", title: "套餐包", width: 260 },
    {
      render: (_: unknown, plan) =>
        `${plan.subscriptionPeriodRange.min}-${plan.subscriptionPeriodRange.max} 个月`,
      title: "期限",
      width: 120
    },
    {
      render: (_: unknown, plan) => (
        <Switch
          checked={plan.visible}
          disabled={!canManage || !plan.enabled}
          onChange={(visible) => onChange(plan.planId, { visible })}
        />
      ),
      title: "客户可见",
      width: 90
    },
    {
      render: (_: unknown, plan) => (
        <Switch
          checked={plan.recommended}
          disabled={!canManage || !plan.enabled}
          onChange={(recommended) => onChange(plan.planId, { recommended })}
        />
      ),
      title: "推荐",
      width: 80
    },
    {
      render: (_: unknown, plan) => (
        <InputNumber
          disabled={!canManage || !plan.enabled}
          min={0}
          onChange={(displayMonthlyFeeAmountYuan) => onChange(plan.planId, { displayMonthlyFeeAmountYuan })}
          precision={2}
          value={plan.displayMonthlyFeeAmountYuan}
        />
      ),
      title: "展示月租（元）",
      width: 160
    },
    {
      render: (_: unknown, plan) => (
        <Input
          disabled={!canManage || !plan.enabled}
          onChange={(event) => onChange(plan.planId, { displayRemark: event.target.value })}
          value={plan.displayRemark ?? ""}
        />
      ),
      title: "展示说明",
      width: 220
    }
  ];

  return (
    <Card title="订阅方案配置">
      <Table
        columns={columns}
        dataSource={drafts}
        pagination={false}
        rowKey="planId"
        scroll={{ x: 1180 }}
        size="small"
      />
      {canManage ? (
        <Button loading={saving} onClick={onSave} style={{ marginTop: 16 }} type="primary">
          保存订阅方案配置
        </Button>
      ) : null}
    </Card>
  );
}

function ConditionReportSection({
  canManage,
  onArchive,
  onCreate,
  onDeleteItem,
  onEditItem,
  onNewItem,
  onPublish,
  onSave,
  onSelectReport,
  portalPresentation,
  report,
  reportForm,
  reports,
  saving
}: Readonly<{
  canManage: boolean;
  onArchive: () => void;
  onCreate: () => void;
  onDeleteItem: (item: VehicleConditionReportItem) => void;
  onEditItem: (item: VehicleConditionReportItem) => void;
  onNewItem: () => void;
  onPublish: () => void;
  onSave: (values: VehicleConditionReportFormValues) => Promise<void>;
  onSelectReport: (id: string) => void;
  portalPresentation: PortalConditionPresentation;
  report: VehicleConditionReport | null;
  reportForm: FormInstance<VehicleConditionReportFormValues>;
  reports: VehicleConditionReport[];
  saving: boolean;
}>) {
  return (
    <Flex gap={16} vertical>
      <Alert
        message={`Portal 当前展示：${portalConditionLabel(portalPresentation)}`}
        description={portalConditionDescription(portalPresentation)}
        showIcon
        type={portalPresentation === "NONE" ? "warning" : "info"}
      />
      <Card title="结构化车况报告">
        <Flex align="center" gap={12} justify="space-between" wrap>
          <Select
            onChange={onSelectReport}
            options={reports.map((row) => ({
              label: `${row.reportNo} · ${labelOf(VEHICLE_CONDITION_REPORT_STATUS_LABELS, row.reportStatus)}`,
              value: row.id
            }))}
            placeholder="选择报告"
            style={{ minWidth: 320 }}
            value={report?.id}
          />
          {canManage ? (
            <Space wrap>
              <Button icon={<PlusOutlined />} onClick={onCreate}>
                新建草稿
              </Button>
              <Button disabled={!report || report.reportStatus === "PUBLISHED"} onClick={onPublish} type="primary">
                发布报告
              </Button>
              <Button danger disabled={!report || report.reportStatus === "ARCHIVED"} onClick={onArchive}>
                归档
              </Button>
            </Space>
          ) : null}
        </Flex>

        {report ? (
          <Form form={reportForm} layout="vertical" onFinish={(values) => void onSave(values)} style={{ marginTop: 16 }}>
            <Row gutter={16}>
              <Col lg={6} sm={12} xs={24}>
                <Form.Item label="检测日期" name="inspectionDate">
                  <DatePicker disabled={!canManage} style={{ width: "100%" }} />
                </Form.Item>
              </Col>
              <Col lg={6} sm={12} xs={24}>
                <Form.Item label="检测机构" name="inspectorOrg">
                  <Input disabled={!canManage} />
                </Form.Item>
              </Col>
              <Col lg={6} sm={12} xs={24}>
                <Form.Item label="检测人" name="inspectorName">
                  <Input disabled={!canManage} />
                </Form.Item>
              </Col>
              <Col lg={6} sm={12} xs={24}>
                <Form.Item label="检测里程（公里）" name="odometerKm">
                  <InputNumber disabled={!canManage} min={0} style={{ width: "100%" }} />
                </Form.Item>
              </Col>
            </Row>
            <Form.Item label="整体等级" name="overallGrade">
              <Select
                allowClear
                disabled={!canManage}
                options={optionsFromLabels(VEHICLE_LISTING_CONDITION_GRADE_LABELS)}
                style={{ maxWidth: 260 }}
              />
            </Form.Item>
            <Form.Item label="报告摘要" name="summary">
              <Input.TextArea disabled={!canManage} rows={2} />
            </Form.Item>
            <Row gutter={16}>
              {[
                ["重大事故", "hasMajorAccident"],
                ["水泡", "hasFloodDamage"],
                ["火烧", "hasFireDamage"],
                ["结构性损伤", "hasStructuralDamage"]
              ].map(([label, name]) => (
                <Col key={name} lg={6} sm={12} xs={24}>
                  <Form.Item label={label} name={name} valuePropName="checked">
                    <Checkbox disabled={!canManage}>存在</Checkbox>
                  </Form.Item>
                </Col>
              ))}
            </Row>
            <Row gutter={16}>
              {[
                ["外观", "exteriorSummary"],
                ["内饰", "interiorSummary"],
                ["底盘", "chassisSummary"],
                ["轮胎", "tireSummary"],
                ["制动", "brakeSummary"],
                ["玻璃灯光", "glassLightSummary"]
              ].map(([label, name]) => (
                <Col key={name} lg={8} xs={24}>
                  <Form.Item label={`${label}摘要`} name={name}>
                    <Input.TextArea disabled={!canManage} rows={2} />
                  </Form.Item>
                </Col>
              ))}
            </Row>
            <Typography.Title level={5}>电池检测（Task 8 唯一读取来源）</Typography.Title>
            <Row gutter={16}>
              <Col lg={4} sm={12} xs={24}>
                <Form.Item label="健康度（%）" name="batteryHealthPercent">
                  <InputNumber disabled={!canManage} max={100} min={0} style={{ width: "100%" }} />
                </Form.Item>
              </Col>
              <Col lg={4} sm={12} xs={24}>
                <Form.Item label="循环次数" name="batteryCycleCount">
                  <InputNumber disabled={!canManage} min={0} style={{ width: "100%" }} />
                </Form.Item>
              </Col>
              <Col lg={5} sm={12} xs={24}>
                <Form.Item label="检测日期" name="batteryCheckedAt">
                  <DatePicker disabled={!canManage} style={{ width: "100%" }} />
                </Form.Item>
              </Col>
              <Col lg={5} sm={12} xs={24}>
                <Form.Item label="预估续航（公里）" name="batteryEstimatedRangeKm">
                  <InputNumber disabled={!canManage} min={0} style={{ width: "100%" }} />
                </Form.Item>
              </Col>
              <Col lg={6} sm={12} xs={24}>
                <Form.Item label="质保到期" name="batteryWarrantyUntil">
                  <DatePicker disabled={!canManage} style={{ width: "100%" }} />
                </Form.Item>
              </Col>
            </Row>
            <Form.Item label="电池备注" name="batteryRemark">
              <Input.TextArea disabled={!canManage} rows={2} />
            </Form.Item>
            <Row gutter={16}>
              <Col lg={8} xs={24}>
                <Form.Item label="安全结论" name="safetyConclusion">
                  <Input.TextArea disabled={!canManage} rows={2} />
                </Form.Item>
              </Col>
              <Col lg={8} xs={24}>
                <Form.Item label="维修建议" name="repairSuggestion">
                  <Input.TextArea disabled={!canManage} rows={2} />
                </Form.Item>
              </Col>
              <Col lg={8} xs={24}>
                <Form.Item label="客户摘要" name="customerSummary">
                  <Input.TextArea disabled={!canManage} rows={2} />
                </Form.Item>
              </Col>
            </Row>
            {canManage ? (
              <Button htmlType="submit" loading={saving} type="primary">
                保存结构化报告
              </Button>
            ) : null}
          </Form>
        ) : (
          <Empty description="暂无结构化车况报告" image={Empty.PRESENTED_IMAGE_SIMPLE} />
        )}
      </Card>

      {report ? (
        <Card
          extra={
            canManage ? (
              <Button icon={<PlusOutlined />} onClick={onNewItem} size="small">
                新增检测项
              </Button>
            ) : null
          }
          title="检测项"
        >
          <Table
            columns={conditionItemColumns(canManage, onEditItem, onDeleteItem)}
            dataSource={report.items}
            pagination={false}
            rowKey="id"
            scroll={{ x: 900 }}
            size="small"
          />
        </Card>
      ) : null}
    </Flex>
  );
}

function ConditionItemForm({
  form,
  mediaRows,
  onFinish
}: Readonly<{
  form: FormInstance<VehicleConditionReportItemFormValues>;
  mediaRows: VehicleListingMedia[];
  onFinish: (values: VehicleConditionReportItemFormValues) => Promise<void>;
}>) {
  const mediaOptions = mediaRows
    .filter((media) => media.customerVisible)
    .map((media) => ({ label: media.caption || media.fileName, value: media.id }));
  return (
    <Form form={form} layout="vertical" onFinish={(values) => void onFinish(values)}>
      <Row gutter={16}>
        <Col span={12}>
          <Form.Item label="区域" name="area" rules={[{ required: true, message: "请选择区域" }]}>
            <Select options={optionsFromLabels(VEHICLE_CONDITION_ITEM_AREA_LABELS)} />
          </Form.Item>
        </Col>
        <Col span={12}>
          <Form.Item label="类型" name="itemType" rules={[{ required: true, message: "请选择类型" }]}>
            <Select options={optionsFromLabels(VEHICLE_CONDITION_ITEM_TYPE_LABELS)} />
          </Form.Item>
        </Col>
      </Row>
      <Row gutter={16}>
        <Col span={12}>
          <Form.Item label="严重程度" name="severity">
            <Select options={optionsFromLabels(VEHICLE_CONDITION_ITEM_SEVERITY_LABELS)} />
          </Form.Item>
        </Col>
        <Col span={12}>
          <Form.Item label="结果" name="result">
            <Select options={optionsFromLabels(VEHICLE_CONDITION_ITEM_RESULT_LABELS)} />
          </Form.Item>
        </Col>
      </Row>
      <Form.Item label="部件" name="partName">
        <Input />
      </Form.Item>
      <Form.Item label="标题" name="title">
        <Input />
      </Form.Item>
      <Form.Item label="描述" name="description">
        <Input.TextArea rows={3} />
      </Form.Item>
      <Form.Item label="关联展示图片" name="mediaIds">
        <Select mode="multiple" options={mediaOptions} />
      </Form.Item>
      <Space wrap>
        <Form.Item label="影响安全" name="affectsSafety" valuePropName="checked">
          <Switch />
        </Form.Item>
        <Form.Item label="需要维修" name="repairRequired" valuePropName="checked">
          <Switch />
        </Form.Item>
        <Form.Item label="客户可见" name="customerVisible" valuePropName="checked">
          <Switch />
        </Form.Item>
        <Form.Item label="排序" name="sortOrder">
          <InputNumber />
        </Form.Item>
      </Space>
      <Button htmlType="submit" type="primary">
        保存检测项
      </Button>
    </Form>
  );
}

function mediaColumns(
  canManage: boolean,
  onPatch: (media: VehicleListingMedia, patch: Partial<VehicleListingMediaFormValues>) => Promise<void>,
  onDelete: (media: VehicleListingMedia) => void
): ColumnsType<VehicleListingMedia> {
  return [
    {
      render: (_: unknown, media) => (
        <Button href={buildAdminAssetUrl(media.previewUrl)} target="_blank" type="link">
          预览
        </Button>
      ),
      title: "预览",
      width: 80
    },
    { dataIndex: "fileName", title: "文件名", width: 200 },
    {
      dataIndex: "mediaCategory",
      render: (value: string) => labelOf(VEHICLE_LISTING_MEDIA_CATEGORY_LABELS, value),
      title: "分类",
      width: 130
    },
    { dataIndex: "caption", render: (value?: string | null) => value ?? "-", title: "说明" },
    { dataIndex: "sortOrder", title: "排序", width: 70 },
    {
      render: (_: unknown, media) => (
        <Space>
          {media.isCover ? <Tag color="green">封面</Tag> : null}
          <Tag color={media.customerVisible ? "blue" : "default"}>
            {media.customerVisible ? "客户可见" : "隐藏"}
          </Tag>
        </Space>
      ),
      title: "状态",
      width: 160
    },
    ...(canManage
      ? [
          {
            render: (_: unknown, media: VehicleListingMedia) => (
              <Space>
                <Button disabled={media.isCover} onClick={() => void onPatch(media, { isCover: true })} size="small">
                  设封面
                </Button>
                <Button
                  onClick={() => void onPatch(media, { customerVisible: !media.customerVisible })}
                  size="small"
                >
                  {media.customerVisible ? "隐藏" : "显示"}
                </Button>
                <Button danger icon={<DeleteOutlined />} onClick={() => onDelete(media)} size="small" />
              </Space>
            ),
            title: "操作",
            width: 240
          }
        ]
      : [])
  ];
}

function conditionItemColumns(
  canManage: boolean,
  onEdit: (item: VehicleConditionReportItem) => void,
  onDelete: (item: VehicleConditionReportItem) => void
): ColumnsType<VehicleConditionReportItem> {
  return [
    { dataIndex: "title", render: (value?: string | null) => value ?? "-", title: "标题" },
    { dataIndex: "partName", render: (value?: string | null) => value ?? "-", title: "部件" },
    {
      dataIndex: "area",
      render: (value: string) => labelOf(VEHICLE_CONDITION_ITEM_AREA_LABELS, value),
      title: "区域"
    },
    {
      dataIndex: "result",
      render: (value: string) => labelOf(VEHICLE_CONDITION_ITEM_RESULT_LABELS, value),
      title: "结果"
    },
    {
      dataIndex: "severity",
      render: (value: string) => labelOf(VEHICLE_CONDITION_ITEM_SEVERITY_LABELS, value),
      title: "严重程度"
    },
    {
      dataIndex: "customerVisible",
      render: (value: boolean) => (value ? <Tag color="green">客户可见</Tag> : <Tag>仅后台</Tag>),
      title: "可见性"
    },
    ...(canManage
      ? [
          {
            render: (_: unknown, item: VehicleConditionReportItem) => (
              <Space>
                <Button onClick={() => onEdit(item)} size="small">编辑</Button>
                <Button danger onClick={() => onDelete(item)} size="small">删除</Button>
              </Space>
            ),
            title: "操作",
            width: 130
          }
        ]
      : [])
  ];
}

function buildPlanDrafts(response: VehicleListingPlansResponse): VehicleListingPlanDraft[] {
  const configured = new Map(response.plans.map((plan) => [plan.subscriptionPlanId, plan]));
  return response.availablePlans.map((available, index) => {
    const existing = configured.get(available.planId);
    return {
      ...available,
      displayMonthlyFeeAmountYuan: yuanFromCents(existing?.displayMonthlyFeeAmount),
      displayRemark: existing?.displayRemark ?? null,
      enabled: Boolean(existing),
      recommended: existing?.recommended ?? false,
      sortOrder: existing?.sortOrder ?? index,
      visible: existing?.visible ?? false
    };
  });
}

function flattenSourceDocuments(batches: VehicleDocumentBatchView[]): VehicleListingSourceDocumentView[] {
  return batches.flatMap((batch) =>
    batch.items.map((document) => ({
      createdAt: document.createdAt,
      deletedAt: document.deletedAt,
      documentStatus: document.documentStatus,
      documentType: document.documentType,
      fileName: document.originalName || document.fileName,
      id: document.id,
      mimeType: document.mimeType,
      previewUrl: document.previewUrl,
      versionNo: batch.versionNo
    }))
  );
}

function profileToFormValues(
  profile: VehicleListingProfile | null,
  vehicle: VehicleWorkspaceTabProps["vehicle"]
): VehicleListingProfileFormValues {
  return {
    applicationNotice: profile?.applicationNotice,
    customerTagsText: arrayToLines(profile?.customerTags),
    displayName:
      profile?.displayName ??
      [vehicle.brand, vehicle.series, vehicle.modelDisplayName || vehicle.model].filter(Boolean).join(" "),
    faqJson: jsonArrayText(profile?.faqSnapshot),
    feeDescription: profile?.feeDescription,
    highlightSummary: profile?.highlightSummary,
    portalVisible: profile?.portalVisible ?? false,
    sellingPointsText: arrayToLines(profile?.sellingPoints),
    serviceHighlightsText: arrayToLines(profile?.serviceHighlights),
    shortTitle: profile?.shortTitle,
    sortOrder: profile?.sortOrder ?? 0,
    subtitle: profile?.subtitle
  };
}

function toProfilePayload(values: VehicleListingProfileFormValues) {
  return {
    applicationNotice: values.applicationNotice,
    customerTags: textToLines(values.customerTagsText),
    displayName: values.displayName,
    faqSnapshot: parseJsonArray(values.faqJson),
    feeDescription: values.feeDescription,
    highlightSummary: values.highlightSummary,
    portalVisible: values.portalVisible ?? false,
    sellingPoints: textToLines(values.sellingPointsText),
    serviceHighlights: textToLines(values.serviceHighlightsText),
    shortTitle: values.shortTitle,
    sortOrder: values.sortOrder ?? 0,
    subtitle: values.subtitle
  };
}

function reportToFormValues(report: VehicleConditionReport | null): VehicleConditionReportFormValues {
  if (!report) {
    return {};
  }
  return {
    batteryCheckedAt: dateValue(report.batteryCheckedAt),
    batteryCycleCount: report.batteryCycleCount,
    batteryEstimatedRangeKm: report.batteryEstimatedRangeKm,
    batteryHealthPercent: report.batteryHealthPercent,
    batteryRemark: report.batteryRemark,
    batteryWarrantyUntil: dateValue(report.batteryWarrantyUntil),
    brakeSummary: report.brakeSummary,
    chassisSummary: report.chassisSummary,
    customerSummary: report.customerSummary,
    exteriorSummary: report.exteriorSummary,
    glassLightSummary: report.glassLightSummary,
    hasFireDamage: report.hasFireDamage,
    hasFloodDamage: report.hasFloodDamage,
    hasMajorAccident: report.hasMajorAccident,
    hasStructuralDamage: report.hasStructuralDamage,
    inspectionDate: dateValue(report.inspectionDate),
    inspectorName: report.inspectorName,
    inspectorOrg: report.inspectorOrg,
    interiorSummary: report.interiorSummary,
    odometerKm: report.odometerKm,
    overallGrade: report.overallGrade,
    repairSuggestion: report.repairSuggestion,
    safetyConclusion: report.safetyConclusion,
    summary: report.summary,
    tireSummary: report.tireSummary
  };
}

function reportFormToPayload(values: VehicleConditionReportFormValues) {
  return {
    ...values,
    batteryCheckedAt: values.batteryCheckedAt?.format("YYYY-MM-DD") ?? null,
    batteryWarrantyUntil: values.batteryWarrantyUntil?.format("YYYY-MM-DD") ?? null,
    inspectionDate: values.inspectionDate?.format("YYYY-MM-DD") ?? null
  };
}

function itemToFormValues(item?: VehicleConditionReportItem): VehicleConditionReportItemFormValues {
  return item
    ? {
        affectsSafety: item.affectsSafety,
        area: item.area,
        customerVisible: item.customerVisible,
        description: item.description,
        itemType: item.itemType,
        mediaIds: item.mediaIds,
        partName: item.partName,
        repairRequired: item.repairRequired,
        result: item.result,
        severity: item.severity,
        sortOrder: item.sortOrder,
        title: item.title
      }
    : {
        affectsSafety: false,
        customerVisible: true,
        repairRequired: false,
        result: "UNKNOWN",
        severity: "MINOR",
        sortOrder: 0
      };
}

function itemFormToPayload(values: VehicleConditionReportItemFormValues) {
  return {
    ...values,
    affectsSafety: values.affectsSafety ?? false,
    customerVisible: values.customerVisible ?? true,
    mediaIds: values.mediaIds ?? [],
    repairRequired: values.repairRequired ?? false,
    sortOrder: values.sortOrder ?? 0
  };
}

function portalConditionLabel(value: PortalConditionPresentation) {
  return {
    NONE: "无可展示车况",
    SOURCE_DOCUMENT: "车辆检测报告原件",
    STRUCTURED_REPORT: "结构化车况报告"
  }[value];
}

function portalConditionDescription(value: PortalConditionPresentation) {
  if (value === "SOURCE_DOCUMENT") {
    return "Portal 只展示当前精确绑定的检测报告原件长图，不同时展示结构化报告。";
  }
  if (value === "STRUCTURED_REPORT") {
    return "未绑定检测报告原件，Portal 回退展示最新已发布的结构化车况报告。";
  }
  return "既未绑定检测报告原件，也没有已发布的结构化车况报告。";
}

function buildAdminAssetUrl(previewUrl: string) {
  if (/^https?:\/\//.test(previewUrl)) {
    return previewUrl;
  }
  return `${API_BASE_URL.replace(/\/api$/, "")}${previewUrl}`;
}

function arrayToLines(value: unknown) {
  return Array.isArray(value) ? value.filter((item): item is string => typeof item === "string").join("\n") : "";
}

function textToLines(value?: string) {
  return (value ?? "")
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean);
}

function jsonArrayText(value: unknown) {
  return JSON.stringify(Array.isArray(value) ? value : [], null, 2);
}

function parseJsonArray(value?: string) {
  if (!value?.trim()) {
    return [];
  }
  const parsed: unknown = JSON.parse(value);
  if (!Array.isArray(parsed)) {
    throw new Error("FAQ 必须是 JSON 数组");
  }
  return parsed;
}

function appendIfPresent(formData: FormData, key: string, value?: string | null) {
  if (value) {
    formData.append(key, value);
  }
}

function dateValue(value?: string | null) {
  return value ? dayjs(value) : null;
}

function reportTime(report: VehicleConditionReport) {
  return dayjs(report.inspectionDate ?? report.publishedAt ?? report.updatedAt).valueOf();
}

function errorText(error: unknown) {
  return error instanceof Error && !(error.name === "ApiError") ? error.message : getErrorMessage(error);
}
