[CmdletBinding()]
param()

$ErrorActionPreference = 'Stop'
$projectRoot = [IO.Path]::GetFullPath((Join-Path $PSScriptRoot '../..'))
$readerScript = Join-Path $projectRoot 'scripts/ci/read-junit.ps1'
$testRoot = Join-Path $projectRoot ('artifacts/ci-junit-tests/' + [guid]::NewGuid().ToString('N'))
$shell = (Get-Process -Id $PID).Path
$utf8 = [Text.UTF8Encoding]::new($false)
$passed = 0
$skipped = 0
$junction = $null
$createdFiles = [Collections.Generic.List[string]]::new()

function Assert-Test { param([bool]$Condition, [string]$Message) if (-not $Condition) { throw $Message } }
function New-XmlFile {
    param([string]$Name, [string]$Text)
    $file = Join-Path $testRoot ($Name + '.xml')
    [IO.File]::WriteAllText($file, $Text, $utf8)
    $createdFiles.Add($file)
    return $file
}
function Quote-Argument {
    param([string]$Value)
    return '"' + [regex]::Replace([regex]::Replace($Value, '(\\*)"', '$1$1\"'), '(\\+)$', '$1$1') + '"'
}
function Invoke-Reader {
    param([string]$File)
    $process = [Diagnostics.Process]::new()
    try {
        $process.StartInfo.FileName = $shell
        $process.StartInfo.Arguments = ((@('-NoProfile', '-File', $readerScript, '-Path', $File) | ForEach-Object { Quote-Argument $_ }) -join ' ')
        $process.StartInfo.UseShellExecute = $false
        $process.StartInfo.CreateNoWindow = $true
        $process.StartInfo.WindowStyle = [Diagnostics.ProcessWindowStyle]::Hidden
        $process.StartInfo.RedirectStandardOutput = $true
        $process.StartInfo.RedirectStandardError = $true
        $process.StartInfo.StandardOutputEncoding = $utf8
        $process.StartInfo.StandardErrorEncoding = $utf8
        $null = $process.Start()
        $stdout = $process.StandardOutput.ReadToEndAsync()
        $stderr = $process.StandardError.ReadToEndAsync()
        if (-not $process.WaitForExit(15000)) { throw 'JUnit reader exceeded the host test budget.' }
        if (-not $stdout.Wait(1000) -or -not $stderr.Wait(1000)) { throw 'JUnit reader output did not close.' }
        return [pscustomobject]@{ Code = $process.ExitCode; Out = $stdout.GetAwaiter().GetResult(); Err = $stderr.GetAwaiter().GetResult() }
    } finally {
        try { if (-not $process.HasExited) { $process.Kill(); $null = $process.WaitForExit(1000) } } catch { }
        $process.Dispose()
    }
}
function Assert-Rejected {
    param([string]$Name, [string]$Text)
    $answer = Invoke-Reader (New-XmlFile $Name $Text)
    Assert-Test ($answer.Code -ne 0 -and $answer.Out.Length -eq 0 -and $answer.Err.Trim().Length -gt 0) ('Invalid XML accepted or failure polluted stdout: ' + $Name)
    $script:passed++
}

