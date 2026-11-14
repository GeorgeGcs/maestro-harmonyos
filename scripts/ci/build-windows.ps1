#Requires -Version 7.0
[CmdletBinding()]
param([string]$OutputDirectory = 'artifacts/ci-host')

$ErrorActionPreference = 'Stop'
$PSNativeCommandUseErrorActionPreference = $false
$root = [IO.Path]::GetFullPath((Join-Path $PSScriptRoot '../..'))
$upstream = Join-Path $root '.upstream/maestro'
$extension = Join-Path $root 'packages/vscode'
$output = [IO.Path]::GetFullPath($OutputDirectory, $root)
$null = New-Item -ItemType Directory -Path $output

function Invoke-BuildStep {
    param([string]$Name, [scriptblock]$Action)
    $global:LASTEXITCODE = 0
    & $Action 2>&1 | Tee-Object -FilePath (Join-Path $output "$Name.log") | Out-Host
    if ($LASTEXITCODE -ne 0) { throw "$Name failed with exit code $LASTEXITCODE." }
}

$report = [ordered]@{ commit = $null; status = 'running'; startedAt = [DateTime]::UtcNow.ToString('o'); stage = 'preflight' }
try {
    if (!$IsWindows) { throw 'The current Maestro host tests require Windows.' }
    $report.commit = (& git -C $root rev-parse HEAD)
    if ($LASTEXITCODE -ne 0) { throw 'Could not read the source commit.' }
    if (!$env:JAVA_HOME -or !(Test-Path -LiteralPath (Join-Path $env:JAVA_HOME 'bin/javac.exe'))) {
        throw 'Set JAVA_HOME to a complete JDK 17.'
    }
    $java = Join-Path $env:JAVA_HOME 'bin/java.exe'
    $javaVersion = (& $java -version 2>&1 | ForEach-Object ToString) -join "`n"
    if ($LASTEXITCODE -ne 0 -or $javaVersion -notmatch 'version "17\.') { throw 'The build requires JDK 17.' }
    $report.java = $javaVersion
    $report.node = (& node --version)
    if ($LASTEXITCODE -ne 0 -or [version]($report.node.TrimStart('v')) -lt [version]'22.12') { throw 'The build requires Node.js 22.12 or later.' }
    $report.upstreamCommit = (Get-Content -LiteralPath (Join-Path $root 'upstream.lock.json') -Raw | ConvertFrom-Json).commit
    $report.patchSha256 = (Get-FileHash -LiteralPath (Join-Path $root 'patches/maestro/0001-harmonyos-host.patch')).Hash.ToLowerInvariant()
    $env:MAESTRO_CLI_NO_ANALYTICS = '1'
    $env:MAESTRO_CLI_ANALYSIS_NOTIFICATION_DISABLED = 'true'

    $report.stage = 'source'
    # Fail an upstream transfer that stops making progress instead of losing the job budget.
    if (!$env:GIT_HTTP_LOW_SPEED_LIMIT) { $env:GIT_HTTP_LOW_SPEED_LIMIT = '1' }
    if (!$env:GIT_HTTP_LOW_SPEED_TIME) { $env:GIT_HTTP_LOW_SPEED_TIME = '60' }
    Invoke-BuildStep prepare { & (Join-Path $root 'scripts/prepare-upstream.ps1') }
    $report.stage = 'host-tests'
    Invoke-BuildStep host-tests { & (Join-Path $root 'scripts/test-host.ps1') }
    $report.stage = 'cli'
    $env:GRADLE_USER_HOME = Join-Path $root '.gradle-user-home'
    Invoke-BuildStep build-cli { & (Join-Path $upstream 'gradlew.bat') -p $upstream :maestro-cli:installDist --no-daemon --console=plain }
    $cli = Join-Path $upstream 'maestro-cli/build/install/maestro'
    Invoke-BuildStep cli-version { & (Join-Path $cli 'bin/maestro.bat') --version }
    Invoke-BuildStep build-snapshot { & node (Join-Path $root 'scripts/ci/snapshot-build.mjs') (Join-Path $output 'build-observed.json') $root }

    $report.stage = 'extension'
    Push-Location -LiteralPath $extension
    try {
        Invoke-BuildStep npm-ci { & npm.cmd ci --ignore-scripts }
        Invoke-BuildStep extension-tests { & npm.cmd test }
        Invoke-BuildStep package-extension { & npm.cmd run package }
    } finally { Pop-Location }
    $report.stage = 'package'
    $cliArchive = Join-Path $output 'maestro-harmonyos-cli.zip'
    [IO.Compression.ZipFile]::CreateFromDirectory($cli, $cliArchive)
    $vsix = @(Get-ChildItem -LiteralPath (Join-Path $extension 'dist') -Filter '*.vsix' -File)
    if ($vsix.Count -ne 1) { throw 'Expected one VSIX in the fresh extension build.' }
    Copy-Item -LiteralPath $vsix[0].FullName -Destination $output
    $checksums = foreach ($file in @($cliArchive, (Join-Path $output $vsix[0].Name))) {
        '{0}  {1}' -f (Get-FileHash -LiteralPath $file).Hash.ToLowerInvariant(), (Split-Path -Leaf $file)
    }
    Set-Content -LiteralPath (Join-Path $output 'SHA256SUMS') -Value $checksums -Encoding utf8NoBOM
    $report.status = 'passed'
} catch {
    $report.status = 'failed'
    $report.error = $_.Exception.Message
    throw
} finally {
    $report.finishedAt = [DateTime]::UtcNow.ToString('o')
    $report | ConvertTo-Json -Depth 5 | Set-Content -LiteralPath (Join-Path $output 'host-job.json') -Encoding utf8NoBOM
    $testResults = Join-Path $root 'host-tests/build/test-results/test'
    if (Test-Path -LiteralPath $testResults) {
        $junit = New-Item -ItemType Directory -Path (Join-Path $output 'junit')
        Get-ChildItem -LiteralPath $testResults -Filter 'TEST-*.xml' -File | Copy-Item -Destination $junit.FullName
    }
}
