# 使用指南

本文面向第一次使用本项目的应用开发者和测试人员。命令按 Windows PowerShell 编写，路径均从仓库根目录计算。能力和验证状态截至 2026-10-29。

## 这个项目用来做什么

Maestro HarmonyOS 让电脑按照 YAML 测试脚本操作鸿蒙应用：启动应用、找控件、点击、输入文字、滑动，再检查页面结果并保存截图。应用改版后可以重复运行同一份脚本，用来发现原本能走通的页面流程是否被改坏。

例如，一个“输入姓名并检查显示结果”的流程可以写一次，后续每次构建应用后重新执行，失败时查看对应日志和截图。已有 Maestro 用例的团队可以复用 Flow、参数和部分选择器写法；用例涉及的设备命令仍需按本项目的支持范围逐项检查。

本项目安装在开发或测试电脑上，不需要作为运行时库引入应用，也不是一个 ArkTS/ohpm 依赖。测试应用需要事先安装到手机。项目目前提供三部分：

| 部分 | 用途 |
| --- | --- |
| 带鸿蒙适配的 Maestro CLI | 在终端执行标准 YAML，输出结果和截图 |
| VSCode Recorder 扩展 | 看截图、选择控件、执行操作，生成 YAML 并回放 |
| 逐台验证脚本 | 在指定设备上顺序执行相同流程，按设备和轮次整理结果 |

适合先接入已有测试应用中的启动检查、表单输入、页面跳转和回归流程。当前不适合把一份任意 Android/iOS 用例直接当作鸿蒙兼容用例，也不提供应用构建、HAP 安装、自动登录或业务数据准备。

## 安装方式和前置条件

当前仓库的交付方式是**固定 Maestro 上游版本、应用适配补丁，再在本机构建**。下面不依赖公共 Release 下载包或扩展商店安装项；VSIX 也从仓库源码构建。仅安装普通 Maestro 分发包不能替代本项目的适配版本。

| 项目 | 要求 |
| --- | --- |
| 开发电脑 | 本文提供 Windows 操作步骤；PowerShell 7、Windows PowerShell 5.1 已做运行脚本回归 |
| Git | 可获取本仓库和固定的 Maestro 上游提交 |
| Java | 完整 JDK 17，包含 `java`、`javac`；本文按已验证版本配置 |
| Node.js | 本指南统一使用 22.12 或以上并安装 npm，供 CLI 前端资源与 VSIX 构建使用；本项目实测为 24.14.0 |
| HDC | 与手机匹配的 DevEco SDK/HDC，可发现已经授权的本机设备 |
| VSCode | 使用录制扩展时需 1.95 或以上；本次实际验证为 1.140 |
| 手机 | 开启 USB 调试并授权、已解锁、保持亮屏；设备应提供适配所需的 UITest 能力 |
| 测试应用 | 已安装，已知 bundle 名称、入口 Ability、可选 module；页面和权限已准备好 |

首次构建会下载 Gradle、依赖和上游资源，需要联网。CLI 与 VSIX 是两个独立产物；VSIX 不包含 JDK、HDC 或 Maestro CLI。只使用 CLI 时不必安装录制扩展。

应用的 bundle 名称通常从 `AppScope/app.json5` 获取，入口 Ability 和 module 从应用的 `module.json5` 核对。以下示例中的 `org.example.demo`、`EntryAbility`、`entry`、页面文字及工具路径都需要换成自己的值。仓库不附带这个示例包名的可安装应用。

## 从源码构建 CLI

### 1. 获取仓库、配置工具

在准备存放项目的目录执行：

```powershell
git clone https://gitcode.com/HarmonyPandaWorkshop/maestro-harmonyos.git
if ($LASTEXITCODE -ne 0) { throw '仓库获取失败。' }
Set-Location ./maestro-harmonyos

# 以下两个路径是示例，必须改为本机实际路径。
$env:JAVA_HOME = 'D:\tools\jdk-17'
$env:PATH = (Join-Path $env:JAVA_HOME 'bin') + [IO.Path]::PathSeparator + $env:PATH
$env:MAESTRO_HARMONYOS_HDC = 'D:\tools\openharmony\toolchains\hdc.exe'

./scripts/check-environment.ps1 -HdcPath $env:MAESTRO_HARMONYOS_HDC
if ($LASTEXITCODE -ne 0) { throw '请先补齐环境检查中未通过的项目。' }
& $env:MAESTRO_HARMONYOS_HDC list targets
```

