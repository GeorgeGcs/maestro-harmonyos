# 主机端测试

测试分为 HDC/布局模块、完整驱动、YAML 流程和 CLI 会话四部分，均不要求连接手机。主机测试使用合成布局和模拟设备响应；HDC 进程测试会启动本地 Java 子进程，检查输出读取、超时、中断及参数传递。

## 运行

首次在仓库根目录执行：

```powershell
./scripts/prepare-upstream.ps1
./scripts/test-host.ps1
```

测试脚本会检查并应用补丁。已有适配改动时不要重复执行 `prepare-upstream.ps1`，后续直接运行测试。首次运行需要下载 Gradle 与依赖，缓存完整后可加 `-Offline`。

默认入口只编译 HDC、布局解析、上游 `TreeNode` 和 `TempFileHandler`，不要求 Android SDK，也不编译完整驱动或 CLI。报告位于 `host-tests/build/reports/tests/test/index.html`。补丁脚本的检查入口是 `./scripts/tests/test-patch-scripts.ps1`。

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
./.upstream/maestro/gradlew.bat -p ./.upstream/maestro :maestro-cli:test --tests 'maestro.cli.harmonyos.*' --no-daemon --console=plain
if ($LASTEXITCODE -ne 0) { throw 'CLI 会话测试失败。' }
```

完整上游构建会解析其他模块的依赖，首次准备成本高于独立主机构建；报告分别位于对应模块的 `build/reports/tests/test/index.html`。

## 测试覆盖

- HDC/布局：设备选择、参数转义、超时与中断、布局解析、文件传输和临时文件清理。
- 完整客户端：真实驱动和选择器、启动与停止、输入动作、截图尺寸、等待、错误状态及未支持操作；系统录屏的占用检查、超时、文件校验、导出和清理。
- YAML 集成：真实 `YamlCommandReader → Orchestra → Maestro → HarmonyOSDriver → HdcClient`，仅替换 `HdcCommandRunner`。有状态模拟设备提供布局和 PNG，验证参数、条件子流程、ID/文本点击、中文及引号输入、断言、滚动后重新定位、连续子流程、截图产物与失败中断。
- 录屏收尾：通过真实 Orchestra 和 HarmonyOSDriver 验证断言失败、取消和停止失败；此组使用模拟录屏句柄，不调用系统录屏服务。
- CLI 会话：参数约束、设备选择、环境配置、显式录屏开关和设备占用锁。

运行脚本的参数与退出码回归使用 `./scripts/tests/test-run-harmonyos.ps1`，需要 JDK 17。脚本测试不操作手机。公共输出文件的生命周期回归位于上游 `maestro-orchestra` 的 `ScreenRecordingOutputTest` 和 `ArtifactsGeneratorTest`，可分别用 `:maestro-orchestra:test --tests '*ScreenRecordingOutputTest' --tests '*ArtifactsGeneratorTest'` 执行。

这些检查不验证真实手机的授权、键盘、文本输入或系统兼容性，也不等同于 CLI 分发包已构建。CLI 构建与真机命令见[使用说明](../docs/setup.md)，实际结果分别记录在 `docs/progress/`。

## 查看设备

独立主机构建也可以查询 HDC 设备列表，不执行页面动作：

```powershell
if (Test-Path -LiteralPath ./config.local.ps1) { . ./config.local.ps1 }
$env:GRADLE_USER_HOME = Join-Path (Get-Location) '.gradle-user-home'
./.upstream/maestro/gradlew.bat -p ./host-tests devices --no-daemon --console=plain
```

HDC 可通过 PATH 或 `MAESTRO_HARMONYOS_HDC` 指定。查询成功但没有设备时输出 `{"devices":[]}`；HDC 执行失败时返回非零退出码。设备标识只用于本地调试，不提交到仓库。
