# 主机端测试

这个构建入口用于开发 HDC 调用和 UITest 布局转换。它直接编译 `.upstream/maestro` 中的适配代码、上游 `TreeNode` 和测试所需的 `TempFileHandler`，版本与依赖沿用固定上游的配置，没有另写 Maestro 类型的替身。

测试不需要连接手机，也不需要 Android SDK。HDC 进程测试会启动本地 Java 子进程，检查输出读取、超时、中断和参数传递；布局样本为合成数据，不是真机采集结果。

## 运行

首次在仓库根目录执行：

```powershell
./scripts/prepare-upstream.ps1
./scripts/test-host.ps1
```

测试入口会检查并应用补丁。已有适配改动时，不要重复执行 `prepare-upstream.ps1`，后续直接运行 `test-host.ps1`。

报告位于 `host-tests/build/reports/tests/test/index.html`。补丁脚本本身的检查可通过 `./scripts/tests/test-patch-scripts.ps1` 运行。

## 查看设备

以下命令使用新写的 HDC 适配层查询设备列表，不执行设备动作：

```powershell
if (Test-Path ./config.local.ps1) { . ./config.local.ps1 }
$env:GRADLE_USER_HOME = Join-Path (Get-Location) '.gradle-user-home'
./.upstream/maestro/gradlew.bat -p ./host-tests devices --no-daemon --console=plain
```

发现成功但没有设备时输出 `{"devices":[]}`。HDC 执行失败时返回非零退出码，不把失败当成空列表。设备标识仅用于本地调试，不提交到仓库。

## 与完整客户端测试的区别

`./scripts/test-host.ps1 -FullUpstream` 使用上游完整的 `:maestro-client:test`。其中 `UitestMaestroSelectorTest` 还会检查真实 Maestro 选择器及坐标转换，它不在独立主机测试范围内。

独立测试通过只能说明这些主机模块通过测试，不能证明完整 CLI 已构建，也不能证明鸿蒙驱动、设备输入或录屏可用。每类测试结果分别记录在 `docs/progress/`。
