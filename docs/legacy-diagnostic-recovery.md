# 已审查的历史故障查询恢复

本入口仅用于旧 CLI 将只读故障查询的包装命令登记为 `recoverable=false`、主机应答丢失，但设备上原完成凭据仍然存在的历史会话。它不是普通回归的自动恢复选项，不适用于来源不明的命令、后台 shell、缺少完成凭据或未结束的主机调用。

## 审查与边界

调用者必须先核对原构建的查询实现、原会话和归档日志，取得对该次维护的明确授权。日志中的 `FAULT_QUERY` 分类只提供审查上下文，不独立证明命令完成，也不等于恢复授权。旧日志没有保存完整包装参数；不得声称已从摘要还原原始 argv。

显式作用域绑定设备、会话、操作 UUID、原命令 SHA-256、已审查日志路径与日志 SHA-256。实现拒绝日志变更、非故障查询分类、冲突调用标识；派发前尚未登记的空 hostCallId 合法，但后续必须绑定唯一的、日志中已登记且原 journal 确认停止的主机调用。作用域仅在当前调用线程有效，正常返回或异常后均移除。

普通恢复的设备锁、当前 owner、journal 归属、主机进程终止、原设备完成凭据及资源归属检查保持生效。完成凭据必须逐项匹配原 generation、owner、operation、命令摘要和 token，并有合法退出码。没有凭据、凭据错误或作用域不匹配时仍为 unknown，不清理资源、不派发旧命令。清理只处理原 journal 登记的文件；未修改 `recoverable` 标记，不改写历史测试失败。

该工具依赖本机可信的原始归档和显式源码审查，不能把不可信日志里的文字当作批准，也不能把同一入口推广为任意 shell 命令的恢复许可。

## 调用

使用包含 `HarmonyOSDiagnosticCompletionRecovery` 的新构建，配合仓库中的 [RecoverReviewedFaultQuery.java](../scripts/recovery/RecoverReviewedFaultQuery.java)。参数文件只包含以下字段，全部来自原会话及已审查归档，不包含新的设备动作：

```json
{
  "deviceId": "<原设备>",
  "sessionId": "<原会话 UUID>",
  "operationId": "<原未决操作 UUID>",
  "commandSha256": "<原命令摘要>",
  "tracePath": "<本地已审查日志绝对路径>",
  "traceSha256": "<日志原始字节摘要>"
}
```

```powershell
$env:MAESTRO_HARMONYOS_HDC = '<已有 HDC 路径>'
& $java --class-path "$cli/lib/*" scripts/recovery/RecoverReviewedFaultQuery.java `
  '<scope.json>' '<尚不存在的 response.json>'
```

脚本只调用原恢复后端，不执行 Flow。成功必须同时有 `state=complete`、`cleanup.state=complete`、`handoffReady=true`、`pendingOperations=0`、`temporaryFiles=0`；另行核验回执 SHA-256 与设备 gate 为 clean，再安排新的已授权回归。输出 unknown 时保留原会话，不换目录或设备标识规避隔离。

## 2026-11-19 验证

原 journal 和进程执行器共 34 项测试通过，无跳过。覆盖正确凭据、缺失凭据、错误凭据、错误命令摘要、日志变更、非诊断分类、异常后作用域清除，以及原有后台命令阻断和真实 shell/主机进程测试。

经用户批准，对 11 月 16 日的一条手机旧会话执行一次有效恢复：原完成凭据匹配后返回 complete，未决命令从 1 降为 0、临时文件从 13 降为 0；独立核对回执摘要和 clean gate。没有重启设备、重放旧命令或手改 gate/journal，原用例失败保留。本次使用从版本化补丁提取的 canonical 源码对冻结 CLI 编译的隔离类覆盖，记录了类摘要；不声称已重建或发布完整分发包。
