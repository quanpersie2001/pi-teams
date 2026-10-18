param([Parameter(Mandatory=$true)][string]$PipeName)
$ErrorActionPreference = 'Stop'
if ($PSVersionTable.PSVersion.Major -lt 7 -or [Enum]::GetNames([IO.Pipes.PipeOptions]) -notcontains 'CurrentUserOnly') {
  [Console]::Error.WriteLine('Windows peer ingress requires pwsh.exe (PowerShell 7+) with .NET PipeOptions.CurrentUserOnly support.')
  exit 3
}
$pipeOptions = [Enum]::Parse([IO.Pipes.PipeOptions], 'CurrentUserOnly, Asynchronous', $false)
if ($PipeName -notmatch '^pi-teams-peer-[a-f0-9-]{36}$') { exit 2 }
$server = $null
$stage = 'initialize'
try {
  [Console]::InputEncoding = [Text.UTF8Encoding]::new($false)
  [Console]::OutputEncoding = [Text.UTF8Encoding]::new($false)
  $stdin = [Console]::In
  $stdout = [Console]::Out
  while ($true) {
    # Publish READY only after Windows successfully creates the secure listener instance.
    $stage = 'create-listener'
    $server = [IO.Pipes.NamedPipeServerStream]::new($PipeName, [IO.Pipes.PipeDirection]::InOut, 1, [IO.Pipes.PipeTransmissionMode]::Byte, $pipeOptions)
    if (-not $script:readySent) { $stdout.WriteLine('READY'); $stdout.Flush(); $script:readySent = $true }
    $stage = 'wait-for-client'
    $server.WaitForConnection()
    $stage = 'read-frame'
    $frame = [IO.MemoryStream]::new()
    $readBuffer = [byte[]]::new(1)
    $readDeadline = [Threading.CancellationTokenSource]::new(10000)
    try {
      while ($true) {
        # PipeStream.ReadTimeout is unsupported; use the asynchronous, cancellation-aware overload.
        $readTask = $server.ReadAsync($readBuffer, [int]0, [int]1, [Threading.CancellationToken]$readDeadline.Token)
        $bytesRead = $readTask.GetAwaiter().GetResult()
        if ($bytesRead -eq 0) { throw 'unexpected-end-of-frame' }
        $b = $readBuffer[0]
        if ($b -eq 10) { break }
        if ($frame.Length -ge 24576) { throw 'frame-too-large' }
        $frame.WriteByte([byte]$b)
      }
      $line = [Text.UTF8Encoding]::new($false, $true).GetString($frame.ToArray())
    } finally {
      $readDeadline.Dispose()
      $frame.Dispose()
    }
    $stage = 'forward-frame'
    $stdout.WriteLine($line)
    $stdout.Flush()
    $stage = 'wait-for-node-response'
    $readTask = [Console]::In.ReadLineAsync()
    if (-not $readTask.Wait(15000)) { throw 'node-response-timeout' }
    $response = $readTask.Result
    if ($null -eq $response) { break }
    $stage = 'write-response'
    $writer = [IO.StreamWriter]::new($server, [Text.UTF8Encoding]::new($false), 4096, $true)
    $writer.AutoFlush = $true
    $writer.WriteLine($response)
    $writer.Dispose()
    $server.Dispose()
    $server = $null
  }
} catch {
  [Console]::Error.WriteLine(([pscustomobject]@{ stage=$stage; reason=$_.Exception.Message; exception=$_.Exception.GetType().FullName; psVersion=$PSVersionTable.PSVersion.ToString() } | ConvertTo-Json -Compress))
  exit 1
}
finally { if ($null -ne $server) { $server.Dispose() } }
