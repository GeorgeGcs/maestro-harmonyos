# Bounded ZIP extraction: validate every member before creating the destination.
[CmdletBinding()]
param(
    [Parameter(Mandatory)][ValidateSet('Pack', 'Extract')][string]$Mode,
    [Parameter(Mandatory)][string]$Archive,
    [Parameter(Mandatory)][string]$Directory
)
$ErrorActionPreference = 'Stop'
if ($PSVersionTable.PSVersion.Major -lt 7) { throw 'PowerShell 7 is required.' }
$archivePath = [IO.Path]::GetFullPath($Archive)
$directoryPath = [IO.Path]::GetFullPath($Directory)
function Assert-NoLink([string]$Target) {
    for ($current = $Target; $current; $current = [IO.Path]::GetDirectoryName($current)) {
        if ((Test-Path -LiteralPath $current) -and ((Get-Item -LiteralPath $current -Force).Attributes -band [IO.FileAttributes]::ReparsePoint)) {
            throw 'ZIP paths must not follow links.'
        }
    }
}
Assert-NoLink $archivePath
Assert-NoLink $directoryPath
if ($Mode -eq 'Pack') {
    if (Test-Path -LiteralPath $archivePath) { throw 'Archive already exists.' }
    if (-not (Test-Path -LiteralPath $directoryPath -PathType Container)) { throw 'Missing package directory.' }
    foreach ($item in Get-ChildItem -LiteralPath $directoryPath -Recurse -Force) {
        if ($item.Attributes -band [IO.FileAttributes]::ReparsePoint) { throw 'Package includes a link.' }
    }
    [IO.Compression.ZipFile]::CreateFromDirectory($directoryPath, $archivePath, [IO.Compression.CompressionLevel]::Fastest, $false)
    exit 0
}
if (Test-Path -LiteralPath $directoryPath) { throw 'Extraction destination must not exist.' }
if ((Get-Item -LiteralPath $archivePath).Length -gt 2GB) { throw 'ZIP exceeds 2 GiB.' }
$zip = [IO.Compression.ZipFile]::OpenRead($archivePath)
try {
    $members = [Collections.Generic.Dictionary[string,bool]]::new([StringComparer]::OrdinalIgnoreCase)
    [long]$total = 0
    if ($zip.Entries.Count -gt 50000) { throw 'Too many ZIP entries.' }
    foreach ($entry in $zip.Entries) {
        $name = $entry.FullName
        $isDirectory = $name.EndsWith('/')
        $relative = if ($isDirectory) { $name.Substring(0, $name.Length - 1) } else { $name }
        if (-not $relative -or $relative.Length -gt 1000 -or $relative -match '[\\:<>"|?*\x00-\x1f\x7f]' -or $relative.StartsWith('/')) { throw 'Unsafe ZIP path.' }
        foreach ($part in $relative.Split('/')) {
            if (-not $part -or $part -in '.', '..' -or $part -match '[. ]$' -or $part -match '^(?i:con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\.|$)') { throw 'Unsafe ZIP path component.' }
        }
        if ($members.ContainsKey($relative)) { throw 'Duplicate ZIP path.' }
        $members.Add($relative, $isDirectory)
        $unixType = ($entry.ExternalAttributes -shr 16) -band 0xf000
        if ($unixType -notin 0, 0x8000, 0x4000 -or ($entry.ExternalAttributes -band 0x400)) { throw 'ZIP links and special entries are forbidden.' }
        if ($entry.Length -lt 0 -or ($isDirectory -and $entry.Length -ne 0)) { throw 'Invalid ZIP member length.' }
        $total += $entry.Length
        if ($total -gt 2GB) { throw 'Expanded ZIP exceeds 2 GiB.' }
    }
    foreach ($name in $members.Keys) {
        $parent = $name
        while ($parent.Contains('/')) {
            $parent = $parent.Substring(0, $parent.LastIndexOf('/'))
            if ($members.ContainsKey($parent) -and -not $members[$parent]) { throw 'ZIP file/directory path conflict.' }
        }
    }
    [IO.Directory]::CreateDirectory($directoryPath) | Out-Null
    foreach ($entry in $zip.Entries) {
        $target = [IO.Path]::GetFullPath((Join-Path $directoryPath $entry.FullName))
        $relativeTarget = [IO.Path]::GetRelativePath($directoryPath, $target)
        if ($relativeTarget -eq '..' -or $relativeTarget.StartsWith('..' + [IO.Path]::DirectorySeparatorChar) -or [IO.Path]::IsPathRooted($relativeTarget)) { throw 'ZIP path escaped extraction root.' }
        if ($entry.FullName.EndsWith('/')) { [IO.Directory]::CreateDirectory($target) | Out-Null; continue }
        [IO.Directory]::CreateDirectory([IO.Path]::GetDirectoryName($target)) | Out-Null
        $inputStream = $entry.Open()
        $outputStream = [IO.File]::Open($target, [IO.FileMode]::CreateNew, [IO.FileAccess]::Write, [IO.FileShare]::None)
        try {
            $buffer = [byte[]]::new(65536)
            [long]$copied = 0
            while (($count = $inputStream.Read($buffer, 0, $buffer.Length)) -gt 0) {
                $copied += $count
                if ($copied -gt $entry.Length) { throw 'ZIP member exceeded declared size.' }
                $outputStream.Write($buffer, 0, $count)
            }
            if ($copied -ne $entry.Length) { throw 'Truncated ZIP member.' }
        } finally { $outputStream.Dispose(); $inputStream.Dispose() }
    }
} finally { $zip.Dispose() }
