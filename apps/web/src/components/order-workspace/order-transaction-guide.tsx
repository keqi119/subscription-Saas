import {
  AuditOutlined,
  BellOutlined,
  FileAddOutlined,
  FormOutlined,
  MinusCircleOutlined,
  PayCircleOutlined,
  PlayCircleOutlined,
  RedoOutlined,
  RightOutlined,
  RollbackOutlined,
  StopOutlined,
  SyncOutlined,
  ThunderboltOutlined,
  ToolOutlined,
  UserAddOutlined
} from "@ant-design/icons";
import { Badge, Button, Flex, Tag, Tooltip, Typography } from "antd";
import dayjs from "dayjs";
import type { ReactNode } from "react";

import {
  getWorkspaceActionPresentation,
  getWorkspaceStatePresentation,
  type OrderWorkspaceState,
  type OrderWorkspaceTabKey
} from "../../lib/admin-order-workspace";

export type OrderTransactionGuideCategory = Exclude<OrderWorkspaceTabKey, "overview">;

export interface OrderTransactionGuideItem {
  actionCode: string | null;
  additionalCount: number;
  blocking: boolean;
  category: OrderTransactionGuideCategory;
  priority: number;
  reasonCode: string;
  state: OrderWorkspaceState;
  targetRecordId: string | null;
  targetTab: OrderTransactionGuideCategory;
  updatedAt: string | null;
}

export interface OrderTransactionGuideTarget {
  actionCode: string;
  targetRecordId: string | null;
  targetTab: OrderTransactionGuideCategory;
}

export interface OrderTransactionGuideSummary {
  asOf: string;
  guidance: readonly OrderTransactionGuideItem[];
  primaryAction: OrderTransactionGuideTarget | null;
}

export interface OrderTransactionGuideNavigation {
  focus?: string;
  tab: OrderTransactionGuideCategory;
}

export interface OrderTransactionGuideProps {
  onNavigate: (target: OrderTransactionGuideNavigation) => void;
  summary: OrderTransactionGuideSummary;
}

const CATEGORY_LABELS = {
  contract: "主合同及订阅套餐",
  handover: "车辆交接",
  entitlement: "订阅权益",
  service: "用车中事务",
  finance: "财务/收款核销",
  change: "变更/历史快照"
} satisfies Record<OrderTransactionGuideCategory, string>;

const CATEGORY_ORDER: readonly OrderTransactionGuideCategory[] = [
  "contract",
  "handover",
  "entitlement",
  "service",
  "finance",
  "change"
];

const ACTION_ICONS: Readonly<Record<string, ReactNode>> = {
  AuditOutlined: <AuditOutlined />,
  BellOutlined: <BellOutlined />,
  FileAddOutlined: <FileAddOutlined />,
  FormOutlined: <FormOutlined />,
  MinusCircleOutlined: <MinusCircleOutlined />,
  PayCircleOutlined: <PayCircleOutlined />,
  PlayCircleOutlined: <PlayCircleOutlined />,
  RedoOutlined: <RedoOutlined />,
  RollbackOutlined: <RollbackOutlined />,
  SyncOutlined: <SyncOutlined />,
  ThunderboltOutlined: <ThunderboltOutlined />,
  ToolOutlined: <ToolOutlined />,
  UserAddOutlined: <UserAddOutlined />
};

export function OrderTransactionGuide({
  onNavigate,
  summary
}: Readonly<OrderTransactionGuideProps>) {
  const itemsByCategory = new Map(summary.guidance.map((item) => [item.category, item]));
  const orderedItems = CATEGORY_ORDER.flatMap((category) => {
    const item = itemsByCategory.get(category);
    return item ? [item] : [];
  });
  const primaryGuideItem = summary.primaryAction
    ? orderedItems.find((item) => isPrimaryGuideItem(item, summary.primaryAction))
    : undefined;
  const deferredPrimaryAction =
    summary.primaryAction && !primaryGuideItem ? summary.primaryAction : null;

  return (
    <section aria-label="订单推进指引" data-workspace-guide="true">
      <Flex align="center" gap={8} justify="space-between" style={{ padding: "6px 0" }} wrap>
        <Flex align="center" gap={8}>
          <Typography.Text strong>当前推进</Typography.Text>
          {deferredPrimaryAction
            ? renderGuideAction({
                actionCode: deferredPrimaryAction.actionCode,
                kind: "primary",
                onClick: () =>
                  onNavigate(toGuideNavigation(deferredPrimaryAction))
              })
            : null}
          {summary.primaryAction === null ? (
            <Typography.Text type="secondary">
              当前无待处理动作，订单履约运行正常
            </Typography.Text>
          ) : null}
        </Flex>
        <Typography.Text style={{ fontSize: 12 }} type="secondary">
          更新于 {formatGuideTime(summary.asOf)}
        </Typography.Text>
      </Flex>

      <div
        style={{
          borderBlock: "1px solid #f0f0f0",
          overflowX: "auto",
          scrollbarGutter: "stable"
        }}
      >
        <div
          style={{
            display: "grid",
            gridTemplateColumns: "repeat(6, minmax(168px, 1fr))",
            minWidth: 1080
          }}
        >
          {orderedItems.map((item, index) => (
            <GuideItem
              isPrimary={isPrimaryGuideItem(item, summary.primaryAction)}
              item={item}
              key={item.category}
              onNavigate={onNavigate}
              primaryAction={
                isPrimaryGuideItem(item, summary.primaryAction)
                  ? summary.primaryAction
                  : null
              }
              showDivider={index > 0}
            />
          ))}
        </div>
      </div>
    </section>
  );
}

