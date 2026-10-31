# 无法确认旧命令结束时的设备维护

普通恢复使用 `agent.recover` v2。如果旧命令的完成文件丢失，它可能一直返回 `unknown`。这时不能删除本机占用记录后继续执行：HDC 客户端退出，不等于设备上的命令已经结束。

`harmonyos-recovery` 提供一个独立的维护入口。它先核实 Windows 已重启，再读取手机运行时间作为基线；手机随后重启，运行时间下降得到确认后，才清理旧会话登记的临时路径。原用例结果、错误和报告保留，旧命令不会被改成执行成功。

这是 Windows 上的有限命令恢复功能。它不处理未解决的录屏、驱动关闭错误、未确认停止的本机调用或无法解释的日志损坏。遇到这些情况，仍需按[录屏与恢复说明](recording-diagnostics.md)调查。

## 使用前

- 使用本仓库构建的完整 CLI 分发目录，不能混用不同版本的 JAR。
- 保存其他工作。流程需要手动重启电脑和手机，命令本身不会重启任何系统。
- 使用错误中给出的设备 ID 和 `recoverySessionId`。不要使用 Flow 的 runId 或 attemptId。
- 准备 HDC、PowerShell 和仓库中 `scripts/recovery/observe-windows-boot.ps1` 的路径。维护过程中保留这些文件及 CLI、Java 的路径和内容。
- 不启动其他设备自动化任务。维护入口与正常会话竞争同一设备锁，原会话保持占用，直到最后一步核验完成。

以下路径仅为示例。`--device` 和 `--platform` 放在子命令之前。

```powershell
$cli = 'D:\tools\maestro-harmonyos\bin\maestro.bat'
$device = '<HDC target>'
$session = '<recoverySessionId>'
$maintenanceArgs = @(
  '--session', $session,
  '--hdc', 'D:\tools\hdc.exe',
  '--powershell', 'C:\Windows\System32\WindowsPowerShell\v1.0\powershell.exe',
  '--host-script', 'D:\src\maestro-harmonyos\scripts\recovery\observe-windows-boot.ps1'
)
```

## 三个步骤

1. 保存原会话及电脑启动基线：

   ```powershell
   & $cli --platform harmonyos --device $device harmonyos-recovery prepare @maintenanceArgs
   ```

   只有 `phase=prepared` 才继续。此时设备仍不可移交。保存命令输出，手动选择 Windows 的“重启”；注销、睡眠、断开 USB 都不替代这一步。

2. 重启电脑后，恢复上述变量，连接并授权手机，执行：

   ```powershell
   & $cli --platform harmonyos --device $device harmonyos-recovery resume @maintenanceArgs
   ```

   入口核实主机重启后才读取手机基线。只有 `phase=phone_prepared` 才手动重启手机。不要提前重启手机来代替这一步之后的重启。

3. 手机重新开机、解锁并授权 HDC 后，执行：

   ```powershell
   & $cli --platform harmonyos --device $device harmonyos-recovery complete @maintenanceArgs
   ```

   核对完整输出与退出码。只有核验、清理和回执落盘全部成功，才会返回 `handoffReady=true`。单独看到进程退出或某个 `complete` 字样不足以判断设备可用。

每次主机观察有 20 秒执行预算；完成阶段的设备查询与清理共用 30 秒预算。终止本次自有进程另有最多 5 秒确认时间。超时、工具变化、证据缺失或未确认的调用都保留阻塞，不自动重放原命令。

部分维护调用未确认时，需要保留现场继续诊断；重复同一命令不保证能够自动续办。失败时 stderr 提供异常类型和代码位置，不输出日志正文或命令凭据。

## 手机运行时间的限制

当前读取系统自带的无参数 `uptime`，接受明确的英文输出格式。[OpenHarmony 的 Toybox 实现](https://github.com/openharmony/third_party_toybox/blob/master/toys/other/uptime.c)使用 `sysinfo`，将运行时间截取到整分钟。维护入口按这个格式和语义解析，保留原始输出与整数分钟，不把输出中的当前时钟当成重启依据。

只有后一次整分钟数严格小于基线，才接受为运行时间重置。相等或增加均拒绝。因此，基线不足一分钟，或者重启后等待太久，可能无法得到证明。没有可读的受支持输出时也不会解除占用。此限制保留了拒绝恢复的可能，不通过估算补齐证据。

该检查没有声称所有 HarmonyOS 版本使用相同实现。不同系统输出需要另行验证后适配。

## 记录和兼容性

维护记录保存在原设备会话目录，包含原始文件快照、工具指纹、阶段引用、调用记录及清理结果。清理只涉及原日志登记的路径，不扫描删除整个临时目录。历史 `completed` 字段保留，重启终止的操作单独记录。

进入维护后，占用记录使用版本 2；最终维护回执使用版本 3。旧 CLI 会拒绝这些版本。新 CLI 的普通 `agent.recover` 也不会接管进行中的维护，必须继续同一维护入口。

维护输出是独立的 `harmonyos.reboot-recovery` 文档，不属于 agent v1/v2 响应。现有 Node 客户端和 CI 状态校验器尚未支持维护回执，不能把该输出作为普通恢复报告传入，也不能手工清除 CI 的未知状态。正常会话的 agent 协议保持原有版本。

## 验证范围

相关主机回归共 106 项通过，包括 59 项维护、时间观察和传输测试，以及 47 项原有会话与恢复测试。状态机测试模拟主机与手机重启，使用实际的日志、设备锁和维护传输实现；它们不代替真实重启验证。

Windows 启动观察另有 40 项 Node 测试通过。PowerShell 5.1 已在 252 字符目标路径完成实际观察；临时文件使用同目录短名称，避免拼接完整目标名后超过旧版路径限制。

系统 `uptime` 已在单台真机读到有效输出，实际 `prepare` 阶段已完成，原命令日志和旧回执哈希保持不变。完整的电脑重启、手机重启和维护释放仍待实测，当前设备继续保持占用。
