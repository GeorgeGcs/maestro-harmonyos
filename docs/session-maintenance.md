# 无法确认旧命令结束时的设备维护

普通恢复使用 `agent.recover` v2。如果旧命令的完成文件丢失，它可能一直返回 `unknown`。这时不能删除本机占用记录后继续执行：HDC 客户端退出，不等于设备上的命令已经结束。

正常会话关闭时，命令日志的核验和自有目录清理共用 30 秒预算，与显式恢复的预算一致。较长 Flow 会留下多批完成凭据，外层执行超时应给收尾留出余量。预算用尽或清理应答缺失仍会阻止接管；即使 YAML 断言全部通过，清理 `unknown` 也不能算整次运行通过。所有设备命令已确认、仅目录清理超时时，先通过 `agent.recover` 处理，无需直接进入重启维护。

`harmonyos-recovery` 提供一个独立的维护入口。它先核实 Windows 已重启，再读取手机运行时间作为基线；手机随后重启，运行时间下降得到确认后，才清理旧会话登记的临时路径。原用例结果、错误和报告保留，旧命令不会被改成执行成功。

这是 Windows 上的有限命令恢复功能。它不处理未解决的录屏、驱动关闭错误、未确认停止的本机调用或无法解释的日志损坏。遇到这些情况，仍需按[录屏与恢复说明](recording-diagnostics.md)调查。

维护范围包括原会话已登记的布局 JSON 和截图 PNG。只有取得原流程要求的主机、设备顺序重启证据后，才按精确路径清理；文件名相似但未登记的内容不会被接管。录屏文件、其他类型的临时资源、符号链接或未预期的目录内容仍会阻止释放。原命令结果及临时文件登记保留在原日志中，清理结果由独立维护回执记录。

含布局或截图资源的维护记录需要配套使用支持此范围的 CLI 和 Node 核验器；旧版核验器会拒绝非空的临时资源清单。此扩展没有降低重启证据要求，也不能仅凭重新插入 USB 解除未确认命令。

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

## 重启后工具发生变化

Windows 更新可能同时替换系统 PowerShell。即使路径和文件大小相同，程序内容也可能变化；当前维护入口要求工具与 prepare 时一致，因此会拒绝继续。微软签名有效只能确认签名校验结果，不能代替原检查点的工具一致性检查。

可先只读检查检查点登记的文件：

```powershell
node scripts/recovery/check-maintenance-tools.mjs --checkpoint 'C:/sessions/owner/maintenance/id/checkpoint-UUID.json'
```

输出逐文件的 expected/actual 指纹，以及 unchanged、changed 或 unreadable 状态。退出码 0 表示本次读取的登记文件均一致，2 表示有变化或不可读，1 表示输入或检查点读取失败。此工具不启动 PowerShell、Java 或 HDC，也不修改文件。输出可能含本机路径，分享前检查内容。

这个检查只用于定位变化，不检查全部维护证据或批准接管；即使全部 unchanged，也必须通过原恢复入口。遇到工具变化时，保留原检查点、占用和旧日志，不直接改哈希、替换系统文件或删除占用。

### 显式迁移系统 PowerShell

只允许迁移仍处于首次 `prepared`、没有任何维护设备调用的会话。运行者应先核对 Windows 更新事实及系统程序签名，并使用已审查、已测试的新 CLI；工具指纹清单本身不是发布者签名。新 CLI 放在独立目录，原分发目录和其他工具必须保持原样。

先用新 CLI 生成清单。`CHECKPOINT_SHA256` 是原 gate 引用的检查点摘要：

```powershell
& $cli --platform harmonyos --device $device harmonyos-recovery plan-host-migration @maintenanceArgs `
  --checkpoint-sha256 CHECKPOINT_SHA256 > tool-approval.json
# 阅读清单并核对新 CLI 的构建来源、工具路径与摘要后，再执行迁移。
& $cli --platform harmonyos --device $device harmonyos-recovery migrate-host @maintenanceArgs `
  --tool-approval ./tool-approval.json
```

清单绑定原检查点及当前新工具集。允许系统 PowerShell 在原路径更换内容；Java、HDC、观察脚本必须不变。CLI 可移到独立目录，JAR 文件集合必须一致，只有 Maestro 的 cli/client/orchestra/orchestra-models 四类实现 JAR 允许更换内容，其他依赖的字节必须一致。原 CLI 的全部文件与目录成员仍需核验。

迁移核实同一主机已重启，保存原 gate、检查点、阶段引用、确认清单及新主机观察，再原子更新 gate 指向的检查点。新检查点采用 v2，旧文件不覆盖，原命令仍未确认，设备仍不可接管。已执行设备调用、旧文件变化、清单过期、依赖变化或不能证明主机重启都会拒绝。

成功后继续用同一个新 CLI 执行 `resume`。它要求仍是迁移时的电脑启动周期，保存手机基线后才进入 `phone_prepared`；此后再手动重启手机并执行 `complete`。迁移之前已经重启过手机，不能代替基线记录之后的重启。若发生第二次系统工具更新或已有未确认调用，不会自动再次迁移。

## 手机运行时间的限制

