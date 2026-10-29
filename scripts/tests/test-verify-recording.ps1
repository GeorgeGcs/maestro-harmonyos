[CmdletBinding()]
param([Parameter(Mandatory = $true)][string]$FfmpegPath)

$ErrorActionPreference = 'Stop'
$root = [IO.Path]::GetFullPath((Join-Path $PSScriptRoot '../..'))
$script = Join-Path $root 'scripts/verify-recording.ps1'
$testRoot = Join-Path $root ('artifacts/recording-verifier-tests/' + [guid]::NewGuid().ToString('N'))
$null = [IO.Directory]::CreateDirectory($testRoot)
$utf8 = [Text.UTF8Encoding]::new($false)
$passed = 0
function Assert-Test { param([bool]$Condition, [string]$Message) if (-not $Condition) { throw $Message } }
function Invoke-Verification {
    param([string]$InputFile, [string]$Decoder = $FfmpegPath, [int]$Budget = 10)
    $directory = Join-Path $testRoot ([guid]::NewGuid().ToString('N').Substring(0, 8))
    $output = @(& $script -InputPath $InputFile -FfmpegPath $Decoder -OutputDirectory $directory -TimeoutSeconds $Budget)
    $code = $LASTEXITCODE
    $reports = @(Get-ChildItem -LiteralPath $directory -Recurse -Filter verification.json)
    Assert-Test ($reports.Count -eq 1) 'Expected exactly one verification report.'
    return [pscustomobject]@{ ExitCode = $code; Report = (Get-Content -LiteralPath $reports[0].FullName -Raw -Encoding UTF8 | ConvertFrom-Json); Path = $reports[0].FullName }
}

$valid = Join-Path $testRoot ('video ' + [char]0x718a + [char]0x732b + '.mp4')
& $FfmpegPath -nostdin -hide_banner -loglevel error -f lavfi -i 'color=c=blue:s=64x64:r=10:d=1' -c:v libx264 -pix_fmt yuv420p $valid
Assert-Test ($LASTEXITCODE -eq 0) 'Could not generate a video fixture.'
$originalHash = (Get-FileHash -LiteralPath $valid).Hash
$result = Invoke-Verification $valid
Assert-Test ($result.ExitCode -eq 0 -and $result.Report.status -eq 'passed' -and $result.Report.frames -eq 10 -and $result.Report.progressEnded) 'A complete ten-frame video did not pass.'
Assert-Test ($result.Report.inputSha256 -ceq $result.Report.inputSha256After -and (Get-FileHash -LiteralPath $valid).Hash -ceq $originalHash) 'Verification changed the input.'
$passed++

$variable = Join-Path $testRoot 'variable-timestamps.mkv'
& $FfmpegPath -nostdin -hide_banner -loglevel error -f lavfi -i 'color=c=blue:s=64x64:r=10:d=1' -vf 'settb=1/1000,setpts=if(eq(mod(N\,2)\,0)\,N\,N-0.8)*100' -fps_mode passthrough -enc_time_base 1/1000 -c:v libx264 -pix_fmt yuv420p $variable
Assert-Test ($LASTEXITCODE -eq 0) 'Could not generate the irregular-timestamp fixture.'
$result = Invoke-Verification $variable
Assert-Test ($result.ExitCode -eq 0 -and $result.Report.frames -eq 10 -and $result.Report.inputSha256 -ceq $result.Report.inputSha256After) 'Irregular timestamps lost frames or failed full decoding.'
$passed++

$broken = Join-Path $testRoot 'truncated.mp4'
$bytes = [IO.File]::ReadAllBytes($valid)
[IO.File]::WriteAllBytes($broken, [byte[]]$bytes[0..([int]($bytes.Length / 2))])
$brokenHash = (Get-FileHash -LiteralPath $broken).Hash
$result = Invoke-Verification $broken
Assert-Test ($result.ExitCode -ne 0 -and $result.Report.status -eq 'failed') 'Truncated video was accepted.'
Assert-Test ((Get-FileHash -LiteralPath $broken).Hash -ceq $brokenHash) 'Failure replaced the original video.'
$passed++

$audio = Join-Path $testRoot 'audio-only.m4a'
& $FfmpegPath -nostdin -hide_banner -loglevel error -f lavfi -i 'anullsrc=r=8000:cl=mono' -t 0.1 -c:a aac $audio
Assert-Test ($LASTEXITCODE -eq 0) 'Could not generate an audio-only fixture.'
$result = Invoke-Verification $audio
Assert-Test ($result.ExitCode -ne 0 -and $result.Report.frames -eq 0) 'Audio-only input was accepted as video.'
$passed++

$result = Invoke-Verification (Join-Path $testRoot 'missing.mp4')
Assert-Test ($result.ExitCode -ne 0 -and $result.Report.status -eq 'failed' -and $null -eq $result.Report.exitCode) 'Missing input needs a failed report without an invented process exit.'
$passed++

# A local executable exercises hangs and false-success output without slowing real decoding.
$csc = Join-Path $env:SystemRoot 'Microsoft.NET/Framework64/v4.0.30319/csc.exe'
Assert-Test (Test-Path -LiteralPath $csc) 'The timeout fixtures require the Windows .NET Framework C# compiler.'
$source = Join-Path $testRoot 'DecoderFixture.cs'
$fixture = Join-Path $testRoot 'DecoderFixture.exe'
[IO.File]::WriteAllText($source, @'
using System;
using System.IO;
using System.Threading;
class DecoderFixture {
  static int Main(string[] args) {
    if (args.Length == 1 && args[0] == "-version") { Console.WriteLine("ffmpeg version fixture"); return 0; }
    string input = args[Array.IndexOf(args, "-i") + 1];
    string mode = Path.GetFileNameWithoutExtension(input);
    if (mode == "hang") { Thread.Sleep(30000); return 0; }
    if (mode == "flood") { Console.Write(new string('x', 1100000)); return 0; }
    if (mode == "change") File.AppendAllText(input, "changed");
    if (mode == "diagnostic") Console.Error.WriteLine("decode error despite zero exit");
    if (mode != "no-progress") Console.WriteLine("frame=10\nprogress=end");
    return 0;
  }
}
'@, $utf8)
& $csc /nologo /target:exe (('/out:' + $fixture)) $source
Assert-Test ($LASTEXITCODE -eq 0) 'Could not compile the process fixture.'
foreach ($case in @('hang', 'no-progress', 'diagnostic', 'change', 'flood')) {
    $inputFile = Join-Path $testRoot ($case + '.mp4')
    Copy-Item -LiteralPath $valid -Destination $inputFile
    $watch = [Diagnostics.Stopwatch]::StartNew()
    $result = Invoke-Verification $inputFile $fixture 1
    Assert-Test ($result.ExitCode -ne 0 -and $result.Report.status -eq 'failed') ($case + ' must not produce a successful verification.')
    if ($case -eq 'hang') {
        Assert-Test ($result.Report.timedOut -and $watch.Elapsed.TotalSeconds -lt 10) 'The decoder hang was not bounded.'
    }
    if ($case -eq 'change') { Assert-Test ($result.Report.inputSha256 -cne $result.Report.inputSha256After) 'Changed bytes were not detected.' }
    $passed++
}
Write-Output ('Passed ' + $passed + ' recording verifier checks. Artifacts: ' + $testRoot)
exit 0
