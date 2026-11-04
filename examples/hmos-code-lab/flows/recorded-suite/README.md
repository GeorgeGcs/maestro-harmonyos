# 完整组件场景分段录屏

[`01-components.yaml`](01-components.yaml) 在一个标准 Maestro Flow 内，顺序执行输入、按钮和弹窗三个完整场景。它复用[普通套件](../suite/README.md)的准备、导航、动作与断言，仅增加三组 `startRecording` / `stopRecording`，保留最终返回检查和截图。每段使用不同名称，避免覆盖或混淆诊断归属。

普通套件完整单轮已耗时 12 分 51 秒，超过系统录屏单段 600 秒上限。因此按场景分段；同一 Flow 的停止命令完成后才启动下一段，两者之间没有应用 UI 操作。停止、导出和再次启动仍存在时间间隔，三个原片不构成无缝连续录像，本入口不合成视频。

| 原片名称 | 覆盖范围 |
| --- | --- |
| `hmos-components-01-input.mp4` | 启动应用（保留进程）、准备组件页、进入输入页、输入“鸿蒙测试”、断言、截图、清空和返回 |
| `hmos-components-02-button.mp4` | 定位并进入按钮页、切换 `Textual`、断言和截图、恢复 `Emphasized`、返回 |
| `hmos-components-03-dialog.mp4` | 定位并进入警告弹窗页、打开并检查弹窗、截图、关闭并返回、定位输入入口、最终断言与截图 |

## 检查与运行

使用固定版本的 [HMOS 代码工坊](../../README.md)，安装 `phone` 模块，完成首次引导，使用简体中文。启动前设备须解锁、亮屏且没有其他录屏，应用保持前台；测试期间不要手动操作设备。起始页要求和异常页面恢复范围沿用[普通套件说明](../suite/README.md)。录屏在 `launchApp` 之前开始，以覆盖该启动步骤；`stopApp: false` 保留已有应用进程。

在仓库根目录执行静态检查。需要已构建的鸿蒙 CLI 和 Java；共同依赖根必须指定为 `flows`，因为子 Flow 位于相邻目录：

```powershell
node examples/agent-client/run.mjs --check-only `
  --app com.huawei.hmos.sample `
  --handoff-flow examples/hmos-code-lab/flows/recorded-suite/01-components.yaml `
  --flow-root examples/hmos-code-lab/flows `
  --artifacts ./artifacts/hmos-recorded-check
```

该命令使用原生 Maestro 解析器检查 YAML 和静态依赖，不连接设备，也不验证录屏服务或视频质量。使用其他 CLI 分发目录时增加 `--cli-dir '<包含 lib 的目录>'`；本机可先加载自己的 `config.local.ps1` 配置 Java。

实际运行使用 runner，显式启用录屏并将每段上限设为 600 秒：

```powershell
$env:MAESTRO_HARMONYOS_RECORDING = 'huawei-system'
$env:MAESTRO_HARMONYOS_RECORDING_MAX_SECONDS = '600'
./scripts/run-harmonyos.ps1 `
  -FlowPath ./examples/hmos-code-lab/flows/recorded-suite/01-components.yaml `
  -BundleId com.huawei.hmos.sample -AbilityName EntryAbility -Module phone `
  -DeviceId YOUR_DEVICE_ID -RunTimeoutSeconds 1800 `
  -Artifacts ./artifacts/hmos-recorded-suite
```

`MAESTRO_HARMONYOS_RECORDING_MAX_SECONDS` 仅接受 1～600 的整数，默认 180 秒。600 秒限制针对每段，不是三段累计时长；runner 的 1800 秒预算覆盖整个 Flow 和收尾。各场景正常执行预计在约 6 分钟内，但设备、页面恢复和滚动耗时会变化，必须核对本次实际时长。达到单段上限会报失败，不会自动续录。后端仍为实验功能，环境要求见[视频录屏配置](../../../../docs/setup.md#视频录屏)。

任一动作、断言或录屏启停失败，都保留失败结果，不增加可选步骤或重试。正文中途失败时由已有 Flow 收尾尝试关闭活动录屏；后续场景不会继续。读取实际退出码与 `result.json` 的执行结果、`cleanup`，不能把已有 MP4 或部分场景通过当成完整成功。清理未确认时按[录屏恢复说明](../../../../docs/recording-diagnostics.md)处理，再决定是否执行新的任务。

## 逐段核验

在本次运行结果、证据索引与产物清单中定位三份 `startRecording/` 原片，分别核对名称、归属、时长和覆盖范围。不要根据其他运行目录里的同名文件补齐缺失片段。每段都需要完整解码，例如：

```powershell
./scripts/verify-recording.ps1 `
  -InputPath '<本次运行的实际路径>/startRecording/hmos-components-01-input.mp4' `
  -FfmpegPath 'C:/tools/ffmpeg/bin/ffmpeg.exe' `
  -OutputDirectory './artifacts/hmos-recorded-video-checks' `
  -TimeoutSeconds 600
```

再对 `hmos-components-02-button.mp4` 和 `hmos-components-03-dialog.mp4` 分别执行同一命令，使用各自实际路径。工具为每次核验创建独立报告目录；需三份报告均为 `passed`、退出码均为 0、检查前后输入哈希一致，并核对实际输入文件。工具只检查第一条视频轨，不能证明音轨质量或动作覆盖；还须结合 trace、截图与原片内容检查场景是否录全。

可用[阶段诊断工具](../../../../docs/recording-diagnostics.md#收集阶段诊断)对照三段录屏的启停、导出和清理记录。保留原始 MP4 及失败报告，不以转码或合成结果替代原片核验。执行通过、清理完成、三段视频均有效是分别检查的结论。

## 验证范围

2026-11-04，本入口及 8 个静态 YAML 依赖已通过原生 Maestro `--check-only` 检查；剔除录屏命令后，入口的动作与断言顺序和普通套件一致。此检查不代表真机录屏通过。

本入口与 `suite/01-components.yaml` 分开维护，复用其子 Flow。普通套件的既有单轮和 20 轮结果不能作为本分段录屏入口通过的证据；本入口的录屏开发轮也不计入普通套件的 20 轮统计。恢复重复验证时仍须按[重复验证计划](../../../../docs/validation-plan.md)重新冻结实际入口及完整依赖、获取 trace 并检查必测覆盖。