function GuideItem({
  isPrimary,
  item,
  onNavigate,
  primaryAction,
  showDivider
}: Readonly<{
  isPrimary: boolean;
  item: OrderTransactionGuideItem;
  onNavigate: (target: OrderTransactionGuideNavigation) => void;
  primaryAction: OrderTransactionGuideTarget | null;
  showDivider: boolean;
}>) {
  const categoryLabel = CATEGORY_LABELS[item.category];
  const state = getWorkspaceStatePresentation(item.state);
  const actionCode = primaryAction?.actionCode ?? item.actionCode;
  const navigationTarget = primaryAction
    ? toGuideNavigation(primaryAction)
    : toGuideNavigation(item);

  return (
    <article
      data-workspace-additional-count={item.additionalCount}
      data-workspace-guide-category={item.category}
      style={{
        borderInlineStart: showDivider ? "1px solid #f0f0f0" : undefined,
        minHeight: 126,
        padding: "9px 10px"
      }}
    >
      <Flex gap={7} style={{ height: "100%" }} vertical>
        <Flex align="center" gap={6} justify="space-between">
          <Badge count={item.additionalCount} overflowCount={99} size="small">
            <Typography.Text strong={isPrimary}>{categoryLabel}</Typography.Text>
          </Badge>
          {item.blocking ? (
            <Tag bordered={false} color="red">
              阻塞
            </Tag>
          ) : null}
        </Flex>

        <Badge color={state.color === "default" ? "#bfbfbf" : state.color} text={state.label} />
        <Typography.Text style={{ fontSize: 12 }} type="secondary">
          {formatGuideTime(item.updatedAt)}
        </Typography.Text>

        <Flex align="center" gap={4} style={{ marginTop: "auto" }}>
          {actionCode
            ? renderGuideAction({
                actionCode,
                kind: isPrimary ? "primary" : "secondary",
                onClick: () => onNavigate(navigationTarget)
              })
            : null}
          <Tooltip title={`进入${categoryLabel}`}>
            <Button
              aria-label={`进入${categoryLabel}`}
              data-workspace-navigation={item.targetTab}
              icon={<RightOutlined />}
              onClick={() => onNavigate(navigationTarget)}
              size="small"
              type="text"
            />
          </Tooltip>
        </Flex>
      </Flex>
    </article>
  );
}

function renderGuideAction({
  actionCode,
  kind,
  onClick
}: Readonly<{
  actionCode: string;
  kind: "primary" | "secondary";
  onClick: () => void;
}>) {
  const action = getWorkspaceActionPresentation(actionCode);

  if (!action) {
    return (
      <Tooltip key={actionCode} title="未知动作不可执行">
        <Button
          data-workspace-action-code={actionCode}
          data-workspace-action-kind="unavailable"
          disabled
          icon={<StopOutlined />}
          size="small"
        >
          动作不可用
        </Button>
      </Tooltip>
    );
  }

  return (
    <Button
      data-workspace-action-code={actionCode}
      data-workspace-action-kind={kind}
      icon={ACTION_ICONS[action.icon] ?? <RightOutlined />}
      key={actionCode}
      onClick={onClick}
      size="small"
      type={kind === "primary" ? "primary" : "default"}
    >
      {action.label}
    </Button>
  );
}

function formatGuideTime(value: string | null) {
  if (!value) {
    return "时间未知";
  }

  const time = dayjs(value);
  return time.isValid() ? time.format("YYYY-MM-DD HH:mm") : "时间未知";
}

function isPrimaryGuideItem(
  item: OrderTransactionGuideItem,
  primaryAction: OrderTransactionGuideTarget | null
) {
  return Boolean(
    primaryAction &&
      primaryAction.actionCode === item.actionCode &&
      primaryAction.targetTab === item.targetTab &&
      primaryAction.targetRecordId === item.targetRecordId
  );
}

function toGuideNavigation(
  target: Pick<OrderTransactionGuideTarget, "targetRecordId" | "targetTab">
): OrderTransactionGuideNavigation {
  return {
    ...(target.targetRecordId ? { focus: target.targetRecordId } : {}),
    tab: target.targetTab
  };
}
