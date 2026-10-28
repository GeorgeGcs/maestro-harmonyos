# Maestro 适配补丁

上游版本由仓库根目录的 `upstream.lock.json` 固定。当前补丁为 `0001-harmonyos-host.patch`，包含鸿蒙主机端代码和测试；补丁范围以文件差异为准，不表示已经通过真机验证。

在仓库根目录使用 PowerShell：

```powershell
# 首次获取固定上游
./scripts/prepare-upstream.ps1
# 应用补丁
./scripts/apply-upstream-patches.ps1
# 运行鸿蒙主机测试
./scripts/test-host.ps1
```

回放脚本先检查上游地址、提交号及工作目录，再检查补丁是否可应用。重复执行时，如果完整补丁已在工作区，直接返回并保留其他本地改动。补丁未完整应用且工作区有改动时停止，避免覆盖开发中的代码。脚本不执行 `reset`、`clean` 或自动回滚。

上游已应用补丁后，不要再次用 `prepare-upstream.ps1` 初始化；该脚本会拒绝有改动的工作区。后续直接运行测试入口即可。

`test-host.ps1` 加载本地 `config.local.ps1`（如有），使用仓库内的 `.gradle-user-home`，通过固定上游的 Gradle wrapper 运行 `host-tests`。该入口直接编译上游工作区中的同一份鸿蒙代码和实际 `TreeNode` 类，测试过滤为 `maestro.harmonyos.*`，不依赖 Android SDK、不安装应用或操作手机。

需要验证完整客户端构建时，运行 `./scripts/test-host.ps1 -FullUpstream`，它会执行上游的 `:maestro-client:test` 并使用相同测试过滤。完整构建仍需要上游各模块的依赖和工具链，不等于独立主机测试；测试结果分别记录。

首次运行需要下载 Gradle 和构建依赖；已缓存依赖时可使用 `-Offline`。Gradle 的离线选项不负责阻止 wrapper 首次下载，请先准备好 Gradle 分发包。入口不运行全量测试或 CLI 打包任务。

默认报告位于 `host-tests/build/reports/tests/test/index.html`；完整客户端报告位于 `.upstream/maestro/maestro-client/build/reports/tests/test/index.html`。

更新补丁时将未跟踪的新源码和测试一并导出，保留上游版权声明。在干净的固定版本检出中检查回放，再记录构建与测试结果。
