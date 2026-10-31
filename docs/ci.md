# 在本机或自托管 Windows 环境运行

`scripts/ci/run-device-suite.ps1` 是平台无关的单设备入口。它先固定本次源码、构建文件和应用参数，再调用 Maestro CLI，核对执行结果、设备释放和原生 JUnit 场景清单；启用视频策略后，还会完整解码本次索引中的原视频。

本机假执行器验证之外，已在一台真机上运行成功、预期断言失败及超时强制停止，检查后续阻止和 v2 恢复核销，见[补充验证记录](progress/2026-10-30-followup.md)。尚未配置或验证任何 CI 平台。此入口不安装服务、不下载工具、不构建 CLI、不安装 HAP，也不代表固定场景的稳定性验证已经完成。

## 准备

- 按[使用说明](user-guide.md)构建 CLI，配置 JDK 17、HDC，以及已安装并授权的测试应用。
- 安装 Node.js 22.12 或更新的受支持版本，用于只读校验报告。
- 使用 PowerShell 7；Windows PowerShell 5.1 也提供行为测试，但目录层级应保持较短。
- 同一设备的自动化进程使用同一 Windows 账户，以及同一个设备状态目录。该目录必须在 checkout 和可清理产物目录之外。
- 保留 CLI 默认的持久会话目录 `~/.maestro/harmonyos-sessions`。`-RecoveryRoot` 是核验时信任的现有目录，不会改变 Java 的会话目录。

应用应在运行前解锁、授权并准备到可重复测试的状态。运行脚本不会自动判断所有前置条件，也不会自动重放结果未知的点击或输入。

## 声明一个应用的测试套件

新运行使用 v2 清单。参考[现有 smoke Flow 的清单模板](../examples/ci/suite.example.json)，按应用实际配置修改。所有文件路径都相对清单所在目录解析，也可以使用绝对路径。清单移到其他目录时，路径也要调整。

例如，自己的测试目录为 `D:\tests\flows`，包含 `login.yaml` 和 `common/prepare.yaml`：

```json
{
  "schemaVersion": 2,
  "suiteId": "example-regression",
  "flowPath": "flows",
  "sourceRoot": "flows",
  "expectedFlows": [
    { "path": "flows/login.yaml", "name": "login" }
  ],
  "bundleId": "org.example.app",
  "abilityName": "EntryAbility",
  "moduleName": "entry",
  "environmentNames": ["TEST_ACCOUNT"],
  "buildManifest": {
    "path": "build-observed.json",
    "sha256": "0000000000000000000000000000000000000000000000000000000000000000"
  }
}
```

将该清单保存为 `D:\tests\suite.json`。示例中的全零哈希是占位符，下一步用实际构建记录的哈希替换。

| 字段 | 规则 |
| --- | --- |
| `flowPath` | 单个 YAML 或顶层 Flow 所在目录 |
| `sourceRoot` | 包含主 Flow、公共子 Flow 和静态 JS 依赖的源码根目录；产物目录应放在其外 |
| `expectedFlows` | 每个顶层 Flow 的 `path` 和 `name`，均不可重复；目录模式必须列全直属 YAML 文件 |
| `buildManifest` | 构建记录的路径和实际 SHA-256；必须对应本次入口所在 checkout 及实际安装的 JAR |
| `bundleId`、`abilityName` | 本次调用固定的应用与 Ability |
| `moduleName` | 可省略；省略时沿用 `MAESTRO_HARMONYOS_MODULE`，未设置则为空 |
| `environmentNames` | 可省略；列出的变量必须已在当前进程设置，`APP_ID` 由 `bundleId` 提供 |
| `applicationFile` | 可选的本地 HAP `{ "path": "app.hap", "sha256": "实际 SHA-256" }` |
| `videoPolicy` | 可选的视频质量要求；省略时不启动解码器，配置方式见下文 |

`expectedFlows.name` 必须与 YAML 的 `name` 一致；未写 `name` 时使用不带扩展名的文件名。顶层 Flow（包括单文件入口）必须符合实际 Maestro 选择规则：使用小写 `.yaml` 或 `.yml` 扩展名，文件主名不能是 `config`，内容也不能被识别为工作区配置。公共 `runFlow` 可放在 `common/` 等子目录中，不列为顶层场景；`common/config.yaml` 可以作为 `runFlow` 依赖解析。

