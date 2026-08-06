"use client";

import { Alert, Button, Skeleton } from "antd";
import { useCallback, useEffect, useRef, useState } from "react";

import {
  getPortalJourneyByApplication,
  getPortalJourneyByOrder,
  PortalApiError
} from "../../lib/portal-api";
import {
  PortalSubscriptionJourney,
  toPortalJourneyCardModel
} from "../../lib/portal-journey-view-model";

interface PortalJourneyNextActionCardProps {
  applicationId?: string;
  initialJourney?: PortalSubscriptionJourney;
  orderId?: string;
}

export function PortalJourneyNextActionCard({
  applicationId,
  initialJourney,
  orderId
}: PortalJourneyNextActionCardProps) {
  const [journey, setJourney] = useState(initialJourney);
  const [loading, setLoading] = useState(!initialJourney);
  const [failed, setFailed] = useState(false);
  const pollCountRef = useRef(0);

  const load = useCallback(async (showLoading = false) => {
    if (!applicationId && !orderId) return;
    if (showLoading) setLoading(true);
    try {
      const next = applicationId
        ? await getPortalJourneyByApplication(applicationId)
        : await getPortalJourneyByOrder(orderId!);
      setJourney(next);
      setFailed(false);
    } catch (error) {
      if (error instanceof PortalApiError && error.status === 404) {
        setJourney(undefined);
        setFailed(false);
      } else {
        setFailed(true);
      }
    } finally {
      if (showLoading) setLoading(false);
    }
  }, [applicationId, orderId]);

  useEffect(() => {
    if (!initialJourney) void load(true);
  }, [initialJourney, load]);

  useEffect(() => {
    pollCountRef.current = 0;
  }, [applicationId, orderId]);

  useEffect(() => {
    if (!journey?.polling.enabled) return;
    let timer: ReturnType<typeof setTimeout> | undefined;
    let stopped = false;

    const poll = async () => {
      if (stopped) return;
      if (document.visibilityState !== "visible") {
        timer = setTimeout(poll, journey.polling.intervalMs);
        return;
      }
      if (pollCountRef.current >= journey.polling.maxAttempts) return;
      pollCountRef.current += 1;
      await load();
      if (!stopped && pollCountRef.current < journey.polling.maxAttempts) {
        timer = setTimeout(poll, journey.polling.intervalMs);
      }
    };

    timer = setTimeout(poll, journey.polling.intervalMs);
    return () => {
      stopped = true;
      if (timer) clearTimeout(timer);
    };
  }, [journey?.polling.enabled, journey?.polling.intervalMs, journey?.polling.maxAttempts, load]);

  if (loading) {
    return <Skeleton active paragraph={{ rows: 1 }} style={{ marginBottom: 16 }} />;
  }
  if (!journey && !failed) return null;
  if (failed) {
    return (
      <Alert
        action={<Button onClick={() => void load(true)} size="small">重试</Button>}
        message="暂时无法获取订阅流程"
        showIcon
        style={{ marginBottom: 16 }}
        type="warning"
      />
    );
  }

  const model = toPortalJourneyCardModel(journey!);
  return (
    <Alert
      action={model.action ? (
        <Button href={model.action.href} size="small" type="primary">
          {model.action.label}
        </Button>
      ) : undefined}
      data-testid="portal-journey-next-action"
      description={model.description}
      message={model.title}
      showIcon
      style={{ marginBottom: 16 }}
      type={model.tone}
    />
  );
}
