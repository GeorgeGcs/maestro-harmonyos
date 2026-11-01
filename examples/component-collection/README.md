# ComponentCollection 场景

这组 YAML 对照 ComponentCollection 源码编写，覆盖按钮、弹窗、文本输入，以及滚动后重新定位输入框。四条场景已完成单条预跑和一次同会话录屏批次；各场景结果和边界见下文，不能据此声明重复稳定性通过。

参考应用仓库为 `HarmonyOS_Samples/component-collection`，本地参考源码提交为 `38a78a4aedfbf332ecc5da768b55d28d416474f0`；该提交与官方远端的对应关系尚未独立核实。页面位于 `entry/src/main/ets/pages/`，中文资源位于 `entry/src/main/resources/zh_CN/element/string.json`。应用由使用者自行构建、签名并安装，本目录不包含 HAP、签名文件或设备配置。

## 执行前

只验证页面内操作、需要依靠应用窗口常亮时，使用[保持前台的单页检查](foreground/README.md)。该组从已打开的目标页面开始，不调用下述停止和启动应用的初始化，也不使用系统录屏；每次只运行一个文件。

- 按主仓库使用指南配置 CLI、Java 和 HDC，手机解锁并授权。
- 应用包名为 `ohos.samples.componentcollection`，模块 `entry`，Ability `MainAbility`，使用简体中文界面。
- 每个顶层 Flow 都先停止并重新启动应用，使页面的内存状态重新初始化；不会清除应用数据或修改权限。
- 首次启动提示或权限弹窗需事先处理。首次验证时确认 `0/12` 是初始输入状态，不应靠忽略断言继续执行。

在仓库根目录逐条验证，例如：

```powershell
./scripts/run-harmonyos.ps1 `
  -FlowPath ./examples/component-collection/flows/01-buttons.yaml `
  -BundleId ohos.samples.componentcollection -AbilityName MainAbility -Module entry `
  -DeviceId YOUR_DEVICE_ID -RunTimeoutSeconds 360
```

单条通过后，`FlowPath` 可改为 `./examples/component-collection/flows` 批量执行，需按预跑耗时设置整个套件的超时。`common/` 是依赖目录，不单独执行；其参数由顶层 Flow 传入。用例没有添加失败自动重试，便于保留首次失败位置。

同一会话批量执行时，把目录交给一次 CLI 调用；逐条启动 runner 会创建多个会话。四条场景的开发运行约需十分钟，可先为整批预留二十分钟：

```powershell
./scripts/run-harmonyos.ps1 `
  -FlowPath ./examples/component-collection/flows `
  -BundleId ohos.samples.componentcollection -AbilityName MainAbility -Module entry `
  -DeviceId YOUR_DEVICE_ID -RunTimeoutSeconds 1200
```

批次是否通过需同时检查进程退出码、执行结果和 `cleanup.state`。控制台显示 `Flows Passed` 后仍可能发生会话清理失败；此时先按恢复报告处理，不能直接启动下一批。

## 场景和断言

| Flow | 源码依据 | 必须观察到的结果 |
| --- | --- | --- |
| 01-buttons | `components/buttonAndSelection/buttonSample/ButtonSample.ets` | 点击 `Capsule` 后出现 `Capsule onClickId`；返回后首页 tab 可见 |
| 02-dialogs | `globalMethods/dialogs/alertDialogSample/AlertDialogSample.ets` | 单按钮弹窗显示并关闭；双按钮弹窗显示警告及正文，取消后消失 |
| 03-input | `components/textAndInput/textInputSample/TextInputSample.ets` | 初始计数 0/12；输入 12 个字符后文本及计数 12/12 同时可见 |
| 04-scroll | `components/scrollAndSwipe/scrollSample/ScrollSample.ets` | 执行向上滑动后重新定位 `test_input`，输入内容可见 |

滚动场景包含必执行的 `swipe`，但目标在滑动前是否位于屏幕外仍取决于设备尺寸。真机验证应查看前后截图及步骤记录；本场景不验证嵌套图片区域的滚动距离。输入场景可能弹出键盘，截图用于检查文本与计数是否仍可见；不依赖尚未支持的 `hideKeyboard`。

输入页使用 Stack 将计数文字叠在 TextInput 上，文字控件横跨输入框中部。直接点击输入框中心时，设备可能不把焦点交给输入框。因此输入用例先按提示文字定位，再使用标准 `point: "50%,15%"` 点击该控件内部上方，并断言 `focused: true` 后输入；最终仍须同时看到输入内容与 `12/12`。

这些示例用于开发验证。正式重复测试需另行固定应用版本、设备、场景和初始状态，并使用[验证计划](../../docs/validation-plan.md)记录首次与最终结果；不同构建的开发运行不能累加为同一批统计。

四条顶层 Flow 和两个公共子 Flow 已用 Maestro YAML reader 完成静态解析。输入定位调整后，普通入口及录屏包装入口共八条 Flow 再次解析通过，录屏包装保留原场景全部步骤。解析检查本身不执行设备命令。

