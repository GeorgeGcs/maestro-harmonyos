# Maestro HarmonyOS Recorder

在 VSCode 中查看鸿蒙手机截图和控件树，选择控件、执行操作，生成标准 Maestro YAML，再保存和回放。

首次准备完整工具链请按仓库 `docs/user-guide.md` 操作；维护扩展或桥接接口前可阅读 `docs/development-design.md`。

插件通过面板生成操作步骤，也提供 UITest 真机触摸录制和记录导入。回放由 HarmonyOSDriver 和 Maestro 执行。桥接协议见仓库 `docs/recorder-protocol.md`。

## 安装与配置

需要 VSCode 1.95 或以上版本、JDK 17，以及包含本项目补丁的 Maestro CLI。HDC 应能发现已授权的设备。可以使用本项目发布的 CLI 分发包，或按仓库 `docs/setup.md` 构建 `:maestro-cli:installDist`。

在 VSCode 扩展视图中执行“从 VSIX 安装”，选择发布包中的 `maestro-harmonyos-recorder-0.1.1-<提交号>.vsix`，或本地构建出的 `dist/maestro-harmonyos-recorder-0.1.1.vsix`。扩展安装包不包含 Java、HDC 或 Maestro 分发包。

打开本地项目并信任工作区，在设置中配置：

| 设置 | 用途 |
| --- | --- |
| `harmonyosRecorder.cliDirectory` | 含 `bin`、`lib` 的 Maestro 分发目录；留空使用当前项目下 `.upstream/maestro/maestro-cli/build/install/maestro` |
| `harmonyosRecorder.javaPath` | Java 原生可执行文件；留空使用 VSCode 进程的 `JAVA_HOME` 或 PATH |
| `harmonyosRecorder.hdcPath` | HDC 原生可执行文件；留空使用 `MAESTRO_HARMONYOS_HDC` 或 PATH |
| `harmonyosRecorder.appId` | 连接时预填的测试应用 bundle 名称 |
| `harmonyosRecorder.abilityName` | 启动 Ability，默认 `EntryAbility` |
| `harmonyosRecorder.moduleName` | 可选入口 module |
| `harmonyosRecorder.flowEnvironment` | 运行文件或套件时传给 Maestro 的 `NAME=VALUE` 数组，参数可能出现在本地产物里 |

扩展不会执行 `config.local.ps1`。在终端加载的临时环境不会自动传入已经启动的 VSCode；这时直接填写 Java 和 HDC 路径即可。多文件夹工作区首次使用时选择一个项目作为产物目录。

## 录制与回放

1. 从命令面板执行 **HarmonyOS: 打开流程录制**，点击“连接设备”，选择 HDC 设备并填写应用和 Ability。
2. 点击“启动应用”，等待截图和控件树更新。截图是按操作刷新的，不是视频流。
3. 点击截图只会选择控件，不会直接操作手机。确认高亮位置后点击“点击控件”或“断言控件可见”；也可在控件树里选择父节点或其他节点。
4. 输入文字、滑动、返回或保存截图步骤。只有桥接确认执行成功的步骤才追加到 YAML。操作已成功而后续截图刷新失败时，步骤保留；手动刷新即可，不要重复点击。
5. 点击“保存 YAML”生成完整 Flow。也可直接“回放流程”：插件先关闭录制会话并确认设备锁释放，再启动 CLI 回放当前步骤。回放结束后可重新连接继续录制。

控件优先按唯一 ID 或文字定位。无法唯一匹配时可换选控件；确实需要坐标时，明确点击“按所选坐标点击”。坐标受设备尺寸和布局影响，跨设备流程应优先使用控件定位。页面旋转或尺寸改变时请断开并重新连接。

输入通过 UTF-8 JSON 标准输入传给桥接，避免 Windows 命令行编码改变文字。桥接负责生成和执行同一条 YAML；不能安全表示的内容会明确拒绝，不会悄悄改写。可见文字断言可用于检查输入结果。

插件提供 `maestro-flow`、`maestro-tap` 和 `maestro-assert` 三个 YAML 片段，使用 VSCode 的 YAML 高亮。生成的文件可以继续手工编辑，再从面板运行。点击“回放流程”执行当前面板中的步骤。

## 在 VS Code 里录制真机触摸

在测试设备打开目标应用。在录制面板点击 **开始录制**，选择设备和应用包名，等面板显示「正在录制」后再用手指操作。录制最长两分钟。部分设备会延迟输出操作日志，最终生成的步数以停止后的记录为准。请在整个录制期间保持目标测试应用前台。

点击 **停止并生成 YAML**。插件确认设备端录制进程结束并读取记录后，会在工作区的 `artifacts/recorder/touch-*/touch-flow.yaml` 打开生成的文件。检查步骤并保存修改，再点 **回放触摸流程**。回放失败时可查看错误原因、源码位置、截图和日志。停止回放后，等到「设备已释放」即可继续重跑。

在 HarmonyOS 7.0.0.111 手机的 HMOS 代码工坊上，从 VS Code 录入两次实际手指滑动、生成两条 `swipe` 并在同一台手机回放通过。生成的步骤使用屏幕坐标，适合在相同尺寸、方向和初始页面上复现。

