# 重复验证计划

`scripts/test-validation-plan.ps1` 按事先确定的设备、Flow 和轮次运行验证，分别统计首次成功与重试后的最终成功。它复用 `test-device-matrix.ps1`；YAML 仍由 Maestro 执行，工具本身不解释 YAML，也不会失败补跑。

适用环境：Windows PowerShell 5.1 或 PowerShell 7、Node.js 20+，以及已配置并能执行 Flow 的 HarmonyOS CLI。首次使用先按 [环境配置](setup.md) 跑通一个用例。

## 先确定计数单位

| measurementMode | unit.entry | 一轮的含义 |
| --- | --- | --- |
| `per-flow` | 一个 YAML 文件 | 执行一个顶层 Flow，包括它调用的子 Flow |
| `suite` | 一个目录 | Maestro 完成整个目录中声明的顶层 Flow |

每个 unit、每台设备都有独立统计，分母固定为 `repeat`。两个 Flow 各跑三轮，产生两个分母为三的统计；包含两个 Flow 的套件跑三轮，产生一个分母为三的统计。不同设备也不合并平均。

所有槽位在第一次设备操作前写入 `plan.json` 和 `validation-summary.json`。取消、未知、未执行的槽位都保留。工具没有续跑或补跑入口；修复问题后创建新计划，旧结果仍然保留。

这个验证工具目前只接受不含顶层 `config.yaml` / `config.yml` 的 suite。带 workspace 配置的目录会在冻结时被拒绝，以免把配置文件当 Flow，或自行猜测 `flows` 筛选结果。可改用明确列出的 `per-flow` 单元，或专用的无 workspace 配置目录。原 CLI 和 CI 的标准 Maestro 配置能力不受此限制。

## 最小计划

例如在计划文件旁建立 `flows/login.yaml`：

```yaml
appId: ${APP_ID}
---
- launchApp
- assertVisible: 登录
```

以下 `validation.json` 使用两轮开发检查。把设备编号、包名和界面断言换成实际值。

```json
{
  "schemaVersion": 1,
  "planId": "login-development-01",
  "status": "frozen",
  "purpose": "development",
  "measurementMode": "per-flow",
  "repeat": 2,
  "runTimeoutSeconds": 180,
  "thresholdPolicy": { "metric": "firstPass", "minimumRate": "1" },
  "preparationProcedure": "每轮由 Flow 启动应用，使用同一测试账号和固定数据。",
  "retryPolicy": "只允许 YAML 中已写明的 retry，不在计划外补跑。",
  "manualInterventionPolicy": "review-required",
  "evidencePolicy": { "requireVideo": false },
  "profiles": {
    "demo": {
      "bundleId": "com.example.demo",
      "abilityName": "EntryAbility",
      "moduleName": "entry",
      "environmentNames": []
    }
  },
  "devices": [{ "deviceId": "YOUR_DEVICE_ID" }],
  "units": [{
    "unitId": "login",
    "profile": "demo",
    "entry": "flows/login.yaml",
    "sourceRoot": "flows",
    "requiredTopLevelFlows": [{
      "path": "flows/login.yaml",
      "name": "login",
      "requiredSteps": [
        { "path": "flows/login.yaml", "commandIndex": 0, "role": "action" },
        { "path": "flows/login.yaml", "commandIndex": 1, "role": "assertion" }
      ]
    }]
  }],
  "buildFingerprint": { "files": [] },
  "applicationFingerprint": { "files": [] }
}
```

相对文件路径以源计划所在目录为基准。`sourceRoot` 必须覆盖入口及其 YAML/JS 依赖；工具冻结目录内所有 `.yaml`、`.yml`、`.js` 的字节哈希。输出目录必须放在 `sourceRoot` 外。

`requiredSteps` 标明本场景必须真正执行的动作和断言，每个顶层 Flow 至少包含一项 `assertion`。`commandIndex` 取 Maestro 的源码映射，简单 Flow 从零开始；嵌套命令、hooks 和子 Flow 应先用一次开发运行的 `retry-trace.jsonl` / `evidence-index.json` 核对索引。不要用执行顺序号代替源码索引。同一源码步骤重复执行会有不同的 `stepId` 和 `executionSequence`。

