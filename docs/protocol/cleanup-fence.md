# 清理隔离回执与 CLI 响应

`harmonyos-cleanup-recovery` 为唯一未确认的布局文件删除或导出提供独立恢复入口。适用条件和命令见[使用说明](../cleanup-fence-recovery.md)。该入口不改变 agent v1/v2 的消息格式。

| 文件 | 版本 | 示例 |
| --- | --- | --- |
| 清理隔离回执 | [v4 Schema](cleanup-fence-receipt-v4.schema.json) | [回执](examples/cleanup-fence-receipt.json) |
| CLI 完整响应 | [v1 Schema](cleanup-fence-response-v1.schema.json) | [已隔离](examples/cleanup-fence-response-isolated.json)、[阻塞](examples/cleanup-fence-response-blocked.json) |

示例中的设备、UUID、路径和哈希均为虚构值，只供结构验证，不能作为设备释放证据。版本号分别属于各自文件，响应 v1 引用回执 v4 是正常组合；旧恢复 v1/v2、顺序重启维护 v3 仍按原格式读取，不能互相降版解释。

## 成功响应的含义

命令退出码为 0，并返回 `state=isolated`、`handoffReady=true`。响应包含原设备及会话、新恢复事务 ID、保留目录清单，以及回执的完整路径、SHA-256 和版本。`sessionId` 是原设备会话的 owner，不是 Flow 的 runId 或 attemptId。

回执的以下字段固定：

| 字段 | 值与含义 |
| --- | --- |
| `disposition` | `prevented_before_dispatch`：已阻止原包装器跨过派发入口 |
| `originalResult` | `unknown`：没有将原命令或原用例改成执行成功 |
| `pendingOperations` | `1`：原未确认命令继续保留，并非清零 |
| `temporaryFiles` | `0`：本次登记的图片文件已清理，不表示根目录已删除 |
| `retainedDirectories` | 本次事务保留的一个原会话根目录，不是设备全部历史清单 |
| `checkpoint` | 恢复意图文件的相对文件名和摘要 |
| `verifiedHead` | 生成回执前，最后完成设备核验的阶段文件引用 |

必须保留阻挡目录及其父目录。新会话继承占用记录中的 `retainedFences`，取得设备锁后重新核对远端目录。Schema 不检查设备目录，也不验证回执是否属于调用方指定的原会话。

## 阻塞响应

进入命令实现后发生异常，CLI 返回非零，stdout 为五个字段的阻塞对象：`protocol`、`schemaVersion`、`state=unknown`、`handoffReady=false` 和 `error=CLEANUP_FENCE_BLOCKED`。具体诊断写入 stderr。此对象不附带成功回执或声称设备可以接管。

参数解析、JVM 启动等更早的失败可能没有 JSON 输出，调用方应同时保留退出码和 stderr。未收到完整响应不能推断命令没有派发，也不能自行清除原占用。

机器调用前设置 `MAESTRO_CLI_NO_ANALYTICS=1` 和 `MAESTRO_CLI_ANALYSIS_NOTIFICATION_DISABLED=true`，关闭上游首次运行提示，避免其混入 stdout。若 stdout 含有提示、残缺内容或多份文档，应保存原输出并报错，不从其中截取一行当作完整响应。

## 验证分工

Schema 只验证字段、类型和固定组合。运行核验器还须检查可信根目录、原会话身份、工具来源、引用及实际字节哈希、阶段先后关系、主机进程终态和原日志未变。随后新会话会重新核对设备上的阻挡目录。三个层次的结果不能互相代替。

操作或文件超过 16 项的恢复，固定命令分开核验根目录和文件清单。最终证据链必须以 `verify-root`、`verify` 两次成功观察结尾；后续新会话重新执行这两项检查。旧小会话的命令摘要保持兼容。旧核验器会拒绝扩展范围的回执，调用方应使用与新 CLI 配套的核验脚本，不能仅检查回执 Schema 后手动释放设备。

只读客户端核验使用 `examples/agent-client/cleanup-fence.mjs`；CI 入口及归档说明见 [CI 文档](../ci.md)。回执结构通过不意味着 CI 外层占用已经核销，也不意味着归档完整。

结构与兼容测试使用 PowerShell 7：

```powershell
./scripts/tests/test-cleanup-fence-schema.ps1
```

带生产输出的验证另外传入 `-ProducerDirectory`（主机 `CleanupFenceProducer` 的输出目录）、`-BlockedResponsePath`（真实 CLI 在设备派发前拒绝时保存的 JSON）和 `-RequireProductionEvidence`。强制模式缺少任何一份材料即失败，不将未运行的生产核验记为通过。此测试本身不运行 CLI、HDC 或设备命令。