启动前会用实际安装的 Maestro `YamlCommandReader` 和文件访问范围解析 Flow，检查静态 YAML/JS 依赖。根目录之外的依赖、不符合 `.yaml`/`.yml`/`.js` 扩展名的依赖、无法静态解析的参数化文件路径及名称不符，都会在派发前失败。此检查只解析，不执行 JavaScript 或 HDC；它不是运行时 JS 沙箱，不能证明脚本中的任意文件访问或网络请求也已固定。

CI 会保存 `ci-inputs.json`，记录源码集合及哈希、场景路径和名称、应用参数与环境变量值的哈希、构建来源和实际四个核心 JAR，以及可选 HAP。它还固定 Java、Node、PowerShell、辅助脚本和安装目录中的 JAR 集合，并核对实际 runner 使用的 Java。冻结后输入发生变化会使检查失败。没有本地 HAP 仍可运行；提供 HAP 也只固定该文件，不证明手机上安装的应用与它对应，`installedApplicationCorrespondence` 保持 `unverified`。

清单只列环境变量名称，但原生运行输入、日志和截图可能包含实际值，归档时应限制访问。

需要视频作为通过条件时，在同一清单中增加：

```json
"videoPolicy": {
  "requiredFlows": ["flows/login.yaml"],
  "ffmpeg": { "path": "C:/tools/ffmpeg/bin/ffmpeg.exe", "sha256": "替换为实际 SHA-256" },
  "timeoutSeconds": 60,
  "maxVideos": 4,
  "budgetSeconds": 330
}
```

`requiredFlows` 必须是 `expectedFlows` 中明确的顶层源码路径子集，不能填公共子 Flow。每个指定 Flow 至少要有一份可归属的视频；归属按原生 retry trace 的 stepId 与证据索引关联，不按目录名或相同内容猜测。只要启用策略，本 attempt 其余已索引视频也要解码；总数超过 `maxVideos`、缺少必需视频或归属不明确都会使质量检查失败。省略整个 `videoPolicy` 保留现有无视频行为。

FFmpeg 由使用者提供，入口不下载。派发前固定其字节及视频检查脚本，收尾再次检查。`timeoutSeconds` 为每片解码上限（1–3600 秒），`maxVideos` 为 1–100 且不得少于必需 Flow 数；总预算不得超过 86400 秒，也不能小于 `maxVideos × (timeoutSeconds + 20) + 10`。额外时间用于版本探测、启动和有界退出；不保证阻塞的文件系统操作可立即被中止。

解码复用 `verify-recording.ps1`，每片使用独立新目录和报告指针，核对原视频前后哈希、解码器哈希、退出码、帧数、结束标记及错误输出。报告和日志留在本次 CI 目录的 `video-verification/`，由既有归档入口一并收集。坏片、超时或报告缺失使 `quality.status=failed` 和 CI 非零；原生执行状态与已经确认的 released 保持不变。此检查只验证原片完整解码，不证明画面内容、音轨、流畅度或历史尾部问题已修复。

视频报告的 `process.descendantExitConfirmed` 只在取得并核对直接解码进程终态时为 true；外层超时或报告缺失时为 null。强制终止父进程可能使子解码进程的退出无法确认，不能从 Node 或 PowerShell 已退出推断整棵进程树结束。此时质量失败，已经确认的设备释放仍保留；它与 Java/HDC 的设备隔离判断分别记录。完整取消链仍需在实际 CI 平台配置后验证，不按进程名扫描或结束其他 FFmpeg。

## 记录本次构建

先完成 CLI 构建，再从实际使用的仓库根目录执行：

```powershell
node scripts/ci/snapshot-build.mjs D:\tests\build-observed.json
```

命令要求输出文件尚不存在，返回它的 `path` 和 `sha256`。将这两个值填入清单的 `buildManifest`。可选的第二个参数是实际项目根目录：

