[CmdletBinding()]
param()

$ErrorActionPreference = 'Stop'
$projectRoot = [IO.Path]::GetFullPath((Join-Path $PSScriptRoot '../..'))
$runnerScript = Join-Path $projectRoot 'scripts/run-harmonyos.ps1'
$testParent = Join-Path $projectRoot 'artifacts/runner-tests'
$testRoot = Join-Path $testParent ([Guid]::NewGuid().ToString('N').Substring(0, 12))
$savedEnvironment = [Environment]::GetEnvironmentVariables('Process')
$utf8 = [Text.UTF8Encoding]::new($false)
$passed = 0

function Assert-Test {
    param([bool]$Condition, [string]$Message)
    if (-not $Condition) { throw $Message }
}

function Write-TestFile {
    param([string]$Path, [string]$Text)
    [IO.File]::WriteAllText($Path, $Text, $utf8)
}

function Read-Capture {
    param([string]$Path)
    return @([IO.File]::ReadAllLines($Path, $utf8) | ForEach-Object {
        [Text.Encoding]::UTF8.GetString([Convert]::FromBase64String($_))
    })
}

try {
    $localConfig = Join-Path $projectRoot 'config.local.ps1'
    if (Test-Path -LiteralPath $localConfig -PathType Leaf) { . $localConfig }
    if (-not $env:JAVA_HOME) { throw 'Set JAVA_HOME to a complete JDK 17 to run these tests.' }
    $javaHomeForTests = $env:JAVA_HOME
    $javac = Join-Path $javaHomeForTests 'bin/javac.exe'
    $jar = Join-Path $javaHomeForTests 'bin/jar.exe'
    if (-not (Test-Path -LiteralPath $javac) -or -not (Test-Path -LiteralPath $jar)) {
        throw 'These tests require javac.exe and jar.exe from a complete JDK.'
    }

    $unicodeText = -join ([char[]]@(0x718A, 0x732B, 0x6D4B, 0x8BD5))
    $fixtureRoot = Join-Path $testRoot ('fixture space ' + $unicodeText)
    $fixtureScripts = Join-Path $fixtureRoot 'scripts'
    $distribution = Join-Path $fixtureRoot '.upstream/maestro/maestro-cli/build/install/maestro'
    $libraryDirectory = Join-Path $distribution 'lib'
    $classes = Join-Path $fixtureRoot 'classes'
    foreach ($directory in @($fixtureScripts, $libraryDirectory, (Join-Path $distribution 'bin'), $classes)) {
        $null = [IO.Directory]::CreateDirectory($directory)
    }
    $fixtureRunner = Join-Path $fixtureScripts 'run-harmonyos.ps1'
    Copy-Item -LiteralPath $runnerScript -Destination $fixtureRunner
    Write-TestFile -Path (Join-Path $distribution 'bin/maestro.bat') -Text '@rem This fixture is never executed.'

    $source = @'
package maestro.cli;
import java.nio.charset.StandardCharsets;
import java.nio.file.Files;
import java.nio.file.Path;
import java.util.ArrayList;
import java.util.Base64;
import java.util.List;
public class AppKt {
    public static void main(String[] args) throws Exception {
        if (args.length == 1 && args[0].equals("--hold-pipes")) { Thread.sleep(5000); return; }
        List<String> values = new ArrayList<>();
        for (String key : List.of("MAESTRO_HARMONYOS_ABILITY", "MAESTRO_HARMONYOS_MODULE", "RUNNER_CONFIG_MARKER")) {
            values.add(System.getenv().getOrDefault(key, ""));
        }
        values.addAll(List.of(args));
        List<String> lines = new ArrayList<>();
        for (String value : values) lines.add(Base64.getEncoder().encodeToString(value.getBytes(StandardCharsets.UTF_8)));
        Path capture = Path.of(System.getenv("RUNNER_CAPTURE_FILE"));
        Files.write(capture, lines, StandardCharsets.UTF_8);
        Files.writeString(capture.resolveSibling("launcher-charset.txt"), System.getProperty("sun.jnu.encoding"), StandardCharsets.UTF_8);
        String mode = System.getenv().getOrDefault("RUNNER_CAPTURE_MODE", "normal");
        if (mode.equals("burst")) { for (int i=0; i<15000; i++) System.out.println("fixture-line-"+i); }
        if (mode.equals("hang") || mode.equals("closed-streams")) {
            System.out.println("before-wait"); System.err.println("fixture-diagnostic");
            if (mode.equals("closed-streams")) { System.out.close(); System.err.close(); }
            Thread.sleep(10000);
        }
        if (mode.equals("tail")) {
            Process child = new ProcessBuilder(Path.of(System.getProperty("java.home"), "bin", "java.exe").toString(),
                "-classpath", System.getProperty("java.class.path"), "maestro.cli.AppKt", "--hold-pipes").inheritIO().start();
            Files.writeString(capture.resolveSibling("pipe-child.txt"), Long.toString(child.pid()), StandardCharsets.UTF_8);
        }
        System.exit(Integer.parseInt(System.getenv().getOrDefault("RUNNER_CAPTURE_EXIT", "0")));
    }
}
'@
    $sourcePath = Join-Path $fixtureRoot 'AppKt.java'
    Write-TestFile -Path $sourcePath -Text $source
    & $javac -encoding UTF-8 -d $classes $sourcePath
    if ($LASTEXITCODE -ne 0) { throw 'Could not compile the Java argument-capture fixture.' }
    & $jar --create --file (Join-Path $libraryDirectory 'capture.jar') -C $classes .
    if ($LASTEXITCODE -ne 0) { throw 'Could not package the Java argument-capture fixture.' }

    $configText = '$env:JAVA_HOME = ''' + $javaHomeForTests.Replace("'", "''") + "'`n" + @'
$env:MAESTRO_HARMONYOS_ABILITY = 'config-ability'
$env:MAESTRO_HARMONYOS_MODULE = 'config-module'
$env:RUNNER_CONFIG_MARKER = 'loaded'
'@
    Write-TestFile -Path (Join-Path $fixtureRoot 'config.local.ps1') -Text $configText
    $flowPath = Join-Path $fixtureRoot ('flow with spaces ' + $unicodeText + '.yaml')
    Write-TestFile -Path $flowPath -Text "appId: test.fixture`n---`n- launchApp`n"
    $capturePath = Join-Path $fixtureRoot 'capture.txt'
    $env:RUNNER_CAPTURE_FILE = $capturePath
    $env:RUNNER_CAPTURE_EXIT = '0'
    $env:MAESTRO_HARMONYOS_ABILITY = 'caller-ability'
    $env:MAESTRO_HARMONYOS_MODULE = 'caller-module'
    Remove-Item -LiteralPath Env:RUNNER_CONFIG_MARKER -ErrorAction SilentlyContinue
    $emojiText = -join ([char[]]@(0xD83D, 0xDC3C))
    $argumentValue = $unicodeText + ' O''Reilly "quoted" C:\folder with spaces\tail\ # & | < > % ! = @file'
    $multilineValue = "line one`nline two`ttab`rreturn"
    $parameters = @{
        FlowPath = $flowPath
        BundleId = 'org.example.launcher'
        AbilityName = 'EntryAbility'
        Module = 'entry'
        DeviceId = 'fixture-device'
        Env = @{ INPUT_TEXT = $argumentValue; MULTILINE = $multilineValue; EMPTY = '' }
        Artifacts = (Join-Path $fixtureRoot ('output space ' + $unicodeText))
    }
    & $fixtureRunner @parameters | Out-Null
    $firstExit = $LASTEXITCODE
    Assert-Test ($firstExit -eq 0) ('The successful Java fixture did not exit zero: ' + $firstExit)
    $captured = Read-Capture $capturePath
    $expectedPrefix = @('EntryAbility', 'entry', 'loaded', '--platform', 'harmonyos', '--device', 'fixture-device', 'test', '--test-output-dir')
    for ($index = 0; $index -lt $expectedPrefix.Count; $index++) {
        Assert-Test ($captured[$index] -ceq $expectedPrefix[$index]) ('Unexpected argument at index ' + $index)
    }
    $firstArtifacts = $captured[9]
    $expectedTail = @('-e', 'APP_ID=org.example.launcher', '-e', 'EMPTY=', '-e', ('INPUT_TEXT=' + $argumentValue), '-e', ('MULTILINE=' + $multilineValue),
        '--harmonyos-agent-output', (Join-Path $parameters.Artifacts 'agent'), '--harmonyos-run-id', $captured[21], '--harmonyos-attempt-id', $captured[23], '--harmonyos-attempt-no', '1', $flowPath)
    Assert-Test ($captured.Count -eq 10 + $expectedTail.Count) 'The argument count changed.'
    for ($index = 0; $index -lt $expectedTail.Count; $index++) {
        Assert-Test ($captured[$index + 10] -ceq $expectedTail[$index]) ('Argument text was not preserved at index ' + ($index + 10) + ': actual=' + $captured[$index + 10] + '; expected=' + $expectedTail[$index])
    }
    Assert-Test (Test-Path -LiteralPath $firstArtifacts -PathType Container) 'The artifact directory was not created.'
    $invocation = Get-Content -LiteralPath (Join-Path $firstArtifacts 'invocation.json') -Raw -Encoding UTF8 | ConvertFrom-Json
    Assert-Test ($invocation.agentStatus -eq 'unknown' -and $invocation.cliExitCode -eq 0) 'Missing typed results were treated as confirmed success.'
    Assert-Test ($invocation.runId -ceq $captured[21] -and $invocation.attemptId -ceq $captured[23]) 'Invocation identifiers changed before CLI launch.'
    $runtimeControl = Get-Content -LiteralPath (Join-Path $firstArtifacts 'execution-control.json') -Raw -Encoding UTF8 | ConvertFrom-Json
    Assert-Test ($runtimeControl.runtime.schemaVersion -eq 1 -and $runtimeControl.runtime.java.path -eq $runtimeControl.executable) 'The actual Java launch target was not retained.'
    Assert-Test ($runtimeControl.runtime.java.sha256 -eq (Get-FileHash -LiteralPath $runtimeControl.executable -Algorithm SHA256).Hash.ToLowerInvariant()) 'The retained Java hash differs.'
    Assert-Test ($runtimeControl.runtime.classpath.Count -eq 1 -and $runtimeControl.runtime.classpath[0].sha256 -eq (Get-FileHash -LiteralPath (Join-Path $libraryDirectory 'capture.jar') -Algorithm SHA256).Hash.ToLowerInvariant()) 'The executed classpath member was not retained.'
    Assert-Test ($runtimeControl.runtime.configuration.present -eq $true -and $runtimeControl.runtime.powershell.path -eq (Get-Process -Id $PID).Path) 'The actual PowerShell or local configuration identity is missing.'
    $passed++

    $parameters.RunTimeoutSeconds = 1
    $parameters.TerminationWaitSeconds = 1
    $parameters.OutputDrainSeconds = 1
    foreach ($mode in @('hang', 'closed-streams')) {
        $env:RUNNER_CAPTURE_MODE = $mode
        $timer = [Diagnostics.Stopwatch]::StartNew()
        & $fixtureRunner @parameters | Out-Null
        Assert-Test ($LASTEXITCODE -ne 0 -and $timer.Elapsed.TotalSeconds -lt 8) ('The runner did not bound ' + $mode)
        $capture = Read-Capture $capturePath
        $record = Get-Content -LiteralPath (Join-Path $capture[9] 'execution-control.json') -Raw -Encoding UTF8 | ConvertFrom-Json
        Assert-Test ($record.phase -eq 'unknown' -and $record.stopReason -eq 'run_timeout' -and $record.terminationRequested -eq $true) 'Hard termination was not recorded as uncertain.'
        Assert-Test ($record.processExitObserved -eq $true -and $null -ne $record.processExitCode -and $record.process.startTimeTicks -gt 0) 'The real process identity and exit were not preserved.'
        Assert-Test ((Get-Content -LiteralPath $record.stdoutPath -Raw) -match 'before-wait') 'Standard output was not retained.'
        Assert-Test ((Get-Content -LiteralPath $record.stderrPath -Raw) -match 'fixture-diagnostic') 'Standard error was not retained.'
        $passed++
    }
    $env:RUNNER_CAPTURE_MODE = 'tail'
    $timer = [Diagnostics.Stopwatch]::StartNew()
    & $fixtureRunner @parameters | Out-Null
    Assert-Test ($LASTEXITCODE -ne 0 -and $timer.Elapsed.TotalSeconds -lt 5) 'A descendant holding output pipes blocked the runner.'
    $capture = Read-Capture $capturePath
    $record = Get-Content -LiteralPath (Join-Path $capture[9] 'execution-control.json') -Raw -Encoding UTF8 | ConvertFrom-Json
    Assert-Test ($record.processExitCode -eq 0 -and $record.wrapperExitCode -ne 0 -and $record.stopReason -eq 'output_drain_timeout' -and $record.terminationRequested -eq $false) 'Output loss rewrote the real zero process exit.'
    $childProcess = [Diagnostics.Process]::GetProcessById([int](Get-Content -LiteralPath (Join-Path $fixtureRoot 'pipe-child.txt')))
    try { Assert-Test (-not $childProcess.HasExited) 'The runner terminated a process other than its owned Java process.'; $null = $childProcess.WaitForExit(7000) } finally { $childProcess.Dispose() }
    $passed++
    $env:RUNNER_CAPTURE_MODE = 'burst'
    $parameters.RunTimeoutSeconds = 15
    $parameters.OutputDrainSeconds = 5
    & $fixtureRunner @parameters | Out-Null
    Assert-Test ($LASTEXITCODE -eq 0) 'Buffered output was throttled into a false timeout.'
    $capture = Read-Capture $capturePath
    $record = Get-Content -LiteralPath (Join-Path $capture[9] 'execution-control.json') -Raw -Encoding UTF8 | ConvertFrom-Json
    Assert-Test ($record.phase -eq 'exited' -and $record.stdoutComplete -eq $true -and [IO.File]::ReadAllLines($record.stdoutPath).Length -eq 15000) 'The output burst was not completely retained.'
    $passed++
    Remove-Item -LiteralPath Env:RUNNER_CAPTURE_MODE
    $parameters.Remove('RunTimeoutSeconds'); $parameters.Remove('TerminationWaitSeconds'); $parameters.Remove('OutputDrainSeconds')

    $parameters.ControlRecordPath = Join-Path $fixtureRoot 'explicit control record.json'
    & $fixtureRunner @parameters | Out-Null
    Assert-Test ($LASTEXITCODE -eq 0 -and (Test-Path -LiteralPath $parameters.ControlRecordPath)) 'An explicit control record path was not written.'
    $controlHash = (Get-FileHash -LiteralPath $parameters.ControlRecordPath -Algorithm SHA256).Hash
    Remove-Item -LiteralPath $capturePath -Force
    $savedPreference = $ErrorActionPreference
    try { $ErrorActionPreference = 'Continue'; & $fixtureRunner @parameters 2>$null | Out-Null; $duplicateControlExit = $LASTEXITCODE }
    finally { $ErrorActionPreference = $savedPreference }
    Assert-Test ($duplicateControlExit -ne 0 -and -not (Test-Path -LiteralPath $capturePath)) 'Reusing a control path started another executor.'
    Assert-Test ((Get-FileHash -LiteralPath $parameters.ControlRecordPath -Algorithm SHA256).Hash -eq $controlHash) 'A refused launch changed an existing control record.'
    $parameters.Remove('ControlRecordPath')
    $passed++

    Assert-Test ($env:MAESTRO_HARMONYOS_ABILITY -ceq 'caller-ability') 'Ability environment was not restored.'
    Assert-Test ($env:MAESTRO_HARMONYOS_MODULE -ceq 'caller-module') 'Module environment was not restored.'
    Assert-Test ($null -eq [Environment]::GetEnvironmentVariable('RUNNER_CONFIG_MARKER', 'Process')) 'A config-only environment variable leaked.'
    $passed++

    $env:RUNNER_CAPTURE_EXIT = '37'
    & $fixtureRunner @parameters | Out-Null
    $failedExit = $LASTEXITCODE
    Assert-Test ($failedExit -eq 37) 'The CLI exit code was not preserved.'
    $secondCapture = Read-Capture $capturePath
    Assert-Test ($secondCapture[9] -cne $firstArtifacts) 'Two invocations shared an artifact directory.'
    $failedInvocation = Get-Content -LiteralPath (Join-Path $secondCapture[9] 'invocation.json') -Raw -Encoding UTF8 | ConvertFrom-Json
    Assert-Test ($failedInvocation.cliExitCode -eq 37 -and $failedInvocation.agentStatus -eq 'unknown') 'Missing typed failures were guessed from the exit code.'
    Assert-Test ($env:MAESTRO_HARMONYOS_ABILITY -ceq 'caller-ability') 'Failure did not restore the environment.'
    Assert-Test ($secondCapture[19] -ceq $captured[19]) 'Random invocation directories bypass the stable attempt registry.'
    $parameters.RunId = $captured[21]
    $parameters.AttemptId = $captured[23]
    & $fixtureRunner @parameters | Out-Null
    $duplicateCapture = Read-Capture $capturePath
    Assert-Test ($duplicateCapture[19] -ceq $captured[19] -and $duplicateCapture[21] -ceq $captured[21] -and $duplicateCapture[23] -ceq $captured[23]) 'Resubmission changed the attempt identity or registry root.'
    $parameters.Remove('RunId')
    $parameters.Remove('AttemptId')
    $passed++

    $env:RUNNER_CAPTURE_EXIT = '0'
    $parameters.Remove('Module')
    $parameters.Remove('DeviceId')
    $parameters.Remove('Artifacts')
    $parameters.FlowPath = $fixtureRoot
    & $fixtureRunner @parameters | Out-Null
    Assert-Test ($LASTEXITCODE -eq 0) 'A Flow directory could not be passed to the CLI.'
    $directoryCapture = Read-Capture $capturePath
    Assert-Test ($directoryCapture[1] -ceq 'config-module') 'An omitted module did not use the local configuration.'
    Assert-Test ($directoryCapture[-1] -ceq $fixtureRoot) 'The Flow directory argument changed.'
    Assert-Test ($directoryCapture -cnotcontains '--device') 'An omitted device was still passed.'
    Assert-Test ($directoryCapture[7].StartsWith((Join-Path $fixtureRoot 'artifacts'), [StringComparison]::OrdinalIgnoreCase)) 'The default artifact root was not used.'
    $passed++

    Remove-Item -LiteralPath $capturePath -Force
    $charsetName = [IO.File]::ReadAllText((Join-Path $fixtureRoot 'launcher-charset.txt'), $utf8)
    $nativeEncoding = [Text.Encoding]::GetEncoding($charsetName, [Text.EncoderExceptionFallback]::new(), [Text.DecoderExceptionFallback]::new())
    $emojiRepresentable = $false
    try { $emojiRepresentable = $nativeEncoding.GetString($nativeEncoding.GetBytes($emojiText)) -ceq $emojiText } catch [Text.EncoderFallbackException] { }
    $parameters.Env = @{ INPUT_TEXT = $emojiText }
    $savedPreference = $ErrorActionPreference
    try {
        $ErrorActionPreference = 'Continue'
        $emojiOutput = @(& $fixtureRunner @parameters 2>&1)
        $emojiExit = $LASTEXITCODE
    } finally { $ErrorActionPreference = $savedPreference }
    if ($emojiRepresentable) {
        Assert-Test ($emojiExit -eq 0) 'Representable emoji was rejected.'
        Assert-Test ((Read-Capture $capturePath) -ccontains ('INPUT_TEXT=' + $emojiText)) 'Emoji changed in a Unicode-capable launcher.'
    } else {
        Assert-Test ($emojiExit -eq 1) 'Unrepresentable emoji was not rejected.'
        Assert-Test (($emojiOutput | Out-String) -match 'UTF-8 YAML') 'The rejection did not explain the UTF-8 YAML alternative.'
        Assert-Test (-not (Test-Path -LiteralPath $capturePath)) 'Unrepresentable input still started Maestro.'
    }
    Assert-Test ($env:MAESTRO_HARMONYOS_ABILITY -ceq 'caller-ability') 'Rejected input did not restore the environment.'
    $passed++

    if (Test-Path -LiteralPath $capturePath) { Remove-Item -LiteralPath $capturePath -Force }
    $parameters.Env = @{ APP_ID = 'must-not-override' }
    try {
        $ErrorActionPreference = 'Continue'
        & $fixtureRunner @parameters 2>$null | Out-Null
        $rejectedExit = $LASTEXITCODE
    } finally { $ErrorActionPreference = $savedPreference }
    Assert-Test ($rejectedExit -eq 1) 'An APP_ID override was not rejected.'
    Assert-Test (-not (Test-Path -LiteralPath $capturePath)) 'Invalid parameters still started Java.'
    $passed++

    $parameters.Env = @{}
    $parameters.FlowPath = Join-Path $fixtureRoot 'missing.yaml'
    try {
        $ErrorActionPreference = 'Continue'
        & $fixtureRunner @parameters 2>$null | Out-Null
        $missingExit = $LASTEXITCODE
    } finally { $ErrorActionPreference = $savedPreference }
    Assert-Test ($missingExit -eq 1) 'A missing Flow did not fail.'
    Assert-Test (-not (Test-Path -LiteralPath $capturePath)) 'A missing Flow still started Java.'
    $passed++

    foreach ($script in @($runnerScript, $PSCommandPath)) {
        $parseErrors = $null
        [Management.Automation.Language.Parser]::ParseFile($script, [ref]$null, [ref]$parseErrors) | Out-Null
        Assert-Test ($parseErrors.Count -eq 0) ('PowerShell syntax errors in ' + $script)
    }
    Write-Output ('PASS: ' + $passed + ' runner checks and 2 syntax checks. Used local Java only; no Gradle, network or device operations.')
} finally {
    $currentEnvironment = [Environment]::GetEnvironmentVariables('Process')
    foreach ($name in $currentEnvironment.Keys) {
        if (-not $savedEnvironment.Contains($name)) { Remove-Item -LiteralPath ('Env:' + $name) -ErrorAction SilentlyContinue }
    }
    foreach ($name in $savedEnvironment.Keys) {
        [Environment]::SetEnvironmentVariable($name, [string]$savedEnvironment[$name], 'Process')
    }
    if (Test-Path -LiteralPath $testRoot) {
        $resolvedTestRoot = (Resolve-Path -LiteralPath $testRoot).Path
        $allowedPrefix = [IO.Path]::GetFullPath($testParent).TrimEnd([IO.Path]::DirectorySeparatorChar) + [IO.Path]::DirectorySeparatorChar
        if (-not $resolvedTestRoot.StartsWith($allowedPrefix, [StringComparison]::OrdinalIgnoreCase)) {
            throw 'Refusing cleanup outside the runner-test directory.'
        }
        Remove-Item -LiteralPath $resolvedTestRoot -Recurse -Force
    }
}
