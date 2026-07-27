"use client";

import {
  ArrowLeftOutlined,
  CheckCircleOutlined,
  DeleteOutlined,
  DownloadOutlined,
  EyeOutlined,
  ExclamationCircleOutlined,
  PlayCircleOutlined,
  ReloadOutlined,
  SaveOutlined,
  StopOutlined
} from "@ant-design/icons";
import {
  Alert,
  App,
  Button,
  Checkbox,
  Flex,
  Input,
  InputNumber,
  Modal,
  Popconfirm,
  Progress,
  Radio,
  Spin,
  Tag,
  Tooltip,
  Typography
} from "antd";
import { useParams, useRouter } from "next/navigation";
import {
  type CSSProperties,
  type ReactNode,
  useCallback,
  useEffect,
  useRef,
  useState
} from "react";

import { EvidenceUploadControls } from "../../../../../components/field-handover-evidence-upload-controls";
import {
  buildFieldHandoverFileUrl,
  createFieldESignSubmissionController,
  declareFieldHandoverNoVisibleDamage,
  getFieldHandoverActionErrorMessage,
  getFieldHandoverReadiness,
  getFieldHandoverSession,
  getFieldHandoverWorkOrder,
  isFieldHandoverSessionExpired,
  removeFieldHandoverEvidenceFile,
  startFieldHandoverESign,
  startFieldHandoverWorkOrder,
  submitFieldHandoverEvidence,
  updateFieldHandoverFacts,
  uploadAndAttachFieldHandoverEvidenceFile,
  type FieldEvidenceUploadOptions,
  type FieldEvidenceUploadProgress,
  type FieldHandoverEvidenceItem,
  type FieldHandoverWorkOrderDetail
} from "../../../../../lib/field-handover-api";
import {
  detectFieldEvidenceUploadEnvironment,
  type FieldEvidenceUploadEnvironment,
  type FieldEvidenceMediaType,
  formatUploadBytes,
  validateFieldEvidenceFile
} from "../../../../../lib/field-handover-upload";
import {
  abandonFieldEvidenceUploadRecovery,
  canRetryFieldEvidenceUploadBatch,
  canStartFieldEvidenceUploadBatch,
  canSubmitWithFieldEvidenceUploadBatch,
  canMutateFieldEvidenceWithUploadBatch,
  cancelFieldEvidenceUploadRequest,
  getFieldEvidenceUploadReconciliationItemViewId,
  hasFieldEvidenceUploadRecoveries,
  replaceAndStartFieldEvidenceUploadRecovery,
  retryFieldEvidenceUploadBatch,
  retryFieldEvidenceUploadRefresh,
  runFieldEvidenceUploadBatch,
  startFieldEvidenceUploadBatchFromState,
  type FieldEvidenceUploadBatchState,
  type FieldEvidenceUploadInterruptionReason,
  type FieldEvidenceUploadSnapshot
} from "../../../../../lib/field-handover-upload-batch";
import {
  buildFieldEvidenceCaptureView,
  buildFieldHandoverDetailView,
  buildFieldHandoverFactsPayload,
  buildFieldStage2HandoverView,
  getFieldHandoverSubmitBlockers,
  resolveFieldHandoverFactsAfterRefresh,
  validateFieldHandoverFactsInput,
  type FieldHandoverFactsDraft
} from "../../../../../lib/field-handover-view-model";

const SUBMITTED_TEXT = "现场交接资料已提交，等待客户确认";
const RESUBMITTED_PENDING_ADMIN_TEXT = "现场交接资料已重新提交，等待后台送回客户复核";
const LOCKED_TEXT = "当前交接任务已提交或不可继续编辑";
const MAX_DAMAGE_CLOSEUP_FILES = 20;
const UPLOAD_ACTIVE_BLOCKER_TEXT = "资料正在上传，请完成后再提交";
const UPLOAD_SUBMIT_BLOCKER_TEXT = "资料正在上传或等待重试，请完成后再提交";
const INITIAL_UPLOAD_BATCH_STATE: FieldEvidenceUploadBatchState<File> = {
  batch: null,
  fileIndex: 0,
  recoveries: {},
  status: "IDLE"
};

type EvidenceUploadStartMode = "NORMAL" | "RESELECT" | "RETRY";

interface EvidenceUploadState {
  fileCount: number;
  fileIndex: number;
  fileName: string;
  itemId: string;
  loadedBytes: number;
  percent: number;
  phase: "PROCESSING" | "UPLOADING";
  totalBytes: number;
}

