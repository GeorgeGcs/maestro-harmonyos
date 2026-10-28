# 开发环境与上游接入

已有 HDC 与布局转换的主机端实现。完整鸿蒙驱动尚未接入，当前不能运行鸿蒙 YAML Flow。

## 环境

- Git 与 PowerShell（脚本可在 Windows PowerShell 5.1 或较新 PowerShell 中运行）。
- 完整 JDK 17，包含 `java` 和 `javac`，与固定上游的构建配置一致。
- DevEco SDK 中与目标设备匹配的 HDC。可加入 PATH，也可为环境检查显式传入 `-HdcPath`。
- Node.js 用于后续 VSCode 扩展开发；版本在扩展实现时固定。
- 可授权 USB 调试的鸿蒙真机。具体系统和 API 版本由实际设备记录决定。

```powershell
# 如本机已有个人工具路径配置，先加载到当前进程：
if (Test-Path -LiteralPath ./config.local.ps1) { . ./config.local.ps1 }
./scripts/check-environment.ps1
# HDC 尚未加入 PATH 时：
./scripts/check-environment.ps1 -HdcPath 'D:\path\to\hdc.exe'
```

环境检查只定位工具并读取 Java/Node 版本，不修改环境变量、不安装依赖、不启动或操作设备。缺少工具时返回非零退出码。

个人安装路径可放在被 Git 忽略的 `config.local.ps1` 中，设置当前 PowerShell 进程的 `JAVA_HOME` 和 PATH。该文件由各开发者按本机情况维护，不提交绝对路径，也不修改系统级环境变量。固定上游当前指定 Java 17 toolchain，优先使用完整 JDK 17（包含 `javac`）。

## 固定上游

```powershell
./scripts/prepare-upstream.ps1
```

脚本从 `upstream.lock.json` 的公开地址获取指定提交，检出到 `.upstream/maestro`。该目录不会被提交到本仓。脚本不执行构建、不安装依赖、不修改系统配置；已存在且有改动的上游目录会被保留并报错。

获取源码后执行：

```powershell
./scripts/apply-upstream-patches.ps1
./scripts/test-host.ps1
```

当前补丁 `patches/maestro/0001-harmonyos-host.patch` 包含 HDC、布局转换和对应测试。回放前会检查上游版本与工作区；完整补丁已存在时直接返回，不覆盖其他改动。已有适配改动后不要再次执行 `prepare-upstream.ps1`。

默认测试入口只编译主机模块及所需的真实上游类型，不要求 Android SDK。使用 `./scripts/test-host.ps1 -FullUpstream` 可另行检查完整客户端；两个入口的依赖与验证范围不同，详见[主机测试说明](../host-tests/README.md)。

原始上游中的 AGENTS.md 和构建说明应在开始改动该目录前阅读。不得用预期输出代替编译结果。

## CLI 基线构建

加载 JDK 配置后，在仓库根目录执行：

```powershell
$env:GRADLE_USER_HOME = Join-Path (Get-Location) '.gradle-user-home'
./.upstream/maestro/gradlew.bat -p ./.upstream/maestro :maestro-cli:installDist --no-daemon --console=plain
```

此任务还会构建上游 MCP viewer 并下载模拟器服务资源。2026-10-28 已完成打包和 Windows 版本检查；本机遇到的资源下载问题及缓存处理记录在[当日进展](progress/2026-10-28.md)。分发包位于 `.upstream/maestro/maestro-cli/build/install/maestro/`，当前仍未接入鸿蒙平台分支。

## 最小设备验证

驱动接入后，使用约定的官方示例应用验证：启动 → 获取布局树 → 文本/ID 定位 → 点击 → 中文输入 → 滑动后重新定位 → 断言 → 截图 → 退出与清理。

先记录单轮执行结果，再按 [验收清单](acceptance.md) 重复执行。视频录屏与操作生成 YAML 分别验证。当前 `examples/flows/smoke.yaml` 是参数化设计示例，尚不能证明设备能力可用。

## 资料

- [Maestro 安装文档](https://docs.maestro.dev/maestro-cli/how-to-install-maestro-cli)
- [Maestro 上游](https://github.com/mobile-dev-inc/Maestro)
- [UITest 使用指导](https://github.com/openharmony/docs/blob/master/zh-cn/application-dev/application-test/uitest-guidelines.md)
