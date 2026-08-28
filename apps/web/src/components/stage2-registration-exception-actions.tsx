"use client";

import { Alert, App, Button, Input, Modal, Space, Spin, Tag, Tooltip, Typography } from "antd";
import { useCallback, useEffect, useState } from "react";

import {
  decideAdminStage2RegistrationException,
  loadAdminStage2RegistrationException,
  requestAdminStage2RegistrationException,
  type AdminStage2RegistrationExceptionState
} from "../lib/admin-stage2-handover-esign";

type DialogMode = "APPROVE" | "REJECT" | "REQUEST" | null;

export function Stage2RegistrationExceptionActions({
  canApprove,
  canRequest,
  canView,
  currentUserId,
  onChanged,
  visible,
  workOrderId
}: {
  canApprove: boolean;
  canRequest: boolean;
  canView: boolean;
  currentUserId: string | null;
  onChanged: () => Promise<void> | void;
  visible: boolean;
  workOrderId: string;
}) {
  const { message } = App.useApp();
  const [dialogMode, setDialogMode] = useState<DialogMode>(null);
  const [loading, setLoading] = useState(false);
  const [reason, setReason] = useState("");
  const [state, setState] = useState<AdminStage2RegistrationExceptionState | null>(null);

  const load = useCallback(async () => {
    if (!visible || !canView) return;
    setLoading(true);
    try {
      setState(await loadAdminStage2RegistrationException(workOrderId));
    } catch (error) {
      void message.error(errorMessage(error));
    } finally {
      setLoading(false);
    }
  }, [canView, message, visible, workOrderId]);

  useEffect(() => {
    void load();
  }, [load]);

  if (!visible) return null;

  const latest = state?.latestApproval ?? null;
  const selfApproval = latest?.requestedBy === currentUserId;
  const pending = latest?.status === "PENDING";
  const normalizedReason = reason.trim().replace(/\s+/g, " ");

  async function submit() {
    if (!dialogMode || normalizedReason.length < 3 || normalizedReason.length > 1000) {
      void message.warning("请填写 3-1000 个字符的原因或审批意见");
      return;
    }
    setLoading(true);
    try {
      if (dialogMode === "REQUEST") {
        await requestAdminStage2RegistrationException(
          workOrderId,
          normalizedReason
        );
        void message.success("行驶证例外审批申请已提交");
      } else if (latest) {
        await decideAdminStage2RegistrationException(
          workOrderId,
          latest.id,
          {
            comment: normalizedReason,
            decision: dialogMode === "APPROVE" ? "APPROVED" : "REJECTED",
            expectedVersion: latest.version
          }
        );
        void message.success(
          dialogMode === "APPROVE" ? "行驶证例外已批准" : "行驶证例外已驳回"
        );
      }
      setDialogMode(null);
      setReason("");
      await load();
      await onChanged();
    } catch (error) {
      void message.error(errorMessage(error));
    } finally {
      setLoading(false);
    }
  }

  return (
    <>
      <Alert
        description={
          <Space orientation="vertical" size={4}>
            <Typography.Text>
              请先在车辆证照档案补录有效行驶证并完成现场交付确认；确因外部原因无法补录或交付时，可走管理员例外审批。
            </Typography.Text>
            {loading && !state ? <Spin size="small" /> : null}
            {latest ? (
              <Space size={6} wrap>
                <Tag color={approvalColor(latest.status)}>
                  {approvalLabel(latest.status)}
                </Tag>
                <Typography.Text type="secondary">
                  {latest.approvalNo} · {latest.requestReason}
                </Typography.Text>
              </Space>
            ) : null}
            {state ? (
              <Typography.Text type="secondary">
                当前事实快照：{state.snapshotHash.slice(0, 12)}…
              </Typography.Text>
            ) : null}
          </Space>
        }
        message="行驶证资料阻断签署"
        showIcon
        type="warning"
      />
      <Space size={6} wrap>
        <Button disabled={!canView || loading} onClick={() => void load()} size="small">
          刷新审批状态
        </Button>
        {!pending ? (
          <Button
            disabled={!canRequest || loading}
            onClick={() => setDialogMode("REQUEST")}
            size="small"
          >
            申请例外审批
          </Button>
        ) : null}
        {pending ? (
          <Tooltip title={selfApproval ? "申请人与审批人不能为同一账号" : undefined}>
            <Button
              disabled={!canApprove || selfApproval || loading}
              onClick={() => setDialogMode("APPROVE")}
              size="small"
              type="primary"
            >
              批准例外
            </Button>
          </Tooltip>
        ) : null}
        {pending ? (
          <Button
            danger
            disabled={!canApprove || selfApproval || loading}
            onClick={() => setDialogMode("REJECT")}
            size="small"
          >
            驳回例外
          </Button>
        ) : null}
      </Space>
      <Modal
        confirmLoading={loading}
        destroyOnHidden
        okButtonProps={{ danger: dialogMode === "REJECT" }}
        okText={dialogMode === "REQUEST" ? "提交申请" : dialogMode === "APPROVE" ? "确认批准" : "确认驳回"}
        onCancel={() => {
          setDialogMode(null);
          setReason("");
        }}
        onOk={() => void submit()}
        open={dialogMode !== null}
        title={dialogTitle(dialogMode)}
      >
        <Input.TextArea
          maxLength={1000}
          onChange={(event) => setReason(event.target.value)}
          placeholder={dialogMode === "REQUEST" ? "说明无法及时补录或现场交付行驶证的原因" : "填写核验结论和审批意见"}
          rows={4}
          showCount
          value={reason}
        />
      </Modal>
    </>
  );
}

function approvalColor(status: string) {
  if (status === "APPROVED") return "green";
  if (status === "REJECTED") return "red";
  if (status === "PENDING") return "orange";
  return "default";
}

function approvalLabel(status: string) {
  const labels: Record<string, string> = {
    APPROVED: "已批准",
    EXPIRED: "已失效",
    PENDING: "待审批",
    REJECTED: "已驳回"
  };
  return labels[status] ?? status;
}

function dialogTitle(mode: DialogMode) {
  if (mode === "REQUEST") return "申请行驶证例外审批";
  if (mode === "APPROVE") return "批准行驶证例外";
  if (mode === "REJECT") return "驳回行驶证例外";
  return "行驶证例外审批";
}

function errorMessage(error: unknown) {
  return error instanceof Error ? error.message : "行驶证例外审批操作失败，请刷新后重试";
}