环境检查只查工具，不证明设备已经连接。最后一条命令应列出目标设备；为空时先处理 USB 连接、调试授权和 HDC，再往下执行。`-HdcPath` 接受文件路径；若 HDC 已在 PATH，环境检查可不传此参数。

可以将上述环境变量设置保存在本机 `config.local.ps1` 中，后续用 `. ./config.local.ps1` 加载。该文件已被 Git 忽略。运行脚本会加载它，VSCode 扩展不会加载它。

### 2. 获取固定上游并应用补丁

```powershell
# 仅在首次准备未修改的上游工作副本时执行。
./scripts/prepare-upstream.ps1
./scripts/apply-upstream-patches.ps1
```

固定版本来自 [upstream.lock.json](../upstream.lock.json)，工作副本在 `.upstream/maestro`。已有适配改动时不要重复执行 `prepare-upstream.ps1`；脚本遇到本地修改会停止并保留文件。后续开发流程见[开发设计](development-design.md)。

### 3. 构建分发目录

```powershell
$env:GRADLE_USER_HOME = Join-Path (Get-Location) '.gradle-user-home'
./.upstream/maestro/gradlew.bat -p ./.upstream/maestro :maestro-cli:installDist --no-daemon --console=plain
if ($LASTEXITCODE -ne 0) { throw 'CLI 构建失败，请先检查构建输出。' }
```

成功后分发目录为 `.upstream/maestro/maestro-cli/build/install/maestro`，其中包含 `bin` 和 `lib`。后面的运行脚本和插件都使用这份分发目录。

构建遇到网络或资源下载错误时，不要先操作手机。按[环境与上游接入](setup.md)检查失败的构建阶段；主机测试方法见[测试说明](../host-tests/README.md)。主机测试通过不等于 CLI 分发包已构建。

## 跑通第一个 YAML 流程

### 1. 先验证启动、标题和截图

选择一个启动后能看到固定标题的测试页面。创建 `my-flows/first-flow.yaml`，用 UTF-8 保存：

```yaml
appId: ${APP_ID}
---
- launchApp
- assertVisible: ${START_TEXT}
- takeScreenshot: first-screen
```

在仓库根目录执行，替换包名、Ability、module 和页面标题：

```powershell
./scripts/run-harmonyos.ps1 `
  -FlowPath ./my-flows/first-flow.yaml `
  -BundleId org.example.demo `
  -AbilityName EntryAbility `
  -Module entry `
  -Env @{ START_TEXT = '输入演示' }
if ($LASTEXITCODE -ne 0) { throw '首次流程未通过，请查看上方错误和产物目录。' }
```

不需要 module 的应用可省略 `-Module`。`APP_ID` 由 `-BundleId` 自动传入，不必再写到 `-Env`。多台设备连接时加 `-DeviceId '替换为目标设备标识'`，标识来自 HDC 的输出。

脚本会打印本次 `Artifacts:` 路径。通过表示应用已启动、标题断言成功、截图步骤完成；应再打开截图，确认操作的确是预期页面。默认 `launchApp` 会先停止应用，不会清除数据、修改权限或解除锁屏。首次授权弹窗、登录状态和测试数据需要事先准备。

### 2. 再运行输入示例

现成的 [input-smoke.yaml](../examples/flows/input-smoke.yaml) 会定位输入框、输入文字、断言结果、返回并截图：

```powershell
./scripts/run-harmonyos.ps1 `
  -FlowPath ./examples/flows/input-smoke.yaml `
  -BundleId org.example.demo `
  -AbilityName EntryAbility `
  -Module entry `
  -Env @{
    START_TEXT = '输入演示'
    INPUT_HINT = '请输入姓名'
    INPUT_TEXT = '熊猫测试'
  }
```

运行前输入框应为空。`back` 应关闭键盘或回到仍显示 `START_TEXT` 的页面；目标应用行为不同时，应复制示例并调整步骤。该示例没有登录、支付或提交按钮，新增此类步骤时要使用专门的测试环境和数据。

文字和 ID 选择器按 Maestro 的匹配规则执行，可能使用正则表达式；不要把页面中缺失的文字或其他平台的控件 ID 直接照搬。定位失败时查看真实布局：

