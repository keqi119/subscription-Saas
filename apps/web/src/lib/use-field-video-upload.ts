"use client";

import { Modal } from "antd";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";

import {
  cancelFieldVideoUploadSession,
  listActiveFieldVideoUploadSessions
} from "./field-video-upload-api";
import {
  clearFieldVideoRecovery,
  listFieldVideoRecoveries,
  synchronizeFieldVideoRecoveryPrompts
} from "./field-video-upload-recovery";
import type { FieldVideoUploadRecoveryPrompt } from "./field-video-upload-recovery";
import { runFieldVideoUpload } from "./field-video-upload-runner";
import type { FieldVideoUploadRunnerState } from "./field-video-upload-runner";

interface SelectedFieldVideo {
  evidenceItemId: string;
  file: File;
  replaceEvidenceFileId?: string;
}

export function useFieldVideoUpload({
  onCompleted,
  onSessionExpired,
  workOrderId
}: {
  onCompleted?: () => Promise<void> | void;
  onSessionExpired?: () => void;
  workOrderId: string;
}) {
  const controllerRef = useRef<AbortController | null>(null);
  const recoveryTargetRef = useRef<FieldVideoUploadRecoveryPrompt | null>(null);
  const selectedRef = useRef<SelectedFieldVideo | null>(null);
  const callbacksRef = useRef({ onCompleted, onSessionExpired });
  const [hasActiveRecoveryTarget, setHasActiveRecoveryTarget] = useState(false);
  const [recoveries, setRecoveries] = useState<FieldVideoUploadRecoveryPrompt[]>([]);
  const [state, setState] = useState<FieldVideoUploadRunnerState | null>(null);

  useEffect(() => {
    callbacksRef.current = { onCompleted, onSessionExpired };
  }, [onCompleted, onSessionExpired]);

  const updateRecoveryTarget = useCallback((target: FieldVideoUploadRecoveryPrompt | null) => {
    recoveryTargetRef.current = target;
    setHasActiveRecoveryTarget(Boolean(target));
  }, []);

  const refreshRecoveries = useCallback(async () => {
    const local = listFieldVideoRecoveries();
    try {
      const active = await listActiveFieldVideoUploadSessions();
      const prompts = synchronizeFieldVideoRecoveryPrompts(active);
      setRecoveries(prompts);
      updateRecoveryTarget(prompts.find((record) => record.workOrderId === workOrderId) ?? null);
    } catch (error) {
      setRecoveries(local);
      updateRecoveryTarget(local.find((record) => record.workOrderId === workOrderId) ?? null);
      if (isUnauthorized(error)) {
        callbacksRef.current.onSessionExpired?.();
      }
    }
  }, [updateRecoveryTarget, workOrderId]);

  useEffect(() => {
    void refreshRecoveries();
    return () => controllerRef.current?.abort();
  }, [refreshRecoveries]);

  const execute = useCallback(
    async (selected: SelectedFieldVideo, retryFinalization = false) => {
      if (controllerRef.current) {
        return;
      }
      const controller = new AbortController();
      controllerRef.current = controller;
      selectedRef.current = selected;
      const recovery = listFieldVideoRecoveries().find(
        (record) =>
          record.workOrderId === workOrderId && record.evidenceItemId === selected.evidenceItemId
      );
      updateRecoveryTarget(
        recovery ??
          recoveries.find(
            (record) =>
              record.workOrderId === workOrderId &&
              record.evidenceItemId === selected.evidenceItemId
          ) ??
          null
      );
      try {
        const result = await runFieldVideoUpload({
          evidenceItemId: selected.evidenceItemId,
          file: selected.file,
          onStateChange: (nextState) => {
            setState(nextState);
            if (nextState.session) {
              updateRecoveryTarget(
                isTerminalUploadStatus(nextState.session.status)
                  ? null
                  : toRecoveryPrompt(nextState.session)
              );
            }
          },
          recovery,
          replaceEvidenceFileId: selected.replaceEvidenceFileId,
          retryFinalization,
          signal: controller.signal,
          workOrderId
        });
        await refreshRecoveries();
        if (result.status === "COMPLETED") {
          await callbacksRef.current.onCompleted?.();
        }
      } catch (error) {
        await refreshRecoveries();
        if (isUnauthorized(error)) {
          callbacksRef.current.onSessionExpired?.();
          return;
        }
        const isFileMismatch = isFileSelectionConflict(error);
        setState((current) =>
          current
            ? {
                ...current,
                errorMessage: safeUploadMessage(error),
                status: isFileMismatch ? "VALIDATION_FAILED" : "RETRYABLE_FAILED"
              }
            : current
        );
      } finally {
        if (controllerRef.current === controller) {
          controllerRef.current = null;
        }
      }
    },
    [recoveries, refreshRecoveries, updateRecoveryTarget, workOrderId]
  );

  const selectFile = useCallback((selected: SelectedFieldVideo) => execute(selected), [execute]);
  const pause = useCallback(() => controllerRef.current?.abort(), []);
  const resume = useCallback(() => {
    if (selectedRef.current) {
      return execute(selectedRef.current);
    }
  }, [execute]);
  const retryFinalization = useCallback(() => {
    if (selectedRef.current) {
      return execute(selectedRef.current, true);
    }
  }, [execute]);
  const cancel = useCallback(() => {
    const session = state?.session;
    const target = session ?? recoveryTargetRef.current;
    if (!target) {
      setState(null);
      selectedRef.current = null;
      return;
    }
    Modal.confirm({
      cancelText: "继续上传",
      content: "取消后，已上传分片将被清理，并且需要从头重新上传。",
      okButtonProps: { danger: true },
      okText: "确认取消",
      onOk: async () => {
        controllerRef.current?.abort();
        if (!session || !isTerminalUploadStatus(session.status)) {
          await cancelFieldVideoUploadSession(
            target.workOrderId,
            target.evidenceItemId,
            target.sessionId
          );
        }
        clearFieldVideoRecovery(target.sessionId);
        updateRecoveryTarget(null);
        await refreshRecoveries();
        setState(null);
        selectedRef.current = null;
      },
      title: "取消本次视频上传？"
    });
  }, [refreshRecoveries, state?.session, updateRecoveryTarget]);

  const uploadLocked = Boolean(
    state && state.status !== "COMPLETED" && state.status !== "VALIDATION_FAILED"
  );
  const barrierActive = uploadLocked || hasActiveRecoveryTarget;
  const view = useMemo(() => {
    if (!state) {
      return null;
    }
    return {
      activeEvidenceItemId:
        state.session?.evidenceItemId ?? selectedRef.current?.evidenceItemId ?? null,
      completedParts: state.completedParts,
      errorMessage: state.errorMessage ?? null,
      fileName: state.session?.fileName ?? selectedRef.current?.file.name ?? "视频文件",
      percent: state.percent,
      phaseLabel: phaseLabel(state.status),
      status: state.status,
      totalParts: state.totalParts
    };
  }, [state]);

  return {
    barrierActive,
    cancel,
    pause,
    recoveries,
    resume,
    retryFinalization,
    selectFile,
    uploadLocked,
    view
  };
}

