$ErrorActionPreference = "Stop"

$root = "D:\bayt-windows-capture-soak"
$env:PYTHONPATH = "$root\source"
$env:BAYT_VALIDATION_OUTPUT = "$root\runtime\evidence"
$env:BAYT_HMAC_KEY_FILE = "$root\runtime\secrets\hmac.key"

& "$root\venv\Scripts\mitmdump.exe" `
  --listen-host 127.0.0.1 `
  --listen-port 18080 `
  --set "confdir=$root\runtime\mitm-conf" `
  --set block_global=false `
  --set termlog_verbosity=error `
  --set flow_detail=0 `
  -s "$root\source\mitm_addon.py"
