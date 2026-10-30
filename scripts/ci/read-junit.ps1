[CmdletBinding()]
param([Parameter(Mandatory = $true)][string]$Path)

$ErrorActionPreference = 'Stop'
$utf8 = [Text.UTF8Encoding]::new($false, $true)
[Console]::OutputEncoding = [Text.UTF8Encoding]::new($false)
$maxBytes = 4 * 1024 * 1024
$maxTextBytes = 1024 * 1024

function Assert-JUnitPath {
    param([string]$File)
    for ($current = $File; $current; $current = [IO.Path]::GetDirectoryName($current)) {
        $item = Get-Item -LiteralPath $current -Force -ErrorAction Stop
        if (($item.Attributes -band [IO.FileAttributes]::ReparsePoint) -ne 0) {
            throw 'JUnit paths must not follow symbolic links or reparse points.'
        }
    }
    $item = Get-Item -LiteralPath $File -Force -ErrorAction Stop
    if ($item.PSIsContainer -or $item.Length -gt $maxBytes) { throw 'JUnit must be a regular file of at most 4 MiB.' }
    return $item
}

function Read-JUnitBytes {
    param([IO.Stream]$Stream)
    if ($Stream.Length -gt $maxBytes) { throw 'JUnit exceeds 4 MiB.' }
    $bytes = [byte[]]::new([int]$Stream.Length)
    $offset = 0
    while ($offset -lt $bytes.Length) {
        $count = $Stream.Read($bytes, $offset, $bytes.Length - $offset)
        if ($count -eq 0) { throw 'JUnit changed while being read.' }
        $offset += $count
    }
    if ($Stream.ReadByte() -ne -1) { throw 'JUnit grew while being read.' }
    return ,$bytes
}

function Get-JUnitHash {
    param([byte[]]$Bytes)
    $hasher = [Security.Cryptography.SHA256]::Create()
    try { return ([BitConverter]::ToString($hasher.ComputeHash($Bytes))).Replace('-', '').ToLowerInvariant() }
    finally { $hasher.Dispose() }
}

function Assert-JUnitAttributes {
    param([Xml.XmlReader]$Reader, [string[]]$Allowed)
    if ($Reader.MoveToFirstAttribute()) {
        do {
            if ($Reader.NamespaceURI -or $Reader.Prefix -or $Reader.Name -cnotin $Allowed) {
                throw ('Unexpected JUnit attribute: ' + $Reader.Name)
            }
            if ($utf8.GetByteCount($Reader.Value) -gt $maxTextBytes) { throw 'JUnit attribute exceeds 1 MiB.' }
        } while ($Reader.MoveToNextAttribute())
        $null = $Reader.MoveToElement()
    }
}

function Get-JUnitCount {
    param([Xml.XmlReader]$Reader, [string]$Name)
    $value = $Reader.GetAttribute($Name)
    $number = 0
    if ($null -eq $value -or -not [int]::TryParse($value, [Globalization.NumberStyles]::None,
        [Globalization.CultureInfo]::InvariantCulture, [ref]$number) -or $number -lt 0) {
        throw ('JUnit ' + $Name + ' must be a nonnegative 32-bit integer.')
    }
    return $number
}

