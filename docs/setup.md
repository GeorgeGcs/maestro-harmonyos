# 开发环境与上游接入

当前只提供启动资料和辅助脚本，尚无可运行的鸿蒙适配版本。

## 环境

- Git 与 PowerShell（脚本可在 Windows PowerShell 5.1 或较新 PowerShell 中运行）。
- JDK 17 或以上；真正构建时以固定上游的构建配置为准。
- DevEco SDK 中与目标设备匹配的 HDC。可加入 PATH，也可为环境检查显式传入 `-HdcPath`。
- Node.js 用于后续 VSCode 扩展开发；版本在扩展实现时固定。
- 可授权 USB 调试的鸿蒙真机。具体系统和 API 版本由实际设备记录决定。

```powershell
./scripts/check-environment.ps1
# HDC 尚未加入 PATH 时：
./scripts/check-environment.ps1 -HdcPath 'D:\path\to\hdc.exe'
```

环境检查只定位工具并读取 Java/Node 版本，不修改环境变量、不安装依赖、不启动或操作设备。缺少工具时返回非零退出码。

## 固定上游

```powershell
./scripts/prepare-upstream.ps1
```

脚本从 `upstream.lock.json` 的公开地址获取指定提交，检出到 `.upstream/maestro`。该目录不会被提交到本仓。脚本不执行构建、不安装依赖、不修改系统配置；已存在且有改动的上游目录会被保留并报错。

当前只有基线锁定信息，**尚无适配补丁**。后续在上游工作副本实现 HarmonyOSDriver、设备枚举和 CLI 会话接入，将改动导出至 `patches/maestro` 并补充回放说明与构建步骤。

原始上游中的 AGENTS.md 和构建说明应在开始改动该目录前阅读。不得用预期输出代替编译结果。

## 最小设备验证

驱动接入后，使用约定的官方示例应用验证：启动 → 获取布局树 → 文本/ID 定位 → 点击 → 中文输入 → 滑动后重新定位 → 断言 → 截图 → 退出与清理。

先记录单轮执行结果，再按 [验收清单](acceptance.md) 重复执行。视频录屏与操作生成 YAML 分别验证。当前 `examples/flows/smoke.yaml` 是参数化设计示例，尚不能证明设备能力可用。

## 资料

- [Maestro 安装文档](https://docs.maestro.dev/maestro-cli/how-to-install-maestro-cli)
- [Maestro 上游](https://github.com/mobile-dev-inc/Maestro)
- [UITest 使用指导](https://github.com/openharmony/docs/blob/master/zh-cn/application-dev/application-test/uitest-guidelines.md)
