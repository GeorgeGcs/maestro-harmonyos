# Maestro HarmonyOS

为 Maestro 增加 HarmonyOS 原生 UI 自动化测试能力，参与「课题 11：YAML 声明式 UI 测试框架 Maestro 支持鸿蒙」。

**当前进度：已提交技术方案与开发计划，本机工具检查通过。鸿蒙驱动、录屏和 VSCode 扩展尚未实现，尚未完成 Maestro 编译或真机验证。**

## 目标

复用 Maestro 的标准 YAML、Flow、参数、条件分支和执行结果，为鸿蒙设备新增驱动与 CLI 接入。通过 HDC/UITest 获取 ArkUI 布局树并执行操作，补齐等待、重试、视频录屏、批量执行和 VSCode 操作录制辅助。

本项目是独立社区适配项目，与 Maestro 上游及操作系统厂商不存在官方隶属关系。

## 开发资料

- [课题开发技术方案](docs/technical-plan.md)：实现办法、主要风险和测试安排。
- [开发里程碑计划](docs/milestones.md)：10 月 28 日至 12 月 23 日的阶段任务、交付物和完成标准。
- [验收清单与证据要求](docs/acceptance.md)
- [开发环境与上游接入](docs/setup.md)
- [仓库发布与活动启动事项](docs/publishing.md)
- [2026-10-28 启动记录](docs/progress/2026-10-28.md)
- [第三方依赖及 AI 辅助开发记录](THIRD_PARTY.md)

## 目录

```text
docs/                   技术方案、里程碑、验收与进展
scripts/                环境检查、固定版本上游获取
patches/maestro/         后续对 Maestro 的适配补丁
packages/vscode/        后续 VSCode 扩展
examples/flows/          标准 YAML 流程设计示例
upstream.lock.json      上游来源与固定提交
.upstream/maestro/      本地上游工作副本（不提交）
```

本仓采用「固定上游提交 + 可回放补丁 + 辅助工具」方式组织适配成果。后续驱动补丁直接修改真实 Maestro 的 Driver、平台识别和 CLI 会话代码；不另写一个仅支持部分语法的 YAML 执行器。

## 开始开发

在 PowerShell 中执行：

```powershell
./scripts/check-environment.ps1
./scripts/prepare-upstream.ps1
```

第一个命令检查本机工具是否可用；第二个命令需要联网并获取固定提交的上游源码，不安装依赖或执行构建。当前仓库没有可运行的鸿蒙版 Maestro 命令，示例 YAML 需在驱动实现后验证。

## 活动交付

计划交付日期：**2026-12-23（北京时间）**。报名资格、确认时间及验收场景范围以活动组确认为准。项目进度至少每 7 个自然日记录一次。

- [活动规则](https://atomgit.com/org/harmony-connect/discussions/1)
- [课题 11 交付要求](https://atomgit.com/harmony-connect/topic-details-and-delivery#topic-11)

## 许可证

本仓新增内容采用 [Apache-2.0](LICENSE)。保留所有引入的上游许可证、版权声明和 NOTICE；参见 [贡献说明](CONTRIBUTING.md)。
