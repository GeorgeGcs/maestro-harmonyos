# 协议与磁盘文件格式

外部 agent 消息、运行证据和设备恢复文件分别版本化。新增磁盘文件不向 agent v1 增加字段。

| 数据 | Schema | 说明 |
| --- | --- | --- |
| agent 消息 | [v1](agent-v1.schema.json)、[v2](agent-v2.schema.json) | [调用协议](../agent-protocol.md)，v2 需要显式协商 |
| retry JSONL 每条事件 | 当前 [v2](retry-trace-v2.schema.json)，旧 [v1](retry-trace-v1.schema.json) | 实际步骤、登记的源码身份和尝试上下文 |
| retry 摘要 | 当前 [v2](retry-summary-v2.schema.json)，旧 [v1](retry-summary-v1.schema.json) | 完整性、首次通过与同版本追踪文件引用 |
| 用户输入的验证计划 | 当前 [v2](validation-plan-input-v2.schema.json)，旧 [v1](validation-plan-input-v1.schema.json) | v2 增加应用版本和准备凭据；旧 v1 仅接受新建 development 计划 |
| 已冻结验证计划 | 当前 [v3](validation-plan-v3.schema.json)，旧 [v2](validation-plan-v2.schema.json)、[v1](validation-plan-v1.schema.json) | 源码、静态依赖检查、配置、实际运行环境、准备凭据和批次 |
| 验证汇总 | 当前 [v3](validation-summary-v3.schema.json)，旧 [v2](validation-summary-v2.schema.json)、[v1](validation-summary-v1.schema.json) | 原始计数、逐槽核验、统计达标与正式资格分别记录 |
| 人工复核输入 | 当前 [v2](validation-review-v2.schema.json)，旧 [v1](validation-review-v1.schema.json) | v2 增加逐槽安装和准备状态确认；见[验证计划](../validation-plan.md) |
| 录屏资源登记与快照 | [v1](recording-resources-v1.schema.json) | [资源身份、阶段与原件](recording-resources.md) |
| 内部恢复凭据 | [v1/v2](recovery-receipt.schema.json) | v2 增加不可变录屏资源快照引用 |
| 依次重启维护凭据 | [v3](maintenance-receipt-v3.schema.json) | 独立维护分支；原执行结果保持 unknown |
| 依次重启维护响应 | [v1](maintenance-response-v1.schema.json) | prepare/resume/complete 的成功命令响应；见[维护格式](maintenance.md) |
| 清理隔离恢复回执 | [v4](cleanup-fence-receipt-v4.schema.json) | 保留阻挡目录，原命令仍未确认；见[清理隔离格式](cleanup-fence.md) |
| 清理隔离 CLI 响应 | [v1](cleanup-fence-response-v1.schema.json) | 已隔离与阻塞响应；与 agent v1/v2 分别版本化 |
| 完整解码报告 | [v1](recording-verification-v1.schema.json) | [解码命令与检查范围](../recording-diagnostics.md) |
| 录屏阶段诊断 | [v1](recording-diagnostics-v1.schema.json) | [来源、事件与视频关联](recording-diagnostics.md) |

以上采用 JSON Schema 2020-12，检查 JSON 结构和局部约束。JSONL 应逐行检查。跨文件身份、文件哈希、事件顺序、重复 ID、步骤覆盖、计数及设备清理状态仍由运行验证器核验；Schema 通过不能直接作为运行成功或设备可接管的依据。读取器还应拒绝重复 JSON 键、尾随内容和超出读取预算的文件。

重试事件、源码关联、冻结计划与人工审核字段见 [Retry 与验证计划协议](retry-and-validation.md)；录屏身份、阶段和内部凭据见[录屏资源格式](recording-resources.md)。

retry v2 的 `sourceIdentity` 区分内容相同的不同来源文件。旧 v1 仍可读取，但只有内容哈希能唯一对应本次登记来源时，才可证明必测覆盖；v2 的源码步骤缺少身份时不会回退猜测。这次版本变化不修改 agent 消息、证据索引或旧产物。

新冻结计划和汇总独立采用 v3；开发输入仍接受 v1/v2，正式输入仍要求 v2。冻结时通过实际 Maestro YAML reader 和 `FileAccessScope.under(sourceRoot)` 检查静态依赖、Flow 名称及原生顶层集合，保留解析器与输出指纹。检查不执行 JavaScript，也不提供 JavaScript 运行时沙箱。

旧 v1/v2 冻结结果仍可按原格式和原有统计规则复核已有证据，不能重新派发，也不能补认具有 v3 的静态依赖保证。v3 的 group `complete/qualified` 和顶层 `qualified` 还要求 `staticInspectionComplete=true`；原始首次/最终通过数及设备释放结论不因此改写。正式结论另看 `formalEligible` 和 `formalQualified`。旧 v1 复核返回的正式结论始终为 false，不向旧文件追加新版字段。

runner 控制记录、矩阵指针及控制索引是脚本间的内部接口，目前由 [CI 验证器](../../scripts/ci/verify-state.mjs) 和[验证计划入口](../../scripts/validation/main.mjs) 检查，不承诺独立的对外兼容接口。
