# 协议与磁盘文件格式

外部 agent 消息、运行证据和设备恢复文件分别版本化。新增磁盘文件不向 agent v1 增加字段。

| 数据 | Schema | 说明 |
| --- | --- | --- |
| agent 消息 | [v1](agent-v1.schema.json)、[v2](agent-v2.schema.json) | [调用协议](../agent-protocol.md)，v2 需要显式协商 |
| retry JSONL 每条事件 | [v1](retry-trace-v1.schema.json) | 实际步骤、源码和尝试上下文 |
| retry 摘要 | [v1](retry-summary-v1.schema.json) | 完整性、首次通过与追踪文件引用 |
| 用户输入的验证计划 | [v1](validation-plan-input-v1.schema.json) | 冻结前的计划输入 |
| 已冻结验证计划 | [v1](validation-plan-v1.schema.json) | 工具记录的源码、配置和批次 |
| 验证汇总 | [v1](validation-summary-v1.schema.json) | 每个运行槽位、原始状态、首次/最终计数和资格判断 |
| 人工复核输入 | [v1](validation-review-v1.schema.json) | 人工介入与解码报告引用；见[验证计划](../validation-plan.md) |
| 录屏资源登记与快照 | [v1](recording-resources-v1.schema.json) | [资源身份、阶段与原件](recording-resources.md) |
| 内部恢复凭据 | [v1/v2](recovery-receipt.schema.json) | v2 增加不可变录屏资源快照引用 |
| 完整解码报告 | [v1](recording-verification-v1.schema.json) | [解码命令与检查范围](../recording-diagnostics.md) |

以上采用 JSON Schema 2020-12，检查 JSON 结构和局部约束。JSONL 应逐行检查。跨文件身份、文件哈希、事件顺序、重复 ID、步骤覆盖、计数及设备清理状态仍由运行验证器核验；Schema 通过不能直接作为运行成功或设备可接管的依据。读取器还应拒绝重复 JSON 键、尾随内容和超出读取预算的文件。

重试事件、源码关联、冻结计划与人工审核字段见 [Retry 与验证计划协议](retry-and-validation.md)；录屏身份、阶段和内部凭据见[录屏资源格式](recording-resources.md)。

runner 控制记录、矩阵指针及控制索引是脚本间的内部接口，目前由 [CI 验证器](../../scripts/ci/verify-state.mjs) 和[验证计划入口](../../scripts/validation/main.mjs) 检查，不承诺独立的对外兼容接口。
