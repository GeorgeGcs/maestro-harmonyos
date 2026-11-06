# Maestro HarmonyOS

**用标准 Maestro YAML 编写鸿蒙应用的界面自动化测试。** 在电脑上连接设备，查找控件、点击、输入、滑动和检查结果，保存截图与运行报告。应用改版后可以重复执行同一个 Flow，检查原有操作是否仍然正常。

工具运行在开发或测试电脑上，测试应用需提前安装，无需引入 ArkTS/HAR 运行依赖。本项目是独立社区适配项目，与 Maestro 上游及操作系统厂商不存在官方隶属关系。

**让 Agent 调用测试：[鸿测 Agent 开源仓库](https://gitcode.com/HarmonyPandaWorkshop/hongce-agent)。** 鸿测基于本项目提供 MCP、CLI 和 HTTP 接口，负责提交回归任务、查询执行状态和交付 HTML 报告。接入方式见下方 [Agent 接入](#agent-接入)。

**下载 v0.1.2：** [便携包（含 CLI、脚本和示例）](https://gitcode.com/HarmonyPandaWorkshop/maestro-harmonyos/releases/download/v0.1.2/maestro-agent-75470f36.zip) · [独立 CLI](https://gitcode.com/HarmonyPandaWorkshop/maestro-harmonyos/releases/download/v0.1.2/maestro-harmonyos-cli-75470f36.zip) · [VSCode 插件](https://gitcode.com/HarmonyPandaWorkshop/maestro-harmonyos/releases/download/v0.1.2/maestro-harmonyos-recorder-0.1.1-75470f36.vsix) · [SHA-256 校验值](https://gitcode.com/HarmonyPandaWorkshop/maestro-harmonyos/releases/download/v0.1.2/SHA256SUMS)。安装方法见[交付说明](docs/releases/0.1.2.md)。

## 交付进度

- **交付时间：** 具备交付条件后提前提交，最晚 2026 年 12 月 23 日。
- **当前进度：** **100%**（更新于 2026 年 11 月 6 日 00:33，北京时间，按本期功能、验证、文档与发行件的交付准备度统计）。功能开发、真机验证和交付包已完成，v0.1.2 的 6 个发行附件已上传。

Maestro 鸿蒙适配、YAML 执行、重试与报告、VSCode 辅助工具和通用 CI 入口已实现。手机固定版本的 HMOS 完整组件套件在同一台真机上 **20/20 轮首次通过，通过率 100%**；未使用 YAML 重试，人工干预、固定输入和执行证据均已复核，所有轮次正常清理。后续修复及平板验证单独记录，不替换这份版本基线。

[完整场景套件](examples/hmos-code-lab/flows/suite/README.md)串联中文输入、按钮样式、弹窗及回程导航。此前 ComponentCollection 前台单 Flow 和 HMOS 按钮样式单 Flow 的 20/20 结果单独保留；手机和平板的输入、弹窗开发验证也不与本次完整套件混算。

| 项目 | 状态 | 验证依据 |
| --- | --- | --- |
| 导航修复及完整场景单轮 | **通过** | 按钮定向回归 3 分 36 秒、完整单轮 12 分 51 秒；未使用重试，CLI 与 runner 退出码均为 0，`cleanup=complete` |
| HDC 诊断及最终清理核验 | **单轮与 20 轮收尾通过** | 501 项 JVM 回归通过；真机 20 轮清理完成，设备最终释放；23,114 次 HDC 调用日志已核对，本批未复现此前约 5 秒的超时故障 |
| 完整场景分段录屏 | **此前版本通过一次完整运行** | `728859cb` CLI 执行 12 分 55 秒，输入、按钮、弹窗三段原片均完整解码通过，清理完成 |
| 交付文件与插件回放 | **v0.1.2 包核验及真机验证通过** | `75470f36` 独立构建 CLI、VSIX 0.1.1 和便携包；458 个文件核验、三项便携包自测及 24 项插件测试通过。实际包完整单轮 Flow 9 分 46 秒通过，随后同版 CLI 平板 20/20 通过；此前真实 VSCode 保存回放记录保留 |
| 手机完整套件 20 轮稳定性 | **通过** | 11 月 5 日 01:20:50～05:38:24，20 轮耗时 **4 小时 17 分 34 秒**，单轮平均约 **12 分 52 秒**；固定版本 20/20 首次通过，100%，无重试、无人工干预，清理及证据复核通过 |
| HarmonyOS 7 平板补充验证 | **v0.1.2 完整套件 20/20 首次通过** | 11 月 5 日 20:30～23:59，约 **3 小时 29 分钟**；无重试、无人工干预，20 轮清理完成、设备正常释放。15,673 次已归档 HDC 调用无失败，见[平板记录](docs/progress/2026-11-06-tablet-v012.md)；旧失败批次保留 |

旧版 20 轮的四次失败均发生在顶部标题栏覆盖的按钮入口，20 轮清理均完成，执行期间无人工操作、重装或重启。当前修复针对示例页面，不提供通用遮挡检测；原始结果分别保留，详见[导航修复记录](docs/progress/2026-11-04-hmos-navigation.md)及[历史稳定性记录](docs/progress/2026-11-03-hmos-stability.md)。

长场景录屏留证和真实 VSCode 回放已有[验证记录](docs/progress/2026-11-04-delivery.md)。手机完整套件 20 轮结果见[手机记录](docs/progress/2026-11-05-hdc-cleanup.md#完整套件-20-轮)；平板新版本的 20 轮、人工干预复核及耗时见[平板记录](docs/progress/2026-11-06-tablet-v012.md)，两批分别统计。包含查询超时和长会话恢复修复的 [v0.1.2](docs/releases/0.1.2.md)已发布，实际 CLI 冒烟与平板长测均通过。实际 CI 平台部署、更多设备和 OpenHarmony 真机属于后续补充验证。20 轮批次录屏关闭，不将它记为录屏重复验证。

**测试时间成本：** 手机与平板分别执行完整场景套件，实测如下。

| 设备与记录 | 完整套件 20 轮耗时 | 单轮平均耗时 | 首次通过 |
| --- | --- | --- | --- |
| [手机](docs/progress/2026-11-05-hdc-cleanup.md#完整套件-20-轮) | **4 小时 17 分 34 秒** | 约 **12 分 52 秒** | **20/20，100%** |
| [平板](docs/progress/2026-11-06-tablet-v012.md) | 约 **3 小时 29 分钟** | 约 **10 分 25 秒** | **20/20，100%** |

耗时包含逐轮启动、执行和清理。两批分别保留各自的固定版本与设备环境，其他环境耗时会变化；上述数据不作为不同设备的性能对比。批次由脚本独立执行，两批均无重试、无人工干预，全部正常清理并释放设备。

## 背景与用途

Hypium、hmdriver2 等工具提供了代码式的鸿蒙 UI 测试能力。维护页面回归用例时，团队还需要组织测试代码、等待条件、失败处理和公共流程。已有其他移动平台用例的团队，也需要处理测试体系之间的迁移与复用。

本项目在 Maestro 中补充 `HarmonyOSDriver` 和 CLI 会话，沿用原有 YAML 解析、Flow 编排与报告。常见操作可以直接写成可读的测试步骤，通过子 Flow、参数、条件分支和显式 `retry` 组织用例，再从命令行或 CI 调用。跨平台可以复用用例组织方式，控件标识、应用配置及平台命令仍需按目标应用调整。

## 官方示例

新增 [HMOS 代码工坊](examples/hmos-code-lab/README.md)的固定版本获取入口。它来自华为 [HarmonyOS_Samples/sample_in_harmonyos](https://gitcode.com/HarmonyOS_Samples/sample_in_harmonyos)，手机和平板使用同一个 `phone` 模块；本仓补充前台常亮和 Maestro Flow。

```powershell
node examples/hmos-code-lab/prepare.mjs
```

脚本把完整工程准备到 `examples/hmos-code-lab/app`。用 DevEco 打开该目录，为自己的设备配置调试签名并运行，再按[单页用例说明](examples/hmos-code-lab/flows/README.md)执行。固定源码要求兼容 API 23、目标 API 24；源码下载约 360 MB，工程和本机签名配置均由 Git 忽略。无需下载其全部外部 Sample。

| 示例 | 用途与状态 |
| --- | --- |
| [HMOS 代码工坊](examples/hmos-code-lab/README.md) | 获取完整官方工程；输入和弹窗 Flow 已在手机与 API 26 平板各通过一次。原按钮 Flow 在两台设备上均未通过短暂 Toast 断言；按钮样式单 Flow 在手机固定版本 20/20 轮首次通过。11 月 5 日，输入、按钮、弹窗及回程导航组成的完整套件在手机上固定版本 20/20 轮首次通过，见[本轮记录](docs/progress/2026-11-05-hdc-cleanup.md#完整套件-20-轮)。旧失败批次分别保留，另见[平板记录](docs/progress/2026-11-03-hmos.md)与[历史稳定性记录](docs/progress/2026-11-03-hmos-stability.md)。 |
| [ComponentCollection](examples/component-collection/README.md) | 已有按钮、输入、弹窗、滚动用例及手机、平板的开发验证记录；手机前台单 Flow 连续 20/20 轮通过。运行前需自行准备应用。 |

### 页面预览

下面是 2026-11-03 在平板运行 HMOS 输入和弹窗 Flow 时保存的原始截图。测试条件与结果见[验证记录](docs/progress/2026-11-03-hmos.md)，图片来源见[图片说明](docs/images/README.md)。

| TextInput 输入验证 | AlertDialog 弹窗验证 |
| --- | --- |
| <img src="docs/images/hmos-code-lab-input-tablet.png" width="480" alt="HMOS 平板输入用例的原始截图，输入内容为 maestro-hmos"> | <img src="docs/images/hmos-code-lab-dialog-tablet.png" width="480" alt="HMOS 平板弹窗用例的原始截图，显示标题、正文和两个按钮"> |

## 跑一个 Flow

先按[使用指南](docs/user-guide.md)准备 JDK 17、Node.js 22.12+ 和 HDC。[v0.1.2 交付说明](docs/releases/0.1.2.md)列出 CLI、VSIX、便携包及校验方法；也可从固定上游和本仓补丁构建 CLI。普通 Maestro 安装包不能替代这个适配版本，插件不包含 Java、HDC 或 CLI。资源下载和缓存配置见[构建说明](docs/build-reproducibility.md)。

使用便携包时，在解压后的 `source` 目录执行下列脚本，并加上 `-CliDir ../cli`，无需重新编译 CLI。源码检出并构建的用户使用脚本默认路径即可。

以 [ComponentCollection 前台按钮用例](examples/component-collection/foreground/01-buttons.yaml)为例：应用已构建、签名并安装后，手动进入 **Button 按钮**页，保持应用前台、设备解锁，且胶囊按钮尚未点击。Flow 通过控件 ID 点击，并检查点击后的 ID：

```yaml
appId: ohos.samples.componentcollection
---
- assertVisible:
    id: Capsule
- tapOn:
    id: Capsule
    retryTapIfNoChange: false
- assertVisible:
    id: Capsule onClickId
- takeScreenshot: foreground-button
```

在仓库根目录执行，将 `YOUR_DEVICE_ID` 替换为 HDC 设备标识：

```powershell
$env:MAESTRO_HARMONYOS_RECORDING = 'off'
./scripts/run-harmonyos.ps1 `
  -FlowPath ./examples/component-collection/foreground/01-buttons.yaml `
  -BundleId ohos.samples.componentcollection -AbilityName MainAbility -Module entry `
  -DeviceId YOUR_DEVICE_ID -RunTimeoutSeconds 360
```

此用例停留在当前页面，适合依靠应用前台常亮的设备。再次运行前需恢复按钮初始状态；[前台单页用例](examples/component-collection/foreground/README.md)各有不同起始页面，一次只运行一个文件。需要自动导航和批量执行时，使用[完整场景入口](examples/component-collection/README.md)，按其要求准备应用。

测试自己的应用可从参数化的 [smoke.yaml](examples/flows/smoke.yaml)、[input-smoke.yaml](examples/flows/input-smoke.yaml)和 [scroll-input.yaml](examples/flows/scroll-input.yaml)开始。runner 保存独立产物目录和真实退出码；结果与排错方法见[使用指南](docs/user-guide.md)。

## 实现方式

```mermaid
flowchart LR
    YAML[标准 Maestro YAML] --> Orchestra[Maestro Orchestra]
    Orchestra --> Driver[HarmonyOSDriver]
    Driver --> HDC[HDC / UITest]
    HDC --> App[鸿蒙应用 / ArkUI]
    Orchestra --> Report[结果、截图与报告]
```

Maestro 负责解析、编排、等待和断言；适配层将 UITest 布局映射为 Maestro 节点，用文本、ID 等选择器定位控件，再调用设备操作。会话记录命令与临时资源的清理状态；无法确认释放时保留 `unknown` 并阻止接管，恢复不会改写原用例结果。

Kotlin 实现采用固定上游加补丁的交付方式；VSCode 扩展、运行脚本和客户端示例直接保存在本仓。上游版本见 [upstream.lock.json](upstream.lock.json)，模块职责与执行过程见[开发设计](docs/development-design.md)，更新实现的方法见[补丁说明](patches/maestro/README.md)。

## Agent 接入

### 通过鸿测 Agent 提交回归任务

**开源地址：[https://atomgit.com/HarmonyPandaWorkshop/hongce-agent](https://atomgit.com/HarmonyPandaWorkshop/hongce-agent)**

需要让 Agent 执行已有 YAML 并交付报告时，可使用鸿测 Agent。它将本项目的 CLI 封装为独立 worker，提供任务提交、请求去重、状态查询、证据核验和 JSON/HTML 报告。Maestro HarmonyOS 负责实际设备操作与会话清理；上层 Agent 按宿主能力选择 MCP、CLI 或 HTTP，调用同一个 worker。

1. 按本仓[使用指南](docs/user-guide.md)准备 CLI、Java、HDC 和已安装的目标应用，先跑通所需 Flow。
2. 按[鸿测 README](https://gitcode.com/HarmonyPandaWorkshop/hongce-agent/blob/main/README.md)部署 worker，在本地 JSON 配置中绑定设备、实际 CLI 分发包及其指纹，并登记应用和 Flow。配置模板见 [device-config.example.json](https://gitcode.com/HarmonyPandaWorkshop/hongce-agent/blob/main/device-config.example.json)。鸿测通过 `HONGCE_MAESTRO_CONFIG` 读取此 JSON，本仓的 `config.local.ps1` 仅配置底层工具路径。
3. 将鸿测的通用回归 Skill 和所选协议入口接到 Agent，按已登记的用例提交任务，保存 `request_id` / `run_id`，查询终态并读取报告。完整配置与调用示例见[鸿测真机执行指南](https://gitcode.com/HarmonyPandaWorkshop/hongce-agent/blob/main/docs/worker-device-execution.md)。

配置完成后，可以对 Agent 说：“执行这个应用已登记的冒烟回归，结束后给我 HTML 报告，说明失败、阻塞和未执行项。”鸿测当前执行已登记的 YAML，真实用例不自动修改或重放；现有执行器关闭录屏，`cleanup=unknown` 不会算作通过。完整套件的首次通过率与录屏验证仍按本仓[验证计划](docs/validation-plan.md)执行。

### 直接接入底层协议

[Node.js 客户端](examples/agent-client/README.md)通过本地 JSONL 协议查询环境、执行动作、校验结果与证据，并确认设备释放。下面的调用检查当前页面文字并截图；先手动打开测试页面，替换设备、应用和断言内容：

```powershell
node examples/agent-client/run.mjs `
  --device 'YOUR_DEVICE_ID' `
  --app 'org.example.demo' --ability 'EntryAbility' `
  --assert-text '替换为页面上的确定文字' `
  --artifacts './artifacts/agent-example'
```

默认使用本仓构建的 CLI；其他分发位置通过 `--cli-dir` 指定包含 `lib` 的目录。示例默认不启动应用，预检存在未知项时会停止。完整 YAML 可在设备释放后通过 `--handoff-flow` 交给 CLI；没有设备时先运行 [`--check-only` 检查](examples/agent-client/README.md#释放后运行-yaml)。协议字段见[调用协议](docs/agent-protocol.md)，换电脑联调见[便携包说明](docs/agent-bundle.md)。

## 能力与边界

| 能力 | 当前范围 |
| --- | --- |
| YAML 与 ArkUI 操作 | 支持 `tapOn`、输入、滑动、可见性断言、截图及 Flow 编排；具体命令见[已实现与限制](docs/setup.md#已实现与限制)。自绘界面或不可识别节点需单独验证。 |
| 报告与 CI | 支持 Flow/目录执行、Maestro 结果、JUnit 报告和 Windows CI 入口；实际 CI 服务平台尚未接入。首次与重试后的最终结果分别记录。 |
| VSCode 辅助编写 | 提供代码片段、截图与控件树选择、动作执行、YAML 生成和回放；记录插件发出的动作，不监听手机手工触摸。 |
| 视频与会话恢复 | 视频录屏默认关闭，Huawei 系统录屏仍为实验功能；完整场景三段原片均完整解码通过。长场景可使用[分段入口](examples/hmos-code-lab/flows/recorded-suite/README.md)。已确认锁屏拒绝、且未产生采集与媒体的旧资源可受控恢复；其他未知状态仍须逐案核查。 |

每个 CLI 会话操作一台本机 HDC 设备，[逐台验证脚本](docs/device-matrix.md)依次建立会话。目前本仓不提供 HAP 安装、权限修改、清除应用数据、Studio、内置 MCP 服务、多设备分片或云端运行；面向 Agent 的 MCP 服务由上述鸿测项目提供。

历史发行版 [v0.1.1](docs/releases/0.1.1.md)来自源码 `2d5bfaeb`；当前 [v0.1.2](docs/releases/0.1.2.md)来自 `75470f36`，在独立目录构建，复用声明的依赖缓存和已校验资源，没有复制旧编译产物。新包已完成主机核验、实际包单轮及同版 CLI 平板 20 轮验证。各批结果保留对应的源码、文件摘要和设备范围；后续文档提交不改变安装包的源码标识。

详细范围见[测试计划与记录](docs/acceptance.md)、[重复验证计划](docs/validation-plan.md)、[最新手机记录](docs/progress/2026-11-03-phone.md)和[平板验证记录](docs/progress/2026-11-01-tablet.md)。

## 文档与贡献

- 开始使用：[使用指南](docs/user-guide.md) · [环境与运行参数](docs/setup.md) · [HMOS 代码工坊](examples/hmos-code-lab/README.md) · [ComponentCollection 场景](examples/component-collection/README.md)
- 编写与接入：[VSCode 插件](packages/vscode/README.md) · [鸿测 Agent 开源仓库](https://gitcode.com/HarmonyPandaWorkshop/hongce-agent) · [Agent 客户端](examples/agent-client/README.md) · [便携联调包](docs/agent-bundle.md)
- 开发与维护：[开发设计](docs/development-design.md) · [贡献说明](CONTRIBUTING.md) · [主机测试](host-tests/README.md) · [第三方来源](THIRD_PARTY.md)

<details>
<summary>运行、协议及历史验证参考</summary>

- 执行：[逐台验证](docs/device-matrix.md) · [CI 入口与设备占用](docs/ci.md) · [构建复现](docs/build-reproducibility.md)
- 协议：[Agent 协议](docs/agent-protocol.md) · [录制桥接协议](docs/recorder-protocol.md) · [磁盘文件格式与 Schema](docs/protocol/README.md)
- 恢复：[录屏检查与恢复](docs/recording-diagnostics.md) · [顺序重启维护](docs/session-maintenance.md) · [不重启的清理隔离恢复](docs/cleanup-fence-recovery.md)
- 记录：[10-28](docs/progress/2026-10-28.md) · [10-29](docs/progress/2026-10-29.md) · [10-30](docs/progress/2026-10-30.md) · [10-30 补验](docs/progress/2026-10-30-followup.md) · [阶段说明](docs/progress/2026-10-30-stage.md)

</details>

## 许可证

本仓新增内容采用 [Apache-2.0](LICENSE)。引入内容保留原许可证、版权声明及适用的 NOTICE；文档图片的来源见[图片说明](docs/images/README.md)。

## 要求响应与验证证据

下表对应交付要求，结果以各条记录中的版本、设备和场景为准。批量执行、CI 和 VSCode 的原始报告字段及证据索引另见[验证证据](docs/requirements-evidence.md)。

| 要求 | 当前响应 | 证据与范围 |
| --- | --- | --- |
| 标准 Maestro YAML、ArkUI 选择器与通用操作 | 已有真机验证：启动、点击、中文输入、滑动、断言、截图 | [完整场景套件](examples/hmos-code-lab/flows/suite/README.md)及[单轮与 20 轮记录](docs/progress/2026-11-05-hdc-cleanup.md)；自绘控件和未暴露节点的页面须另测 |
| Flow 复用、参数化、条件分支 | 复用 Maestro 编排；完整套件实际调用子 Flow、传参、条件及循环 | [套件入口](examples/hmos-code-lab/flows/suite/01-components.yaml)、[场景说明](examples/hmos-code-lab/flows/suite/README.md) |
| 执行失败重试与尝试证据 | 标准 YAML retry 已有真机恢复和耗尽记录；首次与最终结果分开统计 | [重试恢复](docs/progress/2026-10-30.md#重试证据)、[重试耗尽](docs/progress/2026-10-30-followup.md#标准-yaml-重试耗尽)；稳定性分子不包含重试后才成功的轮次 |
| 执行过程录屏留证 | 完整场景三段原片均完整解码通过，正常清理 | [分段录屏记录](docs/progress/2026-11-04-delivery.md#完整场景与三段原片)；当前为可选 Huawei 系统后端，默认关闭 |
| 单命令批量执行 | 一次 CLI、同一会话执行四条 Flow，4/4 通过 | [同会话批次](docs/progress/2026-11-01.md#同会话录屏批次)；CLI 退出 0、清理完成 |
| 标准报告输出、可接入 CI/CD | 原生 JUnit、结构化结果、非零失败退出码和归档入口均有本机真机证据；具体 CI 平台尚未配置 | [报告与 CI 证据](docs/requirements-evidence.md#批量执行与报告)：两条 Flow 的 JUnit 为 2 tests / 0 failures，成功批次归档 40 文件、0 问题；[CI 入口](docs/ci.md) |
| VSCode 高亮与操作录制辅助，生成标准 YAML 并由 CLI 回放 | 真实 VSCode 八步录制、保存及回放通过；另有交付版两步回放记录 | [录制证据](docs/requirements-evidence.md#vscode-录制保存与回放)、[插件说明](packages/vscode/README.md)；当前记录插件动作，不捕获手机手工触摸 |
| 官方示例应用典型交互覆盖 | 采用固定版本 HMOS 代码工坊，套件覆盖输入、按钮、弹窗及导航 | [官方示例来源与获取](examples/hmos-code-lab/README.md)、[完整套件](examples/hmos-code-lab/flows/suite/README.md)；按所选场景核验，不声称覆盖应用全部功能 |
| 至少一台真实鸿蒙设备完整跑通，系统 OS 6.0.0 及以上 | 手机已有完整套件记录；HarmonyOS 7.0.0 平板同版 CLI 完整套件 20/20 通过，清理与释放通过 | [手机记录](docs/progress/2026-11-05-hdc-cleanup.md)、[平板 20 轮](docs/progress/2026-11-06-tablet-v012.md)；API 级别与产品系统版本分别登记 |
| 完整场景套件 20 轮，首次通过率 ≥95% | 手机与平板各自在固定环境 20/20 首次通过，100%；均无重试、无人工干预、全部清理完成；手机 20 轮 4 小时 17 分 34 秒，平板约 3 小时 29 分钟 | [手机 20 轮](docs/progress/2026-11-05-hdc-cleanup.md#完整套件-20-轮)、[平板补充验证](docs/progress/2026-11-06-tablet-v012.md)、[统计方法](docs/validation-plan.md)；版本、设备与结果分别统计，不混算 |
| 开源、完整使用文档与开发指南 | 源码、固定上游补丁、示例、CLI / VSIX / 便携包已公开 | [使用指南](docs/user-guide.md)、[开发设计](docs/development-design.md)、[贡献说明](CONTRIBUTING.md)、[v0.1.2 发行版](docs/releases/0.1.2.md) |
| 兼容建议：HarmonyOS 与 OpenHarmony，并说明差异 | HDC、UITest、aa 公共接口已对照可用；独立 OpenHarmony 真机尚未验证，无设备 | [平台兼容范围](docs/platform-compatibility.md)：文本命令版本、布局、权限、应用安装与 Huawei 录屏后端分别说明；不以共用底座替代设备测试 |
