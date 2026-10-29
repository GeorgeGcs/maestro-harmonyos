# 在本机或自托管 Windows 环境运行

`scripts/ci/run-device-suite.ps1` 是平台无关的单设备入口。它调用现有 Maestro CLI，核对原生结果和证据，并在进程异常结束后阻止下一次调用直接接管设备。

目前完成的是本机假执行器验证，尚未配置或验证任何 CI 平台。此入口不安装服务、不下载工具、不构建 CLI、不安装 HAP，也不代表官方示例或稳定性验收已经完成。

## 准备

- 按[使用说明](user-guide.md)构建 CLI，配置 JDK 17、HDC，以及已安装并授权的测试应用。
- 安装 Node.js 22.12 或更新的受支持版本，用于只读校验报告。
- 使用 PowerShell 7；Windows PowerShell 5.1 也提供行为测试，但目录层级应保持较短。
- 同一设备的自动化进程使用同一 Windows 账户，以及同一个设备状态目录。该目录必须在 checkout 和可清理产物目录之外。
- 保留 CLI 默认的持久会话目录 `~/.maestro/harmonyos-sessions`。`-RecoveryRoot` 是核验时信任的现有目录，不会改变 Java 的会话目录。

应用应在运行前解锁、授权并准备到可重复测试的状态。运行脚本不会自动判断所有前置条件，也不会自动重放结果未知的点击或输入。

## 声明一个应用的测试套件

创建 JSON 清单。`flowPath` 相对清单所在目录解析，也可以使用绝对路径：

```json
{
  "schemaVersion": 1,
  "suiteId": "example-regression",
  "flowPath": "flows",
  "bundleId": "org.example.app",
  "abilityName": "EntryAbility",
  "moduleName": "entry",
  "environmentNames": ["TEST_ACCOUNT"]
}
```

`moduleName` 和 `environmentNames` 可省略。只列出环境变量名称，值从当前进程环境读取；`APP_ID` 由 `bundleId` 设置。CLI 的运行输入和截图等可能包含这些值，原始产物应限制访问。

一个清单对应一次 CLI 批量调用，应用 bundle/module/ability 在该次调用中固定。公共 `runFlow` 子流程可放在 Flow 目录的子目录，顶层存放可独立执行的主 Flow。

在新的 PowerShell 进程中执行，例如：

```powershell
pwsh -NoProfile -File scripts/ci/run-device-suite.ps1 `
  -SuiteManifest D:\tests\suite.json `
  -DeviceId 'YOUR_DEVICE_ID' `
  -ArtifactsRoot D:\tests\artifacts `
  -DeviceStateDirectory D:\maestro-device-state `
  -RunTimeoutSeconds 600
```

占用记录保存启动该作业的 PowerShell 进程身份。建议始终使用 `pwsh -File` 启动独立进程；在长期存活的交互 PowerShell 中直接 `&` 调用后，该主机进程仍存活，会阻止旧作业的自动核销。

## 时间上限和硬终止

通用入口要求 `-RunTimeoutSeconds`。可选参数：

| 参数 | 默认 | 含义 |
| --- | --- | --- |
| `TerminationWaitSeconds` | 5 | 终止本次 Java 后确认退出的等待上限 |
| `OutputDrainSeconds` | 5 | Java 退出后等待输出管道结束的上限 |
| `VerificationTimeoutSeconds` | 30 | 本机 Node 报告校验的上限 |
| `JobTimeoutSeconds` | 0 | 可选的平台作业预算；0 表示尚未提供平台预算 |

配置平台预算时，必须大于执行、终止、输出收集、校验预算之和，并额外留出至少 60 秒。平台适配还需按真实构建和上传耗时保留足够余量；该参数不会改变平台自身的硬超时。

标准 YAML CLI 目前没有跨进程协作取消入口。runner 超时后只终止自己启动且 PID、启动时间、可执行文件均匹配的 Java 进程，不按进程名结束其他 Java/HDC，不发送额外的设备录屏停止命令。

终止 Java 不证明手机端命令结束。失去可信终态或清理结果时保留 `unknown`，不写成 `cancelled`。bridge 的 `agent.cancel` 支持单步动作的协作取消；它不能控制另一个普通 YAML CLI 进程。

平台直接结束作业可能跳过 PowerShell `finally`、Java shutdown hook 和报告上传。启动前保存的 CI 占用记录仍然有效，下一次调用会拒绝接管。启动成功但进程身份尚未来得及保存的间隙同样按未知处理，不根据超时或 PID 缺失自动解除。

## 两层设备状态

外层是本入口在 `DeviceStateDirectory` 保存的 `maestro.harmonyos.ci-device` v1 记录和作业锁；内层是现有 CLI 会话门禁及资源日志。两层目录都需要持久保存。

正常完成时，本入口核对：

1. runner 的实际退出、完整输出、运行标识及结果路径；
2. agent v1 终态、清理状态和输入/证据哈希；同时沿 `agent-manifest.files` 核对证据索引、原生 manifest、JUnit 等报告的实际字节，缺少必需引用也拒绝通过；
3. 当前内层会话的 clean 记录和归属、路径、哈希一致的清理凭据。

断言失败但清理已确认，可以释放设备并返回非零。证据明确声明 missing/capture_failed 时，作业返回非零；若终态和清理凭据均可信，仍可释放设备。无法核对报告或哈希、硬终止、无法确认清理时，保留占用；不得清空目录或更换账户绕过。已确认资源释放与测试通过是不同结论。

需要恢复时，按[协议说明](agent-protocol.md#51-v2-受控恢复)使用 v2 `agent.recover`，保存它返回的 `recoveryReport` 完整协议文档。恢复不会重放原动作。取得可信报告后，可在独立进程中核销外层占用：

```powershell
pwsh -NoProfile -File scripts/ci/run-device-suite.ps1 `
  -DeviceId 'YOUR_DEVICE_ID' `
  -DeviceStateDirectory D:\maestro-device-state `
  -ReconcileOnly `
  -RecoveryReportPath D:\tests\recovery-response.json