如果设备有正在运行的 UITest 录制或既有录制文件，插件会提示检查归属。设备意外断开时会显示释放未确认。重新连接后，先确认 UITest 录制进程已退出、归档属于该会话的 `/data/local/tmp/record.csv`，再处理对应的 `/data/local/tmp/maestro-touch` 会话目录。前台录制与回放共用该面板，请避免同时从其他工具操作同一设备。

## 导入已有触摸录制

在测试设备上打开目标应用。在终端用 `hdc -t <设备序列号> shell uitest uiRecord record` 开始，执行测试手势后按 Ctrl+C 停止。用 `hdc -t <设备序列号> shell uitest uiRecord read` 读取，保存为 UTF-8 的 `.jsonl` 文件。原始操作记录保存在设备的 `/data/local/tmp/record.csv`，开始前请确认这个文件可以由本次测试使用。[华为 UITest 操作录制说明](https://developer.huawei.com/consumer/cn/doc/HarmonyOS-Guides/uitest-guidelines/)

从 VS Code 命令面板运行 **HarmonyOS: 导入设备触摸录制**，选择文件并确认应用包名。插件把单指点击和滑动转换为坐标 YAML，显示跳过的记录数。导入结果会打开在编辑器中，可检查、保存，再在相同设备尺寸和方向下回放。记录中的应用包名为空时，以手动确认的应用为准，请只录制该测试应用。

在 HarmonyOS 7 平板（UITest 7.0.0.1）上，已验证手指滑动可以导出、转换为 YAML，并用 CLI 在同一设备上回放。点击转换已有测试覆盖。

## 看运行进度、停止与重跑

1. 在“运行与证据”中点击 **运行 YAML 或套件**，选择已保存的 YAML 或套件目录，再选择设备。已经连接录制设备时，插件会先断开录制会话并确认释放。
2. 面板显示主 Flow、子 Flow 和最近步骤。编辑器跟随正在运行的 YAML 行。同一子 Flow 多次执行时按步骤编号区分；重试中的步骤显示尝试次数。
3. 点击失败步骤或 **查看失败证据** 打开运行时的 YAML、失败截图和日志。点 **停止任务** 后，当前步骤先收尾，再结束本轮。面板提示设备已释放后，可用 **重跑** 沿用上次的路径、设备和参数。每轮单独保存产物，文件型用例会重新读取磁盘上的 YAML。
4. 需要看设备画面时勾选 **预览设备画面**。它复用执行器已有截图，两帧至少间隔两秒。界面隐藏时暂停，长时间没有截图的步骤会保留上一帧。

停止、释放确认和预览需要包含本轮交互运行功能的 CLI。没有该能力的 CLI 仍可运行流程；面板在缺少释放凭据时会提示检查设备会话。

## 产物与失败

每次连接和回放分别写入当前项目的 `artifacts/recorder/` 唯一目录。回放目录含 `recorded-flow.yaml`、`cli.log` 和 CLI 生成的报告；面板“打开产物”定位最近一次目录。诊断同时写入 **HarmonyOS Recorder** 输出面板。

使用 v0.1.2 或兼容的适配 CLI 时，可跳到本次运行的 YAML 快照对应行，并打开报告中属于该失败步骤实例的截图或日志。YAML 快照保留执行时的内容，便于对照重试及子 Flow 中的实际步骤。遇到启动失败、证据未生成或产物已清理时，仍可查看回放控制台日志。

录制操作超时会结束桥接进程。若操作结果不确定，请先检查手机，再重新连接。关闭录制面板会关闭录制会话；已开始的 CLI 运行可在重新打开面板后继续查看。关闭编辑器前应先保存录制的 YAML。

当前只支持本机 HDC 设备。VSCode Remote 中需要在运行扩展的主机上配置 Java、HDC 和 CLI；未开展远程主机兼容测试。截图、设备标识和应用内容都在本机处理，分享产物前检查其中的个人信息。

## 开发与验证

扩展开发使用 Node.js 22 或以上版本；同时构建 Maestro CLI 时使用 Node.js 22.12 或以上，以满足其前端资源依赖。本次在 Node.js 24 和 VSCode 1.140 的 Windows 环境验证。

```powershell
npm ci --ignore-scripts
npm test
npm run package
```

单元测试覆盖 JSON 通信、UTF-8 分块、请求串行、错误和超时、截图坐标、过期节点、成功步骤保留，以及回放前释放设备会话。测试使用模拟桥接，不操作手机。

使用本机 VSCode 运行隔离 ExtensionHost 检查：

```powershell
$env:VSCODE_EXECUTABLE_PATH = '你的 Code.exe 完整路径'
npm run test:extension
```

此命令不下载编辑器，测试用户目录和扩展目录放在 `dist/extension-host/`。它检查扩展激活、命令注册、面板创建、YAML 语言和关闭，不代替真机录制回放。实际设备与 Webview 端到端结果记录在仓库 `docs/progress/`。

运行时没有额外 npm 依赖。TypeScript、VSCode 类型、ExtensionHost 测试器和 VSIX 打包器仅作为锁定版本的开发依赖；VSIX 仅包含编译后的运行代码、静态面板文件、片段和许可证。