```powershell
node scripts/ci/snapshot-build.mjs D:\tests\build-observed-next.json D:\work\maestro-harmonyos
```

这是一份已安装文件的观察记录：它读取 Git 身份、上游提交、补丁和四个实际 JAR，不执行构建。`cleanBuildProven=false`、`sourceToBinaryCorrespondence=unverified`；不能用它证明干净构建、源码与二进制对应或签名来源。源码状态、补丁或 JAR 改变后，应生成新的记录。

对不含 `.git` 的隔离源码目录，使用生成该目录时保留的构建 manifest，并填入实际路径和哈希；不要借用父目录的 Git 身份。入口会核对 manifest 声明的源码目录、构建完成状态及实际 JAR。请将自己的清单和观察记录放在 checkout 外或已忽略的目录，避免写入观察记录时改变被观察的 Git 状态。

## 运行和旧清单迁移

在新的 PowerShell 进程中执行，例如：

```powershell
pwsh -NoProfile -File scripts/ci/run-device-suite.ps1 `
  -SuiteManifest D:\tests\suite.json `
  -DeviceId 'YOUR_DEVICE_ID' `
  -ArtifactsRoot D:\tests\artifacts `
  -DeviceStateDirectory D:\maestro-device-state `
  -RunTimeoutSeconds 600
```

旧 v1 套件清单不会再启动新的 Run。迁移时保留原来的应用和环境变量配置，改为 `schemaVersion: 2`，补齐 `sourceRoot`、完整的 `expectedFlows` 以及 `buildManifest`。例如原来的 `flowPath: "flows"`，现在还需列出 `flows/login.yaml` 的真实名称；`common/prepare.yaml` 作为依赖保留在源码根内。

这个版本变化针对套件输入。已有 v1 设备占用记录和下面的 `-ReconcileOnly` 仍可读取，不需要重写旧结果或清空状态目录。

占用记录保存启动该作业的 PowerShell 进程身份。建议始终使用 `pwsh -File` 启动独立进程；在长期存活的交互 PowerShell 中直接 `&` 调用后，该主机进程仍存活，会阻止旧作业的自动核销。

## 时间上限和硬终止

通用入口要求 `-RunTimeoutSeconds`。可选参数：

| 参数 | 默认 | 含义 |
| --- | --- | --- |
| `TerminationWaitSeconds` | 5 | 终止本次 Java 后确认退出的等待上限 |
| `OutputDrainSeconds` | 5 | Java 退出后等待输出管道结束的上限 |
| `VerificationTimeoutSeconds` | 30 | 每次元数据校验的上限；启用视频时，质量步骤另加冻结的 videoPolicy 总预算 |
| `JobTimeoutSeconds` | 0 | 可选的平台作业预算；0 表示尚未提供平台预算 |

配置平台预算时，入口要求：

```text
JobTimeoutSeconds > RunTimeoutSeconds
                  + TerminationWaitSeconds
                  + OutputDrainSeconds
                  + 4 × VerificationTimeoutSeconds
                  + videoPolicy.budgetSeconds（未启用为 0）
                  + 60
