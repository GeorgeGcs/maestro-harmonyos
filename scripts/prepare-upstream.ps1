[CmdletBinding()]
param()

$ErrorActionPreference = 'Stop'
$projectRoot = [IO.Path]::GetFullPath((Join-Path $PSScriptRoot '..'))
$lockPath = Join-Path $projectRoot 'upstream.lock.json'
$upstreamSpec = Get-Content -LiteralPath $lockPath -Raw | ConvertFrom-Json

if ($upstreamSpec.repository -ne 'https://github.com/mobile-dev-inc/Maestro.git') {
    throw 'Unexpected upstream repository. Review the source before changing this script.'
}
if ($upstreamSpec.commit -notmatch '^[0-9a-f]{40}$') { throw 'A full upstream commit SHA is required.' }
if ([IO.Path]::IsPathRooted($upstreamSpec.checkoutPath)) { throw 'The checkout path must be relative.' }

$upstreamRoot = [IO.Path]::GetFullPath((Join-Path $projectRoot '.upstream'))
$checkoutPath = [IO.Path]::GetFullPath((Join-Path $projectRoot $upstreamSpec.checkoutPath))
$allowedPrefix = $upstreamRoot.TrimEnd([IO.Path]::DirectorySeparatorChar) + [IO.Path]::DirectorySeparatorChar
if (-not $checkoutPath.StartsWith($allowedPrefix, [StringComparison]::OrdinalIgnoreCase)) {
    throw 'The checkout must remain inside this repository .upstream directory.'
}

function Invoke-UpstreamGit {
    param([string[]]$GitArguments)
    & git @GitArguments
    if ($LASTEXITCODE -ne 0) { throw 'Git operation failed. Existing files have been preserved.' }
}

if (-not (Get-Command git -CommandType Application -ErrorAction SilentlyContinue)) {
    throw 'Git must be available in PATH.'
}

$gitDirectory = Join-Path $checkoutPath '.git'
if (Test-Path -LiteralPath $checkoutPath) {
    if (-not (Test-Path -LiteralPath $checkoutPath -PathType Container)) { throw 'Checkout path is not a directory.' }
    if (-not (Test-Path -LiteralPath $gitDirectory)) {
        if (Get-ChildItem -LiteralPath $checkoutPath -Force | Select-Object -First 1) {
            throw 'Checkout directory is not empty and is not a Git repository.'
        }
    }
}

if (-not (Test-Path -LiteralPath $gitDirectory)) {
    New-Item -ItemType Directory -Path $checkoutPath -Force | Out-Null
    Invoke-UpstreamGit -GitArguments @('init', $checkoutPath)
    Invoke-UpstreamGit -GitArguments @('-C', $checkoutPath, 'remote', 'add', 'origin', $upstreamSpec.repository)
}

$configuredOrigin = (Invoke-UpstreamGit -GitArguments @('-C', $checkoutPath, 'remote', 'get-url', 'origin') | Out-String).Trim()
if ($configuredOrigin -ne $upstreamSpec.repository) { throw 'Existing checkout origin does not match upstream.lock.json.' }
$worktreeChanges = Invoke-UpstreamGit -GitArguments @('-C', $checkoutPath, 'status', '--porcelain', '--untracked-files=normal')
if ($worktreeChanges) { throw 'Upstream checkout has local changes. Preserve or export them before preparing another baseline.' }

$savedGitPrompt = $env:GIT_TERMINAL_PROMPT
try {
    $env:GIT_TERMINAL_PROMPT = '0'
    Invoke-UpstreamGit -GitArguments @('-C', $checkoutPath, '-c', 'credential.helper=', '-c', 'core.askPass=', 'fetch', '--no-tags', '--depth', '1', 'origin', $upstreamSpec.commit)
    Invoke-UpstreamGit -GitArguments @('-C', $checkoutPath, 'checkout', '--detach', $upstreamSpec.commit)
    $actualCommit = (Invoke-UpstreamGit -GitArguments @('-C', $checkoutPath, 'rev-parse', 'HEAD') | Out-String).Trim()
    if ($actualCommit -ne $upstreamSpec.commit) { throw 'Checked out commit does not match upstream.lock.json.' }
    Write-Output ('Prepared Maestro source at ' + $actualCommit)
    Write-Output 'No adaptation patches, dependency installation, build or device tests were performed.'
} finally {
    if ($null -eq $savedGitPrompt) {
        Remove-Item -LiteralPath Env:GIT_TERMINAL_PROMPT -ErrorAction SilentlyContinue
    } else {
        $env:GIT_TERMINAL_PROMPT = $savedGitPrompt
    }
}