当前读取系统自带的无参数 `uptime`，接受明确的英文输出格式。[OpenHarmony 的 Toybox 实现](https://github.com/openharmony/third_party_toybox/blob/master/toys/other/uptime.c)使用 `sysinfo`，将运行时间截取到整分钟。维护入口按这个格式和语义解析，保留原始输出与整数分钟，不把输出中的当前时钟当成重启依据。

只有后一次整分钟数严格小于基线，才接受为运行时间重置。相等或增加均拒绝。因此，基线不足一分钟，或者重启后等待太久，可能无法得到证明。没有可读的受支持输出时也不会解除占用。此限制保留了拒绝恢复的可能，不通过估算补齐证据。

该检查没有声称所有 HarmonyOS 版本使用相同实现。不同系统输出需要另行验证后适配。

## 记录和兼容性

维护记录保存在原设备会话目录，包含原始文件快照、工具指纹、阶段引用、调用记录及清理结果。清理只涉及原日志登记的路径，不扫描删除整个临时目录。历史 `completed` 字段保留，重启终止的操作单独记录。

进入维护后，占用记录使用版本 2；最终维护回执使用版本 3。旧 CLI 会拒绝这些版本。新 CLI 的普通 `agent.recover` 也不会接管进行中的维护，必须继续同一维护入口。

维护输出是独立的 `harmonyos.reboot-recovery` 文档，不属于 agent v1/v2 响应。正常会话的 agent 协议保持原有版本；不能把维护输出当成 `agent.recover` 的响应。

保存 `complete` 返回的完整 JSON 后，通用 CI 的 `-ReconcileOnly -RecoveryReportPath <响应文件>` 可以核对维护回执。它仍要求原 CI 主机进程和执行进程已结束，再验证当前 clean 占用记录、检查点、完整阶段链、原日志及回执、主机与手机重启观察、调用终态和精确清理路径。原 pending 操作保持原值，只有资源的释放状态改变。参数用法见 [CI 两层设备状态](ci.md#两层设备状态)。

Node 调用方可使用 `examples/agent-client/maintenance.mjs` 中的 `verifyMaintenanceReport`，显式传入设备、可信恢复根目录、原作业创建时间及响应文件。该函数只读核验，不调用 HDC、不重启、不改占用记录，也不自动启动下一任务。读取记录后会再次核对整组文件哈希；核验不代替下一次 CLI 取得设备锁。

共享核验器每次最多读取 4096 个文件、单文件 32 MiB、累计 256 MiB，并有 30 秒检查点预算；外层仍应设置进程超时，因为文件系统调用本身可能阻塞。核验读取保存的工具指纹，不执行或重新散列历史工具。新冻结的 CI 套件和验证计划同时记录核验器及主机观察解析模块的哈希，派发前拒绝工具变化。

核销结果保存维护响应的路径和哈希。CI 归档器可按这些引用收集版本 3 回执、完整阶段链、主机及手机观察、原日志快照、调用和清理记录；无需读取当前设备 gate，后续已有新会话也不影响旧材料归档。已有 CI 结果时，通过独立 `--recovery-state-record` 补充同一次运行的恢复记录，原结果不会被覆盖。命令及限制见 [CI 结果与归档](ci.md#结果与归档)。旧核销结果若没有保存响应路径，归档会标记 incomplete，不能通过猜测目录补齐。核销成功和归档完整是两项不同结论。

## 验证范围

相关主机回归共 106 项通过，包括 59 项维护、时间观察和传输测试，以及 47 项原有会话与恢复测试。状态机测试模拟主机与手机重启，使用实际的日志、设备锁和维护传输实现；它们不代替真实重启验证。

Windows 启动观察另有 40 项 Node 测试通过。PowerShell 5.1 已在 252 字符目标路径完成实际观察；临时文件使用同目录短名称，避免拼接完整目标名后超过旧版路径限制。

单台真机已完成完整恢复流程：Windows 更新替换 PowerShell 后，执行工具迁移与 `resume`，记录手机基线；随后重启手机，执行 `complete`，返回 `handoffReady=true`。独立 Node 核验器检查了 51 份证据并确认释放。原检查点、命令结果和旧回执均保留，原来的一次未确认操作仍为 `unknown`。这证明本次有限命令会话可以通过顺序重启恢复，不代表录屏资源或其他设备上的恢复已经验证。

工具迁移补充验证已通过：61 项 JVM 维护与会话恢复测试、110 项 Node 工具检查与核验归档测试，以及 3 项使用实际维护运行包的 JVM→Node 联测。联测覆盖正常维护、工具迁移后的完整核验与归档、未确认调用保持阻塞；不代替真机重启验收。修复代码也已从独立源码目录完成 CLI 与 VSCode 插件构建，使用现有离线缓存，尚未验证空缓存下载。

恢复后的按钮预跑暴露了普通收尾预算不足：148 条设备操作全部确认，但清理目录在原来的 10 秒预算内未完成，CLI 返回非零，整体保持 unknown。显式恢复完成剩余清理，原结果哈希未变。普通收尾改为共用 30 秒预算后，同一按钮场景重新运行通过，退出码为 0、清理 complete。针对该调整的 62 项 JVM 回归全部通过，包含大日志分批清理和清理应答丢失后禁止接管；这些测试与前述维护测试有重叠，不累加为独立覆盖数量。

新增 Node 核验及 PowerShell 核销入口使用合成维护记录测试：有效链允许解除外层占用，错误会话、缺失文件、哈希变化、未停止调用、原命令被改写、重启不成立及错误清理范围均拒绝。该测试不连接设备，也不把合成回执作为真实维护结果。运行入口为 `node --test scripts/tests/test-maintenance-release.mjs`；可用 `MAESTRO_TEST_TEMP` 指定仓库外的专用短路径测试目录。

2026-11-02，针对保留布局/截图路径的兼容修复，相关 JVM 回归 129 项及 Node/CI 核验 50 项通过，无失败或跳过。覆盖精确文件清理、未知文件和同名目录保留、重新打开日志时保持资源数组顺序，以及 JVM→Node 的含图片资源维护证据核验。重复路径、录屏及其他资源类型被拒绝。以上是主机测试，平板断连后的实际维护尚未完成，见[平板恢复记录](progress/2026-11-01-tablet.md#重连后的恢复检查)。
