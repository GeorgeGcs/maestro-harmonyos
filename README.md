# Maestro HarmonyOS

**用标准 Maestro YAML 编写鸿蒙应用的界面自动化测试。** 在电脑上连接鸿蒙设备，自动启动应用、查找控件、点击、输入、滑动、检查结果，并保存截图和运行报告。

例如，应用修改了一个输入页面，可以把“打开页面 → 找到输入框 → 输入中文 → 检查文字 → 保存截图”写成一个 Flow，之后重复执行，检查改动有没有影响原有行为。VSCode 插件可以通过截图和控件树辅助生成这些步骤。

这套工具运行在开发或测试电脑上，面向鸿蒙应用开发者和测试人员。测试应用需提前安装；使用本工具不需要在应用中加入 ArkTS/HAR 运行依赖。本项目是独立社区适配项目，与 Maestro 上游及操作系统厂商不存在官方隶属关系。

## 项目包含什么

| 部分 | 用途 |
| --- | --- |
| Maestro 鸿蒙适配与 CLI | 复用 Maestro 的 YAML 解析、Flow 编排和报告，通过 `HarmonyOSDriver → HDC / UITest` 操作设备 |
| VSCode 操作录制插件 | 显示设备截图和控件树，选择控件并执行动作，生成 YAML，保存并回放 |
| 运行与逐台验证脚本 | 运行单个 Flow 或流程目录，按指定设备和轮次顺序执行，保存各轮结果与环境信息 |
| 智能体调用接口与示例 | 查询执行条件、调用设备动作、读取结果和证据，取消后核对清理并交接设备 |

适合把重复的界面检查写成可执行流程，也适合给应用版本回归保留结果和失败材料。现有测试集中在原生控件可被 UITest 读取的页面；自绘界面、缺少可识别节点的控件及其他系统版本，需要另行验证。

VSCode 的“操作录制”记录通过插件发出的动作，不监听手机上的手工触摸。“视频录屏”是另一个可选功能，当前默认关闭并标为实验性能力。

## 从哪里开始

| 你要做什么 | 阅读入口 |
| --- | --- |
| 第一次安装、运行自己的应用测试 | [使用指南](docs/user-guide.md)：环境、源码构建、第一条流程、插件、报告与排错 |
| 了解实现、接手开发或扩展命令 | [开发设计文档](docs/development-design.md)：模块职责、执行过程、数据转换、会话与错误处理 |
| 查看工具参数、环境配置和录屏限制 | [环境与运行参考](docs/setup.md) |
| 使用或开发 VSCode 插件 | [插件说明](packages/vscode/README.md)、[本地通信协议](docs/recorder-protocol.md) |
| 接入智能体或自动化调用方 | [调用协议](docs/agent-protocol.md)、[可运行的 Node.js 示例](examples/agent-client/README.md)：环境查询、结果、证据和取消恢复；需重新构建本仓库 CLI |
| 按多台设备或多轮执行同一流程 | [逐台验证说明](docs/device-matrix.md) |
| 准备 ComponentCollection 的交互验证 | [按钮、弹窗、输入和滚动示例](examples/component-collection/README.md)，当前仅静态解析通过 |
| 冻结场景、核对覆盖并分开统计首次与最终成功 | [重复验证计划](docs/validation-plan.md) |
| 接入专用 Windows CI 主机 | [CI 入口与设备占用](docs/ci.md) |
| 检查录屏及恢复保留的媒体 | [录屏检查与恢复](docs/recording-diagnostics.md) |
| 维护无法确认旧命令结束的设备会话 | [Windows 与手机依次重启的维护流程](docs/session-maintenance.md)，完整真机流程待验证 |
| 排查源码构建与资源下载 | [构建复现说明](docs/build-reproducibility.md) |
| 为项目贡献代码 | [贡献说明](CONTRIBUTING.md)、[主机测试说明](host-tests/README.md) |

当前使用方式是从源码构建包含适配补丁的 CLI，再按需打包安装 VSIX。普通 Maestro 安装包不能替代本项目构建出的鸿蒙版本；VSIX 本身也不包含 Java、HDC 或 CLI。

## 目录

```text
docs/                   用户指南、开发设计、测试计划与进展
scripts/                源码准备、补丁、测试、运行及逐台验证
patches/maestro/         驱动、CLI 和测试补丁
host-tests/              不依赖设备的编译和测试入口
packages/vscode/        VSCode 操作录制扩展、测试和打包入口
examples/flows/          参数化的标准 YAML 示例
examples/agent-client/   智能体协议客户端和流程示例
upstream.lock.json      上游来源与固定提交
.upstream/maestro/      本地上游工作副本（不提交）
```

