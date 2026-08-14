"use client";

import { LogoutOutlined, RightOutlined, UnorderedListOutlined } from "@ant-design/icons";
import { Alert, App, Button, Empty, Flex, Spin, Tabs, Tag, Typography } from "antd";
import { useRouter } from "next/navigation";
import { useCallback, useEffect, useState } from "react";

import { FieldVideoUploadRecoveryAlert } from "../../../../components/field-video-upload-recovery-alert";
import {
  getFieldHandoverSession,
  isFieldHandoverUnauthorized,
  listFieldHandoverWorkOrders,
  logoutFieldHandover,
  type FieldHandoverSession,
  type FieldHandoverWorkOrderListItem
} from "../../../../lib/field-handover-api";
import { buildFieldHandoverTaskCard } from "../../../../lib/field-handover-view-model";
import { listActiveFieldVideoUploadSessions } from "../../../../lib/field-video-upload-api";
import {
  listFieldVideoRecoveries,
  synchronizeFieldVideoRecoveryPrompts,
  type FieldVideoUploadRecoveryPrompt
} from "../../../../lib/field-video-upload-recovery";

export default function FieldHandoverTasksPage() {
  const router = useRouter();
  const { message } = App.useApp();
  const [errorMessage, setErrorMessage] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [recoveries, setRecoveries] = useState<FieldVideoUploadRecoveryPrompt[]>([]);
  const [session, setSession] = useState<FieldHandoverSession | null>(null);
  const [tasks, setTasks] = useState<FieldHandoverWorkOrderListItem[]>([]);

  const loadTasks = useCallback(async () => {
    try {
      setLoading(true);
      setErrorMessage(null);
      const currentSession = await getFieldHandoverSession();
      setSession(currentSession);
      const [nextTasks, activeUploads] = await Promise.all([
        listFieldHandoverWorkOrders(),
        listActiveFieldVideoUploadSessions().catch((error) => {
          if (isFieldHandoverUnauthorized(error)) {
            throw error;
          }
          return null;
        })
      ]);
      setTasks(nextTasks);
      setRecoveries(
        activeUploads
          ? synchronizeFieldVideoRecoveryPrompts(activeUploads)
          : listFieldVideoRecoveries()
      );
    } catch (error) {
      if (isFieldHandoverUnauthorized(error)) {
        router.replace("/field/handover");
        return;
      }
      setErrorMessage("任务加载失败，请稍后重试");
    } finally {
      setLoading(false);
    }
  }, [router]);

  useEffect(() => {
    void loadTasks();
  }, [loadTasks]);

  async function logout() {
    try {
      await logoutFieldHandover();
    } catch {
      void message.warning("登录状态已结束，请重新登录");
    } finally {
      router.replace("/field/handover");
    }
  }

  const taskViews = tasks.map((task) => ({
    card: buildFieldHandoverTaskCard(task),
    task
  }));
  const activeTasks = taskViews.filter(({ card }) => card.taskGroup === "ACTIVE");
  const endedTasks = taskViews.filter(({ card }) => card.taskGroup === "ENDED");

  function renderTaskGroup(items: typeof taskViews, emptyDescription: string) {
    if (items.length === 0) {
      return (
        <Empty
          description={emptyDescription}
          style={{ background: "#fff", borderRadius: 8, padding: "36px 12px" }}
        />
      );
    }

    return (
      <Flex gap={12} vertical>
        {items.map(({ card, task }) => (
          <article
            key={card.id}
            style={{
              background: "#fff",
              border: "1px solid #dde5f0",
              borderRadius: 8,
              boxShadow: "0 8px 22px rgba(31, 71, 112, 0.06)",
              padding: 16
            }}
          >
            <Flex align="flex-start" justify="space-between" style={{ gap: 12 }}>
              <div>
                <Typography.Text strong style={{ display: "block", fontSize: 16 }}>
                  {card.title}
                </Typography.Text>
                <Typography.Text style={{ color: "#607086" }}>
                  {card.handoverTypeLabel}
                </Typography.Text>
              </div>
              <Tag color={card.statusColor} style={{ marginInlineEnd: 0 }}>
                {card.statusLabel}
              </Tag>
            </Flex>

            <Flex gap={8} style={{ color: "#374151", marginTop: 12 }} vertical>
              <InfoRow label="预约时间" value={card.scheduledAtText} />
              <InfoRow label="交接地点" value={card.deliveryLocationText} />
              <InfoRow label="车辆" value={card.vehicleText} />
              <InfoRow label="车牌" value={card.plateText} />
              <InfoRow label="VIN" value={card.vinText} />
              <InfoRow label="客户" value={card.customerText} />
              <InfoRow label="资料" value={card.evidenceText} />
            </Flex>

            <Button
              block
              icon={<RightOutlined />}
              iconPosition="end"
              onClick={() => router.push(`/field/handover/tasks/${task.id}`)}
              size="large"
              style={{ marginTop: 14 }}
              type={card.taskGroup === "ACTIVE" ? "primary" : "default"}
            >
              查看任务
            </Button>
          </article>
        ))}
      </Flex>
    );
  }

  return (
    <main
      style={{
        background: "#f5f8fc",
        minHeight: "100vh",
        padding: "max(22px, env(safe-area-inset-top)) 16px max(24px, env(safe-area-inset-bottom))"
      }}
    >
      <section style={{ margin: "0 auto", maxWidth: 520 }}>
        <Flex align="flex-start" justify="space-between" style={{ gap: 12, marginBottom: 18 }}>
          <div>
            <Typography.Title level={2} style={{ fontSize: 24, lineHeight: 1.2, margin: 0 }}>
              我的交接任务
            </Typography.Title>
            <Typography.Text style={{ color: "#5c6878" }}>
              {session?.phoneMasked ? `当前手机号 ${session.phoneMasked}` : "外部交接人员"}
            </Typography.Text>
          </div>
          <Button aria-label="退出登录" icon={<LogoutOutlined />} onClick={logout}>
            退出
          </Button>
        </Flex>

        <div style={{ marginBottom: recoveries.length > 0 ? 14 : 0 }}>
          <FieldVideoUploadRecoveryAlert records={recoveries} />
        </div>

        {loading ? (
          <Flex align="center" gap={10} justify="center" style={{ minHeight: 220 }}>
            <Spin />
            <Typography.Text>正在加载交接任务...</Typography.Text>
          </Flex>
        ) : null}

        {!loading && errorMessage ? (
          <Alert
            action={
              <Button onClick={() => void loadTasks()} size="small">
                重新加载
              </Button>
            }
            message={errorMessage}
            showIcon
            style={{ marginBottom: 14 }}
            type="error"
          />
        ) : null}

        {!loading && !errorMessage ? (
          <Flex align="center" justify="space-between" style={{ marginBottom: 12 }}>
            <Typography.Text style={{ color: "#5c6878" }}>
              共 {session?.taskCount ?? tasks.length} 个任务
            </Typography.Text>
            <Button icon={<UnorderedListOutlined />} onClick={() => void loadTasks()}>
              刷新
            </Button>
          </Flex>
        ) : null}

        {!loading && !errorMessage && tasks.length === 0 ? (
          <Empty
            description={
              <span>
                暂无待处理交接任务
                <br />
                请确认手机号是否由工作人员分配，或联系工作人员
              </span>
            }
            style={{ background: "#fff", borderRadius: 8, padding: "44px 12px" }}
          />
        ) : null}

        {!loading && !errorMessage && tasks.length > 0 ? (
          <Tabs
            defaultActiveKey="active"
            items={[
              {
                children: renderTaskGroup(activeTasks, "暂无活动中任务"),
                key: "active",
                label: `活动中 (${activeTasks.length})`
              },
              {
                children: renderTaskGroup(endedTasks, "暂无已结束任务"),
                key: "ended",
                label: `已结束 (${endedTasks.length})`
              }
            ]}
          />
        ) : null}
      </section>
    </main>
  );
}

function InfoRow({ label, value }: { label: string; value: string }) {
  return (
    <Flex justify="space-between" style={{ gap: 12 }}>
      <Typography.Text style={{ color: "#718096", flex: "0 0 76px" }}>{label}</Typography.Text>
      <Typography.Text style={{ flex: 1, textAlign: "right", wordBreak: "break-word" }}>
        {value}
      </Typography.Text>
    </Flex>
  );
}