## 单机开发预跑

2026-11-01 使用独立构建的 CLI，在同一台已安装并签名的应用上逐条执行。下表耗时取持久结果的开始、结束时间，包含会话收尾，按秒取整。

| 场景 | 最近一次结果 | 耗时 | 清理 |
| --- | --- | --- | --- |
| 首页冒烟（开发用例） | 连续两次通过 | 各约 13 秒 | complete |
| 01-buttons | 修复收尾预算后通过 | 144 秒 | complete |
| 02-dialogs | 通过 | 213 秒 | complete |
| 03-input | 调整点击位置并补焦点断言后通过 | 141 秒 | complete |
| 04-scroll | 滑动、重新定位及输入断言通过 | 153 秒 | complete |

首次按钮运行的 UI 断言通过，但原 10 秒收尾预算不足，整次运行保留 unknown；显式恢复完成剩余清理后，使用 30 秒收尾预算重新运行通过。首次输入运行没有取得输入框焦点，文本断言失败；它的清理完成，原失败证据保留。两次修复后的通过均属于新的运行，不覆盖原记录。

以上为分开执行的预跑。随后四条普通 Flow 同会话执行时，UI 断言全部通过，但清理超时，整批保留 `unknown`；显式恢复后完成剩余清理。修复批量清理命令的执行开销后，四条录屏入口在同一会话中 4/4 通过，CLI 退出码 0，清理 `complete`，四段原始视频完整解码通过，详见 [11-01 记录](../../docs/progress/2026-11-01.md)。

此后固定版本的 20 轮开发验证在第 2 轮因通知干扰、锁屏及录屏启动未确认而停止：1 轮通过、1 轮未知、18 轮未执行，未达到稳定性目标。原计划不续跑，不同构建和不同 YAML 版本不合并计算通过率。旧手机的录屏资源仍阻止该设备接管。新增的[前台单页用例](foreground/README.md)已完成原生解析和命令检查，其中按钮、输入已在平板通过，弹窗界面步骤通过但首次收尾未知、后续已恢复；滚动首次输入断言失败，补充取焦后的用例已通过，见[平板记录](../../docs/progress/2026-11-01-tablet.md)。

## 带录屏的入口

`recorded/` 中的四条 Flow 分别启动录屏、调用同名原场景、显式停止录屏；原场景的初始化和断言保持一致。选择 `flows/` 或 `recorded/` 中的一组执行，不要把整个 `component-collection/` 目录作为批次，以免重复运行。

```powershell
$env:MAESTRO_HARMONYOS_RECORDING = 'huawei-system'
$env:MAESTRO_HARMONYOS_RECORDING_RETAIN_MEDIA = 'false'
$env:MAESTRO_HARMONYOS_RECORDING_MAX_SECONDS = '300'
./scripts/run-harmonyos.ps1 `
  -FlowPath ./examples/component-collection/recorded/01-buttons.yaml `
  -BundleId ohos.samples.componentcollection -AbilityName MainAbility -Module entry `
  -DeviceId YOUR_DEVICE_ID -RunTimeoutSeconds 360
```

系统录屏仍为实验功能。先逐条预跑并检查每段原始视频的完整解码结果，再决定是否进入批次。弹窗正文的单机预跑已超过默认的 180 秒录屏上限，因此示例显式设为 300 秒；该值需按实际场景耗时选择，允许范围为 1～600 秒。runner 超时需另行计入交互、导出和收尾耗时；外层超时不会提高录屏后端的时长上限。也不要通过添加等待来掩盖短录屏失败。

断言失败会跳过 YAML 末尾的 `stopRecording`，由 Maestro 执行器的录屏收尾处理。正文错误、录屏关闭错误、设备清理状态分别保留：断言失败且清理完成仍是测试失败；清理 unknown 时应停止后续设备任务。进程被强制终止不能依赖这个收尾保证，需要按[恢复说明](../../docs/session-maintenance.md)处理。不能为“尽量跑完”忽略录屏错误。

本组录屏入口已在单台设备完成一次同会话批量验证。运行整组时，将上面的 `FlowPath` 改为 `./examples/component-collection/recorded`，并使用 `-RunTimeoutSeconds 1200`；每段录屏上限仍为 300 秒。原始视频校验见[录屏检查](../../docs/recording-diagnostics.md)。正式验证的 sourceRoot 应包含 `flows/` 与 `recorded/`，并重新生成源码索引和计划指纹，不能沿用未录屏版本的覆盖清单。

主机解析检查可使用 JDK 17 和已构建 CLI；输出文件须不存在：

```powershell
& 'C:/tools/jdk/bin/java.exe' --class-path 'C:/build/maestro/lib/*' `
  scripts/tests/fixtures/InspectComponentFlows.java examples/component-collection C:/build/component-source-indices.json
```
