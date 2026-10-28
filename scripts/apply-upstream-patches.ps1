[CmdletBinding()]
param()

$ErrorActionPreference = 'Stop'
$projectRoot = [IO.Path]::GetFullPath((Join-Path $PSScriptRoot '..'))
$upstreamSpec = Get-Content -LiteralPath (Join-Path $projectRoot 'upstream.lock.json') -Raw | ConvertFrom-Json
$expectedRepository = 'https://github.com/mobile-dev-inc/Maestro.git'

if ($upstreamSpec.repository -ne $expectedRepository) { throw 'Unexpected upstream repository in upstream.lock.json.' }
if ($upstreamSpec.commit -notmatch '^[0-9a-f]{40}$') { throw 'A full upstream commit SHA is required.' }
if ([IO.Path]::IsPathRooted($upstreamSpec.checkoutPath)) { throw 'The checkout path must be relative.' }

$upstreamRoot = [IO.Path]::GetFullPath((Join-Path $projectRoot '.upstream'))
$checkoutPath = [IO.Path]::GetFullPath((Join-Path $projectRoot $upstreamSpec.checkoutPath))
$allowedPrefix = $upstreamRoot.TrimEnd([IO.Path]::DirectorySeparatorChar) + [IO.Path]::DirectorySeparatorChar
if (-not $checkoutPath.StartsWith($allowedPrefix, [StringComparison]::OrdinalIgnoreCase)) {
    throw 'The checkout must remain inside this repository .upstream directory.'
}
if (-not (Test-Path -LiteralPath $checkoutPath -PathType Container)) { throw 'Run scripts/prepare-upstream.ps1 first.' }

# Do not apply a patch through a junction into another checkout.
$pathToCheck = $checkoutPath
while ($pathToCheck -ne $projectRoot) {
    $item = Get-Item -LiteralPath $pathToCheck -Force -ErrorAction Stop
    if ($item.Attributes -band [IO.FileAttributes]::ReparsePoint) { throw 'The upstream checkout path must not contain a symbolic link or junction.' }
    $pathToCheck = [IO.Path]::GetDirectoryName($pathToCheck)
}

if (-not (Get-Command git -CommandType Application -ErrorAction SilentlyContinue)) { throw 'Git must be available in PATH.' }
if (-not (Test-Path -LiteralPath (Join-Path $checkoutPath '.git'))) { throw 'Run scripts/prepare-upstream.ps1 first.' }
$patchPath = Join-Path $projectRoot 'patches/maestro/0001-harmonyos-host.patch'
if (-not (Test-Path -LiteralPath $patchPath -PathType Leaf)) { throw 'The HarmonyOS host patch is missing.' }

function Get-GitResult {
    param([string[]]$Arguments)
    $savedErrorActionPreference = $ErrorActionPreference
    try {
        # A failed --check is expected when deciding whether the patch is already present.
        $ErrorActionPreference = 'Continue'
        $PSNativeCommandUseErrorActionPreference = $false
        $lines = @(& git -C $checkoutPath @Arguments 2>&1)
        $code = $LASTEXITCODE
        return [pscustomobject]@{ Code = $code; Output = (($lines | ForEach-Object { $_.ToString() }) -join "`n") }
    } finally {
        $ErrorActionPreference = $savedErrorActionPreference
    }
}

function Get-RequiredGitOutput {
    param([string[]]$Arguments)
    $result = Get-GitResult -Arguments $Arguments
    if ($result.Code -ne 0) { throw ('Git failed: ' + $result.Output) }
    return $result.Output.Trim()
}

$topLevel = [IO.Path]::GetFullPath((Get-RequiredGitOutput -Arguments @('rev-parse', '--show-toplevel')))
if (-not $topLevel.Equals($checkoutPath, [StringComparison]::OrdinalIgnoreCase)) { throw 'The checkout path is not the upstream Git root.' }
$origin = Get-RequiredGitOutput -Arguments @('remote', 'get-url', 'origin')
if ($origin -ne $expectedRepository) { throw 'Existing checkout origin does not match upstream.lock.json.' }
$headCommit = Get-RequiredGitOutput -Arguments @('rev-parse', 'HEAD')
if ($headCommit -ne $upstreamSpec.commit) { throw 'Upstream HEAD does not match upstream.lock.json. Existing files have been preserved.' }

$reverse = Get-GitResult -Arguments @('apply', '--reverse', '--check', '--', $patchPath)
if ($reverse.Code -eq 0) {
    Write-Output 'HarmonyOS host patch is already present. No files were changed; local edits were preserved.'
    return
}

$changes = Get-RequiredGitOutput -Arguments @('status', '--porcelain', '--untracked-files=normal')
if ($changes) {
    throw 'Upstream has local changes and the complete patch is not present. Preserve or export those changes before applying; no files were changed.'
}
$forward = Get-GitResult -Arguments @('apply', '--check', '--', $patchPath)
if ($forward.Code -ne 0) { throw ('Patch pre-check failed. No files were changed.' + "`n" + $forward.Output) }
$applied = Get-GitResult -Arguments @('apply', '--', $patchPath)
if ($applied.Code -ne 0) { throw ('Patch application failed. Inspect the checkout before retrying.' + "`n" + $applied.Output) }
Write-Output ('Applied 0001-harmonyos-host.patch to Maestro ' + $headCommit)
