# 组件场景套件

`01-components.yaml` 按顺序运行中文输入、按钮样式切换和警告弹窗三个场景，并返回组件列表。它复用标准 Maestro 的 `runFlow`、参数、条件分支和 `repeat`；不依赖目录内文件的执行顺序。

2026 年 11 月 3 日 21:18（北京时间），首次真机预跑的三个场景及最终返回检查全部通过，UI 执行约 11 分 37 秒；正常收尾因命令凭据清理超过 30 秒预算而返回 `cleanup=unknown`、CLI 退出码 1。因此整轮尚不能算通过，未启动整套 20 轮验证。21:28 通过现有恢复入口完成剩余清理，设备可继续使用；原失败结果保留。原按钮单页的 20/20 结果不计入本套件。

## 运行

使用固定版本的 [HMOS 代码工坊](../../README.md)，安装 `phone` 模块，首次引导完成后停留在“组件”列表，界面使用简体中文。运行期间不要操作设备。用例会在应用内返回、滑动和选择组件，不退出应用。

```powershell
$env:MAESTRO_HARMONYOS_RECORDING = 'off'
./scripts/run-harmonyos.ps1 `
  -FlowPath ./examples/hmos-code-lab/flows/suite `
  -BundleId com.huawei.hmos.sample -AbilityName EntryAbility -Module phone `
  -DeviceId YOUR_DEVICE_ID -RunTimeoutSeconds 900
```

| 场景 | 操作与检查 | 完成后的状态 |
|---|---|---|
| 输入 | 从列表进入单行文本输入，确认焦点，通过参数输入“鸿蒙测试”，断言并截图 | 清空本流程写入的 4 个字符，返回列表 |
| 按钮 | 进入按钮页，切换到 `Textual`，断言并截图 | 恢复 `Emphasized`，返回列表 |
| 弹窗 | 打开警告弹窗，断言标题、正文和两个按钮，截图后关闭 | 返回列表，定位到单行文本输入入口 |

输入参数与清空字符数对应，修改 `INPUT_TEXT` 时需同步调整 `common/input.yaml` 的 `eraseText`。任一步骤失败会保留失败结果；不要把失败轮中途的手动操作记作自动执行成功。

## 重复验证

以本目录作为 `measurementMode: suite` 的 `entry`，以 `examples/hmos-code-lab/flows` 作为 `sourceRoot`。列表中的三个场景都完成才算一轮通过；不要单独累计子 Flow 的通过次数。完整验证固定设备、应用、CLI 和 YAML，运行 20 轮，至少 19 轮首次通过，运行中的人工干预计为该轮不通过。

冻结前先跑通开发轮，从实际 trace 获取子步骤的源码索引。必测覆盖应包含三个场景的动作和断言，不能仅登记父 Flow 的 `runFlow`。具体计划与审核方法见[重复验证计划](../../../../docs/validation-plan.md)。
