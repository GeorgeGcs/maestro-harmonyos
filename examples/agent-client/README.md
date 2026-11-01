# 智能体调用示例

这个示例演示一个本地调用方怎样使用 Maestro HarmonyOS：先查询设备条件，再执行断言和截图，核对结果与证据，最后确认设备已经释放。需要运行完整 YAML 时，可以在释放后交给 CLI。

示例使用 Node.js 20 或更新版本的内置模块，无需 `npm install`。它直接启动本仓库构建的 Java CLI，不经过 shell。它是协议接入参考，不提供模型调用、任务规划或自动修复流程。

## 准备

按[使用指南](../../docs/user-guide.md)构建 `:maestro-cli:installDist`，配置 Java 和 HDC。手机须已连接并授权；应用已安装，包名、Ability 和可选 module 需填写真实值。普通上游 Maestro 分发包没有本示例所需的鸿蒙桥接接口。

默认分发目录是仓库下的 `.upstream/maestro/maestro-cli/build/install/maestro`。使用其他位置时传 `--cli-dir`，指向包含 `lib` 的目录。Java 默认读取 `JAVA_HOME`，否则使用 PATH 中的 `java`；也可以通过 `--java` 指定原生 `java.exe` 或 `java`。

先手动打开测试页面，选一段确定可见的文字。从仓库根目录执行：

```powershell
node examples/agent-client/run.mjs `
  --device '替换为HDC设备标识' `
  --app 'org.example.demo' `
  --ability 'EntryAbility' `
  --artifacts './artifacts/agent-example' `
  --assert-text '替换为页面上的确定文字'
```

默认只断言当前页面的文字，然后截图。添加 `--launch` 会先启动指定应用；需要 module 时添加 `--module 'entry'`。每个动作使用独立的 `runId`、`attemptId` 和 `attemptNo=1`，请求计划会在派发前保存。

预检返回 `unknown` 时，示例默认停止。先查看输出目录中的 `preflight-1.json`，人工确认对应条件，例如手机已解锁且保持亮屏，再决定是否追加 `--allow-unknown`。这个选项仅允许未知检查，不会跳过已失败的检查。

## 演示取消

用测试页面上不存在的文字等待断言，再在断言开始后请求取消：

```powershell
node examples/agent-client/run.mjs `
  --device '替换为HDC设备标识' `
  --app 'org.example.demo' `
  --ability 'EntryAbility' `
  --artifacts './artifacts/agent-example' `
  --assert-text '__此测试页面不存在的文字__' `
  --cancel-after-ms 0
```

取消回执只说明请求已受理。示例继续查询原尝试，等待执行结束，核对已有证据，再释放会话。清理尚未确认时会尝试一次受控恢复；恢复仍未知就停止，不运行下一个动作。

运行中按 Ctrl+C 只会取消本次调用拥有的活动尝试，并进入释放流程，不启动后续 CLI。动作响应超时后，示例按原 `runId/attemptId` 查询，不重发动作。取消前已经发生的操作不会回滚。

## 释放后运行 YAML

先准备并审查自己的 YAML。例如在本地创建 `.local/agent-handoff.yaml`，替换包名和可见文字：

```yaml
appId: org.example.demo
---
- assertVisible: "替换为页面上的确定文字"
- takeScreenshot: agent-handoff
```

在普通调用中加上 `--handoff-flow`：

```powershell
node examples/agent-client/run.mjs `
  --device '替换为HDC设备标识' `
  --app 'org.example.demo' `
  --ability 'EntryAbility' `
  --artifacts './artifacts/agent-example' `
  --assert-text '替换为页面上的确定文字' `
  --handoff-flow './.local/agent-handoff.yaml'
