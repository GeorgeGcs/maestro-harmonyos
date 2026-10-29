# 录屏诊断报告 v1

`scripts/collect-recording-diagnostics.mjs` 从一个既有 attempt 的原生 `result.json`、证据索引、清单和日志，生成独立的 `recording-diagnostics.json`。格式见 [Draft 2020-12 Schema](recording-diagnostics-v1.schema.json)。

```powershell
node scripts/collect-recording-diagnostics.mjs --result <attempt/result.json> --output-directory <新目录>
```

输出目录必须尚不存在且位于原 attempt 之外。CLI 输出报告路径与计数；退出码 0 表示报告 `complete`，1 表示 `incomplete` 或入口失败。输出目录建立后的输入错误尽量留下部分报告；无法建立输出或写文件时可能只有 stderr。原执行状态、`execution.error` 和 `execution.cleanup.errors` 原样保留，不因诊断结果改写。

`complete` 表示来源核验成功、至少一段属于该 attempt 的录屏诊断完整且没有诊断问题；它不表示 Flow 成功、视频可完整解码、采集内容正确或设备可交接。`videoValidation=not_performed`、`resourceHandoff=not_assessed` 始终明确区分这些工作。视频检查与释放核验分别使用[完整解码入口](../recording-diagnostics.md)和现有 v2 恢复/CI 核验入口。

## 来源与关联

原始 metadata、事件和绑定 JSON 均拒绝重复键（包括转义后的同名键）及尾随 token。清单每一条引用必须有合法 SHA256；result/index 的引用 hash 缺失或为 null 都会拒绝，不能用清单自身 hash 替代。

持久录屏出现 `resourceId` 时，去掉连字符后必须等于 `recordingId`；仅在一段内保持相同但归属不符的资源 ID 也会被拒绝。非持久录屏可不提供该字段。

collector 只读取已有源文件，不调用 HDC、恢复、启停或删除设备媒体，不改 source、gate、runResult 或原件。它拒绝链接及路径越界，只复制清单/索引具体引用且经过大小/hash 检查的文件，在新输出目录内建立排他的 `.verification/agent/runs/<runId>/<attemptId>` 临时快照。随后复用原 `verifyEvidence` 与 `confinedFile` 校验、解析快照。完成后按登记表逐个删除临时文件，再删除空目录；不递归删除目录树。清理失败记为问题，保留剩余诊断材料。

`sources.result/index/manifest` 与 `sourceFiles/logs` 保存原路径、字节数、初始 `sha256` 和复读得到的 `sha256After`；未能完成复读时后者为 null，初始 hash 不被覆盖。输入在身份验证前失败时，`run`、`execution` 及尚未取得的来源引用可以为 null。hash 与清单证明的是本次文件的一致性，不是外部真实性签名。

日志的 `HARMONYOS_RECORDING_DIAGNOSTIC` 事件只接受 producer 的固定 stage/result/fields 白名单；`MAESTRO_RECORDING_OUTPUT` 绑定将 context 与具体输出文件关联。报告把省略的 `resourceId` 归一为 null，每个事件均附 `sources`：日志相对路径、1 起始行号与 JSON payload 的 SHA256。相同身份且 JSON 字节相同的事件合并来源；冲突、序列缺口、耗时倒退、缺终态/数量不符、截断或丢事件使诊断不完整。时间是主机观察时间，不等于设备内部发生时间。

明确绑定在 attempt 外的 context 单独列为 `foreignContexts`，不计入当前录屏，不凭时间接近强行配对。一个 outputPath 被多个 context 绑定时，视频为 `ambiguous`，相关录屏和报告均不完整。提前启动失败的完整 `abort/failed` 轨迹，在尚未 copy/flush 成功且输出确实不存在时，可以同时为诊断 `complete`、`video.state=missing`；不能由缺少索引推断文件不存在。

`observations` 和 `stageDurations` 引用已有事件序号；`exportAttempts` 只汇总已观察的导出尝试。本 producer 未提供远端拉取后的 stat，因此 `remoteAfterBytes=null`、`remoteAfterObservation=not_observed`，不从本地长度或拉取前 stat 补造它。

每段必填的 `archiveObservations` 收集 `archive/observed` 事件的序号、attempt、归档字节数/hash 及 metadataUnavailable 标记；没有这些事件时为空数组。仅在视频唯一且已被证据索引和来源核验确认时，`indexedVideoMatch` 才比较观察到的归档大小/hash 与该视频，否则为 null。producer 未给出归档文件路径，collector 未独立读取该归档，故 `archiveFileVerification=not_performed`；匹配不能替代原归档文件核验，缺失归档元数据也不能补造。

## 限额与结构校验

默认上限：metadata 4 MiB、单文件 64 MiB、所有引用文件总计 256 MiB、单日志行 32 KiB、2048 文件、200000 行、20000 条诊断记录、128 个 context。导出的 `collectRecordingDiagnostics({ resultPath, outputDirectory, limits })` 允许按 `limits` 的同名字段降低上限，不能提高；CLI 使用默认值。metadata JSON 另限制嵌套深度 64、节点数 100000。超限保留可用的部分报告并返回不完整。

所有已定义对象均拒绝未知属性。事件 `fields` 的可选字段按实际 producer 保留；`execution` 中的原始 AgentError 使用既有 kind/code/message，`details` 是唯一开放的 opaque JSON 协议字段，根值为 null 或对象，对象值可包含任意 JSON 内容，其总量受原 metadata 字节与 JSON 深度/节点上限约束。collector 不解释或展开该字段，也不把原错误替换成诊断错误；采集/校验问题另列于 `issues`。

Schema 约束字段形态、枚举、单数组上限及 `complete` 的必要条件。跨字段 hash 相等、来源实际字节、路径归属、连续 seq、event/context/resource/video 的关联、created、最终 close/abort 及 expectedEventCount 核对、跨数组累计限额由 collector 核验；Schema 验证通过不能代替这些检查。
