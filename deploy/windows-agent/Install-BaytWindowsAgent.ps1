param(
  [Parameter(Mandatory = $true)]
  [string]$SourceRoot
)

$ErrorActionPreference = "Stop"
$agentRoot = "D:\bayt\agent"
$collectorTarget = Join-Path $agentRoot "collector"
$taskName = "Bayt-Windows-Agent"

if (-not (Test-Path -LiteralPath "D:\bayt\profile" -PathType Container)) {
  throw "Bayt Chrome profile does not exist at D:\bayt\profile"
}
if (-not (Test-Path -LiteralPath (Join-Path $SourceRoot "collector\package.json") -PathType Leaf)) {
  throw "SourceRoot does not contain the collector package"
}
if (-not (Test-Path -LiteralPath (Join-Path $agentRoot "agent.env.ps1") -PathType Leaf)) {
  throw "Create D:\bayt\agent\agent.env.ps1 before installing the Agent"
}
. (Join-Path $agentRoot "agent.env.ps1")
$nodePath = if ($env:BAYT_NODE_PATH) { $env:BAYT_NODE_PATH } else { "node.exe" }
$npmPath = Join-Path (Split-Path -Parent $nodePath) "npm.cmd"
if (-not (Test-Path -LiteralPath $nodePath -PathType Leaf)) {
  throw "Configured Node executable does not exist: $nodePath"
}
if (-not (Test-Path -LiteralPath $npmPath -PathType Leaf)) {
  throw "npm.cmd does not exist beside the configured Node executable: $npmPath"
}
& icacls.exe (Join-Path $agentRoot "agent.env.ps1") /inheritance:r /grant:r "SYSTEM:(F)" "Administrators:(F)" | Out-Null

New-Item -ItemType Directory -Path $collectorTarget -Force | Out-Null
Copy-Item -LiteralPath (Join-Path $SourceRoot "collector\package.json") -Destination $collectorTarget -Force
Copy-Item -LiteralPath (Join-Path $SourceRoot "collector\package-lock.json") -Destination $collectorTarget -Force
Copy-Item -LiteralPath (Join-Path $SourceRoot "collector\src") -Destination $collectorTarget -Recurse -Force
Copy-Item -LiteralPath (Join-Path $SourceRoot "collector\scripts") -Destination $collectorTarget -Recurse -Force
Copy-Item -LiteralPath (Join-Path $SourceRoot "deploy\windows-agent\Start-BaytWindowsAgent.ps1") -Destination $agentRoot -Force

Push-Location $collectorTarget
try {
  & $npmPath ci --omit=dev
  if ($LASTEXITCODE -ne 0) { throw "npm ci failed with exit code $LASTEXITCODE" }
} finally {
  Pop-Location
}

$action = New-ScheduledTaskAction -Execute "powershell.exe" -Argument '-NoProfile -ExecutionPolicy Bypass -File "D:\bayt\agent\Start-BaytWindowsAgent.ps1"'
$trigger = New-ScheduledTaskTrigger -AtStartup
$settings = New-ScheduledTaskSettingsSet -RestartCount 3 -RestartInterval (New-TimeSpan -Minutes 5) -ExecutionTimeLimit ([TimeSpan]::Zero) -MultipleInstances IgnoreNew
$principal = New-ScheduledTaskPrincipal -UserId "SYSTEM" -LogonType ServiceAccount -RunLevel Highest

Register-ScheduledTask -TaskName $taskName -Action $action -Trigger $trigger -Settings $settings -Principal $principal -Force | Out-Null
Start-ScheduledTask -TaskName $taskName
Write-Output "installed_task=$taskName"
Write-Output "agent_root=$agentRoot"
