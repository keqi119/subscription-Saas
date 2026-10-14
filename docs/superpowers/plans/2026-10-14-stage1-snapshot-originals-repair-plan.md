# Stage 1 snapshot 原件接口修复

本次仅补两条既有生产链：exporter → data-worker → data-proof 保留两次真实源指纹完整观察；final storageReadback → custody/completion 绑定 R3 规范摘要。现有签名、授权、owner 装配和 RC 不在本次修改范围。`SIGN_HISTORY` catalog blocker 由独立修复处理。

1. 在 exporter 的同一 MVCC snapshot 内保留 `before` 和 `after` 完整观察，继续要求 identity 一致，且证明真实先后次序。加密返回、worker `COMPLETE` 和 data-proof 严格字段表逐层传递两份观察；H1 data-result 的签名原件绑定 before。proof 校验各自 identity 与 metadata 摘要、时间顺序。真实两次观察可能在同一毫秒具有相同内容，不能仅因完整摘要相等而误拒；防止以 after 冒充 before 的根本约束是 exporter 对两个独立 source 读取的封闭赋值及端到端传递。既有通用 bundle/custody 摘要保持原契约，避免改变历史 restore 输入。
2. 复用 `readH1SnapshotStorageOriginals` 已产出的 `storageOriginals.storageReadback` 和 raw 原件。在最终 reader 的两处 completion 构造及首次 live 投影传入它；final custody 的 `authoritativeObservationDigest` 取 `sha256Canonical(storageReadback)`，验证引用 raw 的字节、摘要、owner/reader、对象键与现有 final readback 一致，不修改 provisional 或已封存产物。
3. 定向回归先 RED 后 GREEN：exporter before 原件，final custody 摘要，完整 completion 同签名数据及 storage 原件。完成源代码冻结前仅跑相关本地接口测试和语法/差异检查；不运行云端、数据库或 RC。

后续 owner 装配另组实施时，内容寻址 `archive/raw/<digest>.bin` 已存在可在独立核验字节、摘要、owner、权限和路径身份完全一致后**只读复用**，不发生写入；不一致即 STOP。phase 专属 index 或安装标记已存在则 STOP 对账，不能把任意 `EEXIST` 当作重新准备，也不覆盖、删除或自动重试。预建的 `archive/raw` 与 `inputs/snapshots` 父目录必须在会话前存在，避免本地新增目录项使持有的历史输入祖先 mtime/ctime 自失效。目标摘要只在目标创建后获取；短窗口内仅允许本地装配。
