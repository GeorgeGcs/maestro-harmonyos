# Retry 与验证计划协议

这些独立产物使用 JSON Schema draft 2020-12，不增加 agent v1/v2 字段，也不改变原矩阵报告。Schema 文件可离线使用，内部引用均在单个文件中。

| Schema | 校验对象 |
| --- | --- |
| [retry-trace-v2.schema.json](retry-trace-v2.schema.json) | 当前 `retry-trace.jsonl` 的每一行，分别校验；保留[旧 v1](retry-trace-v1.schema.json) |
| [retry-summary-v2.schema.json](retry-summary-v2.schema.json) | 当前一次顶层 Flow 的重试观察汇总；保留[旧 v1](retry-summary-v1.schema.json) |
| [validation-plan-input-v2.schema.json](validation-plan-input-v2.schema.json) | 当前计划输入；保留[旧 v1](validation-plan-input-v1.schema.json) |
| [validation-plan-v3.schema.json](validation-plan-v3.schema.json) | 新冻结的 `plan.json`；保留[旧 v2](validation-plan-v2.schema.json)、[旧 v1](validation-plan-v1.schema.json) |
| [validation-summary-v3.schema.json](validation-summary-v3.schema.json) | 新计划的 `validation-summary.json`；保留[旧 v2](validation-summary-v2.schema.json)、[旧 v1](validation-summary-v1.schema.json) |
| [validation-review-v2.schema.json](validation-review-v2.schema.json) | 当前人工审核输入；保留[旧 v1](validation-review-v1.schema.json) |

## Retry trace

当前写入独立 trace/summary v2；agent v1/v2 与原证据索引不变。每个步骤的 `sourceIdentity` 对应本次输入登记中规范化的原始绝对文件路径，开始、结束和中断必须一致；生成步骤为 null。`sourcePath` 仍指向按内容哈希保存的归档，同内容的 A.yaml、B.yaml 可以共用归档，但由各自 identity 区分实际执行来源。

覆盖核验同时检查输入登记、冻结源码、归档字节、原始身份、内容哈希和命令索引。v2 缺少身份时拒绝，不回退到内容猜测。旧 v1 仍可读取，但只有本次登记来源能按内容哈希唯一定位时才能计入必测覆盖；同内容的多个登记文件无法区分，不据此认定覆盖完成。旧文件和旧 Schema 不会被改写。

首行 `traceStarted` 带 `protocol`、`schemaVersion`、`runId`、`attemptId`、`flowExecutionId`、`flowPath` 和 `flowSha256`。后续事件带 `flowExecutionId`、连续 `sequence` 与单调计时 `elapsedNanos`；首行不占事件序号。`eventCount` 包括 `flowFinished` 和末尾 `traceCompleted`，不包括首行。

步骤由 `stepStarted` 和 `stepFinished` / `stepInterrupted` 配对。`stepId` 沿用 agent v1 步骤身份，`executionSequence` 标识实际执行实例；重复调用同一子 Flow 或重试同一源码会产生不同实例。`commandIndex` 和 `sourceOffset` 是源码位置，不能当执行次数。生成步骤可没有源码，字段保留为 null。

`retryContext` 是从外到内的栈，每帧含 `retryInvocationId`、`retryCommandStepId`、`tryNo`。`parentExecutionSequence` 记录调用关系，`flowScopeOwner` 与 `phase` 区分 body、setup、onFlowStart、onFlowComplete。`commandOptional`、`selectorOptional` 和 `optionalAncestorSequences` 保留可选上下文。

重试块包含 `retryBlockStarted`、每次 `retryTryStarted` / `retryTryFinished`、可能的 `retryScheduled`，最后以 `retryBlockFinished` 收尾。重试是同一 CLI attempt 内的活动，不新分配 `attemptId`。步骤结果保留 Maestro 的 Completed、Failed、Warned、Skipped；中断使用独立事件，`outcome=null`。这与 agent v1 把 Warned/Skipped 都映射为 skipped 的表示不同。

`retry-summary` 的 complete 表示观察记录已封存，不等于 Flow 执行成功。`retryUsed` 只有实际开始第二次尝试才为 true；`optionalRetryUsed` 仅指 retry 命令自身 optional。只要实际重试，首次成功就不能为 passed。incomplete 状态下这两个标志为 null，`firstPassStatus=unknown`；初始 incomplete 的 error 也可以为 null。

Schema 保留上游可能记录的负 `maxRetries`，因为执行器当前只限制上界。执行核验器会拒绝用这种块证明合格；结构校验通过不能替代执行语义检查。

## 验证计划

输入计划通过 `measurementMode` 区分每 Flow 与整个 suite 的一轮。`units`、显式设备、`repeat` 确定分母。`requiredTopLevelFlows[].requiredSteps` 指明必须执行的源码步骤，每个 Flow 至少需要一个 assertion。

新冻结计划和汇总使用 v3，记录源码、静态检查、实现、应用及工具文件指纹、环境值哈希、运行环境、准备凭据和预分配 `batches`。路径转换为绝对路径，人工填写的环境说明不会自动成为已验证事实。`runtime` 的冻结记录与实际调用分别核对，不能仅凭计划里列出的 JAR 认定它们已被执行。

