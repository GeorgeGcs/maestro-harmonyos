import { webview } from '@kit.ArkWeb';

@Entry
@Component
struct Index {
  private controller: webview.WebviewController = new webview.WebviewController();
  @State private debugEnabled: boolean = false;

  build() {
    Column() {
      Text('ArkUI 对照标题').fontSize(20).padding(12)
      Button(this.debugEnabled ? '关闭 ArkWeb 调试' : '开启 ArkWeb 调试')
        .onClick(() => {
          const enabled = !this.debugEnabled;
          webview.WebviewController.setWebDebuggingAccess(enabled);
          this.debugEnabled = enabled;
        })
      Web({ src: $rawfile('probe.html'), controller: this.controller })
        .layoutWeight(1)
        .width('100%')
        .javaScriptAccess(true)
    }
    .width('100%')
    .height('100%')
  }
}
