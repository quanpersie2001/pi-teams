param([Parameter(Mandatory=$true)][string]$PipeName)
$ErrorActionPreference = 'Stop'
if ($PSVersionTable.PSVersion.Major -lt 7 -or [Enum]::GetNames([IO.Pipes.PipeOptions]) -notcontains 'CurrentUserOnly') {
  [Console]::Error.WriteLine('Windows peer ingress requires pwsh.exe (PowerShell 7+) with .NET PipeOptions.CurrentUserOnly support.')
  exit 3
}
$pipeOptions = [Enum]::Parse([IO.Pipes.PipeOptions], 'CurrentUserOnly', $false)
if ($PipeName -notmatch '^pi-teams-peer-[a-f0-9-]{36}$') { exit 2 }
$server = $null
try {
  [Console]::InputEncoding = [Text.UTF8Encoding]::new($false)
  [Console]::OutputEncoding = [Text.UTF8Encoding]::new($false)
  $stdin = [Console]::In
  $stdout = [Console]::Out
  while ($true) {
    # Publish READY only after Windows successfully creates the secure listener instance.
    $server = [IO.Pipes.NamedPipeServerStream]::new($PipeName, [IO.Pipes.PipeDirection]::InOut, 1, [IO.Pipes.PipeTransmissionMode]::Byte, $pipeOptions)
    if (-not $script:readySent) { $stdout.WriteLine('READY'); $stdout.Flush(); $script:readySent = $true }
    $server.WaitForConnection()
    $server.ReadTimeout = 10000
    $frame = [IO.MemoryStream]::new()
    try {
      while (($b = $server.ReadByte()) -ge 0 -and $b -ne 10) {
        if ($frame.Length -ge 24576) { throw 'frame-too-large' }
        $frame.WriteByte([byte]$b)
      }
      $line = [Text.UTF8Encoding]::new($false, $true).GetString($frame.ToArray())
    } finally { $frame.Dispose() }
    $stdout.WriteLine($line)
    $stdout.Flush()
    $readTask = [Console]::In.ReadLineAsync()
    if (-not $readTask.Wait(15000)) { throw 'node-response-timeout' }
    $response = $readTask.Result
    if ($null -eq $response) { break }
    $writer = [IO.StreamWriter]::new($server, [Text.UTF8Encoding]::new($false), 4096, $true)
    $writer.AutoFlush = $true
    $writer.WriteLine($response)
    $writer.Dispose()
    $server.Dispose()
    $server = $null
  }
} catch { [Console]::Error.WriteLine($_.Exception.Message); exit 1 }
finally { if ($null -ne $server) { $server.Dispose() } }