export default function FieldHandoverTaskDetailPage() {
  const params = useParams<{ id: string }>();
  const router = useRouter();
  const { message } = App.useApp();
  const isMountedRef = useRef(true);
  const eSignInFlightRef = useRef(false);
  const eSignSubmissionControllerRef = useRef<ReturnType<
    typeof createFieldESignSubmissionController
  > | null>(null);
  const submissionInFlightRef = useRef(false);
  const uploadAbortControllerRef = useRef<AbortController | null>(null);
  const uploadAbortReasonRef = useRef<Exclude<
    FieldEvidenceUploadInterruptionReason,
    "FAILURE"
  > | null>(null);
  const uploadRequestBodyCompleteRef = useRef(false);
  const uploadBatchStateRef = useRef<FieldEvidenceUploadBatchState<File>>(
    INITIAL_UPLOAD_BATCH_STATE
  );
  const [actionLoading, setActionLoading] = useState<string | null>(null);
  const [blockers, setBlockers] = useState<string[]>([]);
  const [detail, setDetail] = useState<FieldHandoverWorkOrderDetail | null>(null);
  const [errorMessage, setErrorMessage] = useState<string | null>(null);
  const [facts, setFacts] = useState<FieldHandoverFactsDraft>({});
  const [eSignAcknowledged, setESignAcknowledged] = useState(false);
  const [eSignDialogOpen, setESignDialogOpen] = useState(false);
  const [hasActiveUploadRequest, setHasActiveUploadRequest] = useState(false);
  const [loading, setLoading] = useState(true);
  const [removingFileId, setRemovingFileId] = useState<string | null>(null);
  const [successMessage, setSuccessMessage] = useState<string | null>(null);
  const [uploadBatchState, setUploadBatchState] = useState<FieldEvidenceUploadBatchState<File>>(
    INITIAL_UPLOAD_BATCH_STATE
  );
  const [uploadState, setUploadState] = useState<EvidenceUploadState | null>(null);
  const [uploadEnvironment, setUploadEnvironment] =
    useState<FieldEvidenceUploadEnvironment>("DESKTOP");

  useEffect(() => {
    const browserNavigator = navigator as Navigator & {
      userAgentData?: { mobile?: boolean };
    };
    const pointerCoarse =
      typeof window.matchMedia === "function" && window.matchMedia("(pointer: coarse)").matches;

    setUploadEnvironment(
      detectFieldEvidenceUploadEnvironment({
        pointerCoarse,
        userAgent: browserNavigator.userAgent,
        userAgentDataMobile: browserNavigator.userAgentData?.mobile,
        viewportWidth: window.innerWidth
      })
    );
  }, []);

  const loadDetail = useCallback(
    async (options: { preserveFacts?: boolean; showLoading?: boolean } = {}) => {
      const showLoading = options.showLoading !== false;
      try {
        if (showLoading) {
          setLoading(true);
        }
        setErrorMessage(null);
        await getFieldHandoverSession();
        const [nextDetail, readiness] = await Promise.all([
          getFieldHandoverWorkOrder(params.id),
          getFieldHandoverReadiness(params.id)
        ]);
        const mergedDetail = {
          ...nextDetail,
          evidenceChecklist: {
            ...(nextDetail.evidenceChecklist ?? {}),
            blockingReasons:
              readiness.blockingReasons ?? nextDetail.evidenceChecklist?.blockingReasons ?? [],
            ready: readiness.ready ?? nextDetail.evidenceChecklist?.ready ?? false
          }
        };
        if (isMountedRef.current) {
          setDetail(mergedDetail);
          setFacts((current) =>
            resolveFieldHandoverFactsAfterRefresh(
              current,
              mergedDetail.fieldFacts,
              options.preserveFacts === true
            )
          );
        }
        return mergedDetail;
      } catch (error) {
        if (isFieldHandoverSessionExpired(error)) {
          router.replace("/field/handover");
          return null;
        }
        if (isMountedRef.current) {
          setErrorMessage("无法访问该交接任务，请确认任务仍分配给当前手机号");
        }
        return null;
      } finally {
        if (showLoading && isMountedRef.current) {
          setLoading(false);
        }
      }
    },
    [params.id, router]
  );

  useEffect(() => {
    void loadDetail();
  }, [loadDetail]);

  useEffect(() => {
    isMountedRef.current = true;
    eSignSubmissionControllerRef.current =
      createFieldESignSubmissionController({
        submit: (input) => startFieldHandoverESign(params.id, input)
      });
    return () => {
      isMountedRef.current = false;
      eSignSubmissionControllerRef.current = null;
      uploadAbortReasonRef.current = "UNMOUNT";
      uploadAbortControllerRef.current?.abort();
    };
  }, [params.id]);

  const detailView = detail ? buildFieldHandoverDetailView(detail) : null;
  const captureView = detail ? buildFieldEvidenceCaptureView(detail) : null;
  const stage2View = detail ? buildFieldStage2HandoverView(detail) : null;
  const reviewContext = detail?.reviewContext;
  const canSubmitUploadBatch = canSubmitWithFieldEvidenceUploadBatch(uploadBatchState);
  const canMutateEvidence = canMutateFieldEvidenceWithUploadBatch(uploadBatchState);
  const hasUploadRecoveries = hasFieldEvidenceUploadRecoveries(uploadBatchState);
  const uploadingItemId =
    uploadBatchState.status === "UPLOADING" ? (uploadBatchState.batch?.itemViewId ?? null) : null;
  const uploadBarrierText =
    uploadBatchState.status === "REFRESHING"
      ? "正在同步最新资料"
      : uploadBatchState.status === "REFRESH_FAILED"
        ? "最新资料同步失败，请重新加载状态"
        : uploadBatchState.status === "UPLOADING"
          ? UPLOAD_ACTIVE_BLOCKER_TEXT
          : hasUploadRecoveries
            ? UPLOAD_SUBMIT_BLOCKER_TEXT
            : UPLOAD_ACTIVE_BLOCKER_TEXT;

  async function startWork() {
    await runAction("start", async () => {
      await startFieldHandoverWorkOrder(params.id);
      void message.success("已开始现场采集");
      await loadDetail();
    });
  }

  function openStage2ESignDialog() {
    if (!stage2View?.canStartESign || eSignInFlightRef.current) {
      return;
    }
    setESignAcknowledged(false);
    setESignDialogOpen(true);
  }

  async function submitStage2ESign() {
    if (
      !stage2View?.canStartESign ||
      !eSignAcknowledged ||
      stage2View.artifactVersion === null ||
      !stage2View.sourcePdfHash ||
      eSignInFlightRef.current
    ) {
      return;
    }

    const request = eSignSubmissionControllerRef.current?.submit({
      acknowledgement: eSignAcknowledged,
      artifactVersion: stage2View.artifactVersion,
      sourcePdfHash: stage2View.sourcePdfHash
    });
    if (!request) {
      return;
    }

    eSignInFlightRef.current = true;
    setActionLoading("esign");
    try {
      await request;
      setESignDialogOpen(false);
      setESignAcknowledged(false);
      setSuccessMessage("电子签任务已发起，等待客户签署");
      void message.success("电子签任务已发起");
      await loadDetail({ showLoading: false });
    } catch (error) {
      handleActionError(error);
    } finally {
      eSignInFlightRef.current = false;
      setActionLoading(null);
    }
  }

  async function saveFacts() {
    const errors = validateFieldHandoverFactsInput(facts);
    if (errors.length) {
      setBlockers(errors);
      return;
    }

    await runAction("save", async () => {
      await updateFieldHandoverFacts(params.id, buildFieldHandoverFactsPayload(facts));
      setBlockers([]);
      void message.success("现场信息已保存");
      await loadDetail();
    });
  }

  async function updateDamageState(value: "DAMAGE" | "NO_DAMAGE") {
    if (value === "NO_DAMAGE") {
      const nextFacts = { ...facts, damageDeclared: false, noVisibleDamageDeclared: true };
      setFacts(nextFacts);
      await runAction("damage", async () => {
        await declareFieldHandoverNoVisibleDamage(params.id, "现场确认");
        setBlockers([]);
        void message.success("无可见损伤声明已保存");
        await loadDetail({ preserveFacts: true });
      });
      return;
    }

    const nextFacts = { ...facts, damageDeclared: true, noVisibleDamageDeclared: false };
    setFacts(nextFacts);
    await runAction("damage", async () => {
      await updateFieldHandoverFacts(params.id, buildFieldHandoverFactsPayload(nextFacts));
      setBlockers([]);
      void message.success("损伤状态已保存，请上传损伤/瑕疵近拍");
      await loadDetail({ preserveFacts: true });
    });
  }

  function applyUploadBatchState(nextState: FieldEvidenceUploadBatchState<File>) {
    uploadBatchStateRef.current = nextState;
    if (isMountedRef.current) {
      setUploadBatchState(nextState);
    }
  }

  async function uploadEvidence(
    itemViewId: string,
    files: File[],
    startMode: EvidenceUploadStartMode = "NORMAL"
  ) {
    if (
      !detail ||
      (startMode !== "RETRY" && files.length === 0) ||
      uploadAbortControllerRef.current
    ) {
      return;
    }
    if (submissionInFlightRef.current) {
      setBlockers(["任务正在提交，暂不能开始上传"]);
      return;
    }
    const item = findEvidenceItem(detail, itemViewId);
    if (!item?.id) {
      setBlockers(["资料项不存在，请刷新后重试"]);
      return;
    }
    const itemId = item.id;
    const currentReplaceEvidenceFileId = item.allowsMultiple
      ? undefined
      : item.files?.[0]?.evidenceFileId || item.files?.[0]?.id || undefined;
    const uploadOperation = currentReplaceEvidenceFileId
      ? ({ replaceEvidenceFileId: currentReplaceEvidenceFileId, type: "REPLACE" } as const)
      : ({ type: "APPEND" } as const);
    const currentBatchState = uploadBatchStateRef.current;
    const nextBatchState =
      startMode === "RETRY"
        ? retryFieldEvidenceUploadBatch(
            currentBatchState,
            itemViewId,
            captureView?.canEdit === true,
            uploadOperation
          )
        : startMode === "RESELECT"
          ? replaceAndStartFieldEvidenceUploadRecovery(
              currentBatchState,
              itemViewId,
              files,
              item.allowsMultiple === true,
              captureView?.canEdit === true,
              uploadOperation
            )
          : startFieldEvidenceUploadBatchFromState(
              currentBatchState,
              itemViewId,
              files,
              item.allowsMultiple === true,
              fieldEvidenceUploadSnapshot(item)!,
              uploadOperation
            );
    if (nextBatchState.status !== "UPLOADING" || !nextBatchState.batch) {
      return;
    }
    const selectedFiles = nextBatchState.batch.files;
    const replaceEvidenceFileId =
      nextBatchState.batch.operation.type === "REPLACE"
        ? nextBatchState.batch.operation.replaceEvidenceFileId
        : undefined;
    if (
      item.allowsMultiple &&
      (item.files?.length ?? 0) + selectedFiles.length > MAX_DAMAGE_CLOSEUP_FILES
    ) {
      setBlockers([`损伤近拍最多上传 ${MAX_DAMAGE_CLOSEUP_FILES} 个文件`]);
      return;
    }
    for (const file of selectedFiles) {
      const validationError = validateFieldEvidenceFile(
        (item.allowedMediaTypes ?? []) as FieldEvidenceMediaType[],
        file
      );
      if (validationError) {
        setBlockers([validationError]);
        return;
      }
    }

    applyUploadBatchState(nextBatchState);
    setBlockers([]);
    const finalState = await runFieldEvidenceUploadBatch(nextBatchState, {
      getFailureMessage: getFieldHandoverActionErrorMessage,
      getInterruptionReason: () => {
        const reason = uploadAbortReasonRef.current ?? "FAILURE";
        uploadAbortReasonRef.current = null;
        return reason;
      },
      onStateChange: applyUploadBatchState,
      onUploadInterrupted: (error, reason) => {
        if (!isMountedRef.current) {
          return;
        }
        handleActionError(
          error,
          reason === "USER_CANCEL" ? "上传已取消，可重试剩余文件" : undefined
        );
      },
      refreshDetail: async () => {
        const refreshedDetail = await loadDetail({
          preserveFacts: true,
          showLoading: false
        });
        return fieldEvidenceUploadSnapshot(
          refreshedDetail ? findEvidenceItem(refreshedDetail, itemViewId) : null
        );
      },
      uploadFile: async (file, index) => {
        const controller = new AbortController();
        uploadAbortControllerRef.current = controller;
        uploadAbortReasonRef.current = null;
        uploadRequestBodyCompleteRef.current = false;
        if (isMountedRef.current) {
          setHasActiveUploadRequest(true);
          setUploadState({
            fileCount: selectedFiles.length,
            fileIndex: index + 1,
            fileName: file.name,
            itemId,
            loadedBytes: 0,
            percent: 0,
            phase: "UPLOADING",
            totalBytes: file.size
          });
        }
        try {
          const uploadOptions: FieldEvidenceUploadOptions = {
            onProgress: ({ loadedBytes, percent, totalBytes }: FieldEvidenceUploadProgress) => {
              if (!isMountedRef.current) {
                return;
              }
              setUploadState({
                fileCount: selectedFiles.length,
                fileIndex: index + 1,
                fileName: file.name,
                itemId,
                loadedBytes,
                percent,
                phase: "UPLOADING",
                totalBytes
              });
            },
            onUploadComplete: () => {
              uploadRequestBodyCompleteRef.current = true;
              if (!isMountedRef.current) {
                return;
              }
              setUploadState({
                fileCount: selectedFiles.length,
                fileIndex: index + 1,
                fileName: file.name,
                itemId,
                loadedBytes: file.size,
                percent: 100,
                phase: "PROCESSING",
                totalBytes: file.size
              });
            },
            replaceEvidenceFileId: index === 0 ? replaceEvidenceFileId : undefined,
            signal: controller.signal
          };
          const uploadedItem = await uploadAndAttachFieldHandoverEvidenceFile(
            params.id,
            itemId,
            file,
            uploadOptions
          );
          return fieldEvidenceUploadSnapshot(uploadedItem)!;
        } finally {
          if (uploadAbortControllerRef.current === controller) {
            uploadAbortControllerRef.current = null;
          }
          if (isMountedRef.current) {
            setHasActiveUploadRequest(false);
          }
          uploadRequestBodyCompleteRef.current = false;
        }
      }
    });

    if (isMountedRef.current && finalState.status === "IDLE") {
      setUploadState(null);
      if (!finalState.recoveries?.[itemViewId]) {
        void message.success(
          item.allowsMultiple && selectedFiles.length > 1
            ? `已上传 ${selectedFiles.length} 个文件`
            : replaceEvidenceFileId
              ? "资料已替换"
              : "资料已上传"
        );
      }
    }
  }

  function cancelEvidenceUpload() {
    if (uploadRequestBodyCompleteRef.current) {
      return;
    }
    cancelFieldEvidenceUploadRequest(uploadAbortControllerRef.current, (reason) => {
      uploadAbortReasonRef.current = reason;
    });
  }

  function retryEvidenceUpload(itemViewId: string) {
    void uploadEvidence(itemViewId, [], "RETRY");
  }

  function abandonEvidenceUpload(itemViewId: string) {
    const nextState = abandonFieldEvidenceUploadRecovery(uploadBatchStateRef.current, itemViewId);
    if (nextState === uploadBatchStateRef.current) {
      return;
    }
    applyUploadBatchState(nextState);
    setBlockers([]);
    void message.info("已放弃本次上传");
  }

  async function reloadUploadState() {
    const finalState = await retryFieldEvidenceUploadRefresh(uploadBatchStateRef.current, {
      onStateChange: applyUploadBatchState,
      refreshDetail: async () => {
        const itemViewId = getFieldEvidenceUploadReconciliationItemViewId(
          uploadBatchStateRef.current
        );
        const refreshedDetail = await loadDetail({
          preserveFacts: true,
          showLoading: false
        });
        return itemViewId && refreshedDetail
          ? fieldEvidenceUploadSnapshot(findEvidenceItem(refreshedDetail, itemViewId))
          : null;
      }
    });
    if (isMountedRef.current && finalState.status === "IDLE") {
      setUploadState(null);
    }
  }

  async function removeEvidence(itemId: string, evidenceFileId: string) {
    if (!canMutateFieldEvidenceWithUploadBatch(uploadBatchStateRef.current)) {
      setBlockers([UPLOAD_SUBMIT_BLOCKER_TEXT]);
      void message.warning(UPLOAD_SUBMIT_BLOCKER_TEXT);
      return;
    }
    try {
      setRemovingFileId(evidenceFileId);
      setBlockers([]);
      await removeFieldHandoverEvidenceFile(params.id, itemId, evidenceFileId);
      void message.success("资料已删除");
      await loadDetail();
    } catch (error) {
      handleActionError(error, "删除失败，请重试");
    } finally {
      setRemovingFileId(null);
    }
  }

  async function submitEvidence() {
    if (!detail || submissionInFlightRef.current || blockSubmitForUploadBatch()) {
      return;
    }

    submissionInFlightRef.current = true;
    try {
      const currentBlockers = getFieldHandoverSubmitBlockers(detail, facts);
      if (currentBlockers.length) {
        setBlockers(currentBlockers);
        return;
      }

      await runAction("submit", async () => {
        if (blockSubmitForUploadBatch()) {
          return;
        }
        await updateFieldHandoverFacts(params.id, buildFieldHandoverFactsPayload(facts));
        if (blockSubmitForUploadBatch()) {
          return;
        }
        const submitted = await submitFieldHandoverEvidence(params.id);
        const successText =
          submitted.status === "CUSTOMER_OBJECTED" &&
          submitted.adminReviewStatus === "RESUBMITTED_PENDING_ADMIN"
            ? RESUBMITTED_PENDING_ADMIN_TEXT
            : SUBMITTED_TEXT;
        setBlockers([]);
        setSuccessMessage(successText);
        void message.success(successText);
        await loadDetail();
      });
    } finally {
      submissionInFlightRef.current = false;
    }
  }

  function blockSubmitForUploadBatch() {
    if (canSubmitWithFieldEvidenceUploadBatch(uploadBatchStateRef.current)) {
      return false;
    }
    setBlockers([uploadBarrierText]);
    void message.warning(uploadBarrierText);
    return true;
  }

  async function runAction(action: string, callback: () => Promise<void>) {
    try {
      setActionLoading(action);
      await callback();
    } catch (error) {
      handleActionError(error);
    } finally {
      setActionLoading(null);
    }
  }

  function handleActionError(error: unknown, fallback?: string) {
    if (isFieldHandoverSessionExpired(error)) {
      router.replace("/field/handover");
      return;
    }
    const normalized = fallback ?? getFieldHandoverActionErrorMessage(error);
    setBlockers(splitBlockingMessages(normalized));
    void message.error(normalized);
  }

  return (
    <main
      style={{
        background: "#f5f8fc",
        minHeight: "100vh",
        padding: "max(22px, env(safe-area-inset-top)) 16px max(24px, env(safe-area-inset-bottom))"
      }}
    >
      <Modal
        cancelButtonProps={{ disabled: actionLoading === "esign" }}
        confirmLoading={actionLoading === "esign"}
        okButtonProps={{ disabled: !eSignAcknowledged }}
        okText="确认发起"
        onCancel={() => {
          if (actionLoading !== "esign") {
            setESignDialogOpen(false);
          }
        }}
        onOk={() => void submitStage2ESign()}
        open={eSignDialogOpen}
        title="发起电子签"
      >
        <Checkbox
          checked={eSignAcknowledged}
          disabled={actionLoading === "esign"}
          onChange={(event) => setESignAcknowledged(event.target.checked)}
        >
          我已核对交接确认单与现场交接情况一致
        </Checkbox>
      </Modal>
      <section style={{ margin: "0 auto", maxWidth: 520 }}>
        <Button
          icon={<ArrowLeftOutlined />}
          onClick={() => router.push("/field/handover/tasks")}
          style={{ marginBottom: 14 }}
        >
          返回任务列表
        </Button>

        {loading ? (
          <Flex align="center" gap={10} justify="center" style={{ minHeight: 240 }}>
            <Spin />
            <Typography.Text>正在加载交接任务...</Typography.Text>
          </Flex>
        ) : null}

        {!loading && errorMessage ? (
          <Alert
            action={
              <Button onClick={() => void loadDetail()} size="small">
                重新加载
              </Button>
            }
            message={errorMessage}
            showIcon
            type="error"
          />
        ) : null}

        {!loading && detailView && captureView ? (
          <Flex gap={12} vertical>
            <SummaryCard view={detailView} />

            {reviewContext?.customerObjectionReason ? (
              <Alert
                description={[
                  reviewContext.customerObjectionDetails,
                  reviewContext.adminNote ? `后台复检要求：${reviewContext.adminNote}` : null,
                  reviewContext.requestedEvidenceItems?.length
                    ? `复检资料：${reviewContext.requestedEvidenceItems.map((item) => item.title).join("、")}`
                    : null,
                  reviewContext.requestedFieldKeys?.length
                    ? `复检现场信息：${reviewContext.requestedFieldKeys.map(formatReviewFieldKey).join("、")}`
                    : null
                ]
                  .filter(Boolean)
                  .join("；")}
                message={`客户异议：${reviewContext.customerObjectionReason}`}
                showIcon
                type="warning"
              />
            ) : null}

            <article style={cardStyle}>
              <Flex
                align="flex-start"
                justify="space-between"
                style={{ gap: 12, marginBottom: 12 }}
              >
                <div>
                  <Typography.Title level={3} style={{ fontSize: 18, margin: 0 }}>
                    现场资料采集
                  </Typography.Title>
                  <Typography.Text style={{ color: "#607086" }}>
                    {captureView.nextStepText}
                  </Typography.Text>
                </div>
                <Button icon={<ReloadOutlined />} onClick={() => void loadDetail()}>
                  刷新
                </Button>
              </Flex>
              <Flex gap={8} vertical>
                <InfoRow label="资料" value={captureView.progressText} />
                <InfoRow label="现场信息" value={captureView.fieldFactsStatus} />
                <InfoRow label="损伤" value={captureView.damageStateLabel} />
                <InfoRow label="状态" value={detailView.card.statusLabel} />
              </Flex>
            </article>

            {captureView.lockedMessage ? (
              <Alert message={captureView.lockedMessage || LOCKED_TEXT} showIcon type="info" />
            ) : null}
            {successMessage ? (
              <Alert
                icon={<CheckCircleOutlined />}
                message={successMessage}
                showIcon
                type="success"
              />
            ) : null}
            {blockers.length ? <BlockerAlert blockers={blockers} /> : null}

            {stage2View?.shouldShow ? (
              <Stage2HandoverESignPanel
                onStart={openStage2ESignDialog}
                submitting={actionLoading === "esign"}
                view={stage2View}
              />
            ) : null}

            <article style={cardStyle}>
              <Typography.Title level={3} style={{ fontSize: 18, marginTop: 0 }}>
                现场信息
              </Typography.Title>
              <Flex gap={12} vertical>
                <LabeledControl label="交接里程">
                  <InputNumber
                    disabled={!captureView.canEdit}
                    min={1}
                    onChange={(value) =>
                      setFacts((current) => ({ ...current, handoverMileageKm: value ?? null }))
                    }
                    placeholder="请输入公里数"
                    style={{ width: "100%" }}
                    value={facts.handoverMileageKm ?? null}
                  />
                </LabeledControl>
                <LabeledControl label="能源/油量">
                  <Input
                    disabled={!captureView.canEdit}
                    onChange={(event) =>
                      setFacts((current) => ({ ...current, energyLevelText: event.target.value }))
                    }
                    placeholder="例如 80% / 满油"
                    value={facts.energyLevelText ?? ""}
                  />
                </LabeledControl>
                <LabeledControl label="交接地点">
                  <Input
                    disabled={!captureView.canEdit}
                    onChange={(event) =>
                      setFacts((current) => ({ ...current, deliveryLocation: event.target.value }))
                    }
                    placeholder="请输入现场交接地点"
                    value={facts.deliveryLocation ?? ""}
                  />
                </LabeledControl>
                <LabeledControl label="随车物品">
                  <Input.TextArea
                    autoSize={{ maxRows: 5, minRows: 3 }}
                    disabled={!captureView.canEdit}
                    onChange={(event) =>
                      setFacts((current) => ({
                        ...current,
                        accessoryChecklistText: event.target.value
                      }))
                    }
                    placeholder="逐行填写钥匙、充电线、随车工具等"
                    value={facts.accessoryChecklistText ?? ""}
                  />
                </LabeledControl>
                <LabeledControl label="损伤状态">
                  <Radio.Group
                    disabled={!captureView.canEdit || actionLoading === "damage"}
                    onChange={(event) => void updateDamageState(event.target.value)}
                    optionType="button"
                    value={
                      facts.damageDeclared
                        ? "DAMAGE"
                        : facts.noVisibleDamageDeclared
                          ? "NO_DAMAGE"
                          : undefined
                    }
                  >
                    <Radio.Button value="DAMAGE">发现损伤/瑕疵</Radio.Button>
                    <Radio.Button value="NO_DAMAGE">无可见损伤</Radio.Button>
                  </Radio.Group>
                </LabeledControl>
                <LabeledControl label="现场备注">
                  <Input.TextArea
                    autoSize={{ maxRows: 5, minRows: 3 }}
                    disabled={!captureView.canEdit}
                    onChange={(event) =>
                      setFacts((current) => ({ ...current, fieldNotes: event.target.value }))
                    }
                    placeholder="补充现场情况"
                    value={facts.fieldNotes ?? ""}
                  />
                </LabeledControl>
                {captureView.showStartAction ? (
                  <Button
                    block
                    icon={<PlayCircleOutlined />}
                    loading={actionLoading === "start"}
                    onClick={() => void startWork()}
                    size="large"
                  >
                    开始现场采集
                  </Button>
                ) : null}
                {captureView.showSaveAction ? (
                  <Button
                    block
                    icon={<SaveOutlined />}
                    loading={actionLoading === "save"}
                    onClick={() => void saveFacts()}
                    size="large"
                  >
                    保存现场信息
                  </Button>
                ) : null}
              </Flex>
            </article>

            <article style={cardStyle}>
              <Typography.Title level={3} style={{ fontSize: 18, marginTop: 0 }}>
                资料清单
              </Typography.Title>
              <Flex gap={10} vertical>
                {captureView.evidenceItems.map((item) => {
                  const allowedMediaTypes = (
                    (detail ? findEvidenceItem(detail, item.id) : null)?.allowedMediaTypes ?? []
                  ).filter(
                    (mediaType): mediaType is FieldEvidenceMediaType =>
                      mediaType === "PHOTO" || mediaType === "VIDEO"
                  );
                  const isUploading = uploadingItemId === item.id;
                  const itemUploadState = uploadState?.itemId === item.id ? uploadState : null;
                  const recovery = uploadBatchState.recoveries?.[item.id];
                  const canRetry = canRetryFieldEvidenceUploadBatch(
                    uploadBatchState,
                    item.id,
                    captureView.canEdit
                  );
                  const canStartUpload = canStartFieldEvidenceUploadBatch(
                    uploadBatchState,
                    item.id
                  );

                  return (
                    <article key={item.id || item.title} style={itemCardStyle}>
                      <Flex align="flex-start" justify="space-between" style={{ gap: 10 }}>
                        <div>
                          <Typography.Text strong>{item.title}</Typography.Text>
                          {item.description ? (
                            <Typography.Paragraph style={{ color: "#607086", margin: "4px 0 0" }}>
                              {item.description}
                            </Typography.Paragraph>
                          ) : null}
                        </div>
                        <Flex gap={6} wrap="wrap" justify="flex-end">
                          <Tag
                            color={item.requiredText === "必传" ? "red" : "blue"}
                            style={{ marginInlineEnd: 0 }}
                          >
                            {item.requiredText}
                          </Tag>
                          <Tag
                            color={item.statusLabel === "待上传" ? "default" : "green"}
                            style={{ marginInlineEnd: 0 }}
                          >
                            {item.statusLabel}
                          </Tag>
                        </Flex>
                      </Flex>

                      <Typography.Text style={{ color: "#607086", display: "block", marginTop: 8 }}>
                        {item.fileCountText}
                      </Typography.Text>

                      {item.rejectionReason ? (
                        <Alert
                          message={item.rejectionReason}
                          showIcon
                          style={{ marginTop: 8 }}
                          type="warning"
                        />
                      ) : null}

                      {item.showDeclarationComplete ? (
                        <Typography.Text
                          style={{ color: "#2f7d32", display: "block", marginTop: 8 }}
                        >
                          无可见损伤声明已完成
                        </Typography.Text>
                      ) : null}

                      {item.files.length > 0 ? (
                        <Flex gap={8} style={{ marginTop: 10 }} vertical>
                          {item.files.map((file) => (
                            <Flex
                              align="center"
                              gap={8}
                              justify="space-between"
                              key={file.evidenceFileId}
                              style={{ borderTop: "1px solid #e2e8f0", paddingTop: 8 }}
                            >
                              <div style={{ minWidth: 0 }}>
                                <Typography.Text
                                  ellipsis
                                  style={{ display: "block", maxWidth: 260 }}
                                >
                                  {file.displayName}
                                </Typography.Text>
                                <Typography.Text style={{ color: "#718096", fontSize: 12 }}>
                                  {file.sizeText}
                                </Typography.Text>
                              </div>
                              <Flex gap={4}>
                                {file.previewUrl ? (
                                  <Tooltip title="查看资料">
                                    <Button
                                      aria-label="查看资料"
                                      href={buildFieldHandoverFileUrl(file.previewUrl) ?? undefined}
                                      icon={<EyeOutlined />}
                                      target="_blank"
                                      type="text"
                                    />
                                  </Tooltip>
                                ) : null}
                                {file.downloadUrl ? (
                                  <Tooltip title="下载资料">
                                    <Button
                                      aria-label="下载资料"
                                      href={
                                        buildFieldHandoverFileUrl(file.downloadUrl) ?? undefined
                                      }
                                      icon={<DownloadOutlined />}
                                      target="_blank"
                                      type="text"
                                    />
                                  </Tooltip>
                                ) : null}
                                {captureView.canEdit && canMutateEvidence ? (
                                  <Popconfirm
                                    description="删除后需重新上传才能提交。"
                                    okText="删除"
                                    cancelText="取消"
                                    onConfirm={() =>
                                      void removeEvidence(item.id, file.evidenceFileId)
                                    }
                                    title="删除这份资料？"
                                  >
                                    <Tooltip title="删除资料">
                                      <Button
                                        aria-label="删除资料"
                                        danger
                                        icon={<DeleteOutlined />}
                                        loading={removingFileId === file.evidenceFileId}
                                        type="text"
                                      />
                                    </Tooltip>
                                  </Popconfirm>
                                ) : null}
                              </Flex>
                            </Flex>
                          ))}
                        </Flex>
                      ) : null}

                      {itemUploadState ? (
                        <div aria-live="polite" style={uploadProgressStyle}>
                          <Typography.Text strong>
                            {uploadBatchState.status === "REFRESHING" ||
                            uploadBatchState.status === "REFRESH_FAILED"
                              ? "资料状态同步"
                              : itemUploadState.phase === "PROCESSING"
                                ? "服务端处理中"
                                : "上传进度"}
                          </Typography.Text>
                          {uploadBatchState.status === "REFRESHING" ||
                          uploadBatchState.status === "REFRESH_FAILED" ? null : (
                            <>
                              <Typography.Text ellipsis style={{ display: "block", marginTop: 4 }}>
                                {itemUploadState.fileIndex} / {itemUploadState.fileCount} ·{" "}
                                {itemUploadState.fileName}
                              </Typography.Text>
                              <Progress percent={itemUploadState.percent} size="small" />
                            </>
                          )}
                          <Flex align="center" gap={8} justify="space-between" wrap="wrap">
                            <Typography.Text style={{ color: "#607086", fontSize: 12 }}>
                              {uploadBatchState.status === "REFRESHING" ||
                              uploadBatchState.status === "REFRESH_FAILED"
                                ? uploadBarrierText
                                : itemUploadState.phase === "PROCESSING"
                                  ? "请求体已上传，正在保存并绑定资料"
                                  : `${formatUploadBytes(itemUploadState.loadedBytes)} / ${formatUploadBytes(itemUploadState.totalBytes)}`}
                            </Typography.Text>
                            {isUploading &&
                            hasActiveUploadRequest &&
                            itemUploadState.phase === "UPLOADING" ? (
                              <Button
                                danger
                                icon={<StopOutlined />}
                                onClick={cancelEvidenceUpload}
                                style={{ minHeight: 44 }}
                              >
                                取消上传
                              </Button>
                            ) : uploadBatchState.status === "REFRESH_FAILED" ? (
                              <Button
                                icon={<ReloadOutlined />}
                                onClick={() => void reloadUploadState()}
                                style={{ minHeight: 44 }}
                              >
                                重新加载状态
                              </Button>
                            ) : null}
                          </Flex>
                        </div>
                      ) : null}

                      {recovery ? (
                        <div aria-live="polite" style={uploadRecoveryStyle}>
                          <Typography.Text strong type="danger">
                            {recovery.errorMessage}
                          </Typography.Text>
                          <Typography.Text ellipsis style={{ display: "block", marginTop: 4 }}>
                            待处理文件：{recovery.files[0]?.name ?? "未知文件"}
                          </Typography.Text>
                          <Flex gap={8} style={{ marginTop: 10 }} vertical>
                            <Button
                              block
                              disabled={!canRetry || actionLoading === "submit"}
                              icon={<ReloadOutlined />}
                              onClick={() => retryEvidenceUpload(item.id)}
                              style={{ minHeight: 44 }}
                            >
                              重试原文件
                            </Button>
                            <EvidenceUploadControls
                              allowedMediaTypes={allowedMediaTypes}
                              disabled={!canRetry || actionLoading === "submit"}
                              environment={uploadEnvironment}
                              id={`${item.id}-reselect`}
                              label="重新选择"
                              multiple={item.allowsMultiple}
                              onFiles={(files) => void uploadEvidence(item.id, files, "RESELECT")}
                              variant="secondary"
                            />
                            <Popconfirm
                              cancelText="取消"
                              description="放弃后可重新发起资料上传。"
                              disabled={!canRetry || actionLoading === "submit"}
                              okText="放弃"
                              onConfirm={() => abandonEvidenceUpload(item.id)}
                              title="放弃本次上传？"
                            >
                              <Button
                                block
                                danger
                                disabled={!canRetry || actionLoading === "submit"}
                                style={{ minHeight: 44 }}
                              >
                                放弃本次上传
                              </Button>
                            </Popconfirm>
                          </Flex>
                        </div>
                      ) : null}

                      {item.showUpload ? (
                        <EvidenceUploadControls
                          allowedMediaTypes={allowedMediaTypes}
                          disabled={
                            !canStartUpload || !captureView.canEdit || actionLoading === "submit"
                          }
                          environment={uploadEnvironment}
                          id={item.id}
                          multiple={item.allowsMultiple}
                          onFiles={(files) => void uploadEvidence(item.id, files)}
                        />
                      ) : null}
                    </article>
                  );
                })}
              </Flex>
            </article>

            {captureView.showSubmitAction ? (
              <div style={submitBarStyle}>
                {!canSubmitUploadBatch ? (
                  <Alert
                    message={uploadBarrierText}
                    showIcon
                    style={{ marginBottom: 8 }}
                    type="warning"
                  />
                ) : null}
                <Button
                  block
                  disabled={!canSubmitUploadBatch}
                  icon={<CheckCircleOutlined />}
                  loading={actionLoading === "submit"}
                  onClick={() => void submitEvidence()}
                  size="large"
                  type="primary"
                >
                  提交现场资料
                </Button>
              </div>
            ) : null}
          </Flex>
        ) : null}
      </section>
    </main>
  );
}

