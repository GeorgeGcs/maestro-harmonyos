# 逐台设备验证

`scripts/test-device-matrix.ps1` 按显式设备列表逐台运行同一份 Flow，内部调用现有 `run-harmonyos.ps1`。它不并发操作设备，不自动重试失败轮次，也不声明未测设备兼容。

## 使用

先按[环境说明](setup.md)构建 CLI、配置 HDC，并在每台目标设备上安装同一版本的测试应用。通过 `hdc list targets` 获取已连接、已授权的设备标识，在本地传入，设备标识不提交仓库。

```powershell
./scripts/test-device-matrix.ps1 `
  -FlowPath ./examples/flows/input-smoke.yaml `
  -BundleId org.example.demo `
  -AbilityName EntryAbility `
  -Module entry `
  -DeviceIds @('替换为设备一', '替换为设备二') `
  -Env @{ START_TEXT = '输入演示'; INPUT_HINT = '请输入姓名'; INPUT_TEXT = '熊猫测试' } `
  -Repeat 1
```

`DeviceIds` 必填，至少指定一个目标，不能重复。只传一台设备时可以验证工具本身，但结果仍是一台设备的记录。`FlowPath` 支持文件或目录；目录中只放本次要运行的流程及依赖文件。

Windows PowerShell 5.1 受旧版 .NET 路径长度限制影响。仓库或输出目录很深时优先使用 PowerShell 7，或通过 `Artifacts` 指定较短的本地路径。

默认执行一轮。`-Repeat 20` 表示每台设备预先安排 20 次独立执行，不是失败重试。每次执行的 Flow 必须自行准备明确的初始状态；脚本不会清除应用数据、修改权限、解锁设备或恢复未知的页面状态。先固定初始状态、测试范围和计划轮次，再统计结果。

常用参数：

| 参数 | 用途 |
| --- | --- |
| `FlowPath`、`BundleId`、`AbilityName`、`Module`、`Env` | 原样传给运行入口；`APP_ID` 由 `BundleId` 设置 |
| `DeviceIds` | 指定执行顺序，每次只操作一个目标 |
| `Repeat` | 每台设备的计划轮数，默认 1 |
| `Artifacts` | 输出根目录，默认 `artifacts/device-matrix`；每次调用再创建唯一子目录 |
| `ProbeTimeoutSeconds` | 每条只读环境查询的超时，默认 10 秒 |

## 结果和证据

每次调用生成 `matrix.json` 和 `matrix.md`；每台设备、每一轮都有单独的目录、`runner.log` 和 Maestro 产物。JSON 记录 UTC 起止时间、原 CLI 退出码、设备及系统信息、输入文件哈希、上游提交、补丁哈希，以及实际分发包中 CLI、客户端驱动、Orchestra 和模型 JAR 的 SHA-256。主机工具信息也随报告保存。传入的环境参数只记录名称，不把值复制到汇总报告；原 CLI 日志仍可能含输入内容。

轮次状态按实际情况记录：

- `passed`：运行入口正常返回 0，只表示该 Flow 通过。
- `failed`：运行入口返回非零、抛出异常，或执行中断。未支持的操作仍记为失败，保留退出码。
- `not-run`：目标未连接、设备发现失败，或在执行前被中断。某台设备失联后，该设备的剩余轮次不再执行，其他设备继续。
- `running`、`pending`：过程状态。汇总在每轮前后写入；强制结束 PowerShell 时可能保留这些状态，应按未完成记录处理。

汇总通过率的分母是全部计划轮次，未执行项不会被静默排除。每一轮的 `manualIntervention` 初始为 `unknown`，工具无法知道期间是否有人操作了手机，分析结果时需结合观察记录补充审查。脚本退出 0 表示所有计划调用返回 0；存在失败或未执行则退出 1。结果只覆盖实际测试的设备、版本和流程，不能据此推断未测场景或其他设备兼容。

设备环境使用只读查询。基础能力只检查 `uitest` 是否可发现，录屏能力只检查 `mediatool` 和系统录屏服务是否存在。满足这些条件时记为 `available-unverified`；查询失败或格式不确定记为 `unknown`，不推断“不支持”或“已支持”。探测不会启动录屏、点击屏幕或改系统设置。屏幕宽高从本轮实际生成的 PNG 产物读取，没有截图时记为未知，不冒充设备物理屏幕或旋转兼容结果。

录屏需另选含 `startRecording`/`stopRecording` 的 Flow 并显式配置 `MAESTRO_HARMONYOS_RECORDING=huawei-system`。基础流程通过不代表录屏通过；MP4 容器检查也不代表全帧解码成功。录屏的已知限制见[使用说明](setup.md#视频录屏)。

目录模式记录其中 YAML、YML 和 JavaScript 文件的 SHA-256；单文件模式只记录指定文件。目录外的子流程、脚本、测试应用及其他输入还需另行固定版本。环境探测失败不阻止已连接设备执行 Flow，但报告中的未知信息应在给出兼容性或稳定性结论前补齐。

报告会保存本地设备标识、探测原文、路径及界面产物。分享前检查和脱敏，默认留在被 Git 忽略的 `artifacts/` 下。

## 主机回归

```powershell
./scripts/tests/test-device-matrix.ps1
```

测试在临时夹具中模拟 HDC 和运行入口，检查逐台顺序、轮次与独立目录、原退出码、失败及不支持项统计、设备失联、环境查询未知、中断、参数传递和原始输出保留。另实际启动短生命周期本地 PowerShell 子进程，验证输出、退出码及超时。不会操作手机或使用网络。真机和多设备结果需另行记录。
