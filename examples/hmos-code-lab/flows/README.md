# HMOS代码工坊前台用例

这里的四条 Flow 根据官方源码编写。2026-11-03，输入和弹窗用例在 API 26 平板和一台手机上各通过一次；原按钮用例在两台设备上都未通过 Toast 可见性断言。新增的按钮样式用例在手机上单次通过并完成清理，尚未完成 20 轮验证。平板结果见[平板记录](../../../docs/progress/2026-11-03-hmos.md)，手机结果见[手机记录](../../../docs/progress/2026-11-03-phone.md)。

源码版本固定为 [`7aa95cac4eca15e39fc6638cdf1de7db6fb70ad6`](https://gitcode.com/HarmonyOS_Samples/sample_in_harmonyos/tree/7aa95cac4eca15e39fc6638cdf1de7db6fb70ad6)。获取和构建方法见[样例说明](../README.md)。原工程包名为 `com.huawei.hmos.sample`，手机和平板使用 `phone` 模块的 `EntryAbility`。如果签名时修改了包名，需要同步修改 Flow 的 `appId`。

## 运行前准备

先手动完成首次引导，将界面语言设为简体中文，再进入对应的组件详情页。每次只执行一条 Flow。用例的起始页不同，不要直接批量执行整个目录。

运行期间保持应用前台和屏幕亮着。这些 Flow 不启动或停止应用，不点击页面返回，不关闭软键盘，也不依赖全量 Sample 下载。本仓获取脚本会给官方工程应用前台常亮补丁，退到后台时释放常亮；直接从官方仓库获取的原版没有这项改动。本次前台测试期间未出现锁屏，重新安装后首次启动仍需手动解锁。

| Flow | 起始状态 | 检查内容 |
|---|---|---|
| [01-button.yaml](01-button.yaml) | Button 详情页，预览区“按钮示例”可见，operation 为默认 `Click` | 点击后断言“按钮被点击”；本次未读到该 Toast，结果为失败 |
| [02-input.yaml](02-input.yaml) | TextInput 详情页，预览输入框为空，type 为默认 `Normal` | 断言输入焦点，输入 `maestro-hmos`，截图后清空本流程写入的 12 个字符 |
| [03-alert-dialog.yaml](03-alert-dialog.yaml) | AlertDialog 详情页，“点击警告弹窗”可见，未打开弹窗 | 打开弹窗，断言标题、正文和两个按钮，截图后点击“按钮1”关闭 |
| [04-button-style.yaml](04-button-style.yaml) | Button 详情页，“按钮示例”可见，样式为 `Emphasized` | 切换到 `Textual` 并断言，截图后恢复 `Emphasized`；手机单次通过 |

第一次真机核对建议从弹窗或输入用例开始。按钮提示在官方源码中设置为 2 秒，当前点击步骤结束前还会等待界面稳定，可能错过提示；两台设备的日志均不能确认提示是否出现，也不能直接判断点击没有生效。保留原断言和失败结果，后续需核对点击、布局采集与提示消失的时序。

输入用例成功后会恢复空输入框并保留键盘。若它中途失败，重新执行前需手动清空输入框。弹窗用例中途失败时，也应先手动关闭残留弹窗再执行。

## 选择器来源

下列路径均相对于固定版本官方工程的 `features/componentlibrary/`。所有中文文字均来自 `src/main/resources/zh_CN/element/string.json`，Flow 使用完整文字正则，未猜测控件 ID 或坐标。

| 选择器 | 资源名 | 使用该资源的源码 |
|---|---|---|
| `按钮示例`、`按钮被点击` | `button_text`、`btn_click` | `src/main/ets/componentdetailview/buttonview/component/ButtonBuilder.ets` |
| `请输入文字` | `text_placeholder` | `src/main/ets/componentdetailview/textinput/component/TextInputBuilder.ets` |
| `点击警告弹窗` | `alert_dialog_tip` | `src/main/ets/componentdetailview/alertdialogview/component/AlertDialogBuilder.ets` |
| `标题`、`副标题`、`内容` | `title`、`subtitle`、`content` | 同上 |
| `按钮1`、`按钮2` | `button_one`、`button_two` | 同上 |

`ButtonAttributeMapping.ets` 将按钮默认操作设为 `Click`，其 `styleMapData` 包含 `Emphasized` 和 `Textual`；`TextInputAttributeMapping.ets` 将输入类型默认为 `InputType.Normal`。`TextInputBuilder.ets` 未对该输入框设置 `maxLength`。Flow 中的测试字符串为本仓选择的输入值，不是官方页面固有文字。

## 验证边界

源码核对能确认控件声明和文字来源，无法确认设备上一定能找到唯一节点。字体大小、窗口布局、语言、Toast 生命周期和系统弹窗节点都会影响实际执行。YAML 解析成功也不代表设备操作通过。

本目录暂不提供 List 或 Swiper 的滑动 Flow。官方详情页的预览区和属性区会随窗口尺寸改变布局；当前尚未确认稳定的预览区选择器或手势范围。待真机定位后再增加，避免把属性面板滑动误记为组件滑动。
