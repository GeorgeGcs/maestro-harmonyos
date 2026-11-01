# 第三方来源与许可证

## 上游与参考

| 来源 | 使用方式 | 当前状态 |
| --- | --- | --- |
| [Maestro](https://github.com/mobile-dev-inc/Maestro) | 固定提交作为适配底座；来源及提交见 `upstream.lock.json` | 已获取上游工作副本，新增代码和测试通过补丁交付；主机测试直接使用上游类型 |
| [OpenHarmony UITest 文档](https://github.com/openharmony/docs/blob/master/zh-cn/application-dev/application-test/uitest-guidelines.md) | 接口和命令行为参考 | 已在一台 API 26 真机核实布局、点击、中文输入、返回和截图 |
| [OpenHarmony UITest 源码](https://github.com/openharmony/testfwk_arkxtest/tree/f59296c77aac5037a9335c317af58de3a0c22ecb) | 核对布局字段、id/key、命令参数及 `uiInput` 的 `No Error` 成功消息；没有复制其 C++ 实现 | 合成样本随补丁提供；真机布局留在本地，未提交个人界面材料 |
| 本机安装的 DevEco Studio 6.1.1 录屏实现 | 核对 Huawei 系统录屏服务与媒体导出命令；没有复制其实现或分发安装文件 | 仅用于可选 `huawei-system` 后端，不视为通用 OpenHarmony 接口 |
| [imageio-ffmpeg](https://github.com/imageio/imageio-ffmpeg) 0.7.0 / [FFmpeg](https://ffmpeg.org/) 7.1 essentials | 本地验证工具，用于完整解码真机视频；不属于运行依赖，不随仓库分发 | Python 包为 BSD-2-Clause；本次工具包内 FFmpeg 构建为 GPLv3+，工具和视频均保留在被忽略的 `artifacts/` |

引用上游代码时保留其 Apache-2.0 许可证、原版权头和适用的 NOTICE。之后新增依赖时补充名称、版本、来源、许可证和使用范围。本文件不表示依赖已经安装或测试。

## VSCode 扩展开发工具

扩展运行时复用 VSCode 和本机 Java CLI，不附带 npm 运行依赖。开发依赖固定在 `packages/vscode/package-lock.json`：

| 工具 | 版本 | 许可证 | 用途 |
| --- | --- | --- | --- |
| [TypeScript](https://github.com/microsoft/TypeScript) | 5.8.3 | Apache-2.0 | 扩展编译 |
| [@types/node](https://github.com/DefinitelyTyped/DefinitelyTyped) | 22.15.3 | MIT | Node.js 类型声明 |
| [@types/vscode](https://github.com/DefinitelyTyped/DefinitelyTyped) | 1.95.0 | MIT | VSCode API 类型声明 |
| [@vscode/test-electron](https://github.com/microsoft/vscode-test) | 2.5.2 | MIT | 隔离 ExtensionHost 测试 |
| [@vscode/vsce](https://github.com/microsoft/vscode-vsce) | 4.1.0 | MIT | VSIX 打包，开发环境需要 Node.js 22 或以上 |

本轮另使用环境已有的 [Playwright](https://github.com/microsoft/playwright) 1.62.1（Apache-2.0）连接隔离 VSCode 的本地调试端口，检查真实 Webview。该工具不随扩展打包，界面截图及设备测试材料留在本地 `artifacts/recorder/`。
