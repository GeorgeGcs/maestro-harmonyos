# HMOS代码工坊样例

[HMOS代码工坊](https://gitcode.com/HarmonyOS_Samples/sample_in_harmonyos)是华为开源的 HarmonyOS 示例应用。本目录提供固定版本获取脚本、前台常亮补丁和三条 Maestro YAML 用例，方便在相同页面上验证按钮、输入框与弹窗操作。

官方源码固定到 `7aa95cac4eca15e39fc6638cdf1de7db6fb70ad6`，来源、SDK 配置和补丁校验值记录在 [source.json](source.json)。源码下载到本目录的 `app/`，不随适配层仓库提交。上游代码采用 [Apache-2.0 许可证](LICENSE)，保留华为版权声明；前台常亮补丁是本仓维护的改动。

## 获取工程

需要 Node.js 20 或更高版本和 Git。从本仓根目录执行：

```powershell
node examples/hmos-code-lab/prepare.mjs
```

脚本只获取指定提交，校验版本与许可证，检查签名材料，再应用[前台常亮补丁](patches/foreground-keep-awake.patch)。它不会运行上游构建脚本、下载 SDK、签名或访问设备。首次获取的 Git 数据约 360 MB，展开源码约 420 MB；保留 Git 数据后约占 780 MB，构建缓存和依赖还需额外空间。

如果已经有包含这个提交的本地 Git 仓库，可复用其对象，避免再次下载源码：

```powershell
node examples/hmos-code-lab/prepare.mjs --source "D:\samples\sample_in_harmonyos"
```

此方式读取固定提交，不复制该目录中未提交的修改、IDE 配置或个人签名。准备完成后，`app/.maestro-source.json` 记录上游提交、许可证和补丁 SHA-256。

已有 `app/` 时脚本会拒绝覆盖。核对当前工程可执行：

```powershell
node examples/hmos-code-lab/prepare.mjs --check-only
```

这是纯本地只读检查，核对提交、来源记录、许可证和常亮补丁。它允许你在 DevEco 中补充个人签名，不读取或输出签名内容。若需要重新准备，先保存自己修改的源码和签名配置，再手动将原 `app/` 移到其他目录；下载中断留下的目录也采用这个处理方式。

## 在 DevEco 中运行

1. 打开 `examples/hmos-code-lab/app` **工程根目录**，等待工程同步。
2. 选择 `phone` 运行配置。手机、折叠屏和平板共用这个入口，不要单独打开 `products/phone` 子目录。
3. 在 DevEco 中配置自己的调试签名，选择设备并运行。
4. 完成首次引导，把界面设为简体中文，按[用例说明](flows/README.md)手动进入对应组件详情页，再运行一条 Flow。

固定版本的配置为 `compatibleSdkVersion=6.1.0(23)`、`targetSdkVersion=6.1.1(24)`，运行设备需满足兼容版本要求。已安装目标 HarmonyOS SDK 的环境可以直接同步工程；本地验证使用 DevEco Studio `6.1.1.290` 和 HarmonyOS SDK `6.1.1.125`，没有另行下载 SDK。

这三条用例使用应用内置的组件展示页，**无需执行 `hmosword-build` 的全量 Samples 下载**，也不需要配置多 HAP 部署。应用包名为 `com.huawei.hmos.sample`，模块为 `phone`，Ability 为 `EntryAbility`。

补丁只修改 `products/phone/src/main/ets/entryability/EntryAbility.ets`：应用在前台时请求窗口常亮，进入后台或窗口销毁时释放。运行期间保持应用前台；补丁不修改系统锁屏设置。

## 执行一个 Flow

先按主仓[使用指南](../../docs/user-guide.md)构建带鸿蒙适配的 CLI，并准备 Java 和 HDC。以弹窗为例：在 HMOS 代码工坊内手动进入 **AlertDialog** 详情页，让“点击警告弹窗”可见，且没有已打开的弹窗。在仓库根目录执行：

```powershell
$env:MAESTRO_HARMONYOS_RECORDING = 'off'
./scripts/run-harmonyos.ps1 `
  -FlowPath ./examples/hmos-code-lab/flows/03-alert-dialog.yaml `
  -BundleId com.huawei.hmos.sample -AbilityName EntryAbility -Module phone `
  -DeviceId YOUR_DEVICE_ID -RunTimeoutSeconds 360
```

将 `YOUR_DEVICE_ID` 换成自己的 HDC 设备标识。Flow 会打开弹窗、检查内容、截图并关闭弹窗。三条 Flow 的起始页不同，每次只运行一个文件；切换用例前手动进入对应页面。执行失败时按[用例说明](flows/README.md)恢复页面，再检查截图和日志。

没有设备时，可以先检查 YAML 和调用参数；这条命令不启动设备会话：

```powershell
node examples/agent-client/run.mjs --check-only `
  --app com.huawei.hmos.sample `
  --handoff-flow examples/hmos-code-lab/flows/03-alert-dialog.yaml `
  --artifacts ./artifacts/hmos-check
```

## 验证记录

2026-11-02，固定版本原配置和应用常亮补丁后的配置均已在上述 DevEco / SDK 环境构建出 `phone` 未签名 HAP。使用了本机已安装的工具链和依赖缓存，这不是全新电脑的完整复现。

三条 Flow 已通过 Maestro 原生 YAML 解析和 Agent 的 `--check-only` 检查；**这个样例尚未完成签名安装和真机执行**。现有 ComponentCollection 的设备测试结果不能代替本样例的验证。具体起始页面、选择器来源和运行限制见 [Flow 说明](flows/README.md)。

获取脚本的主机回归测试可单独执行，无需设备：

```powershell
node --test examples/hmos-code-lab/prepare.test.mjs
```
