"use client";

import { Alert, App, Button, Card, Checkbox, Descriptions, Input, List, Space, Table, Tag, Typography } from "antd";
import { useState } from "react";

import { PORTAL_API_BASE_URL } from "../../lib/portal-api";
import {
  mockSignPortalReturnManifest,
  respondToPortalSubscriptionClosure,
  uploadPortalSubscriptionClosureDisputeEvidence
} from "../../lib/subscription-closure-api";
import type { CustomerSubscriptionClosureView } from "../../lib/subscription-closure-view-model";

export function PortalReturnSettlementPanel({
  closure,
  onChanged,
  onPay,
  orderId,
  paying
}: {
  closure: CustomerSubscriptionClosureView;
  onChanged: () => Promise<void> | void;
  onPay: (billIds: string[]) => Promise<void> | void;
  orderId: string;
  paying: boolean;
}) {
  const { message } = App.useApp();
  const [submitting, setSubmitting] = useState(false);
  const [signing, setSigning] = useState(false);
  const [selected, setSelected] = useState<string[]>([]);
  const [reasons, setReasons] = useState<Record<string, string>>({});
  const [proofFiles, setProofFiles] = useState<Record<string, File | null>>({});
  const canRespond = closure.allowedActions.includes("ACCEPT_SETTLEMENT") && closure.settlement;
  const activeChargeLines = closure.chargeLines.filter(
    (line) =>
      line.status === "FINAL" &&
      line.settlementRevisionId === closure.settlement?.pricingSettlementRevisionId
  );
  const undisputedBillIds = closure.payableBillIds;

  async function signReturnManifest() {
    const task = closure.returnManifestSigning;
    if (!task) return;
    if (!task.mock) {
      if (!task.signUrl) {
        void message.info("退车确认单签署链接尚未就绪，请稍后刷新。");
        return;
      }
      const target = new URL(task.signUrl, window.location.origin);
      if (target.protocol !== "https:" && target.hostname !== "localhost") {
        void message.error("电子签署链接无效，请联系客户支持。");
        return;
      }
      window.location.assign(target.toString());
      return;
    }
    setSigning(true);
    try {
      await mockSignPortalReturnManifest(orderId, task.taskId);
      void message.success("退车确认单已签署并归档。");
      await onChanged();
    } catch (error) {
      void message.error(error instanceof Error ? error.message : "无法完成退车确认单签署。");
    } finally {
      setSigning(false);
    }
  }

  async function respond(status: "ACCEPTED" | "PARTIALLY_DISPUTED" | "DISPUTED") {
    if (!closure.settlement) return;
    const disputedLineIds = status === "ACCEPTED" ? [] : selected;
    if (
      status !== "ACCEPTED" &&
      (disputedLineIds.length === 0 ||
        disputedLineIds.some(
          (chargeLineId) =>
            !reasons[chargeLineId]?.trim() || !proofFiles[chargeLineId]
        ))
    ) {
      void message.error("请勾选争议收费项，并逐项填写争议理由、上传证明文件。");
      return;
    }
    setSubmitting(true);
    try {
      const disputes = await Promise.all(
        disputedLineIds.map(async (chargeLineId) => {
          const uploaded = await uploadPortalSubscriptionClosureDisputeEvidence(orderId, {
            capturedAt: new Date().toISOString(),
            chargeLineId,
            file: proofFiles[chargeLineId]!,
            idempotencyKey: crypto.randomUUID()
          });
          return {
            chargeLineId,
            evidenceIds: [uploaded.evidenceId],
            reason: reasons[chargeLineId]!.trim()
          };
        })
      );
      await respondToPortalSubscriptionClosure(orderId, {
        disputes,
        idempotencyKey: crypto.randomUUID(),
        settlementHash: closure.settlement.resultHash,
        settlementRevisionId: closure.settlement.id,
        status
      });
      void message.success(status === "ACCEPTED" ? "最终结算方案已确认。" : "争议已提交，车辆回收流程不会因此中断。");
      await onChanged();
    } catch (error) {
      void message.error(error instanceof Error ? error.message : "无法提交结算反馈。");
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <Card title="退车、车况与结算确认">
      <Descriptions
        bordered
        column={1}
        items={[
          { label: "闭环编号", children: closure.caseNo },
          { label: "当前进度", children: closure.nextAction },
          { label: "运营状态", children: closure.status },
          { label: "财务状态", children: closure.financialStatus },
          {
            label: "最终方案",
            children: closure.settlement
              ? `应付 ${formatCents(closure.settlement.amountDueCents)}，应退 ${formatCents(closure.settlement.amountRefundableCents)}`
              : "尚未发布"
          }
        ]}
        size="small"
      />
      {closure.checklist?.attestationMode === "CUSTOMER_SIGNED" &&
      closure.returnManifestSigning &&
      closure.returnManifestSigning.taskStatus !== "COMPLETED" ? (
        <Alert
          action={
            <Button loading={signing} onClick={() => void signReturnManifest()} type="primary">
              签署退车确认单
            </Button>
          }
          description="完成签署归档后，平台才能确认车辆、钥匙、行驶证及随车附件已取回。"
          message="退车确认单待签署"
          showIcon
          style={{ marginTop: 14 }}
          type="warning"
        />
      ) : null}
      {closure.signedReferences.some((item) => item.documentType === "RETURN_MANIFEST") ? (
        <Alert
          action={
            <Typography.Link
              href={`${PORTAL_API_BASE_URL}/portal/orders/${orderId}/subscription-closure/return-manifest/signed-document/preview`}
              rel="noreferrer"
              target="_blank"
            >
              查看已签署退车确认单
            </Typography.Link>
          }
          message="退车确认单已签署并归档"
          showIcon
          style={{ marginTop: 14 }}
          type="success"
        />
      ) : null}
      {closure.checklist ? (
        <>
          <Typography.Title level={5}>现场退车确认清单（R{closure.checklist.revisionNumber}）</Typography.Title>
          <Table
            columns={[
              { dataIndex: "itemCode", title: "确认项目" },
              { dataIndex: "state", title: "退回状态" },
              { dataIndex: "returnedQuantity", title: "退回数量/里程" },
              { dataIndex: "remark", title: "现场备注" }
            ]}
            dataSource={closure.checklist.items}
            pagination={false}
            rowKey="id"
            size="small"
          />
          <List
            dataSource={closure.evidenceLinks.filter((link) => link.visibility === "CUSTOMER_VISIBLE")}
            header="现场证据"
            locale={{ emptyText: "暂无客户可见证据" }}
            renderItem={(item, index) => (
              <List.Item>
                <Typography.Link
                  href={`${PORTAL_API_BASE_URL}/portal/orders/${orderId}/subscription-closure/evidence/${item.id}/preview`}
                  rel="noreferrer"
                  target="_blank"
                >
                  查看现场证据 {index + 1}
                </Typography.Link>
              </List.Item>
            )}
          />
        </>
      ) : null}
      {closure.delta ? (
        <>
          <Typography.Title level={5}>交车/退车状态差异</Typography.Title>
          <Table
            columns={[
              { dataIndex: "itemCode", title: "项目" },
              { dataIndex: "wearClassification", title: "差异" },
              { dataIndex: "quantityDifference", title: "数量差" },
              { dataIndex: "responsibility", title: "责任方" },
              { dataIndex: "decisionReason", title: "判定依据" }
            ]}
            dataSource={closure.delta.items}
            pagination={false}
            rowKey="id"
            size="small"
          />
        </>
      ) : null}
      <Typography.Title level={5}>合同收费明细</Typography.Title>
      <Table
        columns={[
          {
            key: "select",
            render: (_, line) =>
              canRespond ? (
                <Checkbox
                  checked={selected.includes(line.id)}
                  onChange={(event) =>
                    setSelected((current) =>
                      event.target.checked
                        ? [...new Set([...current, line.id])]
                        : current.filter((id) => id !== line.id)
                    )
                  }
                />
              ) : null,
            title: "争议"
          },
          { dataIndex: "lineCode", title: "收费项" },
          { dataIndex: "quantity", title: "数量" },
          {
            dataIndex: "amountCents",
            render: (value: string) => formatCents(value),
            title: "金额"
          },
          {
            dataIndex: "clauseSnapshotId",
            render: (value: string | null) => {
              const clause = closure.contractChargeClauses.find((item) => item.id === value);
              return clause ? (
                <Space orientation="vertical" size={0}>
                  <Typography.Text code>{clause.clauseCode}</Typography.Text>
                  <Typography.Text type="secondary">
                    {clause.sourceTextLocator} · {clause.unit}
                  </Typography.Text>
                </Space>
              ) : (
                <Tag color="red">缺少条款</Tag>
              );
            },
            title: "合同条款快照"
          },
          {
            dataIndex: "unitPriceCents",
            render: (value: string) => formatCents(value),
            title: "合同单价"
          },
          {
            key: "reason",
            render: (_, line) =>
              selected.includes(line.id) ? (
                <Space orientation="vertical" style={{ width: "100%" }}>
                  <Input
                    onChange={(event) =>
                      setReasons((current) => ({ ...current, [line.id]: event.target.value }))
                    }
                    placeholder="逐项填写争议理由"
                    value={reasons[line.id]}
                  />
                  <input
                    accept="image/jpeg,image/png,image/webp,application/pdf,video/mp4"
                    aria-label={`${line.lineCode} 争议证明`}
                    onChange={(event) =>
                      setProofFiles((current) => ({
                        ...current,
                        [line.id]: event.target.files?.[0] ?? null
                      }))
                    }
                    type="file"
                  />
                </Space>
              ) : null,
            title: "争议理由与证明"
          }
        ]}
        dataSource={activeChargeLines}
        locale={{ emptyText: "当前没有客户收费项" }}
        pagination={false}
        rowKey="id"
        size="small"
      />
      {canRespond ? (
        <Space style={{ marginTop: 14 }} wrap>
          <Button loading={submitting} onClick={() => void respond("ACCEPTED")} type="primary">
            确认同意最终方案
          </Button>
          <Button
            danger
            loading={submitting}
            onClick={() =>
              void respond(
                selected.length === activeChargeLines.length
                  ? "DISPUTED"
                  : "PARTIALLY_DISPUTED"
              )
            }
          >
            提交逐项争议
          </Button>
        </Space>
      ) : closure.customerResponse ? (
        <Alert
          message={`您的反馈已记录：${closure.customerResponse.status}`}
          showIcon
          style={{ marginTop: 14 }}
          type="success"
        />
      ) : null}
      {closure.disputes.length > 0 ? (
        <List
          dataSource={closure.disputes}
          header="争议处理进度"
          renderItem={(dispute) => (
            <List.Item>
              <Space wrap>
                <Typography.Text>{dispute.customerReason}</Typography.Text>
                <Tag color={dispute.status === "OPEN" ? "orange" : "blue"}>
                  {disputeStatusLabel(dispute.status)}
                </Tag>
              </Space>
            </List.Item>
          )}
          style={{ marginTop: 14 }}
        />
      ) : null}
      {closure.allowedActions.includes("PAY_UNDISPUTED_BILLS") ? (
        <Button
          disabled={undisputedBillIds.length === 0}
          loading={paying}
          onClick={() => void onPay(undisputedBillIds)}
          style={{ marginTop: 14 }}
          type="primary"
        >
          支付无争议账单
        </Button>
      ) : null}
    </Card>
  );
}

function formatCents(value: string) {
  if (!/^-?\d+$/.test(value)) return "-";
  return `¥${(Number(value) / 100).toFixed(2)}`;
}

function disputeStatusLabel(status: string) {
  return (
    {
      ACCEPTED_BY_PLATFORM: "平台已接受，等待生成后继结算方案",
      OPEN: "平台处理中",
      REJECTED_BY_PLATFORM: "平台未接受，原账单继续有效"
    } as Record<string, string>
  )[status] ?? status;
}
