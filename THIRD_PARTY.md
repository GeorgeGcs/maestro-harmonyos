# 第三方来源与 AI 辅助开发

## 上游与参考

| 来源 | 使用方式 | 当前状态 |
| --- | --- | --- |
| [Maestro](https://github.com/mobile-dev-inc/Maestro) | 固定提交作为适配底座；来源及提交见 `upstream.lock.json` | 本仓未复制上游源码；后续通过脚本获取并维护适配补丁 |
| [OpenHarmony UITest 文档](https://github.com/openharmony/docs/blob/master/zh-cn/application-dev/application-test/uitest-guidelines.md) | 接口和命令行为参考 | 尚未在目标真机验证 |
| [活动课题说明](https://atomgit.com/harmony-connect/topic-details-and-delivery#topic-11) | 交付及验收依据 | 场景集合和统计口径待活动组确认 |

引用上游代码时保留其 Apache-2.0 许可证、原版权头和适用的 NOTICE。之后新增依赖时补充名称、版本、来源、许可证和使用范围。本文件不表示依赖已经安装或测试。

## AI 辅助记录

| 日期 | 范围 | 验证情况 |
| --- | --- | --- |
| 2026-10-28 | 使用 AI 辅助起草启动文档、标准流程示例及开发辅助脚本 | 此次仅开展初始化检查；尚未完成 Maestro 构建、鸿蒙驱动实现或真机测试 |
| 2026-10-28 | 完善课题技术方案和里程碑，补充实现步骤、阶段交付及风险处理 | 对照固定上游核查接口与构建依赖，检查文档链接和差异；未执行 Maestro 构建或真机测试 |

后续将 AI 辅助范围、人工审查与实际验证结果随开发进展持续记录。不得把生成的预期结果当作设备测试证据。