必测步骤只有原始 outcome 为 `Completed`，且自身、选择器及祖先流程均非 optional 时，才算覆盖。`Skipped` 和 `Warned` 不算覆盖；不能靠条件分支跳过必测断言来得到有效成功。

套件模式把 `measurementMode` 改为 `suite`，`entry` 改为目录，并在 `requiredTopLevelFlows` 完整列出该目录直属的所有 YAML Flow，各自指定必测步骤。子 Flow 可放在下级目录，不作为顶层成员计数。例如：

```json
{
  "unitId": "account-suite",
  "profile": "demo",
  "entry": "flows/account",
  "sourceRoot": "flows",
  "requiredTopLevelFlows": [
    { "path": "flows/account/login.yaml", "name": "login", "requiredSteps": [
      { "path": "flows/account/login.yaml", "commandIndex": 1, "role": "assertion" }
    ] },
    { "path": "flows/account/logout.yaml", "name": "logout", "requiredSteps": [
      { "path": "flows/account/logout.yaml", "commandIndex": 2, "role": "assertion" }
    ] }
  ]
}
```

## 执行

设备状态目录与 [CI 运行器](ci.md) 共用，必须位于仓库和本次产物目录之外。所有会使用同一设备的任务都应使用同一个状态目录。

```powershell
pwsh -NoProfile -File .\scripts\test-validation-plan.ps1 `
  -PlanPath D:\maestro-plans\validation.json `
  -ArtifactsRoot D:\maestro-results `
  -DeviceStateDirectory D:\maestro-device-state