本仓用固定上游加补丁的方式交付 Kotlin 实现；VSCode 扩展和辅助脚本直接保存在本仓。修改 `.upstream/maestro` 后必须更新补丁，其他贡献者才能获得同一实现。对应源码位置和更新方法见[开发设计](docs/development-design.md)及[补丁说明](patches/maestro/README.md)。

## 一个使用例子

仓库中的 [input-smoke.yaml](examples/flows/input-smoke.yaml) 执行：启动应用 → 检查标题 → 按提示找到输入框 → 输入文字 → 检查输入内容 → 返回 → 再检查标题 → 截图。

按[使用指南](docs/user-guide.md)完成首次构建后，在仓库根目录运行：

```powershell
./scripts/run-harmonyos.ps1 `
  -FlowPath ./examples/flows/input-smoke.yaml `
  -BundleId org.example.demo -AbilityName EntryAbility -Module entry `
  -Env @{ START_TEXT = '输入演示'; INPUT_HINT = '请输入姓名'; INPUT_TEXT = '熊猫测试' }
```

包名、Ability、模块名、页面文字和输入提示都要替换为自己的应用信息。运行前解锁手机并准备一个空输入框；此示例假定返回后仍能看到 `START_TEXT`。运行脚本会建立独立产物目录，保留实际 CLI 退出码，不自动安装应用、清除应用数据或修改权限。

定位失败、流程修改和报告查看方法见[使用指南](docs/user-guide.md)。其他示例包括 [scroll-input.yaml](examples/flows/scroll-input.yaml)（滑动后重新定位输入框）、[smoke.yaml](examples/flows/smoke.yaml)（按 ID 点击）及 [recording-smoke.yaml](examples/flows/recording-smoke.yaml)（实验性视频录屏）。

## 当前可用程度

截至 2026-10-30，已有以下验证记录：

- 一台 ALN-AL80 / API 26 真机通过标准 YAML 的启动、文字定位、中文输入、断言、返回、滑动后重新定位和截图；单设备批量执行 2/2 通过。
- VSCode 插件 0.1.0 在 VSCode 1.140 上完成真实面板的 8 步录制、YAML 保存和一键 CLI 回放；逐台验证脚本在同一设备执行 1/1 通过。
- 智能体 v2 接口及公开客户端在同一设备完成取消、跨进程阻止接管、凭证据恢复和 CLI 接管；截图后的桥接进程退出恢复也通过。
- 可选 Huawei 系统录屏已验证正常流程和失败收尾；短视频曾出现尾部解码错误，原因尚未查明，仍默认关闭。
- 通用 CI 入口已在本机连接真机完成固定输入、原生报告核验、视频完整解码和证据归档；尚未接入 CI 服务平台。

以上使用本地演示应用。新版执行底座另完成连续 3 轮启动、断言、截图与释放的短测；第二台真机、其他系统版本和长期稳定性测试尚未完成。重试证据、保留录屏恢复、通用 CI 入口及隔离构建的新增结果见 [10-30 进展](docs/progress/2026-10-30.md)；录屏持续时长、组合故障和面板回放的补验见[后续记录](docs/progress/2026-10-30-followup.md)。前期记录见 [10-28 进展](docs/progress/2026-10-28.md)、[10-29 进展](docs/progress/2026-10-29.md)。功能范围见[环境参考](docs/setup.md#已实现与限制)。

最新阶段新增验证计划 v3 的静态依赖冻结、会话日志写入容错及只读主机启动观察。新增示例应用目前仅首页流程通过，完整交互和当前版本的最终整体验证仍待完成；缺少命令完成凭据的旧会话继续阻止自动接管。已交付范围、近期验证与问题集中列在[阶段说明](docs/progress/2026-10-30-stage.md)。

目前没有 HAP 安装、权限修改、清除应用数据、Studio/MCP、多设备分片和云端运行支持。每个 CLI 会话只操作一台本机 HDC 设备，逐台验证脚本依次建立这些会话。

## 测试与维护

- [测试计划与验证记录](docs/acceptance.md)：测试场景、结果和重复运行的统计方法。
- [协议与磁盘文件格式](docs/protocol/README.md)：agent、重试、录屏和验证计划的版本与 Schema。
- [第三方依赖及 AI 辅助记录](THIRD_PARTY.md)。

## 许可证

本仓新增内容采用 [Apache-2.0](LICENSE)。保留所有引入的上游许可证、版权声明和 NOTICE；参见 [贡献说明](CONTRIBUTING.md)。
