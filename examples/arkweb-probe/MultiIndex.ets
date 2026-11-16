import { webview } from '@kit.ArkWeb';

@Entry
@Component
struct Index {
  private primary: webview.WebviewController = new webview.WebviewController();
  private secondary: webview.WebviewController = new webview.WebviewController();
  @State private debugEnabled: boolean = false;

  build() {
    Column() {
      Text('ArkWeb 双页面').fontSize(20).padding(12)
      Button(this.debugEnabled ? '关闭 ArkWeb 调试' : '开启 ArkWeb 调试')
        .onClick(() => {
          const enabled = !this.debugEnabled;
          webview.WebviewController.setWebDebuggingAccess(enabled);
          this.debugEnabled = enabled;
        })
      Web({ src: $rawfile('probe.html'), controller: this.primary })
        .id('probe-primary')
        .layoutWeight(1)
        .width('100%')
        .javaScriptAccess(true)
      Web({ src: $rawfile('probe-secondary.html'), controller: this.secondary })
        .id('probe-secondary')
        .layoutWeight(1)
        .width('100%')
        .javaScriptAccess(true)
    }
    .width('100%')
    .height('100%')
  }
}