```

默认校验、终止和输出等待参数下，600 秒执行预算要求作业预算大于 790 秒；使用上面 330 秒的视频策略时须大于 1120 秒。视频预算不足会在派发前拒绝。额外 60 秒用于启动和归档余量；真实平台还需按构建与上传耗时增加预算。该参数不会改变平台自身的硬超时。

标准 YAML CLI 目前没有跨进程协作取消入口。runner 超时后只终止自己启动且 PID、启动时间、可执行文件均匹配的 Java 进程，不按进程名结束其他 Java/HDC，不发送额外的设备录屏停止命令。

终止 Java 不证明手机端命令结束。失去可信终态或清理结果时保留 `unknown`，不写成 `cancelled`。bridge 的 `agent.cancel` 支持单步动作的协作取消；它不能控制另一个普通 YAML CLI 进程。

平台直接结束作业可能跳过 PowerShell `finally`、Java shutdown hook 和报告上传。启动前保存的 CI 占用记录仍然有效，下一次调用会拒绝接管。启动成功但进程身份尚未来得及保存的间隙同样按未知处理，不根据超时或 PID 缺失自动解除。

## 两层设备状态

外层是本入口在 `DeviceStateDirectory` 保存的 `maestro.harmonyos.ci-device` v1 记录和作业锁；内层是现有 CLI 会话门禁及资源日志。两层目录都需要持久保存。

正常完成时，本入口核对：

1. runner 的实际退出、完整输出、运行标识及结果路径；
2. agent v1 终态、清理状态和输入/证据哈希；同时沿 `agent-manifest.files` 核对证据索引、原生 manifest、JUnit 等报告的实际字节，缺少必需引用也拒绝通过；
3. 当前内层会话的 clean 记录和归属、路径、哈希一致的清理凭据。

断言失败但清理已确认，可以释放设备并返回非零。证据明确声明 missing/capture_failed 时，作业返回非零；若终态和清理凭据均可信，仍可释放设备。无法核对释放所需的报告、哈希或清理状态时，保留占用；不得清空目录或更换账户绕过。

释放核验通过后，才进行固定输入和 JUnit 的独立质量检查。质量检查失败会使 CI 返回非零，但不会撤销已经确认的 `released`，也不会改写原生执行状态或退出码。平台硬停发生在释放尚未确认时，则继续保留 `needs_inspection`；此规则不依赖 `finally` 能否执行。

需要恢复时，按[协议说明](agent-protocol.md#51-v2-受控恢复)使用 v2 `agent.recover`，保存它返回的 `recoveryReport` 完整协议文档。恢复不会重放原动作。取得可信报告后，可在独立进程中核销外层占用：

```powershell
pwsh -NoProfile -File scripts/ci/run-device-suite.ps1 `
  -DeviceId 'YOUR_DEVICE_ID' `
  -DeviceStateDirectory D:\maestro-device-state `
  -ReconcileOnly `
  -RecoveryReportPath D:\tests\recovery-response.json
```

此命令只读核对报告及内层记录，不主动调用 HDC，不修改内层门禁。它要求旧 PowerShell/Java 进程已结束，恢复响应属于当前设备会话，审计文件位于同一个可信恢复根目录且哈希正确；成功只解除外层占用，不修改原执行结果，也不立即启动下一次测试。

如果普通恢复无法确认旧有限命令的结束，可以按[设备维护流程](session-maintenance.md)完成有证据的依次重启。`RecoveryReportPath` 也接受该流程 `complete` 返回的完整 `harmonyos.reboot-recovery` JSON。此分支单独核对版本 2 占用记录、版本 3 回执及维护链，不把维护回执降级成普通 v2 恢复。核销结果记录 `recoveryKind=ordered_restart_maintenance`，原执行仍保留失败或未知。只完成 `prepare`、`resume` 或只有一份声称成功的 JSON 均不够。普通完成路径也不会用维护释放来证明原测试已经通过。

维护核销仍保留原进程身份检查：身份丢失时不会仅凭重启回执跳过。请保留完整维护响应文件；核销结果会记录该路径及哈希，供后续归档使用，不将核销成功当成证据已经收齐。

若进程身份缺失、原进程仍存活、恢复记录损坏或恢复返回 unknown，核销失败，原占用保留。没有“强制清除”开关。录屏的第二版清理凭据还会核对不可变资源快照及保留原件，确认结束、归属和清理；缺少这些证据时仍可能持续返回 unknown，不能只确认一个提示就继续测试。

验证计划通过同一个预约模块使用 `kind: validation` 的占用记录。该记录绑定整个 matrix 调用的 `unitInvocationId` 和 `controlIndexPath`；每个已派发 attempt 都有单独 runner 控制记录。核销时检查索引身份及所有已派发进程，不能仅凭最后一轮的退出解除整次占用。只有 planned 且没有控制文件的项可以作为未派发处理；launching 项缺少进程身份仍会阻止核销。

## 结果与归档

CI 入口返回 0 要同时满足：CLI 和 runner 正常退出 0、执行结果为 passed、证据可读且哈希相符、没有 missing/capture_failed 项、清理已确认，以及 `quality.status=passed`。其他情况返回非零。

三个结果分别记录：

| 结果 | 含义 |
| --- | --- |
| `execution` | 原生测试是否通过，保留原始失败 |
| `state: released` | 本次设备资源的释放已确认，可以结束该占用 |
| `quality.status` | 固定输入、构建引用、原生 JUnit 场景记录及已启用的视频要求是否满足 |

例如预期场景全部出现，JUnit 如实记录断言失败，质量检查可以 passed，但 execution 仍是 failed，CI 返回非零。反过来，原生 passed 也不能覆盖缺失场景或构建文件变化。

JUnit 检查按源文件路径和名称核对每个顶层场景，拒绝空报告、缺项、重复、额外场景和计数矛盾。相对的 `testcase.file` 按本次 runner 的项目根目录解析，原生 `SUCCESS`/`ERROR` 必须与 `<failure>` 和总失败数一致。读取器禁用 DTD 和外部实体，限制文件大小、深度和条目数，并复核原件哈希。

产物位置可从 `DeviceStateDirectory/<设备哈希>.json` 获取：

- `artifactDirectory`：本次 `runner.log`、校验输入、`ci-result.json` 和质量报告 `ci-quality.json`；
- `inputs.path` / `inputs.sha256`：本次冻结的 `ci-inputs.json` 及其哈希；
- `controlRecordPath`：独立 runner 控制记录，包含 stdout/stderr 路径、原始 `processExitCode` 和 `wrapperExitCode`；
- `agentRoot/runs/<runId>/<attemptId>/`：本次原生 JUnit、执行结果、manifest 和证据；
- `resolution.reportPath`：核对过的内层清理或恢复凭据。

不要仅打包外层产物目录，也不要扫描“最新目录”猜运行。用独立收集入口传入本次 CI 入口输出的 `ci-<launchId>` 目录，输出目录必须不存在：

```powershell
node scripts/ci/collect-artifacts.mjs `
  --ci-directory D:\ci\outputs\ci-<launchId> `
  --output-directory D:\ci\archives\<unique-name>