try {
    $absoluteTestRoot = [IO.Path]::GetFullPath($testRoot)
    Assert-Test ($absoluteTestRoot.StartsWith($projectRoot + [IO.Path]::DirectorySeparatorChar, [StringComparison]::OrdinalIgnoreCase)) 'Host fixtures must stay in this workspace.'
    for ($current = $absoluteTestRoot; $current; $current = [IO.Path]::GetDirectoryName($current)) {
        if (Test-Path -LiteralPath $current) {
            Assert-Test (((Get-Item -LiteralPath $current -Force).Attributes -band [IO.FileAttributes]::ReparsePoint) -eq 0) 'Fixture path follows a reparse point.'
        }
    }
    $null = [IO.Directory]::CreateDirectory($testRoot)
    $unicode = -join ([char[]]@(0x6D4B, 0x8BD5))
    $native = @"
<?xml version='1.0' encoding='UTF-8'?>
<testsuites>
  <testsuite name="Test Suite" tests="2" failures="1" time="1.25" timestamp="2026-10-30T03:42:06">
    <properties><property name="suite key" value="A &amp; B"/></properties>
    <testcase id="custom-id" name="$unicode" classname="custom-class" file="flows\a.yaml" status="SUCCESS" time="0.5"><properties><property name="tags" value="smoke"/></properties></testcase>
    <testcase id="b" name="b" classname="b" file="flows\b.yaml" status="ERROR"><failure>first &amp; $unicode<![CDATA[ <second>]]></failure></testcase>
  </testsuite>
</testsuites>
"@
    $file = New-XmlFile ('native space ' + $unicode) $native
    $beforeHash = (Get-FileHash -LiteralPath $file -Algorithm SHA256).Hash.ToLowerInvariant()
    $answer = Invoke-Reader $file
    Assert-Test ($answer.Code -eq 0 -and $answer.Err.Length -eq 0) ('Native XML rejected: ' + $answer.Err)
    $value = $answer.Out | ConvertFrom-Json
    Assert-Test ($value.schemaVersion -eq 1 -and $value.sourcePath -ceq [IO.Path]::GetFullPath($file) -and $value.sha256 -ceq $beforeHash -and $value.sizeBytes -eq (Get-Item -LiteralPath $file).Length) 'Source identity differs.'
    Assert-Test (@($value.suites).Count -eq 1 -and $value.suites[0].tests -eq 2 -and $value.suites[0].failures -eq 1 -and @($value.suites[0].testCases).Count -eq 2) 'Native suite shape differs.'
    $cases = $value.suites[0].testCases
    Assert-Test ($cases[0].name -ceq $unicode -and $cases[0].id -ceq 'custom-id' -and $cases[0].classname -ceq 'custom-class' -and $cases[0].failureCount -eq 0 -and $null -eq $cases[0].failureText) 'Native attributes were changed.'
    Assert-Test ($cases[1].failureCount -eq 1 -and $cases[1].failureText -ceq "first & $unicode <second>") 'Failure text or XML entities differ.'
    Assert-Test ((Get-FileHash -LiteralPath $file -Algorithm SHA256).Hash.ToLowerInvariant() -ceq $beforeHash) 'Original XML was modified.'
    $passed++

    $deferred = Invoke-Reader (New-XmlFile 'semantic-layer' '<testsuites><testsuite tests="9" failures="0"><testcase name="raw" status="WARNING"/></testsuite></testsuites>')
    Assert-Test ($deferred.Code -eq 0) ('Reader incorrectly enforces Node count/status semantics: ' + $deferred.Err)
    $raw = $deferred.Out | ConvertFrom-Json
    Assert-Test ($raw.suites[0].tests -eq 9 -and $null -eq $raw.suites[0].testCases[0].file -and $raw.suites[0].testCases[0].status -ceq 'WARNING') 'Missing optional attributes or raw status were changed.'
    $passed++
    $empty = Invoke-Reader (New-XmlFile 'empty' '<testsuites><testsuite tests="0" failures="0"/></testsuites>')
    Assert-Test ($empty.Code -eq 0 -and @((($empty.Out | ConvertFrom-Json).suites[0].testCases)).Count -eq 0) 'Empty case arrays must remain arrays.'
    $passed++

    Assert-Rejected 'doctype' '<!DOCTYPE testsuites [<!ENTITY hidden "bad">]><testsuites>&hidden;</testsuites>'
    Assert-Rejected 'external-doctype' '<!DOCTYPE testsuites SYSTEM "file:///missing-junit-dtd"><testsuites/>'
    Assert-Rejected 'wrong-root' '<testsuite tests="0" failures="0"/>'
    Assert-Rejected 'unexpected-child' '<testsuites><testcase/></testsuites>'
    Assert-Rejected 'namespace' '<testsuites xmlns="urn:other"/>'
    Assert-Rejected 'duplicate-attribute' '<testsuites><testsuite tests="0" tests="1" failures="0"/></testsuites>'
    Assert-Rejected 'unknown-attribute' '<testsuites unexpected="x"/>'
    Assert-Rejected 'tail' '<testsuites/><testsuites/>'
    Assert-Rejected 'truncated' '<testsuites><testsuite tests="0" failures="0">'
    Assert-Rejected 'missing-count' '<testsuites><testsuite failures="0"/></testsuites>'
    Assert-Rejected 'negative-count' '<testsuites><testsuite tests="-1" failures="0"/></testsuites>'
    Assert-Rejected 'fraction-count' '<testsuites><testsuite tests="1.0" failures="0"/></testsuites>'
    Assert-Rejected 'count-overflow' '<testsuites><testsuite tests="2147483648" failures="0"/></testsuites>'
    Assert-Rejected 'duplicate-failure' '<testsuites><testsuite tests="1" failures="1"><testcase><failure/><failure/></testcase></testsuite></testsuites>'
    Assert-Rejected 'nested-failure' '<testsuites><testsuite tests="1" failures="1"><testcase><failure><b>nested</b></failure></testcase></testsuite></testsuites>'
    Assert-Rejected 'bad-property' '<testsuites><testsuite tests="0" failures="0"><properties><property name="x"/></properties></testsuite></testsuites>'
    Assert-Rejected 'duplicate-properties' '<testsuites><testsuite tests="0" failures="0"><properties/><properties/></testsuite></testsuites>'
    Assert-Rejected 'processing-instruction' '<?other x?><testsuites/>'
    Assert-Rejected 'encoding' '<?xml version="1.0" encoding="utf-16"?><testsuites/>'
    Assert-Rejected 'text-limit' ('<testsuites><testsuite tests="1" failures="1"><testcase><failure>' + ('x' * (1024 * 1024 + 1)) + '</failure></testcase></testsuite></testsuites>')
    Assert-Rejected 'combined-text-limit' ('<testsuites><testsuite tests="1" failures="1"><testcase><failure>' + ('x' * (512 * 1024)) + '<![CDATA[' + ('y' * (512 * 1024 + 1)) + ']]></failure></testcase></testsuite></testsuites>')
    Assert-Rejected 'case-limit' ('<testsuites><testsuite tests="10001" failures="0">' + ('<testcase/>' * 10001) + '</testsuite></testsuites>')
    Assert-Rejected 'file-limit' (' ' * (4 * 1024 * 1024 + 1))

    $invalidUtf8 = New-XmlFile 'invalid-utf8' '<testsuites/>'
    [IO.File]::WriteAllBytes($invalidUtf8, [byte[]]@(0xC3, 0x28))
    $answer = Invoke-Reader $invalidUtf8
    Assert-Test ($answer.Code -ne 0 -and $answer.Out.Length -eq 0) 'Invalid UTF-8 accepted.'
    $passed++
    $writer = [IO.File]::Open($file, [IO.FileMode]::Open, [IO.FileAccess]::ReadWrite, [IO.FileShare]::Read)
    try { $answer = Invoke-Reader $file } finally { $writer.Dispose() }
    Assert-Test ($answer.Code -ne 0 -and $answer.Out.Length -eq 0) 'A concurrently writable original was accepted.'
    $passed++

    $junction = Join-Path $testRoot 'linked-input'
    try { $null = New-Item -ItemType Junction -Path $junction -Target $testRoot -ErrorAction Stop }
    catch { $junction = $null; $skipped++; Write-Warning ('Junction creation unavailable; reparse ancestor test skipped: ' + $_.Exception.Message) }
    if ($junction) {
        $answer = Invoke-Reader (Join-Path $junction ([IO.Path]::GetFileName($file)))
        Assert-Test ($answer.Code -ne 0 -and $answer.Out.Length -eq 0) 'A reparse ancestor was accepted.'
        $passed++
    }
    Write-Output ("JUnit host checks passed: $passed; skipped: $skipped; PowerShell " + $PSVersionTable.PSVersion)
} finally {
    # Delete only this invocation's known files and empty directories; never recurse through a link.
    $absoluteTestRoot = [IO.Path]::GetFullPath($testRoot)
    if (-not $absoluteTestRoot.StartsWith($projectRoot + [IO.Path]::DirectorySeparatorChar, [StringComparison]::OrdinalIgnoreCase)) { throw 'Refusing cleanup outside this workspace.' }
    for ($current = $absoluteTestRoot; $current; $current = [IO.Path]::GetDirectoryName($current)) {
        if (Test-Path -LiteralPath $current) {
            if (((Get-Item -LiteralPath $current -Force).Attributes -band [IO.FileAttributes]::ReparsePoint) -ne 0) { throw 'Refusing cleanup through a replaced fixture ancestor.' }
        }
    }
    if ($junction -and (Test-Path -LiteralPath $junction)) {
        if ([IO.Path]::GetDirectoryName([IO.Path]::GetFullPath($junction)) -cne $absoluteTestRoot -or
            ((Get-Item -LiteralPath $junction -Force).Attributes -band [IO.FileAttributes]::ReparsePoint) -eq 0) { throw 'Unexpected junction cleanup target.' }
        [IO.Directory]::Delete($junction)
    }
    if (Test-Path -LiteralPath $absoluteTestRoot) {
        if (((Get-Item -LiteralPath $absoluteTestRoot -Force).Attributes -band [IO.FileAttributes]::ReparsePoint) -ne 0) { throw 'Refusing cleanup through a replaced fixture directory.' }
        foreach ($file in $createdFiles) {
            if ([IO.Path]::GetDirectoryName([IO.Path]::GetFullPath($file)) -cne $absoluteTestRoot) { throw 'Unexpected fixture cleanup target.' }
            [IO.File]::Delete($file)
        }
        [IO.Directory]::Delete($absoluteTestRoot)
    }
}
