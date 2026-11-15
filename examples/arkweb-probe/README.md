# ArkWeb 验证样例

使用 ComponentCollection 的调试副本。把这里的 `Index.ets` 和 `probe.html` 分别放到 `entry/src/main/ets/pages/Index.ets` 与 `entry/src/main/resources/rawfile/probe.html`，签名构建后安装到测试设备。

页面默认关闭 ArkWeb 调试。打开应用，点击「开启 ArkWeb 调试」，按华为文档为这个应用的 PID 建立 HDC 转发。把实际主机端口填入 `MAESTRO_HARMONYOS_ARKWEB_PORT`，将 `MAESTRO_HARMONYOS_ARKWEB_BUNDLE` 设为 `ohos.samples.componentcollection`，再用包含 DOM 适配的 CLI 执行 `dom.yaml`。[华为 ArkWeb 调试文档](https://developer.huawei.com/consumer/cn/doc/HarmonyOS-Guides/web-debugging-with-devtools/)

DOM 用例直接按 HTML ID 操作输入框和按钮。CLI 会检查绑定是否指向当前设备和应用进程，再接入唯一网页。在没有有效调试连接的情况下，沿用 UITest 控件树。重启应用后保持调试关闭，执行 `foreground.yaml` 即可验证原生路径。

从页面顶部运行 `dom-scroll.yaml` 可验证网页内滚动。它先确认底部标记不在屏幕上，再滚动查找目标，最后用同一元素的 HTML ID 和文本断言并截图。每次运行前重新进入页面，避免继承上一次的滚动位置。

HDC 转发由调用方建立和移除。运行后核对对应规则与监听端口，避免影响同一主机上其他应用的转发。

执行期间可在五秒内复用已经验证的页面连接。每次查询仍读取新的 DOM。应用启停、窗口切换、连接关闭或查询失败会断开连接。再次连接前会重新核对目标设备、应用进程及转发。

2026 年 11 月 15 日，Windows 上的 HarmonyOS API 22 模拟器通过两条用例。开启调试时，按 HTML ID 完成输入、提交和断言，约 46 秒。重启应用后保持调试关闭，按 UITest 文本选择器通过同一交互，约 45 秒。两条用例各保存一张截图。测试结束后移除了本次转发并恢复原样例 HAP。

同日，Mate 60 Pro（HarmonyOS 7.0.0.111 / API 26）通过 DOM 输入提交和网页滚动两项验证。滚动首次使用 25 秒等待预算时超时；改为 65 秒后通过，JUnit 记录约 70.6 秒，保存了目标元素的截图。结束后确认本次转发已移除、原样例 HAP 已恢复。
