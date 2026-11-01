# 保持测试应用前台的单页检查

测试应用的常亮依赖前台窗口。本组用例从已经打开的页面开始，只做页面内操作；不停止或启动应用、不使用返回键、不点击顶部返回按钮、不启动系统录屏。执行前由使用者进入对应页面，完成后留在该页面。

| 用例 | 执行前的页面和状态 | 检查内容 |
| --- | --- | --- |
| `01-buttons.yaml` | Button 按钮页，胶囊按钮尚未点击 | 点击与控件 ID 更新、截图 |
| `02-dialogs.yaml` | AlertDialog 警告弹窗页，没有打开的弹窗 | 单按钮及双按钮弹窗、正文、关闭、截图 |
| `03-input.yaml` | TextInput 文本输入页，12 字符输入框可见 | 取得焦点、清空已有输入、输入与计数、截图 |
| `04-scroll.yaml` | Scroll 滚动页，横向滚动标题可见 | 滑动、重新定位输入框、输入与截图 |

一次只执行一个文件，不把这个目录作为批量入口。四条用例的起始页面不同，也不会自动导航到下一个页面。页面或初始状态不符时应保留失败，不能用重启应用来继续。

```powershell
$env:MAESTRO_HARMONYOS_RECORDING = 'off'
./scripts/run-harmonyos.ps1 `
  -FlowPath ./examples/component-collection/foreground/02-dialogs.yaml `
  -BundleId ohos.samples.componentcollection -AbilityName MainAbility -Module entry `
  -DeviceId YOUR_DEVICE_ID -RunTimeoutSeconds 360
```

输入页清空最多 12 个字符，滚动页清空最多 50 个字符；若起始数据超过这一范围，应先在本页准备数据。按钮用例执行后控件 ID 已改变，不能不准备状态就重复执行。

这组用例用于分开验证页面内能力，不替代完整导航、应用生命周期、系统录屏或固定版本的 20 轮计划。通知或其他系统界面仍可能遮挡页面，出现遮挡或失去前台时停止本项检查。

若上一会话仍为 `unknown`，先完成受控恢复；关闭录屏开关只影响新会话，不能解除旧会话占用。新用例的静态解析与实际设备通过记录应分别记录。

2026-11-01：四条用例已用当前 CLI 的 Maestro YAML 解析器完成解析及命令范围检查，尚未在设备上执行。不要将此记录作为真机通过或稳定性验收结果。
