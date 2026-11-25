# Stops the Agente server started by start.bat (or by the "Agente"
# scheduled task). Run it through stop.bat.

$ErrorActionPreference = 'SilentlyContinue'

# Use the same port as start.bat.
$port = 8000
$setting = Select-String -Path (Join-Path $PSScriptRoot 'start.bat') -Pattern 'set "PORT=(\d+)"'

if ($setting) {
    $port = [int]$setting.Matches[0].Groups[1].Value
}

$stopped = 0

foreach ($listener in Get-NetTCPConnection -LocalPort $port -State Listen) {
    $process = Get-CimInstance Win32_Process -Filter "ProcessId=$($listener.OwningProcess)"

    # Only stop this app's uvicorn server, never anything else on the port.
    if (-not $process -or $process.CommandLine -notmatch 'uvicorn\s+main:app') {
        continue
    }

    # The venv's python.exe is a small launcher that starts the real
    # server as a child, so stop the launcher too.
    $parent = Get-CimInstance Win32_Process -Filter "ProcessId=$($process.ParentProcessId)"

    Stop-Process -Id $process.ProcessId -Force
    $stopped++

    if ($parent -and $parent.CommandLine -match 'uvicorn\s+main:app') {
        Stop-Process -Id $parent.ProcessId -Force
    }
}

# Close the start.bat window if the scheduled task opened it.
schtasks /end /tn Agente *> $null

if ($stopped -gt 0) {
    Write-Output "Agente stopped (port $port)."
} else {
    Write-Output "Agente is not running (nothing on port $port)."
}
