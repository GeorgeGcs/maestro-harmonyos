# 技术方案

状态：启动设计。尚未实现 HarmonyOS 驱动，尚未完成真机验证；本文描述计划和验证顺序。

## 目标与集成方式

为真实 Maestro 增加 HarmonyOS 设备支持，使标准 YAML Flow 能在鸿蒙设备上执行。本仓作为独立集成仓，维护适配代码、必要的上游补丁、构建入口和验证材料，不以另写 YAML 解释器替代框架接入。

- `upstream.lock.json` 固定上游仓库 `https://github.com/mobile-dev-inc/Maestro.git` 的提交 `3fc4ef3fc408bc70ea9baf0bac0ff3e4b565710c`。
- `scripts/prepare-upstream.ps1` 将固定源码获取到被忽略的 `.upstream/maestro`。后续驱动接入修改以 `patches/maestro/` 补丁维护，回放到真实上游源码后构建和验证。
- VSCode 扩展放在 `packages/vscode/`。本轮只初始化文档、目录和环境工具；驱动实现与补丁回放验证属于后续开发。

执行路径：

```text
标准 Maestro YAML
  → 上游解析器与 Orchestra 执行层
  → Maestro / HarmonyOSDriver
  → HDC 与 UITest 能力
  → 鸿蒙设备
```

| 层次 | 计划工作 | 复用或新增 |
| --- | --- | --- |
| YAML 与执行层 | Flow 复用、参数、条件、JavaScript、断言和执行结果 | 复用上游，补充必要的平台识别 |
| CLI 与设备管理 | 鸿蒙平台枚举、HDC 设备发现、设备选择、会话创建和关闭 | 修改上游接入点 |
| HarmonyOSDriver | 应用生命周期、布局树、手势、输入、截图、录屏及状态等待 | 新增驱动实现 |
| HDC 访问层 | 参数化启动进程、超时、退出码、输出解析、文件拉取、设备选择 | 新增可独立测试的适配层 |
| VSCode 辅助插件 | YAML 编辑辅助、设备截图与节点点选、执行并插入操作 | 新增插件，调用同一驱动能力 |

## 首个真机闭环

1. 固定上游基线并构建 CLI，确认新平台能创建 `HarmonyOSDriver`，而非走 Android/iOS 分支。
2. 发现并选择一台设备，记录系统版本、HDC 版本及可用 UITest 能力；校验应用标识与入口 Ability 的配置。
3. 在约定的官方示例上执行启动、布局获取、按 id/文字点击、输入、滑动、断言和截图。
4. 补上 Flow 复用、参数与条件执行，确认实际经过上游解析和执行层。
5. 根据失败记录完善等待和恢复，再扩展录屏、VSCode 辅助及完整验收场景。

## 驱动与布局映射

- 将 UITest 布局树转换为 Maestro `TreeNode`，统一文本、标识、边界以及 enabled、checked、selected 等可获取状态。`resource-id` 是 Maestro 的内部匹配字段，不假定鸿蒙原始字段同名。
- 对缺失属性保留未知状态；统一坐标单位、屏幕尺寸、旋转及窗口偏移，避免把坐标转换错误当作控件缺失。
- 优先使用稳定标识和文本选择器；滚动或页面变化后重新读取布局并定位，不沿用过期坐标。
- 首轮覆盖 `launchApp`、`tapOn`、`inputText`、`swipe`、`back`、`assertVisible` 等核心场景。支持范围逐项记录；未实现能力明确报错，不能以空操作返回成功。

## 稳定性与异常处理

- 同一设备会话内串行执行会改变界面的操作，防止截图、布局查询和手势争用造成步骤错序。
- 用布局变化、目标节点状态及有界轮询判断页面是否就绪；所有等待设截止时间，失败保留最后布局、截图及错误信息。
- 只对可安全重复的查询或已确认未生效的操作进行有界重试。点击、输入等操作在结果不明时先检查界面，避免重复提交或重复输入。
- HDC 超时、断连或命令失败时终止当前操作并清理子进程。恢复连接后重新检查应用与页面状态；不能证明状态一致时结束本轮并记录失败。
- 记录实际等待、重试、恢复和耗时；原始失败与重试后结果分别保留。

## 两类录制分别交付

**视频录屏**：实现驱动的录屏开始/停止，保存可播放视频，处理超时、停止失败、文件拉取和会话退出清理。录屏后端及真机可用性必须单独验证。

**操作录制辅助**：VSCode 展示设备截图和布局节点，用户点选控件、输入操作参数后执行并插入标准 YAML，支持保存和回放。该方案属于交互式辅助生成，是否还要求捕获设备上任意手工操作，需与活动组确认；不能用一段视频替代操作录制辅助。

## 实施与验证边界

先证明设备驱动闭环，再扩展功能清单。官方样例、系统/SDK 版本、完整命令边界、录制辅助形式和统计口径见 [验收计划](acceptance.md)。源码、测试、设计与使用说明随实现同步维护；披露第三方依赖及 AI 生成内容，并人工审查和验证。向上游贡献补丁可另行推进，不作为本仓交付或活动验收的前置条件。

## 依据

- [Maestro Driver 接口](https://github.com/mobile-dev-inc/Maestro/blob/main/maestro-client/src/main/java/maestro/Driver.kt)
- [CLI 会话与驱动创建](https://github.com/mobile-dev-inc/Maestro/blob/main/maestro-cli/src/main/java/maestro/cli/session/MaestroSessionManager.kt)
- [设备发现](https://github.com/mobile-dev-inc/Maestro/blob/main/maestro-client/src/main/java/maestro/device/DeviceService.kt)
- [Orchestra 执行层](https://github.com/mobile-dev-inc/Maestro/blob/main/maestro-orchestra/src/main/java/maestro/orchestra/Orchestra.kt)
- [选择器字段与匹配](https://github.com/mobile-dev-inc/Maestro/blob/main/maestro-client/src/main/java/maestro/Filters.kt)
- [官方 Studio 的交互式命令生成](https://docs.maestro.dev/maestro-studio/run-tests-with-maestro-studio)

以上源码链接用于说明设计依据，链接中的 `main` 可能变化；实施与复现使用本仓记录的固定上游提交。