```

平台应在独立的 always-run 步骤调用它，再上传生成的目录；不依赖执行步骤的 `finally`。原执行退出码、收集退出码和上传结果分别保存，任何一步失败都不能被后一步的 0 覆盖。

若执行进程被强制结束，尚无 `ci-result.json`，需额外明确指定持久状态文件和预期 launch ID：

```powershell
node scripts/ci/collect-artifacts.mjs `
  --ci-directory D:\ci\outputs\ci-<launchId> `
  --state-record D:\ci\device-state\<device-hash>.json `
  --expected-launch-id <launchId> `
  --output-directory D:\ci\archives\<unique-name>
```

状态必须仍属于该次 launch，且目录、runId、attemptId、设备和控制记录相符；不能拿下一次运行的状态替代。已有 `ci-result.json` 时不接受另一份状态记录覆盖它。只有 `ci-preflight.json` 的预检阻塞也可按第一条命令收集，不会因此登记设备运行。

原 `ci-result.json` 已存在、之后通过 `-ReconcileOnly` 核销占用时，可单独补充恢复后的状态文件：

```powershell
node scripts/ci/collect-artifacts.mjs `
  --ci-directory D:\ci\outputs\ci-<launchId> `
  --recovery-state-record D:\ci\device-state\<device-hash>.json `
  --expected-launch-id <launchId> `
  --output-directory D:\ci\archives\<unique-name>
