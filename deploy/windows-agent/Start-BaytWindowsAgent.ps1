$ErrorActionPreference = "Stop"

$agentRoot = "D:\bayt\agent"
$configPath = Join-Path $agentRoot "agent.env.ps1"
$logRoot = Join-Path $agentRoot "logs"

if (-not (Test-Path -LiteralPath $configPath -PathType Leaf)) {
  throw "Missing Windows Agent config: $configPath"
}

. $configPath

$required = @(
  "BAYT_CONTROL_PLANE_URL",
  "BAYT_CONTROL_PLANE_TOKEN",
  "NODE_EXTRA_CA_CERTS",
  "BAYT_SFTP_HOST",
  "BAYT_SFTP_USER",
  "BAYT_SFTP_IDENTITY_FILE",
  "BAYT_SFTP_KNOWN_HOSTS_FILE"
)
foreach ($name in $required) {
  if (-not [Environment]::GetEnvironmentVariable($name, "Process")) {
    throw "Missing required setting: $name"
  }
}

$env:BAYT_WINDOWS_DATA_ROOT = "D:\bayt"
$env:BAYT_BROWSER_PROFILE_DIR = "D:\bayt\profile"
$env:BAYT_WINDOWS_CDP_ENDPOINT = "http://127.0.0.1:19229"
$env:BAYT_WINDOWS_AGENT_ID = "windows-agent"
$env:BAYT_WINDOWS_AGENT_NAME = "Windows采集节点"
$env:BAYT_SFTP_REMOTE_ROOT = "/opt/bayt-intelligence/data/incoming"

$nodePath = if ($env:BAYT_NODE_PATH) { $env:BAYT_NODE_PATH } else { "node.exe" }
$collectorRoot = Join-Path $agentRoot "collector"
$runStamp = Get-Date -Format "yyyyMMdd-HHmmss"
$logPath = Join-Path $logRoot ("agent-{0}.log" -f $runStamp)
$errorLogPath = Join-Path $logRoot ("agent-{0}.stderr.log" -f $runStamp)

New-Item -ItemType Directory -Path $logRoot -Force | Out-Null
$process = Start-Process `
  -FilePath $nodePath `
  -ArgumentList @("--experimental-strip-types", "src\windows-agent.ts") `
  -WorkingDirectory $collectorRoot `
  -NoNewWindow `
  -RedirectStandardOutput $logPath `
  -RedirectStandardError $errorLogPath `
  -PassThru `
  -Wait

exit $process.ExitCode