```powershell
$maestroCli = Join-Path (Get-Location) '.upstream/maestro/maestro-cli/build/install/maestro/bin/maestro.bat'
& $maestroCli --platform harmonyos list-devices
& $maestroCli --platform harmonyos hierarchy
# 多设备时，将 --device '目标设备标识' 放在 hierarchy 前。
```

鸿蒙布局中的 `hint` 会映射为 `hintText`，`id` 或 `key` 会映射为 `resource-id`。`tapOn.text` 可匹配提示文字。先看布局中实际存在什么，再选择 ID、文字或明确的坐标；截图里看得到的自绘内容不一定有可定位节点。

其他示例包括 [smoke.yaml](../examples/flows/smoke.yaml) 的控件 ID 点击和 [scroll-input.yaml](../examples/flows/scroll-input.yaml) 的滑动后重新定位。各文件开头注明所需参数和页面条件，不能在未调整参数时直接批量运行整个示例目录。

## 用 VSCode 生成流程

### 1. 构建并安装扩展

先完成前面的 CLI 构建，然后在仓库根目录执行：

```powershell
Push-Location ./packages/vscode
try {
  npm ci --ignore-scripts
  if ($LASTEXITCODE -ne 0) { throw '扩展依赖安装失败。' }
  npm run package
  if ($LASTEXITCODE -ne 0) { throw '扩展打包失败。' }
} finally {
  Pop-Location
}
```

在 VSCode 扩展视图中选择“从 VSIX 安装”，打开 `packages/vscode/dist/maestro-harmonyos-recorder-0.1.0.vsix`。随后打开本地工作区并信任该工作区。

### 2. 配置工具和应用

在 VSCode 工作区的 `settings.json` 中设置以下项目。JSON 中使用 `/` 可以避免 Windows 反斜杠转义，下面的绝对路径仍需替换：

```json
{
  "harmonyosRecorder.cliDirectory": "",
  "harmonyosRecorder.javaPath": "D:/tools/jdk-17/bin/java.exe",
  "harmonyosRecorder.hdcPath": "D:/tools/openharmony/toolchains/hdc.exe",
  "harmonyosRecorder.appId": "org.example.demo",
  "harmonyosRecorder.abilityName": "EntryAbility",
  "harmonyosRecorder.moduleName": "entry"
}
```

`cliDirectory` 留空时，插件使用当前工作区下的 `.upstream/maestro/maestro-cli/build/install/maestro`。如果在自己的应用工程里使用插件，应把它设为已经构建的 Maestro 分发目录的绝对路径，指向包含 `bin` 和 `lib` 的目录。无需 module 时将 `moduleName` 设为空字符串。

已经打开的 VSCode 不会自动取得后来在 PowerShell 中设置的环境变量，所以这里直接填写 `javaPath` 和 `hdcPath`。个人路径不要提交到公共仓库。

### 3. 录制、保存和回放

1. 从命令面板执行 **HarmonyOS: 打开流程录制**，连接设备并确认应用和 Ability。
2. 点击“启动应用”，等待截图与控件树出现。
3. 点击截图或控件树选中目标。确认位置后，再点“点击控件”执行操作；点击截图本身只做选择。
4. 继续输入文字、滑动、返回、添加可见断言或截图步骤。只有确认执行成功的步骤才追加到 YAML。
5. 点击“保存 YAML”，选择文件位置。面板中的“回放流程”先结束录制会话并释放设备锁，再用 CLI 执行当前面板步骤。
6. 查看回放结果和“打开产物”。回放完成后可重新连接继续录制，关闭编辑器前先保存 YAML。

优先使用唯一 ID 或文字选择器。控件无法唯一定位时，换一个节点，或明确使用“按所选坐标点击”；坐标会受尺寸和布局变化影响。保存后的 YAML 可以手工修改并用 `run-harmonyos.ps1` 运行；面板“回放流程”执行的是面板中的步骤，不会自动读取你另外修改的文件。

这里的“录制”指**把通过插件执行的操作生成 YAML**，不捕获手机上的手工触摸，也不等同于录制 MP4。截图在操作后刷新，不是实时视频流。屏幕旋转、尺寸变化后需要重新连接。动作成功但刷新失败时，已生成步骤仍保留，手动刷新即可，不要为了刷新重复点击或输入。更多说明见[插件文档](../packages/vscode/README.md)。

## 批量执行和逐台验证

