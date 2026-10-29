# 操作录制本地协议

版本：1。用于 VSCode 扩展与本机 Maestro 子进程通信，不监听网络端口。此文档随实现更新。

本文描述原有五个方法，供现有 VSCode 插件使用。智能体接口采用独立的 `agent.*` 方法名，见[智能体调用协议 v1](agent-protocol.md)。两套入口共用设备锁；不要向本页请求添加新协议的追踪字段，也不要在同一设备会话内混用两套动作入口。

启动已构建 CLI 的 `--platform harmonyos harmonyos-bridge` 子命令。标准输入、输出使用 UTF-8 JSON Lines，每行一个请求或响应；诊断写入标准错误。请求串行处理，扩展一次只发送一个设备操作。正常 `disconnect`、输入 EOF 和进程退出时释放会话与已有设备文件锁。

请求：`{"id":1,"method":"devices","params":{}}`。

成功：`{"id":1,"result":{...}}`。

失败：`{"id":1,"error":{"code":"STALE_SNAPSHOT","message":"..."}}`。

`id` 为正整数，响应原样返回。单个请求最多 64 KiB；响应上限 32 MiB。参数错误不得操作设备。失败不自动重发点击、输入等动作。连接与动作发生错误时，原始诊断保留在本地日志。

| 方法 | 参数 | 结果 |
| --- | --- | --- |
| `devices` | `{}` | `{devices:[{id:string}]}`，未连接时也可查询 |
| `connect` | `{deviceId,appId,abilityName,moduleName?,artifactsDir}` | `{deviceId,appId}`；显式目标，已有会话须先断开；产物目录须为绝对路径 |
| `snapshot` | `{}` | 下述截图和节点结构 |
| `action` | 下述动作参数 | `{yaml:string,artifactsDir:string}`；只有执行成功才返回可追加的 YAML 步骤 |
| `disconnect` | `{}` | `{disconnected:true}`；重复调用无副作用 |

快照结构：

```json
{
  "snapshotId": "opaque-id",
  "width": 1260,
  "height": 2720,
  "screenshot": { "mimeType": "image/png", "base64": "..." },
  "nodes": [{
    "nodeId": "0.0",
    "parentId": "0",
    "text": "示例",
    "hintText": "",
    "resourceId": "example-title",
    "className": "Text",
    "bounds": { "left": 0, "top": 0, "right": 100, "bottom": 50 },
    "enabled": true,
    "clickable": false
  }]
}
```

根节点的 `parentId` 为 `null`，缺失的文字字段为空字符串，未知的布尔字段为 `null`。坐标采用包含系统栏的设备物理像素。截图和布局不是原子快照：读取前等待页面稳定；后续节点操作重新检查布局，不能把旧截图坐标直接用于已变化页面。

快照采用最多 20 秒的只读采样预算，间隔 100 毫秒；连续布局一致后取图，并再次比较布局。已确认属于 `com.ohos.sceneboard`、含 `StatusBarBox`、且与目标应用窗口完全不重叠的状态栏，其子节点动态内容不参与稳定性比较，也不进入可选控件列表。状态栏窗口自身的几何、属性和出现/消失仍参与检查；键盘、重叠窗口和弹窗不排除。坐标点击不能落入被排除的区域，选择器唯一性仍检查完整布局。

截图尺寸与会话初始尺寸不一致时返回 `ORIENTATION_CHANGED`，需断开重连。真正的页面变化返回 `UNSTABLE_PAGE` 或 `STALE_SNAPSHOT`，由用户刷新后重新选取，不自动重发设备动作。

动作参数：

| `type` | 附加参数 | 说明 |
| --- | --- | --- |
| `launchApp` | 无 | 使用连接时指定的应用 |
| `tapOn` | `snapshotId,nodeId` 或 `snapshotId,point:{x,y}` | 唯一 ID 或文字优先；坐标模式需用户明确选择 |
| `inputText` | `text` | UTF-8 文本，通过标准输入传递 |
| `swipe` | `direction:UP/DOWN/LEFT/RIGHT,duration:600` | 时长为毫秒 |
| `back` | 无 | 返回键 |
| `assertVisible` | `snapshotId,nodeId` 或 `text` | 生成并执行同一条可见断言 |
| `takeScreenshot` | `name` | 1～80 个英文字母、数字、下划线或连字符，首字符为字母或数字；文件归入本次产物目录 |

节点操作只接受最近一次快照的标识。唯一选择器找不到时返回 `AMBIGUOUS_SELECTOR`；扩展可提示用户换选控件，或明确选择坐标点击。每个动作完成后旧快照失效，扩展先追加成功返回的 YAML，再单独刷新快照；刷新失败不能把已成功动作显示为未执行。

生成的 YAML 交由同一份 Maestro 解析和执行层处理。用户文字必须以字面值保存，中文、引号、换行、反斜杠和 `${...}` 等内容不得改变脚本含义。保存完整 Flow 时增加应用配置头。回放前先 `disconnect` 并收到确认，再启动 CLI，避免录制与回放争抢设备。

单层 `${...}` 会按固定上游的字面转义规则处理。嵌套或未闭合的表达式若不能无损保存，返回 `INVALID_PARAMS`，不执行动作；不尝试执行用户输入中的 JavaScript 来获取文字。

第一版不接收任意 shell 命令、不监听设备上手动触摸事件、不通过此协议开启系统视频录屏。
