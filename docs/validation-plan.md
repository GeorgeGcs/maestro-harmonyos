# 重复验证计划

`scripts/test-validation-plan.ps1` 按事先确定的设备、Flow 和轮次运行验证，分别统计首次成功与重试后的最终成功。它复用 `test-device-matrix.ps1`；冻结时使用安装的 Maestro YAML reader 做静态检查，运行时仍由 Maestro 执行，也不会失败补跑。

输入、冻结计划、汇总和人工审核的字段及 Schema 见[协议说明](protocol/retry-and-validation.md)。结构检查之后，工具仍会核对原文件哈希、实际步骤和设备交接状态。

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
  "schemaVersion": 2,
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

新冻结的 `plan.json` 和 `validation-summary.json` 使用 v3，输入格式仍为 development v1/v2、formal v2。冻结时，真实 Maestro YAML reader 使用 `FileAccessScope.under(sourceRoot)` 解析每个 unit，核对静态依赖、Flow 名称和原生顶层 Flow 集合，并保存解析器及结果指纹。入口、子 Flow、hooks 或 `runScript` 静态引用越界、缺失、包含 `${...}` 动态路径或未命中冻结哈希时，都会在设备派发前失败。把依赖移入 `sourceRoot` 或明确扩大该目录后，重新冻结计划。

静态检查不执行 JavaScript，记录为 `scriptsExecuted=false`；它不限制脚本内部的动态文件访问或网络请求，不是 JavaScript 运行时沙箱。也不能用它替代 Flow 的实际执行、必测步骤覆盖或设备证据核验。

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
| `qualified` | 全部槽位均有确定执行结果及所需证据，且有效无人干预成功数达到阈值；v3 还要求静态检查完整 |
| `runtimeComplete` | 每轮控制记录的 Java、完整 JAR 集合、PowerShell 和本地配置均匹配冻结值 |
| `preparationComplete` | 每轮人工复核均绑定冻结的安装准备记录，并确认安装和准备状态未变 |
| `staticInspectionComplete` | v3 每组及汇总中的静态解析证据已实际复核，不能靠填写 true 取得 |
| `staticInspectionError` | v3 汇总中的静态证据复核失败原因；无失败记录时为 null |
| `formalEligible` | 正式计划具备范围确认，运行环境与准备证据完整；v3 还要求静态检查完整 |
| `formalQualified` | 在 `formalEligible` 的基础上，`qualified` 也成立 |

分母始终是计划槽位数。`minimumRate` 使用十进制字符串，最小成功次数按向上取整计算。缺 trace、trace 截断、身份或哈希不匹配时，首次成功记 `unknown`，不从最终 passed 推断首次成功。optional retry 只要实际进入第二次，也不算首次成功；可选步骤只出现 Warned 不会单独推翻原始最终结果，但不能充当必测覆盖。

必测步骤还要匹配具体源码文件，不能仅凭相同内容和命令索引认定覆盖。当前 retry trace v2 保存输入登记中的原始文件身份，因此同内容的 A.yaml、B.yaml 可分别核对。旧 v1 只有在本次登记来源唯一时才能计入覆盖；同内容的多个来源无法区分时，保留未完成。格式与兼容规则见[Retry 协议](protocol/retry-and-validation.md)。

一次正常失败仍占分母，也允许其必测路径未完成。失败轮的证据必须完整；成功轮只有完成自己的必测路径才计入 `unattendedPassCount`。无法确认清理完成、取消或未知结果会停止同设备后续轮次及后续 unit。

数字阈值达到不改写原退出码。当前执行入口要求人工复核；刚跑完时 `manualIntervention=unknown`、`qualified=false`，所以返回 1。复核可以更新资格结论，但不会把之前失败的矩阵或入口退出码改成成功。自动化系统应分别展示原执行退出码和最终审核结论。

v3 的每组 `complete/qualified` 和顶层 `qualified` 均要求 `staticInspectionComplete=true`；静态证据缺失或被改动时，即使原始通过率达标，也不能认定验证完整或合格。旧 v1/v2 历史复核仍使用原统计规则。开发计划即使 `qualified=true`，也始终 `formalQualified=false`；准备证据缺失或实际运行环境不匹配，同样不能形成正式合格。原始首次/最终通过数和设备释放结论分别保留。

冻结时自动记录实际 Node、PowerShell、Java 可执行文件的路径与 SHA-256、`config.local.ps1` 的存在性和字节，以及安装目录 `lib` 中全部 JAR 的成员列表与哈希。CLI 使用仓库内 `.upstream/maestro/maestro-cli/build/install/maestro`，与现有运行器一致。Java 先采用绝对路径 `JAVA_HOME`，否则由同一 PowerShell 的 `Get-Command java` 选择；相对路径配置需先改为绝对路径。

每个批次派发前检查这些文件是否变化。每轮启动 Java 前，运行器保存本轮所选文件指纹，导入时与冻结值比较。历史复核使用保留下来的控制记录，不用今天安装的工具替代过去的身份。这是本机文件观察记录，并非 JVM 已加载类的内存证明；执行期间应保持安装目录不变。

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

