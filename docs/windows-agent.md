# Windows Agent 部署

Windows Agent 连接控制面，领取串行任务并使用本机官方 Chrome 完成授权范围内的采集。浏览器登录状态、配置令牌和私钥仅保存在目标机器，不进入源码仓库。

将 `deploy/windows-agent/agent.env.example.ps1` 复制到目标机器的 Agent 目录，在本机填写控制面 HTTPS 地址、CA、SFTP 连接和密钥路径。使用 `Install-BaytWindowsAgent.ps1` 安装或更新计划任务。

登录失效、验证码、401、403、429、额度或升级提示、文件映射不明及 ZIP 校验失败都会暂停队列。操作员确认原因后再恢复任务。
