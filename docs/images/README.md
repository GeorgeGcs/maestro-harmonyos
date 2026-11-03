# 文档图片来源

## HMOS 代码工坊实测截图

`hmos-code-lab-input-tablet.png` 与 `hmos-code-lab-dialog-tablet.png` 来自 2026-11-03 平板测试的 `takeScreenshot` 步骤，分别记录输入 `maestro-hmos` 和系统弹窗展开时的页面。图片按原字节复制，没有裁剪或修改。

应用源码来自 [HMOS 代码工坊](https://gitcode.com/HarmonyOS_Samples/sample_in_harmonyos)固定提交 `7aa95cac4eca15e39fc6638cdf1de7db6fb70ad6`，使用本仓的前台常亮补丁。上游许可证保存在 [examples/hmos-code-lab/LICENSE](../../examples/hmos-code-lab/LICENSE)，运行条件及结果见[测试记录](../progress/2026-11-03-hmos.md)。

## ComponentCollection 上游配图

本目录保存 ComponentCollection 上游项目的两张原始配图，用于说明测试页面。实际运行结果见 [ComponentCollection 记录](../../examples/component-collection/README.md#单机开发预跑)。

| 本目录文件 | 上游文件 |
| --- | --- |
| `component-collection-button.png` | `screenshots/devices/button.png` |
| `component-collection-warning-popup.png` | `screenshots/devices/warning_popup.png` |

来源为 [HarmonyOS_Samples/component-collection](https://gitee.com/harmonyos_samples/component-collection) 的本地参考源码，提交 `38a78a4aedfbf332ecc5da768b55d28d416474f0`；图片与该副本逐字节一致。该提交尚未与官方远端独立核对，详见[示例说明](../../examples/component-collection/README.md)。

原项目版权声明为 `Copyright (c) 2023 Huawei Device Co., Ltd. All rights reserved.`，采用 Apache License 2.0。本目录保留原文 [LICENSE](LICENSE)。

按钮图展示按钮类型、状态效果及自定义样式；弹窗图展示 AlertDialog 示例页上的入口和设置，图中未展开弹窗。实际测试流程见 [ComponentCollection 用例](../../examples/component-collection/README.md)。
