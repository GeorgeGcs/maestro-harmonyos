# 构建输入、缓存与复现

更新日期：2026-11-04。

本文说明哪些输入已固定、缓存如何使用，以及如何记录一次隔离构建。首次安装步骤见[使用指南](user-guide.md)，构建命令见[环境说明](setup.md)。

当前不能宣称完整 CLI 已完成全冷构建，也不能宣称生成的 JAR、ZIP 或 VSIX 可逐字节复现。固定源码、核对下载资源和成功执行构建是几项不同的检查。

## 构建依赖哪些输入

| 输入 | 当前来源与固定方式 | 需要注意的边界 |
| --- | --- | --- |
| 适配源码 | 本仓提交及 `patches/maestro/0001-harmonyos-host.patch` | 记录本仓提交和补丁 SHA-256；未提交改动不能只用提交号表示 |
| Maestro 源码 | [upstream.lock.json](../upstream.lock.json) 固定 `3fc4ef3fc408bc70ea9baf0bac0ff3e4b565710c` | 获取源码后核对实际 HEAD，再应用完整补丁 |
| Gradle 程序 | 上游 wrapper 指定 Gradle 8.13 | wrapper 首次下载和 Gradle 依赖下载是两件事；`--offline` 不阻止 wrapper 下载 |
| Java | 完整 JDK 17 | 记录实际发行版和补丁版本，构建使用 `javac` 等工具 |
| JVM 依赖 | 上游 Gradle 配置、版本目录和插件仓库 | 固定版本配置不等于所有远端字节都已经锁定；独立缓存用于发现隐藏的本机依赖 |
| CLI 前端资源 | 上游 `maestro-cli/mcp-viewer/package.json` | 构建执行 `npm install`；新检出没有随适配提交的生成锁文件，不能宣称这部分具备与扩展相同的依赖锁定程度 |
| simulator-server | 官方 Release `simulator-server-37010dc7` | CLI 资源任务需要 Darwin、Linux、Windows 三份归档，Windows 构建也不能省掉另外两份 |
| VSCode 扩展 | `packages/vscode/package-lock.json`，通过 `npm ci` 安装 | 扩展依赖与 CLI 前端依赖分别记录；成功打包扩展不代表 CLI 已构建 |

整套工具链使用 Node.js 22.12 或以上及 npm；已记录的构建环境使用 Node.js 24.14.0。源码更新后仍需重新核对实际依赖，不能直接沿用旧构建的通过结论。

## 区分几种构建记录

- **全冷构建**：新的源码检出，没有已有 wrapper 分发包、Gradle 依赖、npm 缓存、下载资源或编译产物参与。
- **隔离依赖构建**：新的源码检出，Gradle 依赖缓存和 npm 缓存独立；可能复用了已安装的 JDK、Node 和 Gradle 程序。需要明确记录复用了什么。
- **使用已校验资源缓存的构建**：在上项基础上，从本地读取已核对的官方资源归档。资源仍需每次校验，不能把开发目录中的生成文件直接拷进构建结果。
- **增量构建**：复用原工作目录、依赖或生成结果。适合开发回归，不能替代新的检出验证。

无论采用哪种方式，都应保留第一次失败。修改路径、网络设置或缓存策略后的结果作为后续尝试记录。

## 可选的官方资源缓存

默认构建继续使用上游 `downloadSimulatorServer` 任务下载资源。网络无法稳定取得该 Release 时，可以预先下载原始归档，再通过本仓的可选 init script 使用它们。该入口不读取开发构建中的 `build/generated`、JAR 或分发目录。

公开入口：

- [资源锁清单](../scripts/gradle/simulator-resources.lock.json)：版本、官方 URL、字节数和 SHA-256。
- [只读缓存检查](../scripts/gradle/verify-simulator-cache.ps1)：检查 manifest 和三个归档，不下载、不解包、不修改缓存。
- [Gradle init script](../scripts/gradle/simulator-cache.init.gradle)：检查目标源码基线与资源，准备当前构建的生成目录。
- [缓存检查回归](../scripts/gradle/test-simulator-cache.ps1)：覆盖清单损坏、归档缺失或截断、上游版本不匹配；可额外指定真实缓存做正例。

### 固定值从哪里来

