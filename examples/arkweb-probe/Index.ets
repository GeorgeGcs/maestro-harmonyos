import { webview } from '@kit.ArkWeb';

@Entry
@Component
struct Index {
  private controller: webview.WebviewController = new webview.WebviewController();

  build() {
    Column() {
      Text('ArkUI 对照标题').fontSize(20).padding(12)
      Web({ src: $rawfile('probe.html'), controller: this.controller })
        .layoutWeight(1)
        .width('100%')
        .javaScriptAccess(true)
    }
    .width('100%')
    .height('100%')
  }
}
