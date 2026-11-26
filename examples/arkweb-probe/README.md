# ArkWeb 验证样例

使用 ComponentCollection 的调试副本。把这里的 `Index.ets` 和 `probe.html` 分别放到 `entry/src/main/ets/pages/Index.ets` 与 `entry/src/main/resources/rawfile/probe.html`，签名构建后安装到测试设备。

页面默认关闭 ArkWeb 调试。打开应用，点击「开启 ArkWeb 调试」，按华为文档为这个应用的 PID 建立 HDC 转发。把实际主机端口填入 `MAESTRO_HARMONYOS_ARKWEB_PORT`，将 `MAESTRO_HARMONYOS_ARKWEB_BUNDLE` 设为 `ohos.samples.componentcollection`，再用包含 DOM 适配的 CLI 执行 `dom.yaml`。[华为 ArkWeb 调试文档](https://developer.huawei.com/consumer/cn/doc/HarmonyOS-Guides/web-debugging-with-devtools/)

DOM 用例直接按 HTML ID 操作输入框和按钮。CLI 会检查绑定是否指向当前设备和应用进程，再接入唯一网页。在没有有效调试连接的情况下，沿用 UITest 控件树。重启应用后保持调试关闭，执行 `foreground.yaml` 即可验证原生路径。

从页面顶部运行 `dom-scroll.yaml` 可验证网页内滚动。它先确认底部标记不在屏幕上，再滚动查找目标，最后用同一元素的 HTML ID 和文本断言并截图。每次运行前重新进入页面，避免继承上一次的滚动位置。

HDC 转发由调用方建立和移除。运行后核对对应规则与监听端口，避免影响同一主机上其他应用的转发。

## 两个 WebView

用 `MultiIndex.ets` 替换调试副本的 `Index.ets`，同时复制两个 HTML 资源。两个 WebView 分别设置 `.id('probe-primary')` 和 `.id('probe-secondary')`，各自的 HTML 用 `<meta name="maestro-webview-id">` 声明对应的 ID。

应用开启调试后，从 `http://127.0.0.1:<端口>/json/list` 读取目标页面的完整 `url`。将 `MAESTRO_HARMONYOS_ARKWEB_WEBVIEW_ID` 设为 `probe-secondary`，将 `MAESTRO_HARMONYOS_ARKWEB_PAGE_URL` 设为 `probe-secondary.html` 对应的完整 URL，再运行 `dom-secondary.yaml`。CLI 按应用、原生节点 ID 和页面 URL 定位，并核对页面对自身 WebView ID 的声明。页面可以通过这些显式配置切换。

查不到唯一节点或页面、页面标记不匹配、设备转发失效时，CLI 使用 UITest 树。省略两个选择字段时仍可用单 WebView 自动选择。关闭应用的 ArkWeb 调试或省略 ArkWeb 转发配置即可使用原生路径。

使用包含 CSS 查询的源码构建，可用同样的第二页绑定配置运行 `dom-css-secondary.yaml`。重新打开应用使计数归零并打开调试后，Flow 按 CSS 定位计数按钮，检查主页面的输入框未匹配，再点击并确认计数变化。CSS 查询适用于当前可读的目标页面。2026 年 11 月 26 日，API 22 模拟器的该用例 **1/1 通过，约 23.4 秒**。错配 WebView ID 和 URL 时，负向断言按预期失败。两次执行均正常释放会话。

CSS 定位会复用同一次查询刚读取的原生布局。页面 URL 和 WebView 标记仍随每次 DOM 查询核对。日志中的 `HarmonyOS ArkWeb CSS native layout=reused` 可确认命中。真机跑性能对照时，可用 [RPC 准备入口](../../docs/setup.md#检查和准备-rpc) 加 `--require-layout-rpc` 执行该 Flow，确保成绩基于 RPC 取树。

执行期间可在五秒内复用已经验证的页面连接。显式 WebView 目标在同一连接内，可让两秒内紧接的一次读取复用进程及转发核验。再下一次或超过两秒时重新核验。每次仍读取新的 DOM 并检查页面 URL 和 WebView 标记。应用启停、窗口切换、连接关闭或查询失败会断开连接。运行日志分别记录 `device-forward`、`page-discovery` 和 `dom` 的耗时，复用时记为 `device-forward-reused`。

2026 年 11 月 15 日，Windows 上的 HarmonyOS API 22 模拟器通过两条用例。开启调试时，按 HTML ID 完成输入、提交和断言，约 46 秒。重启应用后保持调试关闭，按 UITest 文本选择器通过同一交互，约 45 秒。两条用例各保存一张截图。测试结束后移除了本次转发并恢复原样例 HAP。

同日，Mate 60 Pro（HarmonyOS 7.0.0.111 / API 26）通过 DOM 输入提交和网页滚动两项验证。滚动首次使用 25 秒等待预算时超时；改为 65 秒后通过，JUnit 记录约 70.6 秒，保存了目标元素的截图。结束后确认本次转发已移除、原样例 HAP 已恢复。
