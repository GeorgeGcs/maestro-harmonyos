# 在另一台电脑验证 Agent 接入

便携包把一个已提交版本的项目源码和对应的 Maestro CLI 放到同一个 ZIP 中。接收方可以先检查文件完整性、启动 CLI、查询 Agent 协议并检查参数化 Flow，再配置自己的 HDC 和设备。包内不带 Java、Node.js、PowerShell、HDC、SDK、应用 HAP 或本机设备状态。

目前打包和安全解压入口使用 Node.js 22.12 以上与 PowerShell 7；打包端还需要 Git。CLI 自测使用 JDK 17 的原生 Java 启动器，Flow 检查会编译随包提供的 Java helper。所有命令均可在没有手机的环境执行。

## 包的内容

```text
manifest.json                  版本、构建记录摘要及逐文件 SHA-256
source/                        指定提交的全部 tracked 文件
cli/bin/                       installDist 启动脚本
cli/lib/                       installDist 的完整依赖文件（JAR 与 POM）
licenses/upstream/LICENSE      固定上游提交的许可证
licenses/upstream/NOTICE       固定上游提交存在此文件时一并保留
```

源码来自 `git archive <完整提交 SHA>`，与工作目录中的未提交修改无关。打包器还逐项核对 Git tree 的文件内容，拒绝符号链接、子模块、`export-ignore` 遗漏或导出时改写内容。项目 `.gitattributes` 固定 LF 换行。已跟踪文件若含 `.local`、本机配置、设备配置、签名材料或 HAP，整个打包过程失败；不能通过忽略这些文件来声称已导出了完整源码。

清单中的路径均相对包根目录，采用 `/`，不写入设备标识、本机构建目录或构建日志。原构建记录留在打包端，包内只保留其摘要和通过状态。源码中的通用文档和合成测试夹具仍按 Git 提交原样导出。

## 打包端

先对准备交付的提交完成独立构建，再指定构建记录和实际 `installDist` 目录。输出 ZIP、工作目录都必须尚不存在，且不能位于 CLI 输入目录内；输出 ZIP 也不能位于工作目录内。

```powershell
node scripts/package-agent-bundle.mjs `
  --repository C:\work\maestro-harmonyos `
  --commit <40位项目提交SHA> `
  --cli-directory C:\build\maestro\bin-distribution `
  --upstream-directory C:\build\maestro-source `
  --build-manifest C:\build\manifest.json `
  --build-sha256 <构建记录SHA256> `
  --output C:\delivery\maestro-agent.zip `
  --work-directory C:\delivery\package-work
```

`--git`、`--pwsh` 可以指定工具的完整路径。`--build-sha256` 建议由构建结束后保存的可信记录提供；省略时，清单会明确记录信任来源为调用者显式选择的本地记录，工具不会把它描述为独立验签结果。

构建记录必须是 schema v1 的实际构建结果，包含：

| 字段 | 核验要求 |
| --- | --- |
| `status`、`cliBuildStatus`、`cliVersionStatus` | 均为 `passed` |
| `projectCommit` | 等于指定的完整项目提交 SHA |
| `projectArchive.bytes/sha256` | 等于重新生成的该提交 ZIP |
| `upstreamCommit`、`patchSha256` | 等于提交中的锁文件与适配补丁 |
| `stages` | 有成功、退出码 0 的 `:maestro-cli:installDist` 执行记录 |
| `cliDirectory` | 原构建使用的 CLI 目录，由本地原记录保留 |
| `cliFiles` | 完整分发文件集合，含 `bin`；每项为 `{path,bytes,sha256}`，`path` 相对分发根目录 |

缺少完整 `cliFiles` 的旧记录需要重新构建或在受控构建收尾阶段补齐，不能用一份事后观察快照代替实际构建记录。新增、丢失、修改任何依赖 JAR 或启动器都会使核验失败。打包结果仍标注 `sourceToBinaryCorrespondence=reported-by-build-record`、`signedProvenance=false`：它核对构建记录与文件，不提供签名的构建来源证明，也不声称二进制可重复构建。

命令成功后输出一条 JSON，其中 `archiveSha256` 用于交付核对。将 ZIP 和该摘要通过可信渠道交给接收方。仅把 ZIP 及其自带清单同时替换，无法由包内摘要识别；接收方应保留独立获知的 ZIP 摘要。

## 接收端：先解压核验，再做无设备自测

先从可信项目检出获取校验脚本。不要为了校验一个未知 ZIP 而先运行其中的脚本。

```powershell
node scripts/verify-agent-bundle.mjs `
  --archive C:\incoming\maestro-agent.zip `
  --expected-sha256 <交付端给出的ZIP摘要> `
  --extract-to C:\work\maestro-agent `
  --self-test `
  --java C:\tools\jdk\bin\java.exe `
  --artifacts C:\work\maestro-agent-check
```

解压目录和自测产物目录都必须尚不存在。工具先遍历 ZIP 的全部目录项，拒绝越界路径、Windows 特殊路径、重复路径（不区分大小写）、文件与目录冲突、链接和特殊文件，再创建目标目录。最多允许 50,000 项，压缩包及展开总量均限 2 GiB。完成解压后，按清单核验文件集合、大小和 SHA-256，额外文件也会失败。

`--self-test` 依次执行：

1. CLI `--version`。
2. `harmonyos-bridge`，仅发送一次 `agent.describe` 协商 v2，随后关闭输入并等待进程退出。
3. 包内 `examples/agent-client/run.mjs --check-only`，使用 `examples/flows/smoke.yaml` 和占位参数检查 YAML 及其依赖。`APP_ID` 由 `--app org.example.bundle` 提供，其余参数是合成文本。

这些入口不发送 `agent.preflight`、`connect` 或 UI 命令；HDC 环境变量指向不存在的占位路径，录屏关闭，统计上报和首次使用提示关闭。这里只检查 CLI、协议和 Flow 的主机端入口，不代表设备接入、页面断言、录屏或应用场景已通过。自测日志单独保存在 `--artifacts`；任一步失败都会返回非零退出码，不能跳过后仍报通过。

已解压目录可以用 `--directory C:\work\maestro-agent` 再次核验。此模式无法回溯外部解压器当时的行为；首次接收优先使用上面的 `--archive` 入口。省略 `--self-test` 只做完整性核验，结果会写 `selfTest=not-requested`。指定了 `--java` 或 `--artifacts` 却没有 `--self-test` 会报错。

配置 HDC、安装测试应用和开始设备流程，请继续阅读包内 [Agent 示例](../examples/agent-client/README.md) 和[使用说明](user-guide.md)。设备 ID 与接入产物保存在接收方本地，不回写交付包。

## 工具回归

```powershell
node --test scripts/tests/test-agent-bundle.mjs
```

测试建立隔离的小型 Git 仓库和合成 CLI 文件，验证提交导出、构建记录关联、完整文件集合、篡改拒绝和恶意 ZIP 路径。它不执行合成 JAR，也不调用 HDC。需要指定工具路径时使用 `AGENT_BUNDLE_GIT`、`AGENT_BUNDLE_PWSH`；工具缺失会失败，不会跳过。真实 CLI 的无设备自测由交付包校验命令执行，结果不能用这些夹具测试替代。