资源来源是 Maestro 维护者的[官方 Release](https://github.com/mobile-dev-inc/simulator-server-releases/releases/tag/simulator-server-37010dc7)。上游构建使用的清单位于 [SHA256SUMS](https://github.com/mobile-dev-inc/simulator-server-releases/releases/download/simulator-server-37010dc7/SHA256SUMS)。本仓锁值来自此前从该官方地址取得并保存的原始清单及归档；本次再次读取这些原始文件，核对了字节数和摘要。这不是本轮重新从网络下载成功的记录。

`SHA256SUMS` 文件为 339 字节，其 SHA-256 为：

```text
af22b3f2f4c548072f03f173ce9eb3433ab6c7f202d1f0ec4f391184f765c688
```

| 官方归档 | 字节数 | SHA-256 |
| --- | ---: | --- |
| `simulator-server-37010dc7-darwin-universal.tar.gz` | 7,487,838 | `2656d5acef36240336d513621a313561f57d9424748e5c3cdeedb73245b067ec` |
| `simulator-server-37010dc7-linux-x86_64.tar.gz` | 53,483,507 | `00fcabe51c2913bd8e07b183930e25d95e071c0057bc209ad0d27711454755c4` |
| `simulator-server-37010dc7-windows-x86_64.zip` | 77,794,484 | `b9d22177cbb79558f2b3a24c5b55e806d19c0c994f947730518ddab7a2994937` |

摘要用于识别所使用的固定字节，不是独立于发布者的签名认证。升级上游、资源版本或官方清单时，应审查来源、更新锁及检查入口，并重新验证；不要通过删除摘要检查继续构建。

### 准备缓存

在仓库根目录执行。示例缓存放在被忽略的 `artifacts` 下，也可改为自己的专用目录：

```powershell
$resourceLock = Get-Content ./scripts/gradle/simulator-resources.lock.json -Raw -Encoding UTF8 | ConvertFrom-Json
$resourceCache = [IO.Path]::GetFullPath((Join-Path (Get-Location) 'artifacts/simulator-release-cache'))
$null = [IO.Directory]::CreateDirectory($resourceCache)
$downloads = @($resourceLock.manifest) + @($resourceLock.archives)
foreach ($file in $downloads) {
  $destination = Join-Path $resourceCache $file.name
  if (-not (Test-Path -LiteralPath $destination)) {
    Invoke-WebRequest -UseBasicParsing `
      -Uri ($resourceLock.releaseBaseUrl + '/' + $file.name) `
      -OutFile $destination -TimeoutSec 120
  }
}
./scripts/gradle/verify-simulator-cache.ps1 -CacheDirectory $resourceCache
```

下载被中断或现有文件被修改时，检查会失败。确认具体文件后重新下载该官方归档，不要用改过的摘要接受残缺文件。下载命令不是校验步骤；只有最后的检查通过，缓存才具备进入后续构建的条件。

### 用缓存构建

先准备固定上游并应用本仓补丁。以下命令仍在适配仓根目录执行：

```powershell
$adaptationRepository = (Get-Location).Path
$resourceCache = (Resolve-Path ./artifacts/simulator-release-cache).Path
$cacheInit = Join-Path $adaptationRepository 'scripts/gradle/simulator-cache.init.gradle'
$env:GRADLE_USER_HOME = Join-Path $adaptationRepository '.gradle-user-home'
./.upstream/maestro/gradlew.bat -p ./.upstream/maestro `
  -I $cacheInit `
  "-Dmaestro.harmonyosRepository=$adaptationRepository" `
  "-Dmaestro.simulatorCache=$resourceCache" `
  :maestro-cli:installDist --no-daemon --console=plain
if ($LASTEXITCODE -ne 0) { throw 'CLI 构建未通过，请保留本次输出。' }
```

`maestro.harmonyosRepository` 指向含两份锁文件的适配仓；`-p` 可以另指向独立的 Maestro 检出。init script 会核对该目标的真实 Git HEAD、版本目录和输出位置，因此不要求缓存与源码具有固定的父子目录关系。它只支持上面固定的 Maestro 基线及默认的 `maestro-cli/build/generated/simulator-server` 输出位置。

每次构建会重新执行这些检查：

1. 本仓上游锁与资源锁一致，目标检出的 HEAD 等于固定提交，`simulatorServer` 版本一致。
2. `SHA256SUMS` 的大小和 SHA-256 等于锁值，内容恰好覆盖三份指定归档。
3. 三份归档的大小和 SHA-256 同时符合官方清单与本仓锁值。
4. 解包视图中没有路径穿越或重复文件名，各平台包含预期的可执行文件。
5. 当前构建生成目录的路径集合和每个文件哈希与归档内容完全一致，并含固定版本标记。

全部通过后，才停用本次原网络下载动作。任务不是通过 `-x downloadSimulatorServer` 跳过检查；资源缺失、不匹配或检查失败都会让构建失败。生成资源中的链接也会被拒绝。

核验记录写到目标检出的 `maestro-cli/build/reports/simulator-cache/preparation.json`，包含来源、版本、归档摘要和生成文件摘要；原缓存目录保持只读。该文件证明资源准备经过检查，不代表之后的 Kotlin 编译、测试或 CLI 打包已经成功。

资源缓存不提供 Gradle 分发包、Maven 依赖或 npm 包，也不使整个构建自动离线。

## Windows 路径和网络问题

Gradle 的依赖路径会附加较长的坐标和哈希。有些原生工具仍受 Windows 路径长度限制影响；即使仓库可以打开，`protoc-gen-grpc-java.exe` 等程序也可能无法启动。为隔离构建选择专用的短路径 `GRADLE_USER_HOME`，例如替换为本机可写的 `D:\build-cache\g-maestro`。不要复用已有开发缓存来掩盖路径或下载问题。

移动独立缓存时，先确认对应构建进程已结束；保留缓存来源和路径调整记录，避免把同一批依赖误算成又一次全新下载。本次路径调整只涉及独立测试缓存，没有借用开发依赖缓存来证明成功。

固定 wrapper 的 `networkTimeout=10000`。首次获取 [Gradle 8.13 分发包](https://services.gradle.org/distributions/gradle-8.13-bin.zip) 超时属于 bootstrap 失败；若改用已有 Gradle 8.13 程序继续，应明确标为复用程序的隔离依赖构建。保留原 wrapper、资源下载和 npm 错误，分别处理，不能因存在旧分发目录就把失败记为通过。

## 2026-10-30 的隔离构建记录

源码基线为本仓提交 `9e0b5121fce35ae183dc53a0a1a04fd738b219ed`，通过 `git archive` 导出。上游基线仍为 `3fc4ef3fc408bc70ea9baf0bac0ff3e4b565710c`，应用该源码版本的适配补丁。

| 阶段 | 实际结果 | 结论范围 |
| --- | --- | --- |
| 获取上游 | 网络 Git fetch 遇到连接重置，改用保留固定提交的本地 shallow bundle，核对目标提交 | 验证了固定源码来源和提交，不算本轮远程获取成功 |
| 独立缓存 | 使用新的 Gradle 依赖缓存和 npm 缓存 | 没有用现有 CLI 分发包或编译输出代替构建 |
| wrapper bootstrap | 首次下载在 10 秒网络预算内超时；后续复用已有 Gradle 8.13 程序 | 不满足全冷构建条件 |
| 原生代码生成 | 初始缓存路径使 gRPC 代码生成程序完整路径达到 267 字符，启动失败；移到短路径后同一独立缓存中的 `generateProto` 通过 | 确认了这一处路径问题；不是完整 CLI 通过 |
| 官方 simulator 资源 | 原下载任务遇到连接重置，完整 CLI 构建未完成 | 不能报告该次 `installDist` 成功 |
| VSIX | 独立源码和空 npm 缓存下安装依赖、打包成功 | 仅证明扩展构建，不代替 CLI 构建 |

本轮新增的公开缓存入口通过了本机清单/归档检查及拒绝损坏输入的回归；init script 使用现有 Gradle 8.13 的 Groovy 库完成独立编译检查，没有借此执行共享 Gradle 构建。首次校验命令展开全部 JAR 时触发 Windows 命令行长度限制，改用 JVM classpath 通配符后编译通过。

随后使用公开缓存入口继续同一隔离源码构建，`:maestro-cli:installDist` 成功，耗时 7 分 5 秒。此次显式复用的是 Gradle 8.13 程序及经过锁定哈希校验的官方 simulator 归档；源码编译产物没有从开发目录复制。独立依赖缓存延续本轮前面已下载的内容。这验证了带声明缓存的构建路径，仍不能把最初的网络下载失败改写成全冷构建成功。

## 2026-10-31 的版本构建

本仓提交 `7ca199e` 在新的源码目录完成 CLI 与 VSIX 构建，CLI 版本检查为 `2.12.0`，扩展版本为 `0.1.0`。适配源码来自该提交的 Git archive，上游来自已保存并校验的固定提交 bundle；应用完整补丁后构建，没有复制开发目录的编译输出、node_modules 或安装包。

本次显式复用 Gradle 8.13 程序、已有 Gradle/npm 依赖缓存及经公开锁清单检查的官方 simulator 资源，构建时关闭依赖网络、Gradle build cache 和 configuration cache。它证明的是带声明缓存的独立源码构建，不是全冷构建或产物逐字节可复现。

第一次尝试因 Gradle 客户端无法连接本机 daemon 失败，保留了日志；随后在另一新目录、允许本机进程通信的环境完成构建。没有修改系统配置、更新 SDK 或重启电脑。新产物还通过了 JVM 维护材料到 Node 核验/CI 归档的主机联测，以及八条 ComponentCollection 入口的原生解析。构建和主机检查均不包含安装应用、真实录屏、设备恢复或 VSCode 真机回放。

## 2026-11-01 的版本构建

本仓提交 `f285dc85a3f91f1f0ddd0ab94ada6aa0bf0284a2` 在独立源码目录完成 CLI 与 VSIX 构建，版本分别为 `2.12.0` 和 `0.1.0`。源码通过 Git archive 导出，上游来自固定提交的本地 bundle，显式复用 Gradle 程序、依赖缓存及已校验的官方 simulator 资源；未复制开发编译产物，关闭依赖网络和 Gradle build cache。因此仍属于带声明缓存的隔离构建，不是全冷下载或字节级可复现验证。

该 CLI 随后用于 ComponentCollection 同会话录屏批次及 20 轮开发计划，结果见 [11-01 记录](progress/2026-11-01.md)：前者 4/4 通过，后者在第 2 轮停止、未达标。构建成功、单批执行通过与重复稳定性达标分别记录。后续测试夹具、用例和文档提交不改变这份构建的源码标识；最终交付版本仍需重新冻结并完成联测。

## 2026-11-04 的交付构建

本仓提交 `728859cb` 在干净的独立源码目录完成 CLI 与 VSIX 构建，版本分别为 `2.12.0` 和 `0.1.0`。`:maestro-cli:installDist` 耗时 3 分 41 秒，35 个任务全部执行。显式复用 Gradle/npm 依赖缓存及经过校验的官方 simulator 资源，没有复制旧编译产物；这仍是带声明缓存的独立源码构建，不是全冷构建或字节级可复现验证。

已生成 CLI 分发 ZIP、VSIX、便携包及 `SHA256SUMS`。便携包清单包含 447 个文件，`version`、`describe` 和 `check-only` 三项检查通过，检查期间设备命令数为 0。这些检查证明交付文件和本机入口可用，不代表设备场景或视频质量通过。

同一新 CLI 随后通过 HMOS 完整场景分段录屏，三段原片完整解码通过；同版 VSIX 在真实 VSCode 中通过断言、截图两步的 YAML 保存与 CLI 回放。时间、包摘要和验证边界见[本轮交付记录](progress/2026-11-04-delivery.md)。顶部修复版的新 20 轮仍暂缓；此前版本的结果保留原归属，后续文档整理单独提交，不倒改安装包的 `728859cb` 源码标识。

## 建议保留的复现材料

每次独立验证保留本仓与上游提交、补丁摘要、实际 JDK/Node/npm/Gradle 版本、执行命令、依赖和资源缓存是否复用、原始退出码与完整日志。使用资源缓存时一并保留锁清单和本次 `preparation.json`。生成安装包后可记录其 SHA-256，作为这一次产物的标识。

检查新版本时，从新的源码目录开始；不复制开发目录的 `.gradle`、`build`、`node_modules` 或旧 VSIX 来充当本次结果。缓存可复用，但必须写明来源、边界和校验方式。
