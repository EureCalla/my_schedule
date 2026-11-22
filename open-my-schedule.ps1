$ErrorActionPreference = 'Stop'

$entry = Join-Path $PSScriptRoot 'main.py'

function Get-ListenerIds {
    $connections = netstat.exe -ano -p tcp
    if ($LASTEXITCODE -ne 0) {
        throw 'Unable to list TCP listeners.'
    }
    foreach ($line in $connections) {
        if ($line -match "^\s*TCP\s+\S+:${port}\s+\S+\s+LISTENING\s+(\d+)\s*$") {
            [int]$Matches[1]
        }
    }
}

function Test-ScheduleServer {
    try {
        $status = Invoke-RestMethod -Uri "$url/api/init" -TimeoutSec 2
        if ($status.initialized -isnot [bool]) {
            return $false
        }
        $script = Invoke-WebRequest -UseBasicParsing -Uri "$url/init.js" -TimeoutSec 2
        return $script.Content -match "fetch\('/api/init'\)" -and
               $script.Content -match "sheets\.html"
    } catch {
        return $false
    }
}

if (-not (Test-Path -LiteralPath $entry -PathType Leaf)) {
    throw "Missing server entry point: $entry"
}
$python = (Get-Command python.exe -CommandType Application).Source | Select-Object -First 1
$portConfig = Join-Path $PSScriptRoot 'server_port.py'
$portValue = & $python $portConfig
$port = 0
if ($LASTEXITCODE -ne 0 -or -not [int]::TryParse($portValue, [ref]$port) -or $port -lt 1 -or $port -gt 65535) {
    throw "Invalid port in $portConfig."
}
$url = "http://127.0.0.1:$port"

$listenerIds = @(Get-ListenerIds | Sort-Object -Unique)
if ($listenerIds.Count -gt 0) {
    $listener = Get-Process -Id $listenerIds -ErrorAction SilentlyContinue
    if ($listenerIds.Count -ne 1 -or $listener.ProcessName -notmatch '^python[\d.]*$' -or
        -not (Test-ScheduleServer)) {
        throw "Port $port is in use by an unrecognized process (PID $($listenerIds -join ', '))."
    }

    if ((Get-ListenerIds) -contains $listener.Id -and -not $listener.HasExited) {
        Write-Host "Restarting my_schedule (PID $($listener.Id))..."
        Stop-Process -InputObject $listener -Force
        [void]$listener.WaitForExit(5000)
    }
    if (Get-ListenerIds) {
        throw "Port $port is still in use."
    }
}

$server = Start-Process -FilePath $python -ArgumentList @('-X', 'utf8', ('"' + $entry + '"')) `
    -WorkingDirectory $PSScriptRoot -WindowStyle Hidden -PassThru
$deadline = (Get-Date).AddSeconds(20)
do {
    if ($server.HasExited) {
        throw "my_schedule exited during startup (exit code $($server.ExitCode)). Run python main.py for details."
    }
    if ((Get-ListenerIds) -contains $server.Id -and (Test-ScheduleServer)) {
        Start-Process "$url/"
        exit 0
    }
    Start-Sleep -Milliseconds 300
} while ((Get-Date) -lt $deadline)

throw "my_schedule did not respond at $url within 20 seconds. Check server PID $($server.Id)."
