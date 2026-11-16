# Maestro HarmonyOS 演示

## 基础功能视频

从官方 HMOS 代码工坊的典型交互开始，依次看 YAML 编排、重试、录屏、批量报告和 VS Code 回放。建议用 **1.5× 或 2×** 倍速观看。 [完整演示（哔哩哔哩）](https://www.bilibili.com/video/BV1UqWU6yE3P/)

## 新版现场演示

API 22 模拟器上，CLI 已验证预期断言失败后释放设备并重跑。VS Code 连续两轮完成失败定位、停止、释放与重跑。

准备一台已授权的鸿蒙设备。在设备安装并打开 ComponentCollection，解压 CLI 后将 `bin` 放入 `PATH`。单设备时可用下方命令，多设备时在 `test` 前加 `--device <设备标识>`。 [环境配置](setup.md) · [ComponentCollection 场景](../examples/component-collection/README.md)

```powershell
maestro --platform harmonyos test ./examples/component-collection/ci-smoke.yaml
```

| 演示 | 操作 |
| --- | --- |
| VS Code 失败定位与重跑 | 在面板选择运行 YAML。将冒烟用例最后一条断言改成页面不存在的文字，打开失败行、截图和日志。重跑时点「停止」，确认设备已释放，修正断言再运行。 [插件说明](../packages/vscode/README.md) |
| 录制选择器与预览 | 连接设备，录制或点选一个具有唯一 ID 的控件，查看匹配数及生成的 YAML。开启预览和主机录屏，回放后查看 MP4 和设备释放回执。 [录制说明](user-guide.md) |
| ArkWeb 多页面 | 在包含两个 WebView 的调试样例上分别指定页面。交叉配置 ID 与 URL 时，检查原生树回退结果。 [ArkWeb 样例](../examples/arkweb-probe/README.md) |
| 批量执行与鸿测接入 | 查看 JUnit、截图和会话状态。用同一设备状态目录配置 CI 与鸿测 Worker，核对占用期间的拒绝以及释放后的接续执行。 [通用 CI](ci.md) · [鸿测 Agent](https://gitcode.com/HarmonyPandaWorkshop/hongce-agent) |

[v0.1.3 发行说明](releases/0.1.3.md)
