param(
    [Parameter(Mandatory=$true)][string]$ProjectRoot,
    [ValidateSet('Serial', 'Simulation')][string]$Mode = 'Serial',
    [string]$Port = 'COM17'
)
$ErrorActionPreference = 'Stop'
if ($Mode -eq 'Serial' -and $Port -notmatch '^COM[1-9][0-9]*$') {
    throw 'Port must be a COM name such as COM17.'
}
$node = (Get-Command node.exe -ErrorAction Stop).Source
# Argument values have no whitespace; the project path goes through WorkingDirectory.
$launchArgs = @('dist/apps/rig-launch.js', '--endpoint', '\\.\pipe\cwstation-rig-status', '--history', 'logs/rig-status-history.jsonl')
if ($Mode -eq 'Simulation') { $launchArgs += '--simulate' }
else { $launchArgs += @('--port', $Port, '--baud', '19200', '--confirm-keying-off') }
$hostProcess = Start-Process -FilePath $node -WorkingDirectory $ProjectRoot -ArgumentList $launchArgs -Wait -PassThru
exit $hostProcess.ExitCode
