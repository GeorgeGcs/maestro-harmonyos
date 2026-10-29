# 开发环境与使用

第一次使用先看[使用指南](user-guide.md)。本文保留环境、命令参数和功能限制的参考信息；内部实现见[开发设计](development-design.md)。

已接入 `HarmonyOSDriver` 和 CLI 会话，使用上游的标准 YAML 解析与执行流程。一台 API 26 真机已通过中文输入、截图、VSCode 录制回放及逐台验证脚本，结果见[最新进展](progress/2026-10-29.md)。其他设备和系统版本仍需验证。

## 环境与源码

- Git、PowerShell 和完整 JDK 17（包含 `java`、`javac`）；本仓运行脚本面向 Windows。
- Node.js 和 npm 用于完整 CLI 的前端资源构建。准备整套工具链时使用 Node.js 22.12 或以上，并确保 `node`、`npm` 在 PATH；单独构建扩展的最低要求为 Node.js 22。
- 与目标设备匹配的 DevEco SDK / HDC，可通过 PATH 或 `MAESTRO_HARMONYOS_HDC` 指定。
- 已授权 USB 调试的鸿蒙设备，目标应用已安装，页面可用于测试。
- 构建完整 CLI 时还会下载上游依赖、构建 MCP viewer 并处理模拟器资源，首次构建需要联网。

在仓库根目录执行：

```powershell
if (Test-Path -LiteralPath ./config.local.ps1) { . ./config.local.ps1 }
# 此检查脚本只从 PATH 或 -HdcPath 查找 HDC。
if ($env:MAESTRO_HARMONYOS_HDC -and (Test-Path -LiteralPath $env:MAESTRO_HARMONYOS_HDC -PathType Leaf)) {
  ./scripts/check-environment.ps1 -HdcPath $env:MAESTRO_HARMONYOS_HDC
} else {
  ./scripts/check-environment.ps1
}
if ($LASTEXITCODE -ne 0) { throw '请先补齐环境。' }
# 首次获取源码；已有适配改动时不要重复运行。
./scripts/prepare-upstream.ps1
./scripts/apply-upstream-patches.ps1
./scripts/test-host.ps1
```

环境检查只定位工具和读取版本，不修改系统配置。HDC 不在 PATH 时，可给检查脚本传入 `-HdcPath`。个人工具路径放在被 Git 忽略的 `config.local.ps1` 中，只设置当前 PowerShell 进程的环境变量。

`prepare-upstream.ps1` 按 `upstream.lock.json` 获取固定提交到 `.upstream/maestro`。该目录不提交到本仓；已有改动时脚本会保留目录并报错。`apply-upstream-patches.ps1` 应用 `patches/maestro/0001-harmonyos-host.patch`，内容包括 HDC、布局解析、驱动、CLI 和测试。完整补丁已存在时不重复应用。

改动上游源码前先阅读其 `AGENTS.md`。测试范围及完整测试命令见[主机测试说明](../host-tests/README.md)。

## 构建 CLI

```powershell
$env:GRADLE_USER_HOME = Join-Path (Get-Location) '.gradle-user-home'
./.upstream/maestro/gradlew.bat -p ./.upstream/maestro :maestro-cli:installDist --no-daemon --console=plain
if ($LASTEXITCODE -ne 0) { throw 'CLI 构建失败。' }
$maestroCli = Join-Path (Get-Location) '.upstream/maestro/maestro-cli/build/install/maestro/bin/maestro.bat'
```

使用本次构建的分发包运行鸿蒙流程。首次构建遇到的资源下载问题可参考[启动记录](progress/2026-10-28.md)。

## 运行脚本

构建后也可用仓库提供的入口，它会加载 `config.local.ps1`，为每次运行创建独立产物目录：

```powershell
./scripts/run-harmonyos.ps1 `
  -FlowPath ./examples/flows/input-smoke.yaml `
  -BundleId org.example.sample -AbilityName EntryAbility -Module entry `
  -Env @{ START_TEXT='输入演示'; INPUT_HINT='请输入姓名'; INPUT_TEXT='熊猫测试' }
```

`FlowPath` 可指向单个 YAML 或流程目录。多设备时加 `-DeviceId`；`-Artifacts` 指定输出根目录。脚本不会构建或安装应用，保留 CLI 的退出码，退出时恢复当前进程环境。`APP_ID` 由 `BundleId` 设置。默认关闭匿名统计。

脚本直接启动 Java，避免 `.bat` 对引号再解析；已验证 PowerShell 7 和 Windows PowerShell 5.1。部分 Windows/JDK 17 的启动器会损坏系统编码以外的字符（如 emoji），脚本会在操作设备前拒绝这类参数。此类输入可直接写在 UTF-8 YAML 中。

## 选择设备与应用

```powershell
# HDC 已在 PATH 时使用此值；也可设为本机 hdc.exe 的完整路径。
$env:MAESTRO_HARMONYOS_HDC = 'hdc'
# 按目标应用的 module.json5 设置，不会自动猜测启动 Ability。
$env:MAESTRO_HARMONYOS_ABILITY = 'EntryAbility'
# 仅在启动需要指定模块时设置：
# $env:MAESTRO_HARMONYOS_MODULE = 'entry'

