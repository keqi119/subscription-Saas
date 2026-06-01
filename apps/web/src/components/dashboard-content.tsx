"use client";

import { Card, Col, Row, Statistic, Typography } from "antd";

const stageCards = [
  { title: "阶段", value: "1", suffix: "权限审计" },
  { title: "后台端口", value: "3000", suffix: "web" },
  { title: "API 端口", value: "3001", suffix: "api" },
  { title: "首期车辆规模", value: "500", suffix: "台" }
];

export function DashboardContent() {
  return (
    <>
      <Row gutter={[16, 16]}>
        {stageCards.map((item) => (
          <Col xs={24} sm={12} lg={6} key={item.title}>
            <Card>
              <Statistic
                formatter={() => item.value}
                suffix={item.suffix}
                title={item.title}
                value={item.value}
              />
            </Card>
          </Col>
        ))}
      </Row>
      <Card style={{ marginTop: 16 }} title="阶段 1 交付范围">
        <Typography.Paragraph>
          已进入账号密码登录、JWT Cookie、RBAC、菜单权限和审计日志阶段。
        </Typography.Paragraph>
      </Card>
    </>
  );
}