function phaseLabel(status: FieldVideoUploadRunnerState["status"]) {
  const labels: Record<FieldVideoUploadRunnerState["status"], string> = {
    COMPLETED: "上传完成",
    FINALIZING: "OSS 合并中",
    PAUSED: "已暂停",
    PROCESSING: "清晰度校验和关键帧处理中",
    RETRYABLE_FAILED: "处理失败，可重试",
    SELECTED: "正在校验文件",
    UPLOADING: "上传中",
    VALIDATION_FAILED: "校验失败"
  };
  return labels[status];
}

function isUnauthorized(error: unknown) {
  return Boolean(error && typeof error === "object" && "status" in error && error.status === 401);
}

function safeUploadMessage(error: unknown) {
  if (error instanceof Error && error.message === "VIDEO_UPLOAD_FILE_MISMATCH") {
    return "所选文件与未完成上传记录不一致，请重新选择原文件或取消旧记录。";
  }
  return error instanceof Error && error.message.trim()
    ? error.message
    : "视频上传暂时失败，请稍后重试。";
}

function isFileSelectionConflict(error: unknown) {
  return Boolean(
    error &&
    typeof error === "object" &&
    (("message" in error && error.message === "VIDEO_UPLOAD_FILE_MISMATCH") ||
      ("code" in error && error.code === "VIDEO_UPLOAD_ACTIVE_FILE_CONFLICT"))
  );
}

function isTerminalUploadStatus(status: string) {
  return ["CANCELLED", "COMPLETED", "EXPIRED", "VALIDATION_FAILED"].includes(status);
}

function toRecoveryPrompt(session: {
  evidenceItemId: string;
  expiresAt: string;
  fileName: string;
  sessionId: string;
  sizeBytes: number;
  workOrderId: string;
}): FieldVideoUploadRecoveryPrompt {
  return {
    evidenceItemId: session.evidenceItemId,
    expiresAt: session.expiresAt,
    fileName: session.fileName,
    sessionId: session.sessionId,
    sizeBytes: session.sizeBytes,
    workOrderId: session.workOrderId
  };
}
