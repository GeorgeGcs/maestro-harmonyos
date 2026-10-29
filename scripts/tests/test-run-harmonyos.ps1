[CmdletBinding()]
param()

$ErrorActionPreference = 'Stop'
$projectRoot = [IO.Path]::GetFullPath((Join-Path $PSScriptRoot '../..'))
$runnerScript = Join-Path $projectRoot 'scripts/run-harmonyos.ps1'
$testParent = Join-Path $projectRoot 'artifacts/runner-tests'
$testRoot = Join-Path $testParent ([Guid]::NewGuid().ToString('N'))
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