$source = $null
$reader = $null
$memory = $null
try {
    $absolute = [IO.Path]::GetFullPath($ExecutionContext.SessionState.Path.GetUnresolvedProviderPathFromPSPath($Path))
    $before = Assert-JUnitPath $absolute
    $beforeSize = $before.Length
    $beforeWrite = $before.LastWriteTimeUtc.Ticks
    # Keep a read-only handle that denies writers/deletion throughout parsing on Windows.
    $source = [IO.File]::Open($absolute, [IO.FileMode]::Open, [IO.FileAccess]::Read, [IO.FileShare]::Read)
    $bytes = Read-JUnitBytes $source
    if ($bytes.Length -ne $beforeSize) { throw 'JUnit changed before parsing.' }
    $digest = Get-JUnitHash $bytes
    $decoded = $utf8.GetString($bytes)
    if ($decoded.IndexOf([char]0) -ge 0) { throw 'JUnit must be UTF-8 XML.' }
    $settings = [Xml.XmlReaderSettings]::new()
    $settings.DtdProcessing = [Xml.DtdProcessing]::Prohibit
    $settings.XmlResolver = $null
    $settings.ConformanceLevel = [Xml.ConformanceLevel]::Document
    $settings.CheckCharacters = $true
    $settings.MaxCharactersInDocument = $maxBytes
    $settings.CloseInput = $true
    $memory = [IO.MemoryStream]::new($bytes, $false)
    $reader = [Xml.XmlReader]::Create($memory, $settings)
    $stack = [Collections.Generic.List[string]]::new()
    $suites = [Collections.Generic.List[object]]::new()
    $suite = $null
    $case = $null
    $suiteProperties = $false
    $caseProperties = $false
    $failureText = $null
    $failureBytes = 0
    $caseCount = 0
    $rootSeen = $false
    while ($reader.Read()) {
        if ($reader.Depth -ge 16) { throw 'JUnit exceeds the depth limit of 16.' }
        $parent = if ($stack.Count) { $stack[$stack.Count - 1] } else { '' }
        switch ($reader.NodeType) {
            ([Xml.XmlNodeType]::XmlDeclaration) {
                $encoding = $reader.GetAttribute('encoding')
                if ($encoding -and $encoding -ine 'utf-8') { throw 'JUnit must declare UTF-8 when an encoding is specified.' }
            }
            ([Xml.XmlNodeType]::Element) {
                $name = $reader.Name
                if ($reader.NamespaceURI -or $reader.Prefix) { throw 'JUnit namespaces are not supported by this native format.' }
                $valid = switch -CaseSensitive ($parent) {
                    '' { $name -ceq 'testsuites' -and -not $rootSeen }
                    'testsuites' { $name -ceq 'testsuite' }
                    'testsuite' { $name -cin @('testcase', 'properties') }
                    'testcase' { $name -cin @('failure', 'properties') }
                    'properties' { $name -ceq 'property' }
                    default { $false }
                }
                if (-not $valid) { throw ('Unexpected JUnit element: ' + $name + ' under ' + $parent) }
                switch -CaseSensitive ($name) {
                    'testsuites' { Assert-JUnitAttributes $reader @(); $rootSeen = $true }
                    'testsuite' {
                        Assert-JUnitAttributes $reader @('name', 'device', 'tests', 'failures', 'time', 'timestamp')
                        $suite = [ordered]@{ name = $reader.GetAttribute('name'); tests = (Get-JUnitCount $reader 'tests')
                            failures = (Get-JUnitCount $reader 'failures'); testCases = [Collections.Generic.List[object]]::new() }
                        $suites.Add($suite)
                        $suiteProperties = $false
                    }
                    'testcase' {
                        Assert-JUnitAttributes $reader @('name', 'file', 'id', 'classname', 'status', 'time', 'timestamp')
                        $caseCount++
                        if ($caseCount -gt 10000) { throw 'JUnit exceeds 10000 test cases.' }
                        $case = [ordered]@{ name = $reader.GetAttribute('name'); file = $reader.GetAttribute('file')
                            id = $reader.GetAttribute('id'); classname = $reader.GetAttribute('classname'); status = $reader.GetAttribute('status')
                            failureCount = 0; failureText = $null }
                        $suite.testCases.Add($case)
                        $caseProperties = $false
                    }
                    'properties' {
                        Assert-JUnitAttributes $reader @()
                        if ($parent -ceq 'testsuite') {
                            if ($suiteProperties) { throw 'Duplicate suite properties element.' }
                            $suiteProperties = $true
                        } else {
                            if ($caseProperties) { throw 'Duplicate testcase properties element.' }
                            $caseProperties = $true
                        }
                    }
                    'property' {
                        Assert-JUnitAttributes $reader @('name', 'value')
                        if ($null -eq $reader.GetAttribute('name') -or $null -eq $reader.GetAttribute('value')) {
                            throw 'JUnit properties require name and value attributes.'
                        }
                    }
                    'failure' {
                        Assert-JUnitAttributes $reader @()
                        $case.failureCount++
                        if ($case.failureCount -gt 1) { throw 'Duplicate testcase failure element.' }
                        $failureText = [Text.StringBuilder]::new()
                        $failureBytes = 0
                        $case.failureText = ''
                    }
                }
                if (-not $reader.IsEmptyElement) { $stack.Add($name) }
                elseif ($name -ceq 'testcase') { $case = $null }
                elseif ($name -ceq 'testsuite') { $suite = $null }
            }
            ([Xml.XmlNodeType]::EndElement) {
                $name = $reader.Name
                if (-not $stack.Count -or $parent -cne $name) { throw 'Unbalanced JUnit structure.' }
                if ($name -ceq 'failure') { $case.failureText = $failureText.ToString(); $failureText = $null }
                elseif ($name -ceq 'testcase') { $case = $null }
                elseif ($name -ceq 'testsuite') { $suite = $null }
                $stack.RemoveAt($stack.Count - 1)
            }
            { $_ -in @([Xml.XmlNodeType]::Text, [Xml.XmlNodeType]::CDATA, [Xml.XmlNodeType]::Whitespace, [Xml.XmlNodeType]::SignificantWhitespace) } {
                $size = $utf8.GetByteCount($reader.Value)
                if ($size -gt $maxTextBytes) { throw 'JUnit text exceeds 1 MiB.' }
                if ($parent -ceq 'failure') {
                    $failureBytes += $size
                    if ($failureBytes -gt $maxTextBytes) { throw 'JUnit failure text exceeds 1 MiB.' }
                    $null = $failureText.Append($reader.Value)
                } elseif (-not [string]::IsNullOrWhiteSpace($reader.Value)) { throw 'Unexpected text outside a JUnit failure.' }
            }
            ([Xml.XmlNodeType]::Comment) {
                if ($utf8.GetByteCount($reader.Value) -gt $maxTextBytes) { throw 'JUnit comment exceeds 1 MiB.' }
            }
            default { throw ('Unsupported JUnit XML node: ' + $reader.NodeType) }
        }
    }
    if (-not $rootSeen -or $stack.Count) { throw 'JUnit has no complete testsuites root.' }
    $reader.Dispose(); $reader = $null
    $after = Assert-JUnitPath $absolute
    if ($after.Length -ne $beforeSize -or $after.LastWriteTimeUtc.Ticks -ne $beforeWrite) { throw 'JUnit changed during parsing.' }
    $confirmation = [IO.File]::Open($absolute, [IO.FileMode]::Open, [IO.FileAccess]::Read, [IO.FileShare]::Read)
    try { $afterBytes = Read-JUnitBytes $confirmation } finally { $confirmation.Dispose() }
    if ($afterBytes.Length -ne $beforeSize -or (Get-JUnitHash $afterBytes) -cne $digest) { throw 'JUnit bytes changed during parsing.' }
    $final = Assert-JUnitPath $absolute
    if ($final.Length -ne $beforeSize -or $final.LastWriteTimeUtc.Ticks -ne $beforeWrite) { throw 'JUnit changed during final verification.' }
    $result = [ordered]@{ schemaVersion = 1; sourcePath = $absolute; sha256 = $digest; sizeBytes = $beforeSize; suites = $suites.ToArray() }
    [Console]::Out.WriteLine(($result | ConvertTo-Json -Depth 12 -Compress))
} catch {
    [Console]::Error.WriteLine($_.Exception.Message)
    exit 1
} finally {
    if ($null -ne $reader) { $reader.Dispose() }
    if ($null -ne $memory) { $memory.Dispose() }
    if ($null -ne $source) { $source.Dispose() }
}
