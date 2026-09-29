# Copy this file to D:\bayt\agent\agent.env.ps1 and replace placeholders locally.
# Do not commit or send the real token, private-key path, or CA material through chat.
$env:BAYT_CONTROL_PLANE_URL = "https://collector.example.com"
$env:BAYT_CONTROL_PLANE_TOKEN = "replace-with-32-character-or-longer-agent-token"
$env:NODE_EXTRA_CA_CERTS = "D:\bayt\secrets\bayt-edge-ca.pem"
$env:BAYT_SFTP_HOST = "collector.example.com"
$env:BAYT_SFTP_PORT = "22"
$env:BAYT_SFTP_USER = "collector-sftp"
$env:BAYT_SFTP_IDENTITY_FILE = "D:\bayt\secrets\id_ed25519"
$env:BAYT_SFTP_KNOWN_HOSTS_FILE = "D:\bayt\secrets\known_hosts"
$env:BAYT_NODE_PATH = "D:\bayt\agent\node\node.exe"
$env:BAYT_WINDOWS_CDP_ENDPOINT = "http://127.0.0.1:19229"
$env:BAYT_WINDOWS_LOGIN_CHECK_INTERVAL_MS = "600000"
