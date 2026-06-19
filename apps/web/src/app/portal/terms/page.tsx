import { Typography } from "antd";
import Link from "next/link";

const sections = [
  {
    title: "服务说明",
    body: "本页面为车辆订阅客户门户用户协议的待法务确认版本。平台为客户提供车辆浏览、订阅申请、材料上传、方案确认、合同签署、支付、账单、押金、权益、事故报案和救援申请等线上服务。"
  },
  {
    title: "账户与登录",
    body: "客户应使用本人手机号登录，并妥善保管验证码、登录设备和相关身份材料。任何通过客户账户提交的申请、确认、签署或支付操作，将作为客户本人操作处理。"
  },
  {
    title: "材料上传",
    body: "客户应确保上传材料真实、完整、清晰，并确认其有权提交相关个人信息、证件资料和业务证明。平台仅按订阅审核、合同、支付和履约服务需要使用这些材料。"
  },
  {
    title: "支付与合同",
    body: "客户在确认最终方案、签署合同或发起支付前，应仔细核对车辆、费用、押金、周期、权益和账单信息。具体权利义务以最终签署的合同及平台展示的账单为准。"
  },
  {
    title: "事故与救援",
    body: "事故报案和救援申请用于提交服务线索和处理进度，不代表保险理赔、维修、救援到达时间或费用结果的承诺。实际处理以平台客服、保险公司、救援供应商或合同约定为准。"
  }
];

export default function PortalTermsPage() {
  return (
    <main style={{ background: "#f6f8fb", minHeight: "100vh", padding: "28px 16px 48px" }}>
      <article style={{ margin: "0 auto", maxWidth: 760 }}>
        <Typography.Title level={2}>用户协议</Typography.Title>
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
