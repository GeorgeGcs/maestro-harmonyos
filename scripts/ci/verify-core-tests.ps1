#Requires -Version 7.0
[CmdletBinding()]
param(
    [Parameter(Mandatory)][string]$UpstreamDirectory,
    [Parameter(Mandatory)][string]$Output
)
$ErrorActionPreference = 'Stop'
$allowedSkips = @(
    'maestro.harmonyos.driver.Mp4RecordingValidatorTest::rejects symlinks even when their target is a valid recording()',
    'maestro.orchestra.debug.OrchestraListenerDispatchTest::takeScreenshot keeps a backslash in the file name instead of inventing a folder()'
)
$results = foreach ($module in @('maestro-client', 'maestro-orchestra')) {
    $directory = Join-Path $UpstreamDirectory "$module/build/test-results/test"
    $reports = @(Get-ChildItem -LiteralPath $directory -Filter 'TEST-*.xml' -File)
    if (!$reports.Count) { throw "No JUnit reports for $module." }
    $tests = 0; $skipped = @(); $classes = @()
    foreach ($file in $reports) {
        [xml]$xml = Get-Content -LiteralPath $file.FullName -Raw
        $suite = $xml.testsuite
        if ([int]$suite.failures -or [int]$suite.errors) { throw "Failed core tests in $($file.Name)." }
        $tests += [int]$suite.tests
        $classes += [string]$suite.name
        foreach ($test in $xml.SelectNodes('//testcase[skipped]')) {
            $identity = "$($test.classname)::$($test.name)"
            if (!$IsWindows -or $identity -notin $allowedSkips) { throw "Unexpected skipped core test: $identity" }
            $skipped += $identity
        }
    }
    $required = if ($module -eq 'maestro-client') {
        @('maestro.harmonyos.driver.HarmonyOSDriverTest', 'maestro.harmonyos.driver.HdcHarmonyOSDeviceTest', 'maestro.harmonyos.driver.HarmonyOSWindowStateTest')
    } else {
        @('maestro.orchestra.debug.OrchestraListenerDispatchTest', 'maestro.orchestra.debug.ScreenRecordingOutputTest', 'maestro.orchestra.debug.ArtifactsGeneratorTest')
    }
    foreach ($name in $required) { if ($name -notin $classes) { throw "Core test suite was not run: $name" } }
    if ($tests -le $skipped.Count) { throw "No executed core tests for $module." }
    [ordered]@{ module = $module; tests = $tests; passed = $tests - $skipped.Count; platformExcluded = $skipped }
}
[ordered]@{ schemaVersion = 1; status = 'passed'; modules = @($results) } |
    ConvertTo-Json -Depth 6 | Set-Content -LiteralPath $Output -Encoding utf8NoBOM