function Stage2HandoverESignPanel({
  onStart,
  submitting,
  view
}: {
  onStart: () => void;
  submitting: boolean;
  view: ReturnType<typeof buildFieldStage2HandoverView>;
}) {
  return (
    <article style={cardStyle}>
      <Typography.Title level={3} style={{ fontSize: 18, marginTop: 0 }}>
        交接确认单
      </Typography.Title>
      <Flex gap={8} vertical>
        <InfoRow label="文档编号" value={view.documentNoText} />
        <InfoRow label="生成时间" value={view.generatedAtText} />
        <InfoRow label="文件名称" value={view.fileNameText} />
        <InfoRow label="文件大小" value={view.fileSizeText} />
        <InfoRow label="通知状态" value={view.notificationStatusText} />
        <Flex justify="space-between" style={{ gap: 12 }}>
          <Typography.Text style={{ color: "#718096", flex: "0 0 82px" }}>
            SHA-256
          </Typography.Text>
          <Typography.Text
            copyable={Boolean(view.sourcePdfHash)}
            style={{
              flex: 1,
              overflowWrap: "anywhere",
              textAlign: "right",
              wordBreak: "break-all"
            }}
          >
            {view.sourcePdfHash ?? "-"}
          </Typography.Text>
        </Flex>
      </Flex>
      <Flex gap={8} style={{ marginTop: 14 }} wrap="wrap">
        <Button
          disabled={!view.canPreview}
          href={buildFieldHandoverFileUrl(view.previewUrl) ?? undefined}
          icon={<EyeOutlined />}
          style={{ flex: "1 1 140px" }}
          target="_blank"
        >
          预览
        </Button>
        <Button
          disabled={!view.canDownload}
          href={buildFieldHandoverFileUrl(view.downloadUrl) ?? undefined}
          icon={<DownloadOutlined />}
          style={{ flex: "1 1 140px" }}
          target="_blank"
        >
          下载
        </Button>
      </Flex>
      <Button
        block
        disabled={!view.canStartESign || submitting}
        icon={<CheckCircleOutlined />}
        loading={submitting}
        onClick={onStart}
        size="large"
        style={{ marginTop: 10 }}
        type="primary"
      >
        发起电子签
      </Button>
    </article>
  );
}

