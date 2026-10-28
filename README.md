# Maestro HarmonyOS

为 Maestro 增加 HarmonyOS 原生 UI 自动化测试能力，参与「课题 11：YAML 声明式 UI 测试框架 Maestro 支持鸿蒙」。

**当前进度：已完成首批主机模块，包括 HDC 调用、设备选择、布局读取与转换。完整鸿蒙驱动尚未接入 Maestro CLI，录屏和 VSCode 扩展尚未实现。**

## 目标

复用 Maestro 的标准 YAML、Flow、参数、条件分支和执行结果，为鸿蒙设备新增驱动与 CLI 接入。通过 HDC/UITest 获取 ArkUI 布局树并执行操作，补齐等待、重试、视频录屏、批量执行和 VSCode 操作录制辅助。

本项目是独立社区适配项目，与 Maestro 上游及操作系统厂商不存在官方隶属关系。

## 开发资料

- [课题开发技术方案](docs/technical-plan.md)：实现办法、主要风险和测试安排。
- [开发里程碑计划](docs/milestones.md)：10 月 28 日至 12 月 23 日的阶段任务、交付物和完成标准。
- [验收清单与证据要求](docs/acceptance.md)
- [开发环境与上游接入](docs/setup.md)
- [主机端测试与设备查询](host-tests/README.md)
- [仓库发布与活动启动事项](docs/publishing.md)
- [2026-10-28 启动记录](docs/progress/2026-10-28.md)
- [第三方依赖及 AI 辅助开发记录](THIRD_PARTY.md)

## 目录

```text
docs/                   技术方案、里程碑、验收与进展
scripts/                环境检查、固定版本上游获取
patches/maestro/         主机端适配代码和测试补丁
host-tests/              不依赖设备的编译和测试入口
packages/vscode/        后续 VSCode 扩展
examples/flows/          标准 YAML 流程设计示例
upstream.lock.json      上游来源与固定提交
.upstream/maestro/      本地上游工作副本（不提交）
```

本仓采用固定上游与补丁的方式维护适配代码。当前补丁在上游 `maestro-client` 中增加主机端模块和测试，后续再接入 Driver、平台识别和 CLI 会话。

## 开始开发

在 PowerShell 中执行：

```powershell
if (Test-Path ./config.local.ps1) { . ./config.local.ps1 }
./scripts/check-environment.ps1
# 首次获取源码；已有适配改动时不要重复运行
./scripts/prepare-upstream.ps1
./scripts/test-host.ps1
```

测试入口会检查并应用补丁，首次运行需要下载 Gradle 和依赖。它编译同一份适配源码并运行主机测试，不操作手机。具体范围与设备查询方法见[主机测试说明](host-tests/README.md)。当前还不能执行鸿蒙 YAML Flow，示例需在驱动接入后验证。

## 活动交付

计划交付日期：**2026-12-23（北京时间）**。报名资格、确认时间及验收场景范围以活动组确认为准。项目进度至少每 7 个自然日记录一次。

- [活动规则](https://atomgit.com/org/harmony-connect/discussions/1)
- [课题 11 交付要求](https://atomgit.com/harmony-connect/topic-details-and-delivery#topic-11)

## 许可证

本仓新增内容采用 [Apache-2.0](LICENSE)。保留所有引入的上游许可证、版权声明和 NOTICE；参见 [贡献说明](CONTRIBUTING.md)。