把同一轮要执行的流程放在单独目录，确保各文件有明确初始状态、参数齐全，再把 `-FlowPath` 换成目录即可：

```powershell
./scripts/run-harmonyos.ps1 `
  -FlowPath ./my-flows `
  -BundleId org.example.demo `
  -AbilityName EntryAbility `
  -Module entry `
  -Env @{ START_TEXT = '输入演示' }
```

一次 CLI 会话操作一台设备。需要逐台记录时，显式传入设备列表：

```powershell
./scripts/test-device-matrix.ps1 `
  -FlowPath ./my-flows/first-flow.yaml `
  -BundleId org.example.demo `
  -AbilityName EntryAbility `
  -Module entry `
  -DeviceIds @('替换为设备一', '替换为设备二') `
  -Env @{ START_TEXT = '输入演示' } `
  -Repeat 1
```

只有一台设备时，数组里只写一个标识。此工具按设备和轮次顺序执行，不并行、不自动重试失败轮次。`-Repeat 20` 表示计划执行 20 轮；它不会清除应用数据或替你恢复初始状态，也不会把一次 20 轮执行自动认定为活动验收完成。

汇总生成 `matrix.json` 和 `matrix.md`，各轮独立留存日志与产物。通过率分母包含全部计划轮次；未执行不计为通过。详细参数、退出码和环境探测含义见[逐台设备验证](device-matrix.md)。需要 JUnit 报告时使用[CLI 批量报告命令](setup.md#批量执行与报告)。

## 结果存在哪里

| 入口 | 默认位置和查看方法 |
| --- | --- |
| `run-harmonyos.ps1` | `artifacts/harmonyos-日期时间-唯一标识/`；以控制台打印的 `Artifacts:` 路径为准，可用 `-Artifacts` 改输出根目录 |
| CLI 测试 | 指定的 `--test-output-dir` 下按运行和 Flow 保存报告；通过 `manifest.json` 找产物，PNG 在相应的 `takeScreenshot/` 目录 |
| VSCode 录制与回放 | 当前工作区 `artifacts/recorder/` 的独立目录；回放含 `recorded-flow.yaml`、`cli.log` 和 CLI 产物，诊断也写入 **HarmonyOS Recorder** 输出面板 |
| 逐台验证 | `artifacts/device-matrix/` 的独立目录，含汇总、每台设备每轮的 `runner.log` 与 CLI 产物 |

运行脚本保留 CLI 退出码，非零不能当作通过。逐台脚本退出 0 表示全部计划调用成功，存在失败或未执行时返回 1。不要只看截图是否生成；流程可能在截图后失败。

日志、报告和截图可能包含设备标识、应用内容、输入文字及本机路径，分享前检查并脱敏。默认生成目录已被 Git 忽略；自己的测试工程也应设置相应忽略规则。YAML 和脚本按普通可执行测试代码审查，避免直接运行来源不明的流程。

## 当前支持范围

“已实现”说明当前代码有这条执行路径；“单台实测”只覆盖已记录的场景。2026-10-29 的设备记录为 ALN-AL80、系统报告 `OpenHarmony-7.0.0.105`、API 26，使用本地测试应用，不能外推为所有鸿蒙/OpenHarmony 设备均兼容。

| 功能或命令 | 当前实现与验证情况 | 使用限制 |
| --- | --- | --- |
| `launchApp`、停止应用 | 已实现；默认启动含停止步骤，已有单台流程实测 | 需包名与入口 Ability；不自动安装、清数据、配置权限 |
| `tapOn` 的文字、ID、坐标定位 | 已实现；文字/提示定位有单台实测，ID、边界与选择器有主机/集成测试 | 取决于 UITest 提供的布局；真实控件和系统覆盖尚不完整 |
| `inputText`、可见断言 | 中文、单双引号及录制桥接的字面 `${...}` 有实测记录 | 不保证所有输入法和字符组合；未闭合/嵌套表达式不能无损保存时，录制接口会拒绝 |
| `back`、`swipe`、`takeScreenshot` | 已实现，单台实测通过，包含滑动后重新定位 | 返回不保证等于关闭键盘；滑动时长由速度近似换算 |
| 长按、`eraseText`、部分 `pressKey` | 已实现，有主机测试，完整真机矩阵待补 | 删除通过逐次退格，需正确焦点；不是所有按键都支持 |
| Flow 参数、条件、子流程 | 复用真实 Maestro 解析和执行层，集成测试通过 | 子流程调用到未支持的设备能力仍会失败 |
| 单设备批量、逐台汇总 | 单设备批量 2/2、逐台工具单设备 1/1 已记录 | 第二台设备与正式 20 轮未完成；不支持多设备分片 |
| VSCode 操作录制 | 0.1.0；真实面板 8 步操作、保存与 CLI 回放已在单台通过 | 只记录插件发出的操作；按动作刷新截图，旋转后重连 |
| `startRecording`、`stopRecording` | 实验性 Huawei 系统录屏后端，默认关闭 | 依赖特定系统服务；曾出现短视频尾部解码错误，未修复 |
| HAP 安装、`clearState`、权限修改、`hideKeyboard`、深链接、媒体导入、位置/方向/代理等设置 | 当前不支持 | 不支持的操作明确报错；由人工或独立准备步骤处理，不可当成功跳过 |
| Studio、MCP、自动启动设备、云端运行 | 尚未接入 | 使用本文的本机 CLI 与 VSCode 入口 |

视频录屏需要显式设置 `MAESTRO_HARMONYOS_RECORDING=huawei-system`，测试期间独占系统录屏。正常视频曾通过全帧解码，但短视频有过尾部错误；驱动的容器检查不能证明每帧可解码。启用方法、导出和异常收尾见[视频录屏说明](setup.md#视频录屏)。这项能力不影响普通 YAML 和 VSCode 操作录制的使用。

原始结果和未完成项见[10 月 28 日记录](progress/2026-10-28.md)、[10 月 29 日记录](progress/2026-10-29.md)及[验收清单](acceptance.md)。

## 常见问题

| 现象 | 检查和处理 |
| --- | --- |
| HDC 没有列出设备 | 检查 USB 连接、USB 调试和手机授权；先让同一个 HDC 可列出目标，再启动 CLI |
| 多设备时拒绝运行 | CLI 加 `--device`，运行脚本加 `-DeviceId`，逐台脚本用 `-DeviceIds`；不要靠设备枚举顺序猜目标 |
| 启动失败或锁屏报错 | 手工解锁并保持亮屏，核对 bundle、Ability、module 和应用是否已安装；工具不会替你解锁 |
| 找不到 CLI 的 `lib` 或 JAR | 完成 `:maestro-cli:installDist`；插件路径指向分发目录，不是仓库根、`bin` 或某个 JAR |
| `harmonyos-bridge` 不被识别 | 检查是否使用包含当前补丁的 CLI；应用补丁后重新构建，普通上游分发包没有本项目桥接入口 |
| 设备已有会话占用 | 结束控制该设备的录制/CLI 会话后再试；不要同时从多个入口点击同一台手机 |
| 找不到控件、断言不成立 | 检查真实页面、键盘/弹窗和 `hierarchy`；确认文字、提示、ID及正则匹配条件，页面变化后重新定位 |
| `STALE_SNAPSHOT`、页面不稳定或控件有歧义 | 等页面稳定、刷新并重新选择；不能确认动作是否执行时先检查手机，不自动重复点击或输入 |
| `ORIENTATION_CHANGED` | 断开并重连，获取新尺寸后再操作 |
| 通过 `-Env` 输入 emoji 等字符被拒绝 | Windows/JDK 启动器可能无法无损传入该字符；把文字直接写入 UTF-8 YAML，或使用插件的 UTF-8 录制接口 |
| VSCode 找不到 Java/HDC，但终端可用 | 插件不会读取 `config.local.ps1`；在设置里填写原生 `java.exe`、`hdc.exe` 的完整路径 |
| 返回后流程失败 | `back` 是设备返回键；按应用的真实导航行为调整步骤，不能假设所有页面都只关闭键盘 |
| 不支持的命令失败 | 对照上表删改测试或补充适配；不要用忽略错误把未实现步骤记为通过 |

提问题时提供本仓提交、构建方式、主机与设备系统版本、最小 YAML、实际退出码和脱敏日志。不要直接附设备序列号、真实账号、签名文件或私人页面截图。参与开发前阅读[贡献说明](../CONTRIBUTING.md)和[开发设计](development-design.md)。新增内容按 [Apache-2.0](../LICENSE) 开源，上游和第三方声明见 [THIRD_PARTY.md](../THIRD_PARTY.md)。