function SummaryCard({ view }: { view: ReturnType<typeof buildFieldHandoverDetailView> }) {
  return (
    <article style={cardStyle}>
      <Flex align="flex-start" justify="space-between" style={{ gap: 12, marginBottom: 12 }}>
        <div>
          <Typography.Title level={2} style={{ fontSize: 22, margin: 0 }}>
            {view.card.title}
          </Typography.Title>
          <Typography.Text style={{ color: "#607086" }}>
            {view.card.handoverTypeLabel}
          </Typography.Text>
        </div>
        <Tag color="blue" style={{ marginInlineEnd: 0 }}>
          {view.card.statusLabel}
        </Tag>
      </Flex>

      <Flex gap={8} vertical>
        <InfoRow label="预约时间" value={view.card.scheduledAtText} />
        <InfoRow label="交接地点" value={view.card.deliveryLocationText} />
        <InfoRow label="车辆" value={view.card.vehicleText} />
        <InfoRow label="车牌" value={view.card.plateText} />
        <InfoRow label="VIN" value={view.card.vinText} />
        <InfoRow label="客户" value={view.card.customerText} />
        <InfoRow label="资料清单" value={view.checklistSummary} />
      </Flex>
    </article>
  );
}

function BlockerAlert({ blockers }: { blockers: string[] }) {
  return (
    <Alert
      description={
        <ul style={{ margin: "6px 0 0", paddingInlineStart: 18 }}>
          {blockers.map((item) => (
            <li key={item}>{item}</li>
          ))}
        </ul>
      }
      icon={<ExclamationCircleOutlined />}
      message="请先补齐以下内容"
      showIcon
      type="warning"
    />
  );
}