```

此命令只读核对报告及内层记录，不主动调用 HDC，不修改内层门禁。它要求旧 PowerShell/Java 进程已结束，恢复响应属于当前设备会话，审计文件位于同一个可信恢复根目录且哈希正确；成功只解除外层占用，不修改原执行结果，也不立即启动下一次测试。

若进程身份缺失、原进程仍存活、恢复记录损坏或恢复返回 unknown，核销失败，原占用保留。没有“强制清除”开关。录屏的第二版清理凭据还会核对不可变资源快照及保留原件，确认结束、归属和清理；缺少这些证据时仍可能持续返回 unknown，不能只确认一个提示就继续测试。

验证计划通过同一个预约模块使用 `kind: validation` 的占用记录。该记录绑定整个 matrix 调用的 `unitInvocationId` 和 `controlIndexPath`；每个已派发 attempt 都有单独 runner 控制记录。核销时检查索引身份及所有已派发进程，不能仅凭最后一轮的退出解除整次占用。只有 planned 且没有控制文件的项可以作为未派发处理；launching 项缺少进程身份仍会阻止核销。

## 结果与归档

CI 入口返回 0 的条件是：CLI 和 runner 均正常退出 0，结果为 passed，所引用证据可读取且哈希相符，没有 missing/capture_failed 项，清理已确认。其他情况返回非零。

产物位置可从 `DeviceStateDirectory/<设备哈希>.json` 获取：

- `artifactDirectory`：本次 `runner.log`、校验输入及 `ci-result.json`；
- `controlRecordPath`：独立 runner 控制记录，包含 stdout/stderr 路径、原始 `processExitCode` 和 `wrapperExitCode`；
- `agentRoot/runs/<runId>/<attemptId>/`：本次原生 JUnit、执行结果、manifest 和证据；
- `resolution.reportPath`：核对过的内层清理或恢复凭据。

不要仅打包外层产物目录，也不要扫描“最新目录”猜运行。平台接入时归档以上本次引用的文件，保留访问控制；不要把整个持久设备目录中的其他运行一起公开。上传失败应作为独立作业失败处理。

原生 JUnit 保持原样。首版入口核验实际引用和哈希，不做场景覆盖统计、全帧视频解码、正式重复次数统计或跨设备并发。这些检查可在后续阶段接入，不能由当前退出 0 推断已经完成。

## 本机验证

```powershell
pwsh -NoProfile -File scripts/tests/test-run-harmonyos.ps1
pwsh -NoProfile -File scripts/tests/test-ci-device-suite.ps1
```

Windows PowerShell 5.1 可为 CI 测试传入 `-TestArtifactsRoot D:\tests\ci-fixtures` 等较短的专用目录，避开旧版文件 API 的路径长度限制。

runner 测试使用本地 JDK 编译的假 CLI，覆盖参数传递、正常/非零退出、超时、关闭管道后卡住及输出尾部超时。CI 测试使用本地假执行器和真实文件校验器，覆盖成功、断言失败、证据篡改、跳过 finally 的进程结束、后续阻止及可信恢复。

这些检查不连接手机、不调用 HDC，也不证明某个 CI 服务已经配置可用。