```

只有本次动作通过，或取消演示已完成，且会话明确返回 `handoffReady=true`，示例才启动独立 CLI。需要恢复时还会核对恢复报告的真实路径和 SHA-256。CLI 必须重新取得设备锁；前一个会话释放不代表设备已为它预约。

CLI 使用新的任务与尝试标识。示例保存 CLI 的实际退出码，并读取、核对它的结果文件；超时或中断不自动重跑 YAML。YAML 的应用和前置页面应与本次测试相符，接管不会自动重置应用状态。

## 产物与结果

`--artifacts` 应使用稳定的本地目录，同一目录可重复使用。每次调用另建目录，不覆盖前一次结果：

| 路径 | 内容 |
| --- | --- |
| `client/<invocationId>/invocation.json` | 调用参数及预先生成的动作标识 |
| `client/<invocationId>/preflight-*.json` | 首次及恢复后的预检原文 |
| `client/<invocationId>/*.request.json` | 派发前保存的请求；包含可选 CLI 接管请求 |
| `client/<invocationId>/*.result.json`、`*.evidence.json` | 动作结果、证据索引及可选 CLI 结果 |
| `client/<invocationId>/connected.json`、`released.json` | 已连接及已释放会话 |
| `client/<invocationId>/recovery-*.json` | 返回的恢复报告，保留失败或矛盾报告供检查 |
| `client/<invocationId>/summary.json` | 调用汇总、原始状态、校验计数、错误和进程退出情况 |
| `client/<invocationId>/bridge.stderr.log`、`handoff.log` | 桥接诊断和可选 CLI 日志 |
| `server/runs/<runId>/<attemptId>/` | 桥接动作的原始输入、结果、证据和执行产物 |
| `cli/runs/<runId>/<attemptId>/` | 可选 CLI 调用的原始结果与证据 |

没有发生的阶段不会生成对应文件。证据校验包括尝试归属、真实路径边界、可用文件的 SHA-256，以及失败步骤与索引的关联。声明为可用的文件实际缺失或校验不通过时，汇总保留 `unknown` 和原结果；索引明确声明的缺失证据另行计数，不冒充已经取得材料。

先看 `summary.json` 的 `status`，再看原尝试的 `status/error/effects/cleanup` 和会话 `handoffReady`。退出 0 也可能表示取消演示已完成，不代表断言通过。恢复成功不改写原尝试的取消、失败或未知结论。

对于通过独立 `harmonyos-recovery` 入口完成的维护，可用 `maintenance.mjs` 导出的 `verifyMaintenanceReport({ deviceId, recoveryRoot, createdAt, responsePath })` 核验保存的完整响应和磁盘证据。`createdAt` 使用原作业创建时间，`recoveryRoot` 来自调用方已知的配置，不能从待验证响应中推断。该函数不发送 RPC、不自动恢复或执行设备动作。返回的 `releaseConfirmed` 只表示维护释放证据完整，原用例结果仍为未知；下一次执行需要重新取得设备锁。普通 `runWorkflow` 不会自行触发重启维护。详见[维护说明](../../docs/session-maintenance.md)。

对于 `harmonyos-cleanup-recovery` 的清理隔离响应，使用 `cleanup-fence.mjs` 中的 `verifyCleanupFenceReport({ deviceId, recoveryRoot, createdAt, responsePath })`，参数来源与维护核验相同。它核对版本 4 回执及完整事务链，不派发设备命令。成功表示旧派发已被阻止并允许新会话，原命令仍未确认；已登记的阻挡目录必须保留。普通 `runWorkflow` 不自动触发此恢复，具体条件见[清理恢复说明](../../docs/cleanup-fence-recovery.md)。

设备标识、应用内容、输入文字、截图和本机路径可能出现在这些文件中。仓库的 `artifacts/`、`.local/` 已忽略；使用其他目录时自行设置忽略规则，分享前检查材料。

## 恢复范围

示例首条请求协商协议 v2，需要服务端声明 `agent.recover`。只支持 v1 的旧分发包会被明确拒绝，不会降版后继续执行。协议字段见[调用协议](../../docs/agent-protocol.md)及 [v2 Schema](../../docs/protocol/agent-v2.schema.json)。磁盘上的运行结果和证据索引仍使用 v1。

当前分发包在 `~/.maestro/harmonyos-sessions` 持久保存设备会话的恢复记录和阻止接管的标记。新版 CLI、v1/v2 智能体入口及原录制桥接入口都检查这些记录；以前构建的二进制和外部 HDC 操作不会遵守这项约定。

同进程先释放并等会话 `closed`，再恢复指定设备与会话。跨进程连接遇到 `DEVICE_RECOVERY_REQUIRED` 时，示例只使用错误中的 `details.recoverySessionId` 恢复该设备的旧会话。恢复完成后重新预检；未知检查仍须人工确认后显式允许。预检只有恢复标记这一类必需失败时，才允许尝试连接以取得旧会话标识，不因此派发动作。

恢复核对已登记的命令完成凭据，并清理归属明确的临时资源，不重新执行点击、输入或启动应用。没有可信凭据、设备不可达、记录损坏或仍有资源未结束时，结果保持 `unknown`，不能删除标记或换目录绕过。它不保证恢复所有进程崩溃，也不恢复业务状态。

实验性的 Huawei 系统录屏另有长时间运行的服务。已确认启动但缺少持久结束记录时，恢复可按[录屏恢复条件](../../docs/recording-diagnostics.md)补查当前状态；不能确认时继续保留 `unknown`。首次保存原件仍阻止接管，需要后续显式恢复独立比对。客户端兼容内部审计文件 v1/v2，v2 还核验录屏快照及所有保留原件。示例自身把录屏设为关闭，不会主动开始或停止系统录屏。

默认信任的审计文件根目录是 `~/.maestro/harmonyos-sessions`。`--recovery-root` 只改变客户端信任的目录，不迁移服务端记录；仅在明确知道服务端使用另一目录时设置。`--no-recover` 会跳过恢复尝试，保留未确认的交接状态。`--timeout-ms` 设置调用方每项操作的等待预算，不把超时解释为设备已停止。

后端显式恢复共用 30 秒设备检查预算；示例为该请求最多等待 45 秒，给最终报告落盘和响应留出时间，并以 `--timeout-ms` 为上限。普通请求最多等待 30 秒。较短的自定义预算可能先于后端返回而到期，此时保留未知、不重发恢复、不接管设备；须取得并核验恢复报告后才能继续。

## 本地主机测试

```powershell
node --test examples/agent-client/test/client.test.mjs
```

测试启动本地 fake bridge 子进程，检查 JSONL 乱序和断流、动作不重发、取消及释放竞态、恢复约束、证据路径与哈希。测试产物留在 `artifacts/agent-client-tests/`。这些测试不连接手机，不能代替设备验证。
