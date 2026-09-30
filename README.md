# Bayt Intelligence

Bayt Intelligence 是本地优先的候选人资料、附件与导入批次查看平台。界面采用简约政企风，使用 React、Fluent UI、Express 和 SQLite。

## 当前范围

已经实现：

- 总览、人物库卡片/表格、搜索、筛选、排序和分页；
- 人物详情、真实头像、Bayt PDF、原始附件和转换版 PDF；
- 5 分钟附件访问令牌及预览/下载审计；
- Excel 与 ZIP 上传预检、CV_ID 精确匹配和提交导入；
- 本站单账号登录页与最长 7 天的浏览器会话，不再使用 Basic Auth 弹窗；
- 采集任务模板、高级筛选、串行队列、调序与暂停恢复；
- 本机 Ego 队列 Agent 执行官方页面搜索，完成整页 XLS/PDF 校验后由独立进程上传；接收端校验入库后提供任务简历复核与人物来源链接；
- 登录失效、403/Cloudflare、429 或文件证据不一致时安全暂停并保留检查点；
- 浏览器级HAR记录、脱敏摘要、24小时原始包清理和已验收快照发布；
- 确定性职业评分、透明分项解释和可调整的研究门槛；
- 只有达标人物才进入 Tavily，单批最多30人且后续批次跳过已完成人物；
- 一个A级或两个独立B级来源自动核验，复杂冲突才调用一次 DeepSeek；
- 7天查询缓存、401/403/429立即暂停以及极少量异常人工复核。

评分规则不使用国籍、年龄、性别等敏感属性。未配置 Tavily 时仍可完成本地评分，但不会生成模拟查询、来源或身份结论；未配置 DeepSeek 时确定性评分和来源核验仍可正常工作。

## 评分与公开研究

默认职业分为100分：职位相关度25、技能匹配30、工作经验20、职业资料完整度15、更新时间10。默认70分进入研究队列，单次最多搜索30人。

```text
人物入库
→ 确定性职业评分
→ 未达门槛：停止，不调用Tavily
→ 达到门槛：Tavily公开搜索
→ A级来源1个或独立B级来源2个：自动核验
→ 多个可疑同名来源：DeepSeek单次裁决
→ 裁决后仍冲突：人工复核
```

完整CV、PDF、电话、邮箱和薪资不会发送给 Tavily 或 DeepSeek。DeepSeek 只接收最小身份包与最多5条压缩证据，模型也不能凭不存在或不足的证据自动通过。

## 本地运行

环境要求：Node.js 22.18 或更高版本。

```bash
npm ci
npm run check
npm run dev
```

开发地址为 `http://127.0.0.1:4173`，API 服务为 `http://127.0.0.1:4180`。生产构建可使用：

```bash
npm run build
APP_USER=admin \
APP_PASSWORD='replace-with-a-long-random-password' \
PREVIEW_SECRET='replace-with-at-least-32-random-characters' \
COLLECTOR_AGENT_TOKEN='replace-with-at-least-32-random-characters' \
APP_PUBLIC_ORIGIN='https://app.example.invalid' \
npm start
```

如需启用公开研究，在生产环境单独配置：

```text
TAVILY_API_KEY=...
DEEPSEEK_API_KEY=...
DEEPSEEK_MODEL=...
```

密钥不得写入仓库、日志或聊天。`RESEARCH_AUTO_RUN=0` 为默认值；建议先在研究页确认门槛和达标人数，再决定是否启用导入后自动研究。

## Docker 部署

1. 创建生产配置：

```bash
cp .env.example .env
openssl rand -hex 32
```

把生成值分别写入 `.env` 的 `PREVIEW_SECRET`、`COLLECTOR_API_TOKEN` 和 `COLLECTOR_AGENT_TOKEN`，设置独立的应用管理员密码，并将 `APP_PUBLIC_ORIGIN` 设为实际 HTTPS 入口的完整 origin。采集控制操作使用本站会话；本机 Agent 使用独立长令牌。`.env` 已被忽略，不能提交或通过聊天发送。

2. 空平台启动：

```bash
mkdir -p deployment-data/work deployment-data/published/releases
docker compose up -d --build
docker compose ps
curl http://127.0.0.1:4180/api/health
```

3. 使用已有采集数据时，在 `.env` 中把 `BAYT_DATA_DIR` 指向包含以下结构的目录：

```text
deployment-data/
├── work/                         # 采集器工作数据库和候选人文件
└── published/
    ├── current -> releases/{release_id}
    └── releases/{release_id}/
        ├── collection.db
        └── candidates/{cv_id}/...
```

数据库中历史绝对路径会按 `CV_ID + 文件名` 安全重定位。人物平台只读挂载 `published`，采集中的半成品不会进入人物库；验收通过后由Worker原子切换 `current`。

## 登录、采集队列与安全

- `/api/health` 不需要登录；人物、PDF 和管理 API 在生产模式下受本站会话保护。会话最长 7 天，退出或密码变更后失效；浏览器写操作还需要同源与 CSRF 校验。
- 生产入口使用 HTTPS。Compose 默认只绑定 `127.0.0.1:4180`；受信任的反向代理必须转发 Cookie。示例见 `deploy/edge-nginx.conf`。可选的域名入口示例在 `deploy/domain-caddy.Caddyfile` 和 `deploy/run-domain-edge.sh`，所有站点、上游、证书和 Docker 参数均须显式配置。
- 服务端只管理队列和接收完整批次；本机 Ego Agent 串行领取任务。目录过期、官网验证未完成或全局安全暂停时，任务可排队但不得执行。
- 完整页面经过 XLS、PDF、CV_ID、ZIP CRC 和哈希校验后独立上传；接收端再次校验并入库。上传成功不等于人物已展示，应分别核对接收状态和人物/PDF 绑定。
- 将真实密码、API 令牌、SSH 密钥和候选人资料保存在仓库外的受限目录；不要提交浏览器 Profile、HAR、Excel、PDF 或 ZIP。
- `.env.example` 只含占位值。复制为 `.env` 后，在本机填入独立的管理员密码和长度至少 32 位的密钥。

## 部署

使用 `docker compose up -d --build` 启动空平台。需要导入真实数据时，先在私有环境设置 `BAYT_DATA_DIR`，再按授权范围操作。

当前队列执行端位于 `collector/scripts/local-ego-queue.mjs`，上传进程位于 `collector/scripts/local-ego-upload.mjs`。在本机私有环境中配置 HTTPS 控制面、Agent 令牌、已授权 Ego 会话和 SFTP 参数；不要将这些值写入仓库。验证码、403/Cloudflare 和 429 不得绕过；先核对检查点、官网状态和上传回执，再由操作员恢复。旧 Windows Agent 示例仅供旧流程参考，不代表当前队列会派发到 Windows。

可在授权测试环境使用 `scripts/session-smoke.mjs` 检查会话、受保护接口与 PDF 预览；脚本要求显式提供 `AUTH_SMOKE_BASE`、`APP_PUBLIC_ORIGIN`、`APP_USER` 和 `APP_PASSWORD`，会产生登录/退出审计事件，不应无意指向生产环境。

本仓库不包含候选人数据、生产连接信息或历史采集验收记录。公开代码不代表已经完成任何生产环境的部署或采集验收。

## 验证

```bash
npm ci
npm run check
cd collector && npm ci && npm run check
```

依赖真实本地数据的验收测试只在明确配置私有样本时运行；其余测试可以在空工作区执行。