`purpose=formal` 使用输入 v2，还要求：`confirmation.status=confirmed`，提供已确认范围文件的 `path` / `sha256`；`buildFingerprint.files` 和 `applicationFingerprint.files` 非空，每项包含文件路径和 SHA-256。矩阵的实现指纹必须完整包含 `maestro-cli`、`maestro-client`、`maestro-orchestra`、`maestro-orchestra-models` 四个 JAR 角色，各出现一次，并逐项匹配冻结的 build 文件及实际 classpath。支持无版本名（如 `maestro-client.jar`）和数字开头的版本名（如 `maestro-cli-2.12.0.jar`）；缺角色、重复角色或同名冻结文件不唯一都会拒绝。旧矩阵若漏记角色，不能用于正式统计，不补写旧报告。设备基线可用 `devices[].matrixInfoSha256` 约束矩阵中 `info` 对象的规范 JSON 哈希；说明性环境信息可放在 `environmentFingerprint`。

正式计划的轮数、阈值、应用版本、准备步骤和场景范围由使用者确定，工具没有内置“正式通过”的默认数值。冻结后更换脚本、实现、应用文件或参数，应另建计划。

每个 profile 声明 `applicationVersion: {"versionCode":"1","versionName":"1.0.0"}`，版本以实际应用为准。对每个使用中的 profile/设备组合，在执行前保存一份安装准备记录，并在计划的 `preparations` 数组中填写其 `path` 与 `sha256`。准备记录示例字段如下；其中时间、UUID、文件路径、哈希和版本必须来自实际操作，不可直接照填：

```json
{
  "protocol": "maestro.harmonyos.validation-preparation",
  "schemaVersion": 1,
  "preparationId": "本次准备的 UUID",
  "planId": "与源计划一致的 ID",
  "profileId": "demo",
  "deviceId": "实际设备编号",
  "application": {
    "bundleId": "com.example.demo", "moduleName": "entry", "abilityName": "EntryAbility",
    "versionCode": "1", "versionName": "1.0.0",
    "hap": {"path": "app.hap", "sha256": "与 applicationFingerprint 完全一致的哈希"}
  },
  "installation": {
    "basis": "operator_attested", "installedAt": "实际安装的 UTC ISO 时间",
    "record": {"path": "install.txt", "sha256": "安装记录的哈希"}
  },
  "packageObservation": {
    "basis": "operator_attested", "observedAt": "核对应用版本的 UTC ISO 时间",
    "bundleId": "com.example.demo", "versionCode": "1", "versionName": "1.0.0",
    "record": {"path": "package.txt", "sha256": "版本核对记录的哈希"}
  },
  "preparation": {
    "basis": "operator_attested", "completedAt": "完成准备的 UTC ISO 时间",
    "procedureSha256": "preparationProcedure 原字符串 UTF-8 字节的 SHA-256",
    "record": {"path": "prepare.txt", "sha256": "准备操作记录的哈希"}
  }
}
```

这些路径相对准备记录文件。安装记录写明设备、安装包和安装结果；版本记录写明包名和核对到的版本；准备记录说明初始数据、账号与界面状态。三份记录分开保存，不能跨设备复用。HAP 必须命中冻结的应用指纹；安装、版本核对、准备完成的时间依次排列，均发生在冻结前。

当前入口支持人工安装和人工核对，依据明确记为 `operator_attested`。它检查文件与关联，不会自动安装，也不读取手机中已安装 HAP 的完整字节。`device_observed` 尚未支持，不能用这个标签把手工填写的版本变成设备自动观测。`environmentFingerprint` 仍是说明记录。

正式审核使用 review v2，除人工干预和视频字段外，每个槽位还要增加：

```json
{
  "preparation": {
    "preparationSha256": "本槽位 profile/设备对应的冻结准备记录哈希",
    "installationUnchanged": true,
    "preparationUnchanged": true
  }
}
```

两个布尔值须按本轮实际情况填写，不能由 `manualIntervention=none` 推导。缺少记录、哈希不符、引用被删改或任何一项为 false，均不能正式合格。运行后更换或删除本地 HAP 不会抹去已核验的原执行通过数，但旧准备证据不能再用于正式审核。

开发输入 v1/v2 均冻结为新的 v3 产物；新正式执行的输入仍必须使用 v2。旧冻结 v1/v2 可以按原格式复核原始记录，但不允许派发新执行，也不会补写 v3 静态检查或取得该版本的依赖保证。旧 v1 不会升级为正式合格；旧 v2 仍按原有正式资格算法复核。review v1 可用于人工干预和视频复核，不能补齐准备证据；正式审核仍使用 review v2。旧原件及 v1/v2 Schema 保留。

进程被强制终止时，设备预约会留在 `running` 或 `needs_inspection`。新任务拒绝覆盖它。按 [CI 文档](ci.md) 完成原会话恢复与 `-ReconcileOnly` 核销；验证工具不自动恢复、不删除门禁、不重放未知动作。恢复结果不会把旧计划的未知或未执行槽位改为成功。

## 本地夹具测试

以下检查使用生成的报告和替身矩阵，不访问设备：

```powershell
node --test .\scripts\tests\test-validation-plan.mjs
pwsh -NoProfile -File .\scripts\tests\test-validation-plan.ps1
powershell -NoProfile -File .\scripts\tests\test-validation-plan.ps1
```
