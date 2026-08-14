"use client";

import { Alert, Flex, Typography } from "antd";

import type { FieldVideoUploadRecoveryRecord } from "../lib/field-video-upload-recovery";

export function FieldVideoUploadRecoveryAlert({
  records
}: {
  records: FieldVideoUploadRecoveryRecord[];
}) {
  if (records.length === 0) {
    return null;
  }

  return (
    <Alert
      description={
        <Flex gap={8} vertical>
          {records.map((record) => (
            <div key={record.sessionId}>
              <Typography.Text strong>{record.fileName}</Typography.Text>
              <Typography.Text style={{ display: "block" }}>
                检测到未完成的视频上传。进入原任务并重新选择同一文件后可继续。
              </Typography.Text>
              <a href={`/field/handover/tasks/${encodeURIComponent(record.workOrderId)}`}>
                进入原任务
              </a>
            </div>
          ))}
        </Flex>
      }
      message="存在未完成的视频上传"
      showIcon
      type="warning"
    />
  );
}
