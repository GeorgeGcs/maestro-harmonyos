# ComponentCollection 场景

这组 YAML 对照 ComponentCollection 源码编写，覆盖按钮、弹窗、文本输入，以及滚动后重新定位输入框。当前版本仅完成静态准备，完整真机执行待验证；不能用源码中存在控件 ID 代替设备上的定位结果。

参考应用仓库为 `HarmonyOS_Samples/component-collection`，本地参考源码提交为 `38a78a4aedfbf332ecc5da768b55d28d416474f0`；该提交与官方远端的对应关系尚未独立核实。页面位于 `entry/src/main/ets/pages/`，中文资源位于 `entry/src/main/resources/zh_CN/element/string.json`。应用由使用者自行构建、签名并安装，本目录不包含 HAP、签名文件或设备配置。

## 执行前

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

## 场景和断言

| Flow | 源码依据 | 必须观察到的结果 |
| --- | --- | --- |
| 01-buttons | `components/buttonAndSelection/buttonSample/ButtonSample.ets` | 点击 `Capsule` 后出现 `Capsule onClickId`；返回后首页 tab 可见 |
| 02-dialogs | `globalMethods/dialogs/alertDialogSample/AlertDialogSample.ets` | 单按钮弹窗显示并关闭；双按钮弹窗显示警告及正文，取消后消失 |
| 03-input | `components/textAndInput/textInputSample/TextInputSample.ets` | 初始计数 0/12；输入 12 个字符后文本及计数 12/12 同时可见 |
| 04-scroll | `components/scrollAndSwipe/scrollSample/ScrollSample.ets` | 执行向上滑动后重新定位 `test_input`，输入内容可见 |

滚动场景包含必执行的 `swipe`，但目标在滑动前是否位于屏幕外仍取决于设备尺寸。真机验证应查看前后截图及步骤记录；本场景不验证嵌套图片区域的滚动距离。输入场景可能弹出键盘，截图用于检查文本与计数是否仍可见；不依赖尚未支持的 `hideKeyboard`。

这些示例用于开发验证。正式重复测试需另行固定应用版本、设备、场景和初始状态，并使用[验证计划](../../docs/validation-plan.md)记录首次与最终结果；不同构建的开发运行不能累加为同一批统计。

四条顶层 Flow 和两个公共子 Flow 已用当前安装的 Maestro YAML reader 完成静态解析，未执行脚本或设备命令。这个结果只确认语法和依赖可读；页面定位、键盘遮挡、滑动效果及耗时仍需真机验证。
