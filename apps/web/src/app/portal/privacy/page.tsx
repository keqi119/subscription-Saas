import { Typography } from "antd";
import Link from "next/link";

const sections = [
  {
    title: "个人信息收集使用说明",
    body: "本页面为隐私政策的待法务确认版本。为提供客户门户服务，平台可能收集手机号、姓名、身份材料、联系方式、订阅申请、合同、支付、账单、押金、权益、事故报案、救援申请和通知读取状态等信息。"
  },
  {
    title: "车辆订阅服务信息",
    body: "平台会根据客户提交的申请和材料处理车辆订阅审核、最终方案确认、合同签署、账单支付、权益履约和售后服务。相关信息仅用于业务办理、风控审核、合同履约、客服支持和法定留存。"
  },
  {
    title: "文件与材料",
    body: "客户上传的材料文件通过受控接口访问。平台不会在客户门户响应中暴露 OSS bucket、object key、内部存储路径或不必要的公开下载地址。"
  },
  {
    title: "支付信息",
    body: "支付由受控支付渠道处理。客户门户展示支付订单、账单、核销和回调状态的必要摘要，不展示平台内部密钥、证书、回调验签材料或完整支付供应商凭据。"
  },
  {
    title: "通知与微信服务号",
    body: "站内通知用于展示申请、合同、支付、账单和服务工单进度。微信模板消息真实联调仍处于 Pending，待微信普通模板消息能力审核通过后再启用单 openid 验证。"
  }
];

export default function PortalPrivacyPage() {
  return (
    <main style={{ background: "#f6f8fb", minHeight: "100vh", padding: "28px 16px 48px" }}>
      <article style={{ margin: "0 auto", maxWidth: 760 }}>
        <Typography.Title level={2}>隐私政策</Typography.Title>
        <Typography.Paragraph type="secondary">
          待法务确认版本。上线前请替换为正式文本。
        </Typography.Paragraph>
        {sections.map((section) => (
          <section key={section.title} style={{ marginTop: 24 }}>
            <Typography.Title level={4}>{section.title}</Typography.Title>
            <Typography.Paragraph>{section.body}</Typography.Paragraph>
          </section>
        ))}
        <Typography.Paragraph style={{ marginTop: 32 }}>
          <Link href="/portal/login">返回登录</Link>
        </Typography.Paragraph>
      </article>
    </main>
  );
}