& $maestroCli --platform harmonyos list-devices
& $maestroCli --platform harmonyos hierarchy
```

只有一台 HDC 设备时自动选择；多台设备时必须指定 `--device '<HDC target>'`，例如放在 `hierarchy` 或 `test` 前。同一设备已有 Maestro 会话时，新会话会报错。设备列表查询不操作页面；`hierarchy` 会读取布局和截图以确认设备可用。

应用包名通过 YAML 的 `appId` 提供，与 `MAESTRO_HARMONYOS_ABILITY`、可选的 `MAESTRO_HARMONYOS_MODULE` 一起用于 `aa start`。默认 `launchApp` 会先停止应用，但不清除应用数据，也不自动修改已有权限。首次授权弹窗需在运行流程前处理好。

运行前解锁手机。长时间测试可在自有测试应用的主窗口调用 `setWindowKeepScreenOn(true)`，退到后台时恢复为 `false`。常亮不代替解锁，也不会阻止手动按电源键锁屏。

## 运行输入示例

[input-smoke.yaml](../examples/flows/input-smoke.yaml) 的流程是：启动 → 检查标题 → 按输入提示定位 → 输入 → 检查输入内容 → 返回 → 再检查标题 → 截图。示例不点击登录或提交按钮。

选择一个有空输入框的测试页面，并替换以下示例值。返回操作应关闭键盘或回到仍显示 `START_TEXT` 的页面；如目标应用的返回行为不同，需要调整流程。

```powershell
& $maestroCli --platform harmonyos test `
  -e 'APP_ID=org.example.sample' `
  -e 'START_TEXT=输入演示' `
  -e 'INPUT_HINT=请输入姓名' `
  -e 'INPUT_TEXT=Maestro测试' `
  --test-output-dir ./artifacts/input-smoke `
  ./examples/flows/input-smoke.yaml
if ($LASTEXITCODE -ne 0) { throw '输入流程未通过，请查看运行报告。' }
```

`tapOn.text` 使用上游选择器，同时匹配控件文字和提示文字。鸿蒙布局中的 `hint` 会转换为 `hintText`，`id` 或 `key` 会转换为 `resource-id`；定位失败时先用 `hierarchy` 检查实际属性。

截图及报告写入 `--test-output-dir` 指定目录内的时间戳/Flow 子目录，通过其中的 `manifest.json` 查看文件位置，不写在 YAML 旁。manifest 的截图条目指向截图集合目录；具体 PNG 位于 `takeScreenshot/`。运行产物位于被 Git 忽略的 `artifacts/` 中，分享前检查截图和日志是否含个人信息。

[smoke.yaml](../examples/flows/smoke.yaml) 保留了按控件 ID 点击的示例，需要 `APP_ID`、`START_TEXT`、`BUTTON_ID`、`RESULT_TEXT` 四个参数。选择测试页面上的本地操作按钮，确认点击后的页面含 `RESULT_TEXT`。

[scroll-input.yaml](../examples/flows/scroll-input.yaml) 在输入前增加向上滑动，再按提示重新定位输入框。目标页面应可以滚动，且滚动后仍能找到该输入框。

## VSCode 操作录制

插件 0.1.0 位于 `packages/vscode`。先构建包含本轮桥接补丁的 CLI，再在插件目录执行 `npm ci --ignore-scripts` 和 `npm run package`，得到 `dist/maestro-harmonyos-recorder-0.1.0.vsix`。在 VSCode 扩展视图选择“从 VSIX 安装”。安装包不包含 JDK、HDC 或 Maestro 分发包。

在可信任的本地工作区配置 `harmonyosRecorder.cliDirectory`、`javaPath`、`hdcPath`，从命令面板执行“**HarmonyOS: 打开流程录制**”。扩展不会运行 `config.local.ps1`，已经打开的 VSCode 也不会自动取得后来在终端加载的环境变量；此时在插件设置中填写工具路径。

连接设备并指定应用后，点击“启动应用”。在截图或控件树中选中目标，再执行点击、输入、滑动、返回、断言或截图。点击截图只选择控件，操作按钮才控制手机。只有成功执行的动作才写入 YAML；成功动作之后画面刷新失败时，步骤仍保留，手动刷新即可，不要重复操作。

截图按操作刷新，包含系统栏，坐标按实际像素换算。已识别且不覆盖应用的系统状态栏动态内容不参与页面稳定比较，也不提供录制点选；弹窗、键盘和未知窗口仍参与检查。页面或控件变化后必须刷新；屏幕旋转或尺寸改变后需要断开并重新连接。

“保存 YAML”导出标准 Flow。“回放流程”先关闭录制会话并释放设备锁，再用 CLI 运行面板中的步骤；结果保存在项目 `artifacts/recorder/` 下。插件只记录自身发出的动作，不监听手机手工触摸，也不会自动开启视频录屏。详细配置、回放边界和开发测试入口见[插件说明](../packages/vscode/README.md)，本机通信格式见[录制协议](recorder-protocol.md)。

## 视频录屏

[recording-smoke.yaml](../examples/flows/recording-smoke.yaml) 使用标准 `startRecording` 和 `stopRecording`。目前提供实验性的 Huawei 系统录屏后端，需要显式开启：

```powershell
$env:MAESTRO_HARMONYOS_RECORDING = 'huawei-system'
# 然后用 run-harmonyos.ps1 或 CLI 执行 recording-smoke.yaml。
```

不设置或设为 `off` 时，录屏命令明确报不支持。此后端依赖系统录屏服务、`mediatool` 和媒体状态查询，不是所有 OpenHarmony 设备都有的接口。

录屏期间需独占设备录屏，不要手动开始、停止或切换系统录屏。系统只有启停切换命令，没有可指定的录制会话 ID；适配会拒绝已存在的录屏进程、检查本次 PID，并且不再次停止已生成完整文件的录制，但无法识别同一进程被手工接管的所有情况。

默认最长录制 3 分钟，导出上限 512 MiB。达到时长上限会停止并报告失败。输出保留系统录屏的分辨率、帧率和音频设置，可能含音轨。驱动校验 MP4 容器和视频轨信息，不在每次执行时完整解码视频。

单台真机的正常流程已通过录像全帧解码。故意断言失败的短流程能自动停录并导出，但发现过视频尾部 H.264 解码错误，原因尚未确定；因此暂不保证每段录像都可完整解码。将视频作为验证材料前仍需逐段检查，详细复现结果见[进展记录](progress/2026-10-28.md)。

视频写入运行目录中的 `startRecording/`。本地写入及刷新成功后才删除手机上的本次唯一视频；导出失败会保留该视频供恢复。普通失败和取消会尝试收尾，强制结束 Java 进程或设备断连时仍可能需要手动停止系统录屏。

## 批量执行与报告

同一设备可以顺序执行多个 Flow。使用已有参数配置后，向 CLI 传入多个 YAML 或流程目录，并选择 JUnit 报告：

```powershell
& $maestroCli --platform harmonyos test ./my-flows `
  --format JUNIT --output ./artifacts/report.xml `
  --test-output-dir ./artifacts/batch-run
