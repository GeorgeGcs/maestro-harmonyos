# 录屏资源与恢复文件格式

这些文件用于持久设备会话的资源追踪、原件核验和故障调查。外部调用继续使用 [agent v2](../agent-protocol.md) 的 `agent.recover`；调用方不应自行编辑资源文件来解除占用。

| 文件 | 格式定义 | 写入者 |
| --- | --- | --- |
| `recording-resources.json` | [资源登记 v1](recording-resources-v1.schema.json) | 驱动在录屏状态变化时原子更新 |
| `recoveries/<recoveryId>-recordings.json` | 同上 | 恢复入口复制当时的资源登记，不覆盖既有快照 |
| `recoveries/<recoveryId>.json` | [内部恢复凭据 v1/v2](recovery-receipt.schema.json) | 会话关闭或显式恢复入口，每次使用新的 ID |
| `verification.json` | [完整解码结果 v1](recording-verification-v1.schema.json) | `scripts/verify-recording.ps1` |

Schema 使用 JSON Schema 2020-12，约束字段类型、版本及能在单份文件中检查的状态关系。文件路径、设备身份和哈希等内容可能包含私人信息，示例与工单应先脱敏。可在 PowerShell 7 中做结构检查：

```powershell
Test-Json -Json (Get-Content -LiteralPath './artifacts/video-check/verification.json' -Raw) `
  -SchemaFile './docs/protocol/recording-verification-v1.schema.json'
```

## 资源身份和阶段

资源登记属于 `<session-root>/<设备标识的 SHA-256>/<ownerId>/`。`ownerId` 为设备会话 UUID；`generation` 决定本次远端临时根目录 `/data/local/tmp/maestro-session-<generation>`。两者不是 runId 或 attemptId。一个会话可以登记多段录屏。

| 字段 | 含义 |
| --- | --- |
| `id`、`fileName` | 录屏资源 UUID；媒体名为 `maestro-recording-<去掉横线的 id>.mp4` |
| `remotePath` | 当前 generation 的 `files/recording-<UUID>.mp4`，只用于本资源的导出 |
| `startRequested`、`stopRequested` | 相应操作派发前已经登记意图，不代表设备已执行 |
| `startAcknowledged`、`ownerPid` | 启动已确认，并记录所属采集进程 |
| `captureEnded` | 已持久登记捕获结束事实；达到时长限制也可能结束，因此不强制要求 `stopRequested=true` |
| `uri` | 查询确认的本次系统媒体 URI，文件名必须与资源身份对应 |
| `archives` | 按归档顺序保存的所有原件版本，包含相对文件名、字节数、SHA-256 |
| `archiveName`、`archiveSize`、`archiveSha256` | 最近一次归档，三项必须同时为空或同时有值，并与 `archives` 最后一项一致 |
| `mediaRemoved` | 本次媒体已删除或确认不存在；必须已有结束证据和本地原件 |
| `clean` | 本资源清理完成；已请求启动的资源还必须确认媒体已移除 |
| `failureFingerprint` | 资源关闭错误的指纹，只用于匹配该资源已经解决的错误 |

原件位于所属会话的 `recording-originals/`。名称为 `<resourceId>-<archive UUID>.mp4`，单份最多 1 GiB。媒体内容变化时保留所有版本，后续恢复仍需核验每份归档。`clean` 只描述资源，不代表视频能完整解码。

资源登记和不可变快照使用同一结构。Schema 可以拒绝“已结束但未确认启动”或“已删除但无归档”等矛盾；它不能比较 `id` 与文件名、识别不同对象重复 ID、确认最新归档与历史一致、读取归档字节或判断实际路径是否经过目录联接。这些检查由驱动和客户端执行。

## 内部恢复凭据

`schemaVersion=1` 沿用原恢复凭据；存在录屏资源登记时，写版本 2 并增加 `recordingResources: {path, sha256}`。其中路径必须指向同一 owner 下、本次 recoveryId 对应的不可变快照。凭据中的版本独立于外部 agent 协议版本，也不改变旧运行结果格式。

`deviceId`、`sessionId`、`recoveryId` 确定身份；`reason` 为 `session_close` 或 `recovery`。`previousState`、`previousReportPath`、`previousReportSha256`、`requiresRecovery` 和 `uncertainReason` 保留恢复前的关联信息，`requiresRecovery` 可能在完成凭据中仍为 true，不能仅看这一项判断本次结果。

结果由 `state`、`operations`、`pendingOperations`、`temporaryFiles`、`issues`、`unresolvedRecording` 和 `closeFailure` 描述。`complete` 要求待确认命令和临时文件均为 0、没有未处理的录屏或关闭错误、issues 为空。`unknown` 保留未完成原因，不能接管设备。

接管前使用 [Node 客户端验证器](../../examples/agent-client/evidence.mjs) 的 `verifyRecoveryReport`，同时检查可信根目录、凭据哈希、owner、不可变快照、全部原件版本及大小。CI 还会检查原进程已经结束、设备持久状态与凭据关联。Schema 检查通过不替代这些判断，也不能通过改写旧凭据获得新的恢复结果。

## 视频解码结果

`verification.json` 记录输入、解码器与哈希、原始参数、起止时间、预算、实际退出码、帧数和结束标记；日志通过 `stdout`、`stderr` 引用同目录文件。执行失败可能发生在打开输入或启动解码器之前，此时尚未取得的值保留 null，`exitCode=null` 表示没有确认到进程退出码。

`passed` 要求解码退出 0、未超时、收到结束标记、至少一帧、无错误，且前后输入哈希一致。Schema 约束这些字段的形态和固定值；两个哈希的相等性、日志内容和原文件字节需要实际验证。具体参数、使用方法和覆盖范围见[录屏检查与恢复](../recording-diagnostics.md)。
