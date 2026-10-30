# Windows 主机启动观察

`scripts/recovery/observe-windows-boot.ps1` 只采集本机启动信息，不执行重启、HDC 命令或设备恢复。它是维护流程的基础工具，目前尚未接入设备会话释放入口。

在已有目录中指定一个不存在的输出文件：

```powershell
./scripts/recovery/observe-windows-boot.ps1 -OutputPath ./artifacts/host-boot.json
```

Windows PowerShell 5.1 和 PowerShell 7 均可使用。调用者负责进程超时及退出确认；脚本中的 CIM 查询超时不代表整个进程有硬截止时间。输出文件已存在、字段不可读、采集期间状态变化或工具指纹变化时，脚本返回非零，不覆盖旧观察。

JSON 使用 `maestro.harmonyos.host-boot-observation`、`schemaVersion: 1`，包含：

| 字段 | 含义 |
| --- | --- |
| `provider` | 观察实现及版本 |
| `observedAt` | UTC 观察时间，用于审计及拒绝旧观察复用 |
| `uptimeMilliseconds` | `GetTickCount64()` 的无损 UInt64 十进制字符串 |
| `lastBootUpTime` | `Win32_OperatingSystem.LastBootUpTime`；前后两次读取须一致 |
| `machineIdSha256` | 规范化 Windows MachineGuid 的 SHA-256，不输出原值 |
| `tools` | 实际 PowerShell 与观察脚本的路径、大小、SHA-256；另记录 PowerShell 版本 |

`scripts/recovery/windows-boot.mjs` 提供 `parseObservation`、`readObservation`、`restarted` 和 `sameBoot`。所有入口都要求调用者提供事先冻结的 `expectedTools`；不能从待核验观察自身复制字段来构造它。历史核验比对已冻结身份，不要求用今天的工具文件代替过去的版本。

`restarted(before, after, expectedTools)` 只在同一主机、新 uptime 严格小于旧值、最近启动时间发生变化且观察时间前进时确认主机重启判据。`sameBoot(resume, now, expectedTools)` 要求同一主机、最近启动时间相同且 uptime 不倒退。计数按 `BigInt` 比较，不转换成 JavaScript `Number`。字段、版本或工具身份无效会抛错；合法观察未满足判据则返回 `confirmed: false` 和原因。

这些结论只适用于正常可信 Windows/SDK 的运行时故障模型。Windows Restart 执行完整启动周期；Fast Startup 可保留内核状态，不能把关机开机、睡眠或休眠恢复直接视为等价操作。若重启后等待过久，导致新 uptime 已不小于准备时的值，工具保守拒绝确认。依据见微软的 [GetTickCount64](https://learn.microsoft.com/en-us/windows/win32/api/sysinfoapi/nf-sysinfoapi-gettickcount64)、[LastBootUpTime](https://learn.microsoft.com/en-us/windows/win32/cimwin32prov/win32-operatingsystem#properties) 和 [Windows 电源状态](https://learn.microsoft.com/en-us/windows/win32/power/system-power-states)说明。

`confirmed: true` 不证明手机已重启、旧设备命令已终结或资源已清理，不能据此修改设备 gate。维护流程仍须把观察绑定到原 owner、不可变检查点和正确阶段，并独立核验手机状态、资源清理及释放回执。目前没有通过这组工具进行真实重启或设备移交验证。

主机回归入口：

```powershell
node --test ./scripts/tests/test-windows-boot.mjs
```
