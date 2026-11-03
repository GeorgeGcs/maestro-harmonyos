# 主机端测试

测试分为 HDC/布局模块、完整驱动、YAML 流程和 CLI 会话四部分，均不要求连接手机。主机测试使用合成布局和模拟设备响应；HDC 进程测试会启动本地 Java 子进程，检查输出读取、超时、中断及参数传递。

## 一次运行主机回归

完整入口为 `scripts/test-host-suite.ps1`，需要 Windows、PowerShell 7 和 Node.js 22.12 以上。它不准备源码、不应用补丁、不查询 HDC，也不自动下载工具。先按[环境说明](../docs/setup.md)准备固定上游、应用补丁并构建 CLI；扩展依赖事先用 `npm ci` 安装。

在仓库根目录执行，路径替换为本机实际位置：

```powershell
./scripts/test-host-suite.ps1 `
  -JavaHome 'D:\tools\jdk-17' `
  -BashPath 'D:\tools\Git\bin\bash.exe' `
  -CliDirectory 'D:\build\current-cli' `
  -OriginalCliDirectory 'D:\build\original-cli' `
  -GradleHome 'D:\tools\gradle-8.13' `
  -SimulatorCache 'D:\build-cache\simulator-release' `
  -TestTempDirectory 'D:\host-test-state' `
  -OutputDirectory './artifacts/host-suite/run-01'
```

`OriginalCliDirectory` 是用于验证旧版拒绝新状态的原分发包，不能用当前 CLI 代替。`TestTempDirectory` 必须在仓库外；CI 模拟占用也使用这个测试目录，不使用真实会话状态。输出目录必须不存在，失败日志保留。脚本不加载 `config.local.ps1`；Java 可以从 `JAVA_HOME` 读取，其他工具路径按参数提供。部分现有 PowerShell 测试会加载本地配置来定位 JDK，但设备执行仍由各自假执行器替代。

| `-Group` | 范围 | 额外准备 |
| --- | --- | --- |
| `All`（默认） | 下列六组，顺序运行 | 所有对应依赖 |
| `Jvm` | 客户端、YAML 集成、CLI 协议与持久会话，以及公共录屏产物生命周期测试 | JDK 17、Git Bash、Gradle 8.13、完整本地依赖缓存、已校验 simulator 缓存；固定上游已应用当前补丁 |
| `Agent` | 全部 Node 客户端测试及真实 Maestro parser 检查 | JDK 17、当前完整 CLI |
| `Recovery` | 清理隔离、维护、CI 归档与 PowerShell 核销 | JDK 17、当前与原版完整 CLI、Git Bash |
| `Scripts` | Node 脚本、runner、矩阵、验证计划及 CI 包装 | JDK 17、Git，PowerShell 7 |
| `Schemas` | 录屏、retry、维护与清理隔离格式；真实 JVM 成功和 CLI 阻塞响应 | JDK 17、当前完整 CLI、Git Bash |
| `VSCode` | 编译与扩展单元测试 | 已安装扩展 npm 依赖、Node 附带的 npm |
| `ExtensionHost`（单独选择） | 真实编辑器的隔离扩展宿主测试 | 扩展 npm 依赖，另传 `-CodePath` 指定现有编辑器 |

可选择一组，例如 `-Group Agent`，或在 PowerShell 调用中选择多组，例如 `-Group Agent,Recovery,Schemas`。`All` 不包含编辑器宿主、真实 FFmpeg 视频检查或任何设备验证；这些范围不能从主机汇总推断为已通过。先加 `-CheckOnly` 会检查依赖并保存执行计划，状态为 `ready`，不计测试通过。

每个阶段保存原始 stdout、stderr 和退出码；`summary.json` 区分已通过、失败和未执行阶段，另汇总可读取的 TAP/JUnit 测试数。PowerShell 内部断言数量保留在各自日志中，不与阶段数混算。任一阶段失败或 TAP/JUnit 出现跳过、todo、零测试时返回非零；不会把缺少依赖造成的全跳过记为通过。遇到首个失败后停止剩余阶段，修复后使用新的输出目录运行。

Windows 的 JVM 范围预先排除 `maestro.harmonyos.driver.Mp4RecordingValidatorTest` 中的 `rejects symlinks even when their target is a valid recording`：原测试明确标注仅 Linux/macOS 执行。该方法单独列入 `summary.platformExclusions`，记为未执行，不计通过；其余任何运行时跳过仍失败。Windows 通过结果不覆盖这项符号链接验证。

Gradle 返回非零时仍统计本轮已产生的有效 XML。后续模块缺报告、报告陈旧或不可解析时，`countsComplete=false` 并逐项保留 `reportErrors`，汇总只包含可确认的新报告，不把尚未运行的模块算作通过。

JVM 阶段默认限时 30 分钟，Node 测试阶段 15 分钟，其余阶段 10 分钟。可用 `-StepTimeoutSeconds 1200` 统一覆盖阶段限时（1～7200 秒）。超时后只终止该入口刚启动的阶段进程树，并记录 `timedOut`、是否观察到退出和终止错误；最多额外等待 20 秒收尾，超时不能记为通过。

JVM 组使用本地 Gradle 程序和 `--offline`，强制重新运行测试任务并拒绝陈旧 XML 报告，不复制开发编译产物、不更换当前冻结 CLI；此入口验证源码测试和指定分发包的联测，不能代替新检出构建或设备验收。

## 单独运行原有测试

首次在仓库根目录执行：