```

每次命令创建新的 `validation-<id>` 目录。工具先加载本地 `config.local.ps1`，再冻结实际配置。`moduleName` 省略时采用当前 `MAESTRO_HARMONYOS_MODULE`，建议计划中显式填写。`environmentNames` 列出的变量必须已存在，只保存它们的 SHA-256；`APP_ID` 由 profile 的包名注入。原始 agent 输入和执行日志仍可能含测试参数，应按测试数据的保密要求保管产物。

`repeat` 可为 1–1000，整个计划最多 10000 个槽位。`runTimeoutSeconds` 是每次 CLI 调用的预算；`-VerificationTimeoutSeconds` 是每次本地元数据核验的预算，默认 120 秒，可设为 1–600。核验超时不会猜测设备已释放。

每个 unit/device 只调用一次矩阵。CLI 内部的 `retry` 沿用该轮的 `attemptId`，不会额外产生矩阵轮次。原 `matrix.json` v1 和 agent v1/v2 不变，新统计放在独立报告中。

## 看结果

| 字段 | 含义 |
| --- | --- |
| `firstPassCount` | 原执行成功，且完整 trace 中没有实际进入第二次 retry |
| `finalPassCount` | 可信原始终态为 passed，包括 retry 后成功 |
| `thresholdMet` | 选定原始通过率是否达到计划阈值 |
| `unattendedPassCount` | 达到所选成功口径，并完成必测覆盖、证据、清理、视频检查，且人工复核确认无干预 |
| `qualified` | 全部槽位均有确定执行结果及所需证据，且有效无人干预成功数达到阈值 |

分母始终是计划槽位数。`minimumRate` 使用十进制字符串，最小成功次数按向上取整计算。缺 trace、trace 截断、身份或哈希不匹配时，首次成功记 `unknown`，不从最终 passed 推断首次成功。optional retry 只要实际进入第二次，也不算首次成功；可选步骤只出现 Warned 不会单独推翻原始最终结果，但不能充当必测覆盖。

一次正常失败仍占分母，也允许其必测路径未完成。失败轮的证据必须完整；成功轮只有完成自己的必测路径才计入 `unattendedPassCount`。无法确认清理完成、取消或未知结果会停止同设备后续轮次及后续 unit。

数字阈值达到不改写原退出码。当前执行入口要求人工复核；刚跑完时 `manualIntervention=unknown`、`qualified=false`，所以返回 1。复核可以更新资格结论，但不会把之前失败的矩阵或入口退出码改成成功。自动化系统应分别展示原执行退出码和最终审核结论。

## 复核人工干预和录屏

查看 `validation-summary.json` 中每个 `slotId` 和原始证据，再建立审核文件。必须明确列出所有槽位；不要预填“无干预”。有人工解锁、点击、补数据等操作时填 `present`，没有则填 `none`。

```json
{
  "schemaVersion": 1,
  "planId": "login-development-01",
  "planSha256": "复制汇总文件中的 planSha256",
  "observedAt": "审核时的 UTC ISO 时间",
  "slots": [
    { "slotId": "复制实际槽位 ID", "manualIntervention": "none", "notes": "已核对原始证据" }
  ]
}
```

创建一个单独请求文件，如 `review-request.json`：

```json
{
  "operation": "review",
  "summaryPath": "D:\\maestro-results\\validation-实际ID\\validation-summary.json",
  "reviewPath": "D:\\maestro-plans\\review.json"
}
```

```powershell
node .\scripts\validation\main.mjs D:\maestro-plans\review-request.json
```

审核会重新核对原矩阵、控制记录、agent 输入与 manifest、证据及 trace，重算自动统计。手改汇总中的成功布尔值不会被沿用；导入后删改证据也不会继续算合格。审核文件的路径、字节哈希与时间保留在 `reviews` 中。工具不替人证明是否发生过干预。

`finish` 只做执行收尾。重复调用它会清空当前人工审核结论、撤销资格；历史 `reviews` 记录保留，需要重新 `review` 才能取得新的审核结论。

需要录屏时设置 `evidencePolicy.requireVideo=true`。按 [录屏诊断](recording-diagnostics.md) 对原始视频执行完整解码，然后给相应槽位增加：

```json
{
  "videoReports": [{
    "path": "decode-result/verification.json",
    "sha256": "该核验报告的 SHA-256"
  }]
}
```

报告路径相对审核文件。工具检查视频原字节、解码退出码、帧数、完成标记和 stderr。可用 `evidencePolicy.decoderSha256` 固定解码器。每个需要视频的槽位必须存在原视频，且它的全部 video 引用都有合格解码报告；仅文件存在或能打开不算完整验证。

## 正式计划与故障处理

`purpose=formal` 还要求：`confirmation.status=confirmed`，提供已确认范围文件的 `path` / `sha256`；`buildFingerprint.files` 和 `applicationFingerprint.files` 非空，每项包含文件路径和 SHA-256。实际执行的所有实现 JAR 必须被 build 指纹覆盖。设备基线可用 `devices[].matrixInfoSha256` 约束矩阵中 `info` 对象的规范 JSON 哈希；说明性环境信息可放在 `environmentFingerprint`。

正式计划的轮数、阈值、应用版本、准备步骤和场景范围由使用者确定，工具没有内置“正式通过”的默认数值。冻结后更换脚本、实现、应用文件或参数，应另建计划。

应用指纹只核对本机文件，不能证明手机安装的正是这个 HAP。`environmentFingerprint` 是说明记录，不会自动探测或核验；可选的 `matrixInfoSha256` 只约束矩阵实际采集的字段。安装包、系统版本和准备状态仍须按准备步骤与人工复核确认。

进程被强制终止时，设备预约会留在 `running` 或 `needs_inspection`。新任务拒绝覆盖它。按 [CI 文档](ci.md) 完成原会话恢复与 `-ReconcileOnly` 核销；验证工具不自动恢复、不删除门禁、不重放未知动作。恢复结果不会把旧计划的未知或未执行槽位改为成功。

## 本地夹具测试

以下检查使用生成的报告和替身矩阵，不访问设备：

```powershell
node --test .\scripts\tests\test-validation-plan.mjs
pwsh -NoProfile -File .\scripts\tests\test-validation-plan.ps1
powershell -NoProfile -File .\scripts\tests\test-validation-plan.ps1
```
