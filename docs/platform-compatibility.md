# HarmonyOS 与 OpenHarmony 兼容范围

更新日期：2026-11-05。

当前结论：**HarmonyOS 已有真机执行记录；OpenHarmony 已完成公共接口与适配代码对照，尚无独立 OpenHarmony 设备的运行结果。** 共用接口为移植提供了基础，不能替代目标设备验证。

本项目的 `HarmonyOSDriver` 运行在电脑端，通过 HDC 调用设备的 UITest 和应用管理命令。它不把 ArkUI 库链接进 CLI，也不重写应用的 UI 框架。对另一套系统，首先应检查这些命令、布局数据和权限是否满足驱动约定；只有出现实际差异时，才需要增加对应适配。

## 系统版本与验证范围

| 记录 | 能说明什么 | 不能说明什么 |
| --- | --- | --- |
| [HMOS 完整场景套件 20 轮记录](progress/2026-11-05-hdc-cleanup.md#完整套件-20-轮) | 固定 CLI、用例、应用及同一台 HarmonyOS 手机环境下，20/20 轮首次通过，清理完成 | 不代表其他系统版本或设备型号的稳定性 |
| [2026-11-05 平板完整单轮](progress/2026-11-05-tablet.md)：HUAWEI MRDI-W00，系统发行名称 `HarmonyOS`，发行版本 `7.0.0`，API `26` | 系统版本满足 HarmonyOS 6.0.0 及以上；完整套件首次通过，57 个必测步骤完成、正常清理 | 单轮通过不能代替 20 轮稳定性结果；也不表示 HarmonyOS 6.0.0 本身已经测试 |
| 同一平板的 `const.ohos.fullname` 为 `OpenHarmony-7.0.0.111` | 设备另有这一底座版本标识 | 不能把这台 HarmonyOS 平板记作独立 OpenHarmony 真机，也不能把 API 26 等同于 OS 6.0 或 OpenHarmony 发布版本 |
| 独立 OpenHarmony 设备 | 已有接口对照，可按下文开展验证 | 当前没有真机通过记录，不标注为“已验证支持” |

产品系统版本、设备 API 级别和底座版本字符串分别记录。系统要求使用发行名称和发行版本核对；能力要求以目标镜像实际提供的命令及运行结果核对。

## 按能力对照

下表中的“共用基础”指可对照的接口，不表示本项目已经在所有 OpenHarmony 发行版运行过。

| 能力 | 当前实现及共用基础 | 需要在目标设备核对的差异 |
| --- | --- | --- |
| YAML、Flow、参数与断言 | 复用 Maestro 解析和编排，平台操作交给 `HarmonyOSDriver` | 语法可复用，具体命令仍受驱动支持范围约束，见[使用与限制](setup.md) |
| 设备连接、shell 与文件传输 | `hdc list targets`、`-t`、`shell`、`file recv` 均可在 [OpenHarmony HDC 文档](https://github.com/openharmony/developtools_hdc/blob/master/README_zh.md)中对照 | 镜像是否含设备端服务、主机 HDC 是否匹配、调试授权是否有效，以及 shell 和 `/data/local/tmp` 是否可用 |
| 点击、长按、滑动、按键 | 调用 `uitest uiInput`，按设备截图和布局的像素坐标执行 | 分辨率、窗口布局、焦点与命令回执可能不同；当前不提供多显示屏选择，不能假设手机坐标可直接用于平板 |
| 文本输入 | 先定位并点击输入框，再调用 `uitest uiInput text` | 该子命令从 API 18 提供，依赖当前焦点；当前驱动没有旧版 `inputText x y` 的自动降级。应检查实际命令能力，不能只看系统名称。[UITest 命令说明](https://github.com/openharmony/docs/blob/master/zh-cn/application-dev/application-test/uitest-guidelines.md#注入ui模拟操作) |
| ArkUI 控件定位 | `uitest dumpLayout -p` 后读取 JSON；`text`、`hint`、`id` / `key`、`type`、`bounds` 转成 Maestro 可用属性 | 当前解析 `attributes` / `children` 节点或窗口数组；`id` 优先、`key` 备选，作为稳定标识，运行时 `accessibilityId` 不替代它们。自绘内容或未暴露可访问属性的控件不保证可定位；字段或坐标格式变化需适配 |
| 启动和停止应用 | `aa start -b … -a …`，必要时加 `-m`；`aa force-stop …`。这些接口可在 [OpenHarmony aa 文档](https://github.com/openharmony/docs/blob/master/zh-cn/application-dev/tools/aa-tool.md)中对照 | 包名、Ability、模块、组件导出配置及系统策略必须允许调用；签名和应用安装单独完成。启动成功后还需断言实际页面，不能只认进程启动 |
| 截图 | `uitest screenCap -p`、HDC 接收 PNG、登记并清理临时文件 | 截图权限、图像尺寸、目标路径和传输结果需核验；当前走默认显示屏。该接口与视频录屏分别验证。[UITest 截图说明](https://github.com/openharmony/docs/blob/master/zh-cn/application-dev/application-test/uitest-guidelines.md#获取截图) |
| 视频录屏 | 可选 `huawei-system` 后端，依赖 `com.huawei.hmos.screenrecorder.ServiceExtAbility`、媒体工具和系统服务状态 | 这是 Huawei 系统录屏适配，不是通用 OpenHarmony shell 接口。OpenHarmony 上不推定存在这些服务；默认关闭，不能把截图通过等同于录屏通过。替换后端或辅助包方案目前不算已实现 |
| 会话与清理 | 主机登记操作、设备临时文件及录屏资源，核对命令完成和资源清理后释放设备 | 依赖目标 shell 工具与目录权限。超时或归属不明时保留未知状态，按[会话维护说明](session-maintenance.md)恢复，不能直接删记录作为成功 |
| 主机运行入口 | 本仓已交付 Windows PowerShell 脚本、CLI 和便携包 | HDC 本身有其他主机平台实现，不代表本仓脚本及发行包已在 Linux / macOS 验证 |

代码对照范围为[版本化适配补丁](../patches/maestro/0001-harmonyos-host.patch)中的 `HarmonyOSDriver`、`HdcHarmonyOSDevice`、`HierarchyReader`、`UitestLayoutParser` 和 `HarmonyOSSystemScreenRecorder`。输入回执校验还对照了[固定版本 UITest 服务源码](https://raw.githubusercontent.com/openharmony/testfwk_arkxtest/f59296c77aac5037a9335c317af58de3a0c22ecb/uitest/server/server_main.cpp)。官方 `master` 文档会随开发更新，不能据此假设旧设备已经包含全部命令。

### 权限与应用差异

目前基础操作通过已授权的 HDC shell 完成，不要求在目标应用中集成本项目的运行库。目标系统必须允许 UITest 注入、读布局、截图及临时文件传输；如果厂商镜像禁用了其中一项，应记录为该能力不可用。当前没有自动提权或修改设备安全策略的流程。

标准 YAML 可复用，不表示同一个 HAP 可以跨系统直接安装。测试应用仍需满足目标 SDK、设备类型、签名和所引用 Kit 的要求。HMOS 代码工坊在 HarmonyOS 上的验证，不能直接代替该应用在 OpenHarmony 上的构建和安装验证。

## 首次接入的核对步骤

先执行以下只读查询，记录工具、系统和设备信息。示例在 Windows PowerShell 中执行；将 `YOUR_DEVICE_ID` 换成 `list targets` 的目标值，不在公开报告中保留完整设备标识。

```powershell
$hdcPath = if ($env:MAESTRO_HARMONYOS_HDC) { $env:MAESTRO_HARMONYOS_HDC } else { 'hdc' }
$targetId = 'YOUR_DEVICE_ID'
& $hdcPath list targets
& $hdcPath -t $targetId shell param get const.product.os.dist.name
& $hdcPath -t $targetId shell param get const.product.os.dist.version
& $hdcPath -t $targetId shell param get const.product.software.version
& $hdcPath -t $targetId shell param get const.ohos.fullname
& $hdcPath -t $targetId shell param get const.ohos.apiversion
& $hdcPath -t $targetId shell uitest --version
& $hdcPath -t $targetId shell uitest help
& $hdcPath -t $targetId shell uitest uiInput help
& $hdcPath -t $targetId shell aa help
```

某项系统参数为空时记录“未提供”，不根据其他版本号补填。`uitest help` 应能找到布局、截图和输入能力，输入帮助应包含 `text`。帮助信息可用于筛选环境，最终仍需实际执行验证。

随后，在已安装并完成首次授权的测试应用上运行一个短 Flow，覆盖启动、按文本或 ID 定位、点击、中文输入、滑动、断言和截图。使用[运行入口](setup.md#运行脚本)或[CI 入口](ci.md)，由框架登记与清理资源；首轮先设 `MAESTRO_HARMONYOS_RECORDING=off`。应用保持前台和可交互状态，避免与其他 UITest 工具同时操作设备。

核验结果时，使用以下判断：

| 现象 | 结论与处理 |
| --- | --- |
| 找不到 HDC、目标设备或必需子命令 | 环境或能力不满足；保留诊断，不能按测试通过处理 |
| shell / HDC 退出码为 0，但 UI 没有完成动作 | 退出码不足以证明成功。当前驱动还要求 `uiInput` 返回 `No Error` 且没有标准错误输出；Flow 需要断言预期页面或内容 |
| 命令已执行，但回执与驱动约定不同 | 作为接口差异定位，保留原始输出；不要先放宽校验来取得通过结果 |
| 布局解析失败、选择器找不到或命中错误控件 | 对照实际布局字段、可见性、窗口与像素坐标，区分应用可访问性问题和驱动转换问题 |
| PNG 没有生成、传输失败或清理状态未知 | 截图链路或会话未完成；报告应保留失败/未知，不复用该会话继续统计成功 |
| 基础 Flow 通过，但录屏服务不存在 | 基础 UI 能力通过，视频后端不支持；两个结果分别记录 |

取得完整场景执行结果后，再在兼容表中登记实际系统、设备、CLI、应用和 Flow 的固定版本，以及报告和清理结果。若进行稳定性验证，应在同一环境另建批次；不能与已有 HarmonyOS 手机的 20 轮混合计算。