```

该参数不能与 `--state-record` 同用，且必须有原 CI 结果。除 `state`、`updatedAt`、`resolution` 外，补充记录的全部字段必须与原记录一致，原执行结果、退出码、输入和运行身份均不能改变。两份记录分别保存在归档中；核销只证明当时核实了资源释放，不会把原执行改成 passed。状态文件已被下一作业覆盖时，应使用此前保存的、属于该次 launch 的恢复状态副本。

维护版本 3 的归档由回执及已核对哈希的完整响应开始，只跟随该 owner/maintenance 目录内的明确引用。收集检查点、阶段链、重启观察、原日志及回执快照、调用前后日志和清理批次，不读取当前 gate、当前日志或历史工具文件，不扫描其他维护目录。缺失响应路径、引用文件或哈希不符时保留已取得材料并返回 incomplete；一个损坏文件不阻止其他可读取材料收集。元数据文件上限为 4 MiB，整组文件仍受下述归档预算限制。`maintenance_receipt_and_chain` 表示引用的维护材料收齐，不是重新执行恢复或独立批准设备接管。

收集范围是选定 CI 目录、精确的 `agentRoot/runs/<runId>/<attemptId>/` 子树（含源码快照和未封存的 partial 文件）、对应控制记录，以及 `resolution` 明确绑定的回执、录屏快照和已登记原件。索引、manifest、源码内容地址和回执引用的哈希另行核对。不会扫描其他 attempt、按当前 gate 猜 owner，或复制整个会话目录。若原生错误指出 `DEVICE_RECOVERY_REQUIRED` 的 owner，却没有绑定回执，报告会列出未收集的恢复材料并返回非零；这不表示该 owner 没有保留原件。

`archive-manifest.json` 记录每个源路径、包内路径、复制前后源哈希、目标哈希，以及原执行、cleanup、quality 数据。`status=complete` 只表示本次声明范围已收齐，可与测试 failed 或 cleanup unknown 同时出现，不是清理或移交证明。缺文件、引用冲突、文件变化、输出未收完、超出限制或读写失败时尽量保留已得材料，标记 incomplete 并返回非零；不改原状态、gate 或结果。原生 JUnit 原样复制。工具、classpath、HAP 只保留已有指纹记录，不复制其字节；此目录是执行证据包，不是构建重放包。

启用视频策略后，收集器还会逐级核对质量报告、视频报告、报告指针、独立解码报告及其日志的引用和哈希；声明的文件缺失或被修改时归档不完整，不重新解码来覆盖原结论。

默认最多 4096 个文件、4096 个目录，单文件 1 GiB、合计 4 GiB。收集预算为 120 秒，在阶段和读写块之间检查，不能打断操作系统中阻塞的文件调用。平台仍需为独立收集步骤设置外层超时，并另留上传时间；强杀或磁盘不可写可能只留下部分文件而没有最终清单。链接、路径穿越、跨 attempt 引用、输出与输入嵌套及覆盖旧输出均拒绝。原始日志、截图、视频和本地路径需保留访问控制，上传失败应作为独立作业失败处理。

派发前检查失败时，本次目录中的 `ci-preflight.json` 记录 `blocked`、`dispatched=false` 和原因；不会创建本次设备测试的占用记录。静态解析日志也保存在本次目录中，可用于定位错误路径或名称。

原生 JUnit 保持原样。此入口核对声明的顶层场景，不据此判断每个 UI 步骤或条件分支已覆盖，也不执行重复次数统计或跨设备并发。全帧视频解码按上述显式策略启用；进一步的统计或录屏诊断分别见[验证计划](validation-plan.md)和[录屏检查工具](recording-diagnostics.md)。

## 本机验证

```powershell
pwsh -NoProfile -File scripts/tests/test-run-harmonyos.ps1
pwsh -NoProfile -File scripts/tests/test-ci-device-suite.ps1
node --test scripts/tests/test-ci-suite.mjs
node --test scripts/tests/test-ci-collect-artifacts.mjs
node --test scripts/tests/test-ci-videos.mjs
pwsh -NoProfile -File scripts/tests/test-ci-junit.ps1
```

Windows PowerShell 5.1 可为 CI 测试传入 `-TestArtifactsRoot D:\tests\ci-fixtures` 等较短的专用目录，避开旧版文件 API 的路径长度限制。

只检查视频策略、预算和释放状态不被质量失败覆盖时，可对 `test-ci-device-suite.ps1` 使用 `-VideoOnly`。

runner 测试使用本地 JDK 编译的假 CLI。CI 测试使用本地执行器替身和文件校验器；套件及 XML 测试用于检查固定输入、场景匹配和格式拒绝行为。测试报告以每次命令的实际输出为准。

这些检查不连接手机、不调用 HDC，也不证明某个 CI 服务已经配置可用。
