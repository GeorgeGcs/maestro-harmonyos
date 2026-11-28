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

在目标 WebView 的顶层网页中，`tapOn: { css: ... }` 会在每次发出触摸前，检查该屏幕点实际落在哪个 DOM 元素上。点中按钮内部的文字或图标也算命中。浮层拦住点击时，驱动会在约三秒的观察窗口内复查；浮层消失后，重新读取 WebView 的位置并核对点击点。持续遮挡时，步骤失败，错误信息中的 `blocked by` 指出拦截点击的元素。这条检查也适用于 CSS 目标的相对坐标和重试。检查与设备输入之间仍有时间差，业务 Flow 可以用点击后的状态断言确认操作结果。

在 API 26 手机上，用两个 WebView 中第二页的同一个计数按钮核对了四种情况。下表按每条 Flow 单独统计，设备日志给出实际派发次数，页面事件计数给出接收次数。四次会话都已释放。

| 点击点所在位置 | HDC 派发 | 按钮收到 | 浮层收到 | Flow 结果 |
| --- | ---: | ---: | ---: | --- |
| 持续拦截触摸的透明浮层 | 0 | 0 | 0 | 按预期失败，报告 `blocked by div#maestro-test-overlay` |
| 首次检查时被浮层挡住，随后浮层消失 | 1 | 1 | 0 | 通过 |
| 无遮挡的按钮 | 1 | 1 | 0 | 通过 |
| 按钮内的 `span` | 1 | 1 | 0 | 通过，页面记录的事件目标为该 `span` |

使用下文的优化版再次运行四项用例时，持续遮挡一项连续查到 19 次拦截，最终报出浮层的 ID；短暂遮挡一项两次查到拦截，随后只点击了一次。检查确认专用转发已移除，原样例已装回。

### CSS 点击如何核验转发

一条页面连接最多使用五秒。显式绑定 WebView 后，两秒内紧接的一次读取可以沿用上次进程与转发的核验结果。

显式绑定 WebView 时，一条 CSS `tapOn` 会多次读取页面，用来查找按钮、等待布局稳定、确认点击位置和观察点击后的变化。同一连接、同一文档的读取可以共用最近两秒内的核验结果。每次仍读取新的 DOM，检查页面 URL 和 WebView 标记。发出触摸前，驱动再次确认应用进程、HDC 转发以及触点下的元素。

如果派发前连接的剩余寿命不足两秒，驱动会同时重新查找调试页面。新连接必须指向原页面，网页也必须保留本步骤的文档标记，才能继续点击。另一条点击命令会重新核验。应用切换窗口、进程变更或连接失效时，驱动会丢弃旧连接。

观察 `maestro.log` 时，`device-forward` 表示实际核验，`device-forward-reused` 表示复用。`page-discovery` 记录查找调试页面的时间，`dom` 记录查询网页的时间。

### API 26 手机点击计时

对照用例在第二个 WebView 查找 `button#secondary-counter`，点击一次，再查找按钮并截图。用例关闭 `retryTapIfNoChange`，要求 RPC 取原生布局。每轮运行前后独立读取网页计数器，同时从设备日志核对实际派发次数。下文的点击耗时从 `tapOn` 开始定位算到点击后等待结束；前后的断言、截图、安装和设备清理单独计时。

2026 年 11 月 28 日，以适配仓 `6d15902` 对应的驱动作为基线，在同一台手机上交替运行。两份 CLI 逐文件核对了 200 个文件，只有包含这次修改的 `maestro-client.jar` 和 `maestro-orchestra.jar` 不同。以下四组计时均在主机构建结束后开始。

| 组次及运行顺序 | 基线点击（ms） | 优化版点击（ms） | 节省（ms） |
| --- | ---: | ---: | ---: |
| 1 · 基线先跑 | 5,566 | 3,691 | 1,875 |
| 2 · 优化版先跑 | 4,770 | 3,824 | 946 |
| 3 · 基线先跑 | 5,369 | 3,378 | 1,991 |
| 4 · 优化版先跑 | 6,015 | 3,436 | 2,579 |

按两份构建各自的四次结果取中位数，点击耗时从 5,467.5 ms 降至 3,563.5 ms。一次点击内实际核验转发的次数从 4 次降至 2 次，累计核验耗时从 2,310.5 ms 降至 1,169 ms。HDC 派发输入本身的耗时从 782 ms 变为 766 ms，节省的时间主要来自点击前后的查询与等待。八次执行各派发一次触摸、保存一张截图，计数器依次从 0 增至 8。用例结束后确认会话释放、测试转发移除并恢复原 HAP。

### 早期设备验证

2026 年 11 月 15 日，Windows 上的 HarmonyOS API 22 模拟器通过两条用例。开启调试时，按 HTML ID 完成输入、提交和断言，约 46 秒。重启应用后保持调试关闭，按 UITest 文本选择器通过同一交互，约 45 秒。两条用例各保存一张截图。测试结束后移除了本次转发并恢复原样例 HAP。

同日，Mate 60 Pro（HarmonyOS 7.0.0.111 / API 26）通过 DOM 输入提交和网页滚动两项验证。滚动首次使用 25 秒等待预算时超时；改为 65 秒后通过，JUnit 记录约 70.6 秒，保存了目标元素的截图。结束后确认本次转发已移除、原样例 HAP 已恢复。
