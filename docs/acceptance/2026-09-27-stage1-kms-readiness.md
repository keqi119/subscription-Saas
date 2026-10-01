# 阶段 1 KMS 历史核查与方案否决记录

2026-09-27，账号 `1457643390906675`，地域 `cn-shanghai`。本记录只涵盖已有快照加密要求，不新增业务功能或验收门槛。

**当前决定：不采用商用 KMS。** 用户已明确拒绝该方案，并于本日再次纠正。此前将此事列为“等待 KMS 预算”不符合用户指令，现予撤销；不得继续询价、申请预算或采购。下列 KMS 资料仅保留为历史核查，不是待执行配置方案。此前操作均为只读查询，没有创建或购买 KMS 资源。

## 已核实状态

- CLI 原续期会话 `92228` 接受已显示的地域/语言默认值后自然退出 0；没有读取或打印凭据配置。
- 07:39:46 UTC，`sts GetCallerIdentity` 返回上述账号，`IdentityType=Account`，exit 0。
- 07:40:07 UTC，`kms ListAliases` 第 1 页、每页 100 条返回 `TotalCount=0`，所以固定 `alias/stage1-snapshot-custody` 当前不存在。
- 07:41:56 UTC，`kms ListKmsInstances` 同样返回 `TotalCount=0`，该账号上海区域没有可直接复用的实例。此结论不外推其他地域或账号。
- 09:00:13 UTC，续期后的同一 profile 再调用 `kms ListKeys`，第 1 页、每页 100 条返回 `TotalCount=0`、空 Key 列表及 exit 0；本次还排除了该地域可复用现存密钥的可能，不以别名或实例数量推断密钥清单。
- 尚未创建实例、密钥或别名，未调用 GenerateDataKey/Decrypt，未改变任何 RAM 权限。

非秘密 API 读回保存于候选工作区 `.superpowers/sdd/2026-09-22-stage1-r3-final-image-dual-chain-plan/cloud-kms-{alias-renewed,instances,keys}-readback.json`；续期记录为同目录 `cloud-oauth-refresh-pending.json`。

## 已否决路线对应的历史配置

现有 `release/contracts/snapshot-cloud-policy.v1.json` 和 producer crypto 合同要求不可导出的对称 KEK、固定别名、GenerateDataKey-only producer 与独立获准 Decrypt consumer。现有 H2 证据 writer/audit-reader 不能直接扩权代替这两个身份。

适配阿里云的配置为：同账号上海软件密钥管理实例、一个 `Aliyun_AES_256` / `ENCRYPT/DECRYPT` / `Origin=Aliyun_KMS` 密钥及上述别名；使用合同已固定的共享网关 `kms.cn-shanghai.aliyuncs.com`。不需要为了此项更换现有 endpoint schema 或建立跨账号网络平台。原生 CreateKey 的实例参数为 `DKMSInstanceId`，具体值须取实际启用实例。

官方说明默认密钥只用于云产品服务端加密，不能支持本方案的自建应用密码运算。软件实例支持共享公网网关，但密码运算公网开关需要在控制台开启，官方说明不支持 OpenAPI 开启。当前浏览器连接失败，尚不能代为操作该开关；CLI 续期成功不等于浏览器已恢复。

来源：[密钥类型](https://help.aliyun.com/zh/kms/key-management-service/user-guide/overview-of-key-management)、[共享网关集成](https://help.aliyun.com/zh/kms/key-management-service/user-guide/application-access)、[公网开关](https://help.aliyun.com/zh/kms/key-management-service/user-guide/access-keys-of-a-kms-instance-over-the-internet)。CreateKey 参数另已通过本地阿里云 CLI 3.5.1 的 API 帮助核对。

## 历史费用资料与当前执行边界

当时查询到的官方按量计费页标示软件实例 30 元/天、一个密钥版本 0.3 元/天，另加 QPS 等用量项；最低基数为 30.3 元/天，按 30 天计算 909 元，尚未计调用费用。按量页说明创建后即开始收费。包月页标示中国内地软件实例 2,499 元/月，通用 FAQ 与按量页面的支持描述不一致。这些历史公开价格不构成采购决定，也不再产生预算或下单待办。

来源：[按量计费](https://help.aliyun.com/zh/kms/key-management-service/pay-as-you-go)、[包月计费](https://help.aliyun.com/zh/kms/key-management-service/product-overview/kms-billing)、[计费 FAQ](https://help.aliyun.com/zh/kms/key-management-service/product-overview/faq-2)。

KMS 采购已从收口待办移除，不再等待预算答复。后续须按“不采用商用 KMS”的约束，核对如何复用现有 H1 加密目录、独立恢复副本和 OSS 保管设施，最小调整快照加解密接缝及其现有合同。现有源码中的 KMS 耦合尚未解除，不能将软件文件密钥宣称为硬件不可导出，也不能只改文档就宣布加密链通过。

非商用接缝仍须以实际 lawful snapshot 与候选冻结密钥绑定、run、source/build、输入使用授权及原件加密读回。这里的历史配置核查不代表 R3 或阶段 1 收口完成。
