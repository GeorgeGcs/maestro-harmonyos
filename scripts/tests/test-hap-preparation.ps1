#Requires -Version 7.0
param([Parameter(Mandatory)][string]$CliDir)
$ErrorActionPreference = 'Stop'
$PSNativeCommandUseErrorActionPreference = $false
$classes = Join-Path (Get-Item -LiteralPath $CliDir).FullName 'lib/*'
$java = Join-Path $env:JAVA_HOME 'bin/java.exe'
$root = (New-Item -ItemType Directory -Path (Join-Path ([IO.Path]::GetTempPath()) ('maestro-hap-' + [guid]::NewGuid().ToString('N')))).FullName
$oldHdc = $env:MAESTRO_HARMONYOS_HDC
$oldAnalytics = $env:MAESTRO_CLI_NO_ANALYTICS
try {
    $env:MAESTRO_HARMONYOS_HDC = Join-Path $root 'no-such-hdc.exe'
    $env:MAESTRO_CLI_NO_ANALYTICS = '1'
    $hap = Join-Path $root 'fixture.hap'
    $archive = [IO.Compression.ZipFile]::Open($hap, 'Create')
    try {
        $manifest = [IO.StreamWriter]::new($archive.CreateEntry('module.json').Open())
        try { $manifest.Write('{"app":{"bundleName":"com.example.test","versionCode":42}}') }
        finally { $manifest.Dispose() }
    } finally { $archive.Dispose() }
    $sha = (Get-FileHash -LiteralPath $hap -Algorithm SHA256).Hash.ToLowerInvariant()
    $cases = @(
        @{name='sha'; bundle='com.example.test'; hash=('0'*64); code='HAP_INPUT_INVALID'; message='SHA-256'},
        @{name='bundle'; bundle='com.example.other'; hash=$sha; code='HAP_INPUT_INVALID'; message='bundle name'},
        @{name='missing-hdc'; bundle='com.example.test'; hash=$sha; code='DEVICE_SELECTION_FAILED'; message='HDC'}
    )
    foreach ($case in $cases) {
        $lines = & $java '-Dfile.encoding=UTF-8' "-Duser.home=$root" -cp $classes maestro.cli.AppKt --platform harmonyos --device fixture harmonyos-prepare-app `
            --hap $hap --bundle $case.bundle --sha256 $case.hash 2> (Join-Path $root "$($case.name).stderr")
        $exitCode = $LASTEXITCODE
        $receipt = ($lines -join "`n") | ConvertFrom-Json
        if ($exitCode -eq 0 -or $receipt.protocol -cne 'maestro.harmonyos.app-preparation' -or $receipt.schemaVersion -ne 1 -or
            $receipt.status -cne 'failed' -or $receipt.cleanup -cne 'notStarted' -or $receipt.error.code -cne $case.code -or
            $receipt.error.message -notmatch $case.message) { throw "Unexpected $($case.name) receipt: $lines" }
        if ($case.name -eq 'missing-hdc' -and ($receipt.sha256 -cne $sha -or $receipt.bundleId -cne $case.bundle -or $receipt.versionCode -ne 42)) {
            throw 'Verified HAP identity was lost on device-selection failure.'
        }
    }
    Write-Host "$($cases.Count) CLI failure receipts verified."
} finally {
    $env:MAESTRO_HARMONYOS_HDC = $oldHdc
    $env:MAESTRO_CLI_NO_ANALYTICS = $oldAnalytics
    $expectedRoot = [IO.Path]::GetFullPath([IO.Path]::GetTempPath()).TrimEnd('\','/')
    if ((Split-Path $root -Parent) -eq $expectedRoot -and (Split-Path $root -Leaf) -match '^maestro-hap-[a-f0-9]{32}$') {
        Remove-Item -LiteralPath $root -Recurse -Force
    }
}
exit 0
