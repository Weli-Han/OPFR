# OPFR runner: keeps the PC awake and keeps the dispatcher alive until the project
# is finished (.opfr/DONE) or stopped (.opfr/STOP). Started by `opfr.js start`.
param([Parameter(Mandatory = $true)][string]$Project, [int]$MaxRestarts = 30)

$ErrorActionPreference = 'Continue'
$opfr = Join-Path $Project '.opfr'
$log = Join-Path $opfr 'runner.log'
$dispatcher = Join-Path (Split-Path $PSScriptRoot -Parent) 'dispatcher\dispatcher.js'
function Log($m) { Add-Content -Path $log -Value ("{0} {1}" -f (Get-Date -Format s), $m) -Encoding utf8 }

Add-Type -Namespace OPFR -Name Power -MemberDefinition '[DllImport("kernel32.dll")] public static extern uint SetThreadExecutionState(uint esFlags);'
# ES_CONTINUOUS | ES_SYSTEM_REQUIRED: no sleep while this process runs; display may turn off.
[void][OPFR.Power]::SetThreadExecutionState([uint32]2147483649)
Log "runner start pid $PID, keep-awake on"

$node = (Get-Command node -ErrorAction SilentlyContinue).Source
if (-not $node) { Log 'node not found on PATH'; exit 1 }
$cli = Join-Path (Split-Path $PSScriptRoot -Parent) 'dispatcher\opfr.js'
# Login entry so an unfinished project resumes after a reboot or sign-out.
Log (& $node $cli autostart auto 2>&1)
# Each project gets its own office site on its own port (reused if already up).
Log (& $node $cli office $Project 2>&1)

$restarts = 0
while (-not (Test-Path (Join-Path $opfr 'DONE')) -and -not (Test-Path (Join-Path $opfr 'STOP'))) {
  & $node $dispatcher $Project *>> (Join-Path $opfr 'dispatcher.out')
  $code = $LASTEXITCODE
  if ((Test-Path (Join-Path $opfr 'DONE')) -or (Test-Path (Join-Path $opfr 'STOP'))) { break }
  $restarts++
  Log "dispatcher exited code $code, restart $restarts/$MaxRestarts"
  if ($restarts -ge $MaxRestarts) { Log 'too many restarts, giving up'; break }
  Start-Sleep -Seconds 15
}

Log (& $node $cli autostart auto 2>&1)
[void][OPFR.Power]::SetThreadExecutionState([uint32]2147483648)
Log 'runner end, keep-awake off'
