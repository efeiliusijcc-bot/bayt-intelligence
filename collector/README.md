# Bayt CV Collector

本地、可恢复的Bayt企业CV采集器。以 `CV_ID` 为唯一主键，将官方Excel导出、Bayt标准PDF、候选人原始附件、转换后的PDF副本和头像对应保存。

## 安全边界

- 只使用已登录企业账号当前具备的权限。
- 不点击联系方式揭示，不购买新额度。
- 遇到登录失效、验证码、限流、购买或升级页面立即暂停。
- 打开候选人详情可能在Bayt中留下 `Viewed` 记录。
- 数据仅保存在工作区 `../data/`，目录权限为当前用户可访问。
- 生产Worker固定使用校验过SHA-256的Google官方Chrome；官方浏览器启动失败时默认中止，不能静默回退到Playwright Chromium。
- 人工登录先打开Bayt公开首页，再进入企业登录页；登录前不会直接请求简历搜索页。

## 命令

```bash
npm run login
npm run preflight
npm run collect -- --target 500
npm run resume
npm run verify
npm run import-staging -- /absolute/path/to/ego-staging run-id search-id
```

默认搜索词为 `Software Engineer`。采集器先尝试“最近6个月更新”筛选；结果不足目标数量时自动取消该筛选。`collect` 的首批固定为10人，只有整批Excel和附件映射均成功后才继续扩大。

## 输出

```text
../data/
├── collection.db
├── browser-profile/
├── runs/{run_id}/
│   ├── manifest.csv
│   ├── manifest.jsonl
│   ├── verification_report.md
│   └── batches/{batch_no}/source.xls
└── candidates/{cv_id}/
    ├── bayt-cv.pdf
    ├── original.{ext}
    ├── original-converted.pdf
    ├── avatar.{ext}
    └── manifest.json
```

原始附件不存在时记录 `not_available`；真实头像会保存，Bayt默认占位图只记录状态而不保存文件。

当普通Playwright被站点安全页拦截、但已授权的人工登录会话可正常访问时，浏览器阶段使用
`ego-browser` 生成暂存批次，再用 `import-staging` 做CV_ID核对、正式归档、Office转PDF、
SQLite检查点、SHA-256、manifest和验收报告。导入前必须已完成安全检查，且不能包含联系方式揭示或购买操作。

分页暂存命令使用文件队列和逐人 `result.json` 检查点：

```bash
./scripts/collect-page.sh TASK_SPACE_ID PAGE_NO STAGING_ROOT REUSE_ROOT 20 120
```

最后两个参数是个人详情和批量导出的固定最低间隔（秒），默认分别为20秒和120秒。
这些是保守工程配置，不代表Bayt公布的官方阈值。检测到账号高搜索活动时写入
`runtime-state.json` 的 `rate_limited` 状态及5/15/60分钟退避时间，但不会自动恢复；
到期后仍需人工确认 `continue`。不隐藏浏览器自动化特征、不模拟真人行为、不切换代理或IP绕过限制。