```powershell
./scripts/prepare-upstream.ps1
$env:MAESTRO_TEST_POSIX_SHELL = 'D:\tools\Git\bin\bash.exe'
./scripts/test-host.ps1
```

测试脚本会检查并应用补丁。已有适配改动时不要重复执行 `prepare-upstream.ps1`，后续直接运行测试。首次运行需要下载 Gradle 与依赖，缓存完整后可加 `-Offline`。

两项清理脚本测试还需要 POSIX shell；Windows 上在首次运行测试前用 `MAESTRO_TEST_POSIX_SHELL` 指定已有的 Git Bash，示例路径须替换为本机实际文件。未配置时这两项会标记为跳过，不能计为通过；其他测试仍运行。

默认入口编译 HDC、布局解析及录屏资源恢复所需的设备适配和录屏支持类，并包含上游 `TreeNode`、`ScreenRecording`、`RecordingDiagnosticContext` 和 `TempFileHandler`；Okio 与日志依赖复用上游版本目录。它不要求 Android SDK，也不编译完整 `HarmonyOSDriver` 或 CLI。录屏资源恢复测试使用模拟 HDC 响应，不操作设备。报告位于 `host-tests/build/reports/tests/test/index.html`。补丁脚本的检查入口是 `./scripts/tests/test-patch-scripts.ps1`。

完整客户端测试：

```powershell
./scripts/test-host.ps1 -FullUpstream
```

这会执行上游 `:maestro-client:test` 中的 `maestro.harmonyos.*`，覆盖真实 Maestro 选择器、`HarmonyOSDriver` 和设备命令处理。驱动测试目录不在独立主机构建的范围内。

YAML 集成和 CLI 会话测试使用完整上游构建，在仓库根目录执行：

```powershell
if (Test-Path -LiteralPath ./config.local.ps1) { . ./config.local.ps1 }
$env:GRADLE_USER_HOME = Join-Path (Get-Location) '.gradle-user-home'
./.upstream/maestro/gradlew.bat -p ./.upstream/maestro :maestro-test:test --tests 'maestro.harmonyos.*' --no-daemon --console=plain
if ($LASTEXITCODE -ne 0) { throw 'YAML 集成测试失败。' }
./.upstream/maestro/gradlew.bat -p ./.upstream/maestro :maestro-cli:test --tests 'maestro.cli.harmonyos.*' --tests 'maestro.cli.session.*' --no-daemon --console=plain
if ($LASTEXITCODE -ne 0) { throw 'CLI 会话测试失败。' }
```

完整上游构建会解析其他模块的依赖，首次准备成本高于独立主机构建；报告分别位于对应模块的 `build/reports/tests/test/index.html`。

## 测试覆盖

- HDC/布局：设备选择、参数转义、超时与中断、布局解析、文件传输和临时文件清理。
- 完整客户端：真实驱动和选择器、启动与停止、输入动作、截图尺寸、等待、错误状态及未支持操作；系统录屏的占用检查、超时、文件校验、导出和清理。
- YAML 集成：真实 `YamlCommandReader → Orchestra → Maestro → HarmonyOSDriver → HdcClient`，仅替换 `HdcCommandRunner`。有状态模拟设备提供布局和 PNG，验证参数、条件子流程、ID/文本点击、中文及引号输入、断言、滚动后重新定位、连续子流程、截图产物与失败中断。
- 录屏收尾：通过真实 Orchestra 和 HarmonyOSDriver 验证断言失败、取消和停止失败；此组使用模拟录屏句柄，不调用系统录屏服务。
- CLI 会话：参数约束、设备选择、环境配置、显式录屏开关和设备占用锁。
- 操作录制接口：JSONL 边界和会话关闭、截图稳定性、状态栏排除、旧快照与歧义拒绝、字面文字保存、真实 Maestro 执行与生成 YAML 回放。此组与 CLI 会话测试一并位于 `maestro.cli.harmonyos.*`。

运行脚本的参数与退出码回归使用 `./scripts/tests/test-run-harmonyos.ps1`，需要 JDK 17。脚本测试不操作手机。公共输出文件的生命周期回归位于上游 `maestro-orchestra` 的 `ScreenRecordingOutputTest` 和 `ArtifactsGeneratorTest`，可分别用 `:maestro-orchestra:test --tests '*ScreenRecordingOutputTest' --tests '*ArtifactsGeneratorTest'` 执行。

逐台验证工具的主机回归入口为 `./scripts/tests/test-device-matrix.ps1`。扩展的 `npm test` 和隔离 ExtensionHost 检查见[插件说明](../packages/vscode/README.md)；主机检查通过后，仍需在真实面板上录制、保存并回放。

这些检查不验证真实手机的授权、键盘、文本输入或系统兼容性，也不等同于 CLI 分发包已构建。CLI 构建与真机命令见[使用说明](../docs/setup.md)，实际结果分别记录在 `docs/progress/`。

## 查看设备

独立主机构建也可以查询 HDC 设备列表，不执行页面动作：

```powershell
if (Test-Path -LiteralPath ./config.local.ps1) { . ./config.local.ps1 }
$env:GRADLE_USER_HOME = Join-Path (Get-Location) '.gradle-user-home'
./.upstream/maestro/gradlew.bat -p ./host-tests devices --no-daemon --console=plain
```

HDC 可通过 PATH 或 `MAESTRO_HARMONYOS_HDC` 指定。查询成功但没有设备时输出 `{"devices":[]}`；HDC 执行失败时返回非零退出码。设备标识只用于本地调试，不提交到仓库。