function LabeledControl({ children, label }: { children: ReactNode; label: string }) {
  return (
    <label style={{ display: "block" }}>
      <Typography.Text strong style={{ display: "block", marginBottom: 6 }}>
        {label}
      </Typography.Text>
      {children}
    </label>
  );
}

function InfoRow({ label, value }: { label: string; value: string }) {
  return (
    <Flex justify="space-between" style={{ gap: 12 }}>
      <Typography.Text style={{ color: "#718096", flex: "0 0 82px" }}>{label}</Typography.Text>
      <Typography.Text style={{ flex: 1, textAlign: "right", wordBreak: "break-word" }}>
        {value}
      </Typography.Text>
    </Flex>
  );
}

function findEvidenceItem(detail: FieldHandoverWorkOrderDetail, itemId: string) {
  return (detail.evidenceChecklist?.items ?? []).find((item) => item.id === itemId) ?? null;
}

function fieldEvidenceUploadSnapshot(
  item: FieldHandoverEvidenceItem | null
): FieldEvidenceUploadSnapshot | null {
  if (!item) {
    return null;
  }
  const ids = (item.files ?? [])
    .map((file) => file.evidenceFileId || file.id || "")
    .filter(Boolean);
  const count =
    typeof item.fileCount === "number" ? Math.max(item.fileCount, ids.length) : ids.length;
  return { count, ids };
}

