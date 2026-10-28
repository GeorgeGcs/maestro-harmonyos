# Maestro HarmonyOS

为 Maestro 增加 HarmonyOS 原生 UI 自动化测试能力，参与「课题 11：YAML 声明式 UI 测试框架 Maestro 支持鸿蒙」。

**当前进度：M3 部分完成。** 标准 YAML 已在一台真机上通过启动、定位、中文输入、滑动后重新定位、断言和截图，单设备批量执行 2/2 通过。

VSCode 操作录制辅助已提供 0.1.0 VSIX。在 VSCode 1.140 和现有 ALN-AL80 / API 26 真机上，8 步录制、YAML 保存和一键 CLI 回放通过。逐台设备验证工具也已在该设备执行 1/1 通过；第二台设备和正式 20 轮尚未验证。

实验性的 Huawei 系统录屏后端默认关闭。正常流程已实测，失败流程也能自动停止、导出视频；短视频出现过尾部解码错误，原样复跑通过，偶发原因尚未查明。

## 目标

复用 Maestro 的标准 YAML、Flow、参数、条件分支和执行结果，为鸿蒙设备新增驱动与 CLI 接入。通过 HDC/UITest 获取 ArkUI 布局树并执行操作，补齐等待、重试、视频录屏、批量执行和 VSCode 操作录制辅助。

本项目是独立社区适配项目，与 Maestro 上游及操作系统厂商不存在官方隶属关系。

## 开发资料

- [课题开发技术方案](docs/technical-plan.md)：实现办法、主要风险和测试安排。
- [开发里程碑计划](docs/milestones.md)：10 月 28 日至 12 月 23 日的阶段任务、交付物和完成标准。
- [验收清单与证据要求](docs/acceptance.md)
- [开发环境与上游接入](docs/setup.md)
- [主机端测试与设备查询](host-tests/README.md)
- [VSCode 录制插件](packages/vscode/README.md)、[本地通信协议](docs/recorder-protocol.md)
- [逐台设备验证](docs/device-matrix.md)
- [仓库发布与活动启动事项](docs/publishing.md)
- [2026-10-28 启动记录](docs/progress/2026-10-28.md)
- [2026-10-29 插件与逐台验证](docs/progress/2026-10-29.md)
- [第三方依赖及 AI 辅助开发记录](THIRD_PARTY.md)

## 目录

```text
docs/                   技术方案、里程碑、验收与进展
scripts/                环境检查、固定版本上游获取
patches/maestro/         驱动、CLI 和测试补丁
host-tests/              不依赖设备的编译和测试入口
packages/vscode/        VSCode 操作录制扩展、测试和打包入口
examples/flows/          参数化的标准 YAML 示例
upstream.lock.json      上游来源与固定提交
.upstream/maestro/      本地上游工作副本（不提交）
```

本仓采用固定上游与补丁的方式维护适配代码，复用上游的 YAML 解析、Orchestra 执行和报告机制。鸿蒙驱动通过 HDC 调用设备上的 UITest，不需要另写一套 Flow 语法。

## 开始开发

在 PowerShell 中执行：

```powershell
if (Test-Path ./config.local.ps1) { . ./config.local.ps1 }
./scripts/check-environment.ps1
# 首次获取源码；已有适配改动时不要重复运行
./scripts/prepare-upstream.ps1
./scripts/test-host.ps1
```

测试入口会检查并应用补丁，首次运行需要下载 Gradle 和依赖。默认测试不操作手机；完整驱动、YAML 集成和 CLI 会话的测试命令见[主机测试说明](host-tests/README.md)。

构建 CLI 后，可用 [run-harmonyos.ps1](scripts/run-harmonyos.ps1) 运行单个 YAML 或流程目录。脚本加载本地配置，为每次运行创建产物目录，并保留 CLI 退出码；PowerShell 7 和 Windows PowerShell 5.1 的中文、引号参数回归已通过。参数和编码限制见[环境与使用说明](docs/setup.md)。

安装录制插件后，可在 VSCode 查看截图和控件树，点选控件、执行动作、保存标准 YAML，再交由 CLI 回放。第一版只记录插件发出的操作，不监听手机上的手动触摸。截图按操作刷新；旋转或尺寸改变后需要重新连接。安装、配置和使用步骤见[插件说明](packages/vscode/README.md)。

示例包括 [input-smoke.yaml](examples/flows/input-smoke.yaml)（输入与截图）、[scroll-input.yaml](examples/flows/scroll-input.yaml)（滑动后重新定位输入框）、[recording-smoke.yaml](examples/flows/recording-smoke.yaml)（视频录屏）和 [smoke.yaml](examples/flows/smoke.yaml)（按控件 ID 点击）。需按测试应用提供包名、启动 Ability 和页面文字。

视频录屏需要显式设置 `MAESTRO_HARMONYOS_RECORDING=huawei-system`。该后端依赖 Huawei 系统录屏服务和 `mediatool`，不是通用 OpenHarmony 接口；测试期间需独占系统录屏，不要手工切换。默认最长 3 分钟、导出上限 512 MiB，详细限制见[录屏说明](docs/setup.md#视频录屏)，正常与失败视频的实测结果见[验收记录](docs/acceptance.md)。

每个 CLI 会话操作一台本机 HDC 设备，可批量运行 Flow；[矩阵脚本](docs/device-matrix.md)按指定设备列表逐台调用并汇总结果。HAP 安装、权限修改、清除应用数据、Studio/MCP 和多设备分片尚未支持。已通过的流程使用本地演示应用，不代替活动约定的官方示例、20 轮统计或跨设备兼容验证。

## 活动交付

计划交付日期：**2026-12-23（北京时间）**。报名资格、确认时间及验收场景范围以活动组确认为准。项目进度至少每 7 个自然日记录一次。

- [活动规则](https://atomgit.com/org/harmony-connect/discussions/1)
- [课题 11 交付要求](https://atomgit.com/harmony-connect/topic-details-and-delivery#topic-11)

## 许可证

本仓新增内容采用 [Apache-2.0](LICENSE)。保留所有引入的上游许可证、版权声明和 NOTICE；参见 [贡献说明](CONTRIBUTING.md)。
