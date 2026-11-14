# VS Code 运行面板真机验收

2026 年 11 月 14 日，在 Windows 的 VS Code 和 HarmonyOS 7 平板上运行 HMOS 代码工坊。CLI 从固定上游和本项目补丁构建。插件在隔离的 VS Code 开发窗口运行。

| 检查 | 真机结果 |
| --- | --- |
| 运行中查看步骤 | 主 Flow 和子 Flow 同时显示「运行中」。子 Flow 的断言执行时，编辑器高亮 `child.yaml` 第 6 行。 |
| 失败证据 | 断言按预期失败。从面板打开证据菜单可定位到子 Flow 第 6 行，并看到失败截图、运行日志和 CLI 控制台日志。 |
| 停止和重跑 | 点击「重跑」启动新目录。断言执行中点击「停止任务」，面板最终显示「已停止 · 设备已释放」。CLI 结果为 `cancelled`，清理为 `complete`，同场景另用 CI 核验器验证了释放回执。保存修正过的子 Flow 后再次点击「重跑」，面板显示「通过 · 设备已释放」。 |
| 同一子 Flow 多次执行 | 主 Flow 两次调用同一子 Flow，两个执行编号分别显示通过。 |
| 画面预览 | 同一短用例各跑一次，关闭预览用时 24.72 秒，开启用时 24.43 秒并显示 4 帧。两轮均通过并核实设备释放。这组短用例未观察到明显开销。 |

预览从执行时已有截图中取帧，两帧至少间隔两秒，只有面板可见且启用时才写入。两次取帧之间可能没有新截图。停止在步骤边界检查，当前步骤先返回，随后由 CLI 关闭会话。用更早的 CLI 运行时，以支持的事件和证据字段为准。

复现时可在工作区新建两份 YAML。主文件如下。

```yaml
appId: com.huawei.hmos.sample
---
- launchApp:
    stopApp: false
- runFlow: child.yaml
```

在同目录保存 `child.yaml`。

```yaml
appId: com.huawei.hmos.sample
---
- waitForAnimationToEnd:
    timeout: 1500
- takeScreenshot: live-run-ui
- extendedWaitUntil:
    visible: "maestro-live-run-assertion-missing"
    timeout: 11000
```

在面板选主文件运行，勾选预览并观察第 6 行。失败后查看该步骤证据，再重跑并在断言运行时点击停止。操作说明见[插件文档](../../packages/vscode/README.md)。
