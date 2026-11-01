# 依次重启维护文件

维护入口及前提见[设备维护](../session-maintenance.md)。这里说明消费者如何识别文件，不提供跳过维护或清除占用的方法。

## 版本与结果

| 文件 | 版本 | 消费方式 |
| --- | --- | --- |
| 普通恢复凭据 | schemaVersion 1/2 | 沿用 [recovery-receipt.schema.json](recovery-receipt.schema.json) |
| 维护最终凭据 | schemaVersion 3 | 使用 [maintenance-receipt-v3.schema.json](maintenance-receipt-v3.schema.json)；不按普通 v2 读取 |
| 维护响应 | protocol=harmonyos.reboot-recovery，schemaVersion=1 | 使用 [maintenance-response-v1.schema.json](maintenance-response-v1.schema.json) |
| 占用记录 | schemaVersion 2 | 含 maintenanceId、checkpoint、head；由维护核验器与设备锁共同处理 |
| 检查点 | schemaVersion 1/2 | v2 增加 transition 引用，关联工具更新前的 v1 检查点与初始阶段 |
| 阶段记录 | schemaVersion 1 | 内部证据链，字段和跨文件关系由维护核验器检查 |

最终凭据 v3 只在清理完成后产生。中途失败保留阶段记录和占用，不生成一个声称完成的凭据。响应的 `phase=complete`、`state=complete`、`cleanup.state=complete`、`handoffReady=true` 必须同时成立，并引用 v3 凭据；其他阶段不允许接管。

`operations` 是旧日志中的操作总数；`originalPendingOperations` 是旧日志里未确认的数量；`pendingOperations=0` 表示维护已经确认这些操作终止并清理资源。旧日志中的 `completed=false` 不会因此改成 true，`originalExecutionResult` 始终为 `unknown`。CI 还须保留原本的失败或未知结果。

## 引用与核验

检查点固定原占用、原日志、原回执、主机观察和工具指纹。每个阶段通过 `previous` 指向前一阶段，记录调用登记、观察结果、结束日志及清理批次。最终凭据中的 `evidenceHead` 指向写凭据之前的 cleaned 阶段；完整响应的 `head` 指向 complete 阶段，两者本来就不同。

引用采用 `{ "path": "step-11111111-1111-4111-8111-111111111111.json", "sha256": "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa" }`。这是格式示意，不是可用于恢复的证据。相对文件名只能在同一 owner/maintenanceId 目录内解析；凭据位置和响应目录还须与当前选择的会话根目录匹配。

JSON Schema 只检查结构和局部约束。它不能证明 recoveryId 等于 maintenanceId、观察确实显示依次重启、操作集合没有变化、文件哈希正确，或设备仍由该会话占用。`scripts/recovery/verify-maintenance.mjs` 负责这些检查；CI 另外检查原运行进程和外层占用。核验成功也不是设备锁，后续执行仍须通过正常入口取得锁。

读取日志应保留大整数，尤其是进程启动 ticks；不能经过 JavaScript Number 四舍五入后比较。还须拒绝重复 JSON 键、目录链接、超限文件和跨目录引用。

归档由最终凭据和完整响应开始，沿明确引用收集不可变材料，不读取后来变化的 gate 或当前日志。`maintenance_receipt_and_chain` 仅表示材料收齐，不独立批准接管。用法及读取预算见 [CI 说明](../ci.md)。

## 不接设备的兼容性测试

`scripts/tests/fixtures/MaintenanceProducer.java` 调用实际 JVM 协调器、日志和维护 transport；HDC runner 和主机观察由测试在进程内注入。模拟工具文件不是可执行程序。它覆盖完成后重复调用不再清理，以及查询未确认时拒绝重入。

```powershell
$env:MAESTRO_TEST_JAVA = 'C:/tools/jdk/bin/java.exe'
$env:MAESTRO_TEST_CLI = 'C:/build/maestro'
$env:MAESTRO_TEST_TEMP = 'C:/build/test-temp'
node --test --test-name-pattern JVM scripts/tests/test-maintenance-release.mjs scripts/tests/test-ci-collect-artifacts.mjs
pwsh -NoProfile -File scripts/tests/test-maintenance-schema.ps1
pwsh -NoProfile -File scripts/tests/test-recording-schema.ps1
```

选择含当前适配的 CLI 分发目录。未设置两个工具变量时，JVM 联测会明确跳过，不能按已通过统计。测试用源码启动方式编译 Java 夹具，读取 CLI JAR，不修改分发目录，也不启动真实 HDC 或 PowerShell 观察脚本。Windows 是维护实现的目标平台。

若需要检查实际生产格式，可手动将夹具输出保留在新目录，再传给 Schema 测试：

```powershell
& $env:MAESTRO_TEST_JAVA --class-path "$env:MAESTRO_TEST_CLI/lib/*" scripts/tests/fixtures/MaintenanceProducer.java C:/build/new-maintenance-fixture complete
pwsh -NoProfile -File scripts/tests/test-maintenance-schema.ps1 -ProducerDirectory C:/build/new-maintenance-fixture
```

这些测试验证实现之间的兼容性，不证明真实电脑和手机已经重启，也不代替设备恢复验收。