function formatReviewFieldKey(value: string) {
  return REVIEW_FIELD_LABELS[value] ?? value;
}

function splitBlockingMessages(message: string) {
  return message
    .split(/[,，\n]/)
    .map((item) => item.trim())
    .filter(Boolean);
}

const cardStyle: CSSProperties = {
  background: "#fff",
  border: "1px solid #dde5f0",
  borderRadius: 8,
  boxShadow: "0 8px 22px rgba(31, 71, 112, 0.06)",
  padding: 16
};

const itemCardStyle: CSSProperties = {
  background: "#f8fafc",
  border: "1px solid #e2e8f0",
  borderRadius: 8,
  padding: 12
};

const uploadProgressStyle: CSSProperties = {
  background: "#fff",
  border: "1px solid #d9e2ef",
  borderRadius: 8,
  marginTop: 10,
  padding: 10
};

const uploadRecoveryStyle: CSSProperties = {
  background: "#fff7e6",
  border: "1px solid #ffd591",
  borderRadius: 8,
  marginTop: 10,
  padding: 10
};

const submitBarStyle: CSSProperties = {
  background: "rgba(245, 248, 252, 0.94)",
  bottom: 0,
  padding: "8px 0 max(8px, env(safe-area-inset-bottom))",
  position: "sticky"
};

const REVIEW_FIELD_LABELS: Record<string, string> = {
  accessoryChecklist: "随车物品",
  damageDeclared: "损伤状态",
  deliveryLocation: "交接地点",
  energyLevelText: "能源状态",
  fieldNotes: "现场备注",
  fuelLevelText: "油量状态",
  handoverMileageKm: "交接里程",
  noVisibleDamageDeclared: "无可见损伤声明",
  scheduledAt: "预约时间"
};
