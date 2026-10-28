# 课题 11：Maestro 鸿蒙适配技术方案

更新日期：2026-10-28

项目仓库：[HarmonyPandaWorkshop/maestro-harmonyos](https://gitcode.com/HarmonyPandaWorkshop/maestro-harmonyos)

目前已完成建仓和工具检查，并开始 HDC 调用、设备选择与布局转换的主机端开发。JDK 17.0.13、HDC 3.2.0d 可用；已有鸿蒙真机，最近一次设备列表为空。完整驱动、平台接入和 VSCode 扩展尚未完成，实际构建与测试结果见[进展记录](progress/2026-10-28.md)。

## 要完成什么

让标准 Maestro YAML 在鸿蒙设备上执行。继续使用 Maestro 的解析器、Flow 编排、参数、条件和报告，在设备接入层增加鸿蒙支持。

首批实现应用启动、控件查找、点击、文本输入、滑动、返回、断言和截图。随后补齐约定命令、失败处理、视频录屏、批量执行，以及 VSCode 中的编辑和操作录制辅助。

首版先针对一台真机及约定的官方示例完成测试。设备型号、系统版本、示例来源和必需命令需要登记；其他系统版本和应用类型，验证后再加入支持列表。具体场景和 20 轮统计方式见[验收计划](acceptance.md)。

## 实现办法

### 1. 在 Maestro 上增加鸿蒙驱动

电脑端使用 Kotlin/JVM，新增 `HarmonyOSDriver`；通过 HDC 调用设备可用的 UITest 能力。VSCode 扩展使用 TypeScript，调用同一套设备接口。

```text
YAML → Maestro CLI / Orchestra → HarmonyOSDriver → HDC / UITest → 鸿蒙设备
                                      ↑
                              VSCode 操作录制辅助
```

除了驱动类，还要修改平台枚举、设备发现、设备选择及会话创建。当前上游的平台分支只有 Android、iOS 和 Web，需要逐处检查，防止鸿蒙设备进入原有平台路径。

| 部分 | 主要工作 |
| --- | --- |
| 设备接入 | 发现 HDC 设备、选择目标、创建和关闭会话；无设备或多设备未指定时给出明确错误 |
| 应用管理 | 将 YAML 应用标识映射到 bundle 标识，处理入口 Ability；启动、停止和数据重置分别实现 |
| HDC 调用 | 统一进程执行、设备参数、超时、退出码、文件传输和错误输出 |
| 驱动 | 实现约定命令涉及的 Driver 方法，处理布局、手势、输入、截图及录屏 |
| CLI 与报告 | 复用上游批量执行和报告，把鸿蒙错误和测试材料关联到对应步骤 |
| VSCode 扩展 | YAML 高亮、设备截图与节点选择、生成操作、保存和回放 |

同一设备的操作串行执行。Flow 运行期间，VSCode 不能同时控制该设备；取消或退出时清理子进程和录制任务。未实现的方法明确报错，不能返回成功，也不能在能力声明中标为支持。

### 2. 把 ArkUI 布局转换成 Maestro 能识别的节点

将 UITest 输出转换为 Maestro `TreeNode`，处理文本、稳定标识、父子关系、边界和控件状态。上游的文字、标识和边界在属性中匹配，enabled、checked、selected 等状态有独立字段，需要分别映射。设备没有提供的状态保留未知值。

定位优先使用 id 和文字。重复文字按选择器规则处理，不随机选一个节点。滑动、页面跳转、弹窗或输入法变化后重新获取布局，避免使用旧坐标。旋转、屏幕尺寸及窗口偏移也要在真机上核对。

第一批真实布局保存为脱敏样本，用来检查转换、定位和坐标计算。自绘控件或布局中缺失的节点，先记录限制，再评估处理办法。

### 3. 输入、等待和重试

中文输入需要尽早验证，测试内容包括中文、英文、空格、换行和特殊字符。主机进程参数与设备 shell 参数分别处理转义，不能直接拼接输入内容。命令执行成功后还要检查实际输入结果；无法读取文本的场景，用约定的业务结果判断。

等待以节点状态和布局变化为依据，设置超时，不为每个页面堆叠固定长延时。上游未能确认页面稳定时，不能直接视为成功；下一次定位仍需更新布局。

查询失败可以有限重试。点击、提交和输入的结果不明确时，先检查界面，避免重复提交或重复输入。设备断连后保留本次失败；重连后若不能确认页面状态，就结束该轮，不从未知状态继续执行。

### 4. 分别完成视频录屏和操作录制辅助

**视频录屏**用于记录测试过程。M1 就检查真机能否开始、停止录屏并导出可播放文件，M3 再完成驱动集成。需要处理停止失败、视频不完整、文件拉取和异常退出清理。截图不能代替视频录屏。

**操作录制辅助**计划在 VSCode 展示截图和布局节点，用户点选控件、填写动作参数，插件执行动作并生成标准 YAML。生成的 Flow 要能保存和回放，重复文本、转义和断言由工具提示或人工补充。

这里的点选生成不等于捕获手机上的任意手工操作。活动对此的要求需要在 M1 前后明确；如果必须捕获全局操作，要先核查公开接口、权限和实现成本，再调整计划。

### 5. 固定上游版本，保留可复现的改动

上游固定为 `upstream.lock.json` 中的提交：

```text
3fc4ef3fc408bc70ea9baf0bac0ff3e4b565710c
```

上游工作副本放在 `.upstream/maestro`，适配改动以补丁保存在 `patches/maestro/`；VSCode 扩展放在 `packages/vscode/`。目前已提供主机模块补丁、回放脚本和独立测试入口。交付时仍需从干净检出验证完整构建和设备流程。

固定上游使用 JDK 17。CLI 构建还包含 npm 资源构建、模拟器服务资源下载和 iOS 相关模块依赖，所以本机 Java 可用还不足以证明能编译。M1 先检查当前 Windows 主机能否完成构建，必要调整单独保留补丁。

## 主要风险

| 风险 | 什么时候查 | 处理办法 |
| --- | --- | --- |
| 真机 UITest 能力与参考文档不同 | M1 首批检查 | 逐项验证布局、操作和权限。系统能力不足时，再评估公开接口或设备侧测试组件，并记录安装、签名和工期要求 |
| 上游在 Windows 构建受阻 | M1 开始时 | 先跑固定上游，区分依赖下载、资源生成和代码问题；如需更换构建主机，明确新增条件和影响 |
| 布局缺字段、滚动后定位不准 | M1～M2 | 用真实布局样本检查映射，每次界面变化后重新定位；保留失败布局和截图 |
| 中文输入或录屏不可用 | M1 先探测 | 验证输入结果与视频文件，再确定后端；不能留到功能收尾才发现问题 |
| 操作录制和验收范围理解不一致 | M0～M1 | 确认示例、命令、录制方式及通过率口径，保留确认记录 |
| 重试掩盖失败或导致重复操作 | M2 起持续检查 | 限制重试次数，检查动作结果，首次失败和重试后结果分别统计 |

当前 Windows 上的客户端编译和新增测试已通过。真机 UITest、中文输入和录屏仍待验证，这几项会影响后续工作量。详细日期、阶段任务和交付物见[开发里程碑](milestones.md)。

## 怎么验证和交付

主机端重点测试布局转换、坐标、HDC 输出解析、超时和错误处理；集成测试确认命令确实经过 Maestro 的解析和执行层；真机测试验证输入、滑动定位、截图、录屏及 Flow 回放。这几类结果分别记录，模拟数据测试不代替真机测试。

正式稳定性测试前，固定应用、脚本、驱动版本、初始状态和重试策略。按确认范围执行 20 轮，逐轮保留结果、失败原因和材料路径，同时展示首次与重试后的通过率。20 轮通过 19 轮等于 95%；最终采用哪种统计口径，以活动确认内容为准。中途改动实现或脚本后，重新运行，不混合不同版本的数据。

交付内容包括：

- 固定上游、适配补丁、构建入口和依赖说明。
- VSCode 扩展、标准 YAML 用例和命令支持清单。
- 设备环境、测试报告、截图/视频及失败记录。
- 安装使用说明、开发指南、已知限制和问题记录。

AI 辅助用于代码、测试和文档初稿，生成内容仍需核对接口、审查改动并实际运行。依赖来源和使用范围记入 [THIRD_PARTY.md](../THIRD_PARTY.md)。个人工具路径、设备序列号和签名材料保留本地；测试材料使用专门的示例应用和测试数据。

## 参考资料

- [课题 11 交付要求](https://atomgit.com/harmony-connect/topic-details-and-delivery#topic-11)
- [固定版本 Driver 接口](https://github.com/mobile-dev-inc/Maestro/blob/3fc4ef3fc408bc70ea9baf0bac0ff3e4b565710c/maestro-client/src/main/java/maestro/Driver.kt)
- [平台定义](https://github.com/mobile-dev-inc/Maestro/blob/3fc4ef3fc408bc70ea9baf0bac0ff3e4b565710c/maestro-client/src/main/java/maestro/device/Platform.kt)、[设备发现](https://github.com/mobile-dev-inc/Maestro/blob/3fc4ef3fc408bc70ea9baf0bac0ff3e4b565710c/maestro-client/src/main/java/maestro/device/DeviceService.kt)、[CLI 会话管理](https://github.com/mobile-dev-inc/Maestro/blob/3fc4ef3fc408bc70ea9baf0bac0ff3e4b565710c/maestro-cli/src/main/java/maestro/cli/session/MaestroSessionManager.kt)
- [布局节点](https://github.com/mobile-dev-inc/Maestro/blob/3fc4ef3fc408bc70ea9baf0bac0ff3e4b565710c/maestro-client/src/main/java/maestro/TreeNode.kt)、[选择器](https://github.com/mobile-dev-inc/Maestro/blob/3fc4ef3fc408bc70ea9baf0bac0ff3e4b565710c/maestro-client/src/main/java/maestro/Filters.kt)、[CLI 构建配置](https://github.com/mobile-dev-inc/Maestro/blob/3fc4ef3fc408bc70ea9baf0bac0ff3e4b565710c/maestro-cli/build.gradle.kts)
- [OpenHarmony UITest 使用指导](https://github.com/openharmony/docs/blob/master/zh-cn/application-dev/application-test/uitest-guidelines.md)：参考资料，具体能力以目标真机系统版本为准。