每个 unit 使用安装的 Maestro YAML reader，在 `FileAccessScope.under(sourceRoot)` 范围内解析声明的顶层 Flow，核对静态 YAML/JS 依赖的路径与哈希、Flow 名称和原生执行计划选出的顶层集合。静态 `runFlow`、hooks 和 `runScript` 引用不能越出 `sourceRoot`；路径含 `${...}` 时也会拒绝，即使磁盘上存在字面同名文件。解析失败、依赖未冻结或集合不符都会在派发前拒绝。记录中的 `scriptsExecuted=false` 表示解析阶段没有执行 JavaScript。这个保证只覆盖静态输入依赖，不是对脚本内部文件访问、网络请求或动态加载的运行时沙箱，也不证明任何设备动作已经执行。

`units[].staticInspection` 保存 `javaPath`、`libraryDirectory`、完整 `classpath`、解析器 `implementationFiles`、请求/响应及 stdout/stderr 的四项 `evidenceFiles`，以及带 `kind=yaml/script` 的 `dependencies`。文件引用均包含绝对路径与 SHA-256；`classpath` 仅列路径，其字节指纹在 `implementationFiles` 中。派发与复核逻辑还要核对证据内容和关联，不能仅依据这些声明或 Schema 通过。

v2 输入的 `preparations` 引用准备记录的路径和 SHA-256。正式计划还要求确认范围、实现/应用文件指纹，以及每个 profile 的 `applicationVersion`：`versionCode` 是十进制字符串，`versionName` 非空。冻结后的准备记录按 profile 和设备区分，保存 HAP、安装记录、包版本观察和准备过程记录的引用。首版凭据使用 `operator_attested`，表示操作者提供的可复核材料；不接受 `device_observed`，也不把人工声明写成设备探测事实。

汇总中的 `slots` 保留所有计划槽位，包括 pending、not-run、cancelled 和 unknown。`firstPassStatus` 与 `finalPass` 分开；groups 中的原始通过率、必测覆盖、无人干预成功数与 `qualified` 也分开。v2 逐槽增加 `runtimeVerification` 和 `preparationVerification`，并单列 `formalEligible`、`formalQualified`。统计达标不能补齐正式资格，开发记录也不会自动成为正式结果。`batches[].releaseConfirmed` 仍独立记录设备交接核验。

v3 在每个 group 和汇总顶层增加 `staticInspectionComplete`，顶层 `staticInspectionError` 保存静态证据复核失败原因或 null。验证器只有实际核验对应静态证据成功后才计算完成状态，不接受请求或已写汇总中的布尔声明作为依据。保存/复核汇总时只读检查保留的请求、响应和日志哈希，以及解析器、运行环境与源码集合的关联；失败会将静态状态置为 false，group 的 `complete/qualified` 和顶层 `qualified` 均不能成立，派发入口则直接拒绝。v3 的 `formalEligible` 同样要求静态检查完整；原始首次/最终通过数及设备释放结论保持独立，旧 v1/v2 继续使用原统计规则。静态检查完整本身不表示执行成功、统计达标或正式合格。

审核文件用 `planSha256` 绑定计划，逐槽明确 `manualIntervention=none/present`，可引用视频完整解码报告。v2 的 `preparation` 还需绑定 `preparationSha256`，分别确认 `installationUnchanged` 和 `preparationUnchanged`。任一为 false 会记录 changed；缺少确认仍是 unknown。`manualIntervention=none` 不代替这两项确认。`finish` 本身不提供人工结论；审核入口重新核对原始证据。操作示例及限制见 [验证计划使用说明](../validation-plan.md)。

版本迁移保留以下边界：

- development 输入继续接受 v1/v2，formal 输入继续要求 v2；新冻结的 plan/summary 统一为 v3，没有新增输入 v3。
- 旧 frozen plan/summary v1/v2 仍可读取、复核已有运行材料，不能启动新批次。复核保持原格式，不补写 v3 静态检查或声称旧证据具备这项保证；v1 返回的 `formalQualified` 仍始终为 false，v2 保留原有正式资格算法。
- v1 review 可用于新版计划的人工介入和视频复核，但不能补充准备确认或取得正式资格。正式复核仍需要 v2 review 和匹配的冻结凭据。
- agent、矩阵报告和控制记录保持原版本；不修改历史文件或把缺少的新字段默认成 verified。

## 校验边界与检查命令

Schema 只检查形状、类型、枚举和部分同文档条件。它不证明序号连续、栈平衡、跨文件身份相同、步骤确实执行、哈希匹配、路径安全、分母未减少、人工未干预或统计合格。仍须运行 `scripts/validation` 中的证据核验逻辑；`qualified=true` 的结构合法性不代表其内容可信。日期 format 的约束程度也取决于所用 validator。

```powershell
pwsh -NoProfile -File .\scripts\tests\test-retry-validation-schema.ps1
```

检查包含公开合成正负例。若本地存在开发真机产物，还会只读检查原件形态；缺失时明确输出 SKIP，不计作真机检查通过。测试不连接设备、不修改原件，也不复制真实设备编号或本机路径到公开示例。
