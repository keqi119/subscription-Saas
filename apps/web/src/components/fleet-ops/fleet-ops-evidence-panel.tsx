"use client";

import { Card, List, Space, Tag, Typography } from "antd";

import type { FleetOpsEvidenceGroup } from "../../lib/fleet-ops-view-model";

export function FleetOpsEvidencePanel({ groups }: Readonly<{ groups: FleetOpsEvidenceGroup[] }>) {
  return (
    <Card title="证据与诊断信息">
      <List
        dataSource={groups}
        locale={{ emptyText: "暂无证据" }}
        renderItem={(group) => (
          <List.Item>
            <Space direction="vertical" size={8} style={{ width: "100%" }}>
              <Space>
                <Tag color="blue">{group.source}</Tag>
                <Typography.Text type="secondary">{group.items.length} 条证据</Typography.Text>
              </Space>
              <Space wrap>
                {group.items.map((item, index) => (
                  <Tag key={`${group.source}-${item.sourceId ?? index}-${item.evidenceType ?? "evidence"}`}>
                    {item.sourceId ?? item.evidenceType ?? item.layer ?? "evidence"}
                  </Tag>
                ))}
              </Space>
            </Space>
          </List.Item>
        )}
      />
    </Card>
  );
}
