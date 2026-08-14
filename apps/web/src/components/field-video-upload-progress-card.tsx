"use client";

import { Alert, Button, Flex, Progress, Typography } from "antd";

import type { FieldVideoUploadRunnerStatus } from "../lib/field-video-upload-runner";

export interface FieldVideoUploadProgressView {
  completedParts: number;
  errorMessage: string | null;
  fileName: string;
  percent: number;
  phaseLabel: string;
  status: FieldVideoUploadRunnerStatus;
  totalParts: number;
}

export function FieldVideoUploadProgressCard({
  onCancel,
  onPause,
  onResume,
  onRetry,
  view
}: {
  onCancel: () => void;
  onPause: () => void;
  onResume: () => void;
  onRetry: () => void;
  view: FieldVideoUploadProgressView;
}) {
  const canPause = view.status === "UPLOADING";
  const canResume = view.status === "PAUSED";
  const canRetry = view.status === "RETRYABLE_FAILED";

  return (
    <div
      aria-live="polite"
      style={{
        background: "#fff",
        border: "1px solid #d9e2ef",
        borderRadius: 8,
        marginTop: 10,
        padding: 12
      }}
    >
      <Flex align="center" justify="space-between" style={{ gap: 8 }}>
        <Typography.Text strong>{view.phaseLabel}</Typography.Text>
        <Typography.Text>
          {view.completedParts}/{view.totalParts}
        </Typography.Text>
      </Flex>
      <Typography.Text ellipsis style={{ display: "block", marginTop: 4 }}>
        {view.fileName}
      </Typography.Text>
      <Progress
        percent={view.percent}
        size="small"
        status={
          view.errorMessage ? "exception" : view.status === "COMPLETED" ? "success" : "active"
        }
      />
      {view.errorMessage ? (
        <Alert message={view.errorMessage} showIcon style={{ marginTop: 8 }} type="error" />
      ) : null}
      <Flex gap={8} style={{ marginTop: 10 }} vertical>
        {canPause ? (
          <Button block onClick={onPause} style={{ minHeight: 44 }}>
            暂停上传
          </Button>
        ) : null}
        {canResume ? (
          <Button block onClick={onResume} style={{ minHeight: 44 }} type="primary">
            继续上传
          </Button>
        ) : null}
        {canRetry ? (
          <Button block onClick={onRetry} style={{ minHeight: 44 }} type="primary">
            重试处理
          </Button>
        ) : null}
        {view.status !== "COMPLETED" ? (
          <Button block danger onClick={onCancel} style={{ minHeight: 44 }}>
            取消本次上传
          </Button>
        ) : null}
      </Flex>
    </div>
  );
}