```

`my-flows` 中应只放本次要运行的流程，并提供各流程需要的参数。任一流程失败时，CLI 返回非零退出码。单设备批量与多设备分片是两项能力，当前仍不支持分片。

需要按设备分别留证时，使用 `scripts/test-device-matrix.ps1`，显式传入 `DeviceIds` 和相同的 Flow、应用参数。它按设备及轮次串行调用现有运行脚本，保存各轮退出码、环境和构建指纹，生成 `matrix.json`、`matrix.md`；默认每台一轮，失败不自动重试。当前已完成一台真机的 1/1 检查，不能据此声明第二台设备兼容。参数和统计规则见[逐台设备验证](device-matrix.md)。

## 已实现与限制

| 范围 | 当前行为 |
| --- | --- |
| Flow | 复用标准 YAML、环境参数、条件、子流程和断言，不新增鸿蒙专用语法 |
| 页面操作 | 启动/停止应用、文本/ID/坐标定位、点击、长按、输入、返回、滑动、逐字符删除 |
| 等待与截图 | 连续读取布局判断稳定；截图使用 UITest PNG，坐标按设备实际像素处理 |
| 设备会话 | 本机 HDC、单设备、显式平台选择及会话关闭；无设备、多设备未指定目标、设备动作失败都会报错 |
| 操作录制辅助 | VSCode 截图与控件树点选，执行动作后生成标准 YAML，保存并通过 CLI 回放；仅记录插件内操作 |
| 逐台验证 | 显式设备列表、计划轮次、独立产物及 JSON/Markdown 汇总；已有单设备实测 |
| 视频录屏 | 可选 Huawei 系统录屏后端；显式开启，按本次唯一文件导出和清理 |
| 尚未支持 | HAP 安装、权限修改、`clearState`、`hideKeyboard`、深链接、媒体导入、位置/方向/代理等系统设置 |
| 尚未接入 | Studio、MCP、自动启动设备、多设备分片和云端运行 |

`back` 是设备返回键，不能保证在所有应用中都等同于关闭键盘。UITest 的文本输入、布局可见范围和滑动行为可能因系统版本或控件而不同；滑动时长通过速度近似换算。主机模拟测试不能证明这些行为在手机上可用。

按[测试计划与验证记录](acceptance.md)分别记录插件录制回放、视频录屏和设备兼容结果，再安排重复执行。插件 0.1.0 已在 VSCode 1.140 和现有 API 26 真机完成 8 步录制、保存及一键回放；第二台设备、多轮稳定性测试和视频尾部解码问题仍待处理。

## 资料

- [Maestro 上游](https://github.com/mobile-dev-inc/Maestro)
- [UITest 使用指导](https://github.com/openharmony/docs/blob/master/zh-cn/application-dev/application-test/uitest-guidelines.md)
