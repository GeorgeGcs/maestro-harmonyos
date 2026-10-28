# 开发环境与使用

已接入 `HarmonyOSDriver` 和 CLI 会话，使用上游的标准 YAML 解析与执行流程。主机测试覆盖驱动调用、参数、条件子流程和错误传播；一台 API 26 真机已通过中文输入和截图的最小 Flow。其他系统和页面行为仍需验证，结果见[进展记录](progress/2026-10-28.md)。

## 环境与源码

- Git、PowerShell 和完整 JDK 17（包含 `java`、`javac`）。
- 与目标设备匹配的 DevEco SDK / HDC，可通过 PATH 或 `MAESTRO_HARMONYOS_HDC` 指定。
- 已授权 USB 调试的鸿蒙设备，目标应用已安装，页面可用于测试。
- 构建完整 CLI 时还会下载上游依赖、构建 MCP viewer 并处理模拟器资源，首次构建需要联网。

在仓库根目录执行：

```powershell
if (Test-Path -LiteralPath ./config.local.ps1) { . ./config.local.ps1 }
./scripts/check-environment.ps1
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

## 已实现与限制

| 范围 | 当前行为 |
| --- | --- |
| Flow | 复用标准 YAML、环境参数、条件、子流程和断言，不新增鸿蒙专用语法 |
| 页面操作 | 启动/停止应用、文本/ID/坐标定位、点击、长按、输入、返回、滑动、逐字符删除 |
| 等待与截图 | 连续读取布局判断稳定；截图使用 UITest PNG，坐标按设备实际像素处理 |
| 设备会话 | 本机 HDC、单设备、显式平台选择及会话关闭；无设备、多设备未指定目标、设备动作失败都会报错 |
| 尚未支持 | HAP 安装、权限修改、`clearState`、录屏、`hideKeyboard`、深链接、媒体导入、位置/方向/代理等系统设置 |
| 尚未接入 | Studio、MCP、VSCode 扩展、自动启动设备、多设备分片和云端运行 |

`back` 是设备返回键，不能保证在所有应用中都等同于关闭键盘。UITest 的文本输入、布局可见范围和滑动行为可能因系统版本或控件而不同；滑动时长通过速度近似换算。主机模拟测试不能证明这些行为在手机上可用。

按[验收清单](acceptance.md)记录真机型号与系统版本、运行命令、退出码、断言和产物，再安排重复执行。录屏和操作生成 YAML 另行验证，不计入当前完成范围。

## 资料

- [Maestro 上游](https://github.com/mobile-dev-inc/Maestro)
- [UITest 使用指导](https://github.com/openharmony/docs/blob/master/zh-cn/application-dev/application-test/uitest-guidelines.md)
