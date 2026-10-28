# Maestro HarmonyOS Recorder

在 VSCode 中查看鸿蒙手机截图和控件树，选择控件、执行操作，生成标准 Maestro YAML，再保存和回放。

当前记录通过插件发出的操作，不监听手机上的手动触摸，也不启动系统视频录屏。操作仍由已有 HarmonyOSDriver 和 Maestro 执行；本地桥接协议见仓库 `docs/recorder-protocol.md`。

## 安装与配置

需要 VSCode 1.95 或以上版本、JDK 17，以及包含本项目补丁的 Maestro CLI。HDC 应能发现已授权的设备。第一次使用前按仓库 `docs/setup.md` 构建 `:maestro-cli:installDist`。

在 VSCode 扩展视图中执行“从 VSIX 安装”，选择构建出的 `dist/maestro-harmonyos-recorder-0.1.0.vsix`。扩展安装包不包含 Java、HDC 或 Maestro 分发包。

打开本地项目并信任工作区，在设置中配置：

| 设置 | 用途 |
| --- | --- |
| `harmonyosRecorder.cliDirectory` | 含 `bin`、`lib` 的 Maestro 分发目录；留空使用当前项目下 `.upstream/maestro/maestro-cli/build/install/maestro` |
| `harmonyosRecorder.javaPath` | Java 原生可执行文件；留空使用 VSCode 进程的 `JAVA_HOME` 或 PATH |
| `harmonyosRecorder.hdcPath` | HDC 原生可执行文件；留空使用 `MAESTRO_HARMONYOS_HDC` 或 PATH |
| `harmonyosRecorder.appId` | 连接时预填的测试应用 bundle 名称 |
| `harmonyosRecorder.abilityName` | 启动 Ability，默认 `EntryAbility` |
| `harmonyosRecorder.moduleName` | 可选入口 module |

扩展不会执行 `config.local.ps1`。在终端加载的临时环境不会自动传入已经启动的 VSCode；这时直接填写 Java 和 HDC 路径即可。多文件夹工作区首次使用时选择一个项目作为产物目录。

## 录制与回放

1. 从命令面板执行 **HarmonyOS: 打开流程录制**，点击“连接设备”，选择 HDC 设备并填写应用和 Ability。
2. 点击“启动应用”，等待截图和控件树更新。截图是按操作刷新的，不是视频流。
3. 点击截图只会选择控件，不会直接操作手机。确认高亮位置后点击“点击控件”或“断言控件可见”；也可在控件树里选择父节点或其他节点。
4. 输入文字、滑动、返回或保存截图步骤。只有桥接确认执行成功的步骤才追加到 YAML。操作已成功而后续截图刷新失败时，步骤保留；手动刷新即可，不要重复点击。
5. 点击“保存 YAML”生成完整 Flow。也可直接“回放流程”：插件先关闭录制会话并确认设备锁释放，再启动 CLI 回放当前步骤。回放结束后可重新连接继续录制。

控件优先按唯一 ID 或文字定位。无法唯一匹配时可换选控件；确实需要坐标时，明确点击“按所选坐标点击”。坐标受设备尺寸和布局影响，跨设备流程应优先使用控件定位。页面旋转或尺寸改变时请断开并重新连接。

输入通过 UTF-8 JSON 标准输入传给桥接，避免 Windows 命令行编码改变文字。桥接负责生成和执行同一条 YAML；不能安全表示的内容会明确拒绝，不会悄悄改写。可见文字断言可用于检查输入结果。

插件提供 `maestro-flow`、`maestro-tap` 和 `maestro-assert` 三个 YAML 片段，使用 VSCode 的 YAML 高亮。生成的文件可以继续手工编辑，再按仓库 CLI 使用说明运行；插件“回放流程”始终执行当前面板中的步骤。

## 产物与失败

每次连接和回放分别写入当前项目的 `artifacts/recorder/` 唯一目录。回放目录含 `recorded-flow.yaml`、`cli.log` 和 CLI 生成的报告；面板“打开产物”定位最近一次目录。诊断同时写入 **HarmonyOS Recorder** 输出面板。

断连、超时或命令失败不会自动重发点击和输入。超时会结束桥接进程，操作结果可能不确定，请先检查手机再重新连接。关闭面板和“停止任务”会关闭会话；已录制步骤保留在面板会话中，关闭编辑器前应先保存 YAML。回放失败保留非零退出码及运行日志，不自动重连或继续执行。

当前只支持本机 HDC 设备。VSCode Remote 中需要在运行扩展的主机上配置 Java、HDC 和 CLI；未开展远程主机兼容测试。截图、设备标识和应用内容都在本机处理，分享产物前检查其中的个人信息。

## 开发与验证

开发使用 Node.js 22 或以上版本。本次在 Node.js 24 和 VSCode 1.140 的 Windows 环境验证。

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
