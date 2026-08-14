"use client";

import { Modal } from "antd";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";

import { cancelFieldVideoUploadSession } from "./field-video-upload-api";
import { clearFieldVideoRecovery, listFieldVideoRecoveries } from "./field-video-upload-recovery";
import type { FieldVideoUploadRecoveryRecord } from "./field-video-upload-recovery";
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
  const selectedRef = useRef<SelectedFieldVideo | null>(null);
  const callbacksRef = useRef({ onCompleted, onSessionExpired });
  const [recoveries, setRecoveries] = useState<FieldVideoUploadRecoveryRecord[]>([]);
  const [state, setState] = useState<FieldVideoUploadRunnerState | null>(null);

  useEffect(() => {
    callbacksRef.current = { onCompleted, onSessionExpired };
  }, [onCompleted, onSessionExpired]);

  useEffect(() => {
    setRecoveries(listFieldVideoRecoveries());
    return () => controllerRef.current?.abort();
  }, []);

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
      try {
        const result = await runFieldVideoUpload({
          evidenceItemId: selected.evidenceItemId,
          file: selected.file,
          onStateChange: setState,
          recovery,
          replaceEvidenceFileId: selected.replaceEvidenceFileId,
          retryFinalization,
          signal: controller.signal,
          workOrderId
        });
        setRecoveries(listFieldVideoRecoveries());
        if (result.status === "COMPLETED") {
          await callbacksRef.current.onCompleted?.();
        }
      } catch (error) {
        setRecoveries(listFieldVideoRecoveries());
        if (isUnauthorized(error)) {
          callbacksRef.current.onSessionExpired?.();
          return;
        }
        const isFileMismatch =
          error instanceof Error && error.message === "VIDEO_UPLOAD_FILE_MISMATCH";
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
    [workOrderId]
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
    if (!session) {
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
        if (state?.status !== "VALIDATION_FAILED" && state?.status !== "COMPLETED") {
          await cancelFieldVideoUploadSession(
            session.workOrderId,
            session.evidenceItemId,
            session.sessionId
          );
        }
        clearFieldVideoRecovery(session.sessionId);
        setRecoveries(listFieldVideoRecoveries());
        setState(null);
        selectedRef.current = null;
      },
      title: "取消本次视频上传？"
    });
  }, [state?.session, state?.status]);

  const barrierActive = Boolean(
    state && state.status !== "COMPLETED" && state.status !== "VALIDATION_FAILED"
  );
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
