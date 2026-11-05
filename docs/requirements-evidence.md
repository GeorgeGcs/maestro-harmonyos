# 命令行、CI 与录制辅助的验证证据

更新日期：2026-11-05。这里把可执行入口、已完成的验证和保留产物对应起来。各次结果保留原日期、版本和范围，主机测试、真机运行与 CI 服务平台联调分别记录。

| 能力要求 | 当前响应 | 已有证据 |
| --- | --- | --- |
| 单命令批量执行 | CLI 接受 Flow 目录，运行器保留原退出码 | ComponentCollection 四条 Flow 在一次 CLI 调用、同一设备会话中 **4/4 通过**，退出码 0，清理完成，见[同会话批次](progress/2026-11-01.md#同会话录屏批次) |
| 标准报告输出 | 保留 Maestro 原生 JUnit、结果、步骤与证据索引；CI 另输出执行及质量记录 | 两条真机 Flow 的原生 JUnit 为 **2 tests / 0 failures**；CLI 与 CI 入口均退出 0，见[固定输入与场景核验](progress/2026-10-30-followup.md#通用-ci-的固定输入与场景核验) |
| 可接入 CI/CD | 提供无交互的 PowerShell 入口、退出码、固定输入核验、设备占用及独立归档入口；本机连接真机验证通过 | 成功、预期断言失败、超时停止及恢复已有记录；成功批次归档 **40 文件、0 问题**，见[CI 归档记录](progress/2026-10-30-followup.md#ci-执行证据归档)。具体 CI 服务平台尚未配置 |
| VSCode 语法高亮及操作录制辅助 | 复用 VSCode YAML 高亮，提供片段；截图或控件树点选后执行动作、生成标准 YAML、保存并交给 CLI 回放 | 真实面板完成 **8 步**录制、逐字一致的 YAML 保存和回放，见[真机结果](progress/2026-10-29.md#真机结果)；另有交付版[两步保存回放](progress/2026-11-04-delivery.md#最终-vsix-的真实回放) |

## 批量执行与报告

ComponentCollection 的按钮、弹窗、输入和滚动 Flow 曾在同一 CLI 会话内运行，4/4 通过、未添加自动重试，进程退出 0、`cleanup=complete`。该批还核对了 111 个步骤和 25 份引用文件。它证明目录批量执行及收尾链路可用，属于一次批量验证，不与后续 20 轮统计混算。

HMOS 完整套件另有固定版本 **20/20 轮首次通过**，每轮包含三个场景及回程导航，全部正常清理、无人工干预。该批关闭视频录屏；对应单轮的 JUnit 为 SUCCESS、0 failures，见[单轮与完整套件记录](progress/2026-11-05-hdc-cleanup.md)。

以下是 10 月 30 日两条 Flow 批次中原始记录的字段摘录。省略设备标识、路径和运行编号，未修改这些结果值：

| 原始产物 | 已核对的值 |
| --- | --- |
| `junit.xml` | `tests=2`、`failures=0`，两个 `testcase` 均为 `SUCCESS` |
| runner 控制记录 | `phase=exited`、`processExitCode=0`、`wrapperExitCode=0`，stdout/stderr 均收集完整 |
| `ci-result.json` | `execution=passed`、`state=released`、`wrapperExitCode=0` |
| `ci-quality.json` | `status=passed`、`execution=passed`、`cleanup.state=complete`、清理错误为空 |
| `archive-manifest.json` | `status=complete`，40 个文件，`issues=[]` |

此批使用当时已安装 CLI 的观察指纹，不能据此宣称完成了当前发行版的隔离构建。当前发布文件的构建、完整文件清单及自测单独见 [v0.1.1 交付说明](releases/0.1.1.md)。本仓的基础报告为 Maestro/JUnit 与结构化结果；上层鸿测提供的 HTML 报告按[鸿测 Agent](https://gitcode.com/HarmonyPandaWorkshop/hongce-agent)的验证记录分别说明。

## CI/CD 接入

可直接使用的公开入口：

- [套件清单模板](../examples/ci/suite.example.json)：声明应用、Flow 目录、顶层场景、参数名和构建记录。
- [执行入口](../scripts/ci/run-device-suite.ps1)：固定输入，执行 CLI，核对 JUnit、结果与设备释放，返回真实退出码。
- [归档入口](../scripts/ci/collect-artifacts.mjs)：按本次运行的明确引用收集报告、日志和证据，生成 `archive-manifest.json`。
- [接入说明](ci.md)：Windows runner 环境、共享设备状态目录、时间预算、异常核销及独立归档步骤。

真实设备上的成功、失败和超时路径均有记录。预期断言失败返回非零，已确认清理时可释放设备；强制停止后无法确认终态则保留 unknown、阻止接管，取得有效恢复凭据后才核销占用。另有开启视频策略的本机真机联动：原执行、视频质量检查、CI 入口及 44 文件归档均通过，见[带视频的 CI 记录](progress/2026-10-30-followup.md#带视频的通用-ci-真机联动)。

因此，命令行执行、报告输出和可由 CI/CD 调用的接口已有实现与运行证据。实际平台的 runner 注册、作业触发、平台直接取消或硬停、报告上传尚未联调，不能写成某个 CI 服务已经通过。接入时，应把归档安排为独立的 always-run 步骤，并为工具执行、清理、校验和上传分别预留时间。

## VSCode 录制、保存与回放

| 记录 | 实际执行范围 | 结果 |
| --- | --- | --- |
| [10 月 29 日真实 Webview](progress/2026-10-29.md#真机结果) | 启动、断言、截图点选输入框、输入、内容断言、返回、滑动、截图，共 8 步 | 保存文件与面板生成 YAML 逐字一致；CLI 回放退出 0，设备锁释放，录制步骤保留 |
| [10 月 30 日实装扩展](progress/2026-10-30-followup.md#实际录制面板的保存与回放) | 实际鼠标键盘操作面板、从控件树选目标、保存对话框写出三步 YAML、点击回放 | 原 CLI 退出 0；录制与回放会话均正常清理 |
| [11 月 4 日交付版](progress/2026-11-04-delivery.md#最终-vsix-的真实回放) | `728859cb` CLI 与同版 VSIX：可见断言、截图两步，保存并回放 | 未使用重试，录制与回放会话均为 clean |
| [v0.1.1 发布包](releases/0.1.1.md) | 插件版本与安装说明更新；24 项单元测试，VSIX 14 文件内容核验 | 主机核验通过；此次打包没有重新执行真实面板操作，不扩大既有真机结论 |

当前录制的是插件发出的动作，不监听手机手工触摸。产物使用标准 Maestro YAML，由已有 CLI 解析执行。操作录制辅助与系统视频录屏是两条能力，不能用其中一项的成功代替另一项。使用方法见[插件说明](../packages/vscode/README.md)。

原始日志、YAML、JUnit、截图、运行控制记录及校验材料在本地保留；公开文档提供运行范围和证据索引。分享原件前应处理设备标识、机器路径和应用数据，不能将去除敏感信息后的展示材料称为原始文件。
