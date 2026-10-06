# 阶段 1 候选静态门槛断言对齐

候选 `5680f2d04fcbe1fbadac7d19a9eec5cee69ce7d4` 的实际 RC 工作流
[`37445114935`](https://github.com/keqi119/subscription-Saas/actions/runs/37445114935)
在 `source-static` 失败：foundation 共 742 项，736 通过、5 失败、1 跳过；
后续 source/final 数据库作业均未启动。该失败记录保留，不作为成功验收证据。

本次只校准五个测试文件，未修改生产实现、工作流、数据库清单或迁移：

- batch A 的 billing suite 已含 payment-authority；断言补齐第二个文件，并检查其数据库上下文边界。
- batch B 已含 contract-archive suite，journey-integrity 已含 application-order-authority；保留九个独立数据库分配及完整文件集合检查。
- dispatch 只读模块已固定导入 `node:buffer` 和 `node:timers`；允许这两个本地模块，同时禁止动态导入，保留签名、进程及网络调用禁令。
- MS2 单帧和 stdin 仍限 1 MiB，stdout 自既有实现起限 2 MiB；1 MiB 后非法字符应拒绝为帧格式错误，而非输出超限。已有精确 2 MiB／多一字节测试继续验证真实上界。
- snapshot 工作流已采用 admission、data、custody 三作业；断言检查手动触发、受保护环境、动态 Runner 路由、data 无凭据输入，以及两个明确的公开 JSON 上传路径。

验证：五项原失败均已定向复现；修正后 batch A/B 4/4、dispatch 22/22、snapshot-export 28/28，MS2 三项相关容量／边界测试 3/3 通过。
`prisma:validate`、发布合同校验通过；合同仍为 320 文件、93 schemas、13 commands、128 migrations。
本机 `prisma migrate status` 因未配置 `datasource.url` 返回失败，未以此声明服务器迁移状态；本次没有业务代码或数据库修改。

合并后须对新的 source SHA 构建同一候选证据并重新进入 RC。
旧 build、RAM 批准、四份 H1 预留及失败工作流保留原始身份；不能把旧 SHA 的证据改名为新候选成功。
真实快照制作、R2/R3、两项 Staging 迁移和 R4 仍未完成。
