import { useMemo, useState, type FormEvent } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Badge, Button, Checkbox, Input, ProgressBar } from "@fluentui/react-components";
import {
  Add24Regular, ArrowDown24Regular, ArrowSync24Regular, ArrowUp24Regular,
  CalendarClock24Regular, Copy24Regular, Delete24Regular, Dismiss24Regular,
  Edit24Regular, Pause24Regular, Play24Regular, Save24Regular, ShieldCheckmark24Regular,
} from "@fluentui/react-icons";
import { apiClient } from "../api";
import type {
  CollectionQueueJob, CollectorFilterCatalog, CollectorFilterSelection, CollectorLimits,
  CollectorSchedule, CollectorSearchSpec, CollectorSearchTemplate,
} from "../types";

import { collectorLabel, collectorReason } from "../collector-labels";

type SelectionMap = Record<string, CollectorFilterSelection>;
const activeStatuses = new Set(["running", "pause_requested"]);

export function CollectorPage() {
  const queryClient = useQueryClient();
  const catalogQuery = useQuery({ queryKey: ["collector-filter-catalog"], queryFn: apiClient.collectorFilterCatalog, refetchInterval: 30_000 });
  const templatesQuery = useQuery({ queryKey: ["collector-search-templates"], queryFn: apiClient.collectorSearchTemplates });
  const queueQuery = useQuery({ queryKey: ["collector-queue"], queryFn: apiClient.collectorQueue, refetchInterval: 15_000 });
  const schedulesQuery = useQuery({ queryKey: ["collector-schedules"], queryFn: apiClient.collectorSchedules, refetchInterval: 30_000 });
  const [templateName, setTemplateName] = useState("");
  const [keyword, setKeyword] = useState("");
  const [sortKey, setSortKey] = useState("");
  const [selections, setSelections] = useState<SelectionMap>({});
  const [editingId, setEditingId] = useState<string | null>(null);
  const [targetCount, setTargetCount] = useState("100");
  const [maxPages, setMaxPages] = useState("");
  const [durationHours, setDurationHours] = useState("");
  const [scheduleTemplate, setScheduleTemplate] = useState<CollectorSearchTemplate | null>(null);
  const [scheduleKind, setScheduleKind] = useState<CollectorSchedule["kind"]>("daily");
  const [scheduleTime, setScheduleTime] = useState("02:00");
  const [scheduleWeekday, setScheduleWeekday] = useState("1");
  const [scheduleRunAt, setScheduleRunAt] = useState("");
  const catalog = catalogQuery.data?.catalog || null;

  const refresh = async () => {
    await Promise.all([
      queryClient.invalidateQueries({ queryKey: ["collector-filter-catalog"] }),
      queryClient.invalidateQueries({ queryKey: ["collector-search-templates"] }),
      queryClient.invalidateQueries({ queryKey: ["collector-queue"] }),
      queryClient.invalidateQueries({ queryKey: ["collector-schedules"] }),
    ]);
  };
  const mutation = useMutation({ mutationFn: async (action: () => Promise<unknown>) => await action(), onSuccess: refresh });
  const limits = useMemo(() => buildLimits(targetCount, maxPages, durationHours), [targetCount, maxPages, durationHours]);
  const searchSpec = (): CollectorSearchSpec => ({
    keyword: keyword.trim(), filterSchemaVersion: catalog?.version || "",
    filters: Object.values(selections).filter(hasSelectionValue), sortKey: sortKey || null,
  });
  const resetEditor = () => {
    setEditingId(null); setTemplateName(""); setKeyword(""); setSortKey(""); setSelections({});
  };
  const editTemplate = (template: CollectorSearchTemplate) => {
    setEditingId(template.id); setTemplateName(template.name); setKeyword(template.searchSpec.keyword);
    setSortKey(template.searchSpec.sortKey || "");
    setSelections(Object.fromEntries(template.searchSpec.filters.map((selection) => [selection.key, selection])));
    window.scrollTo({ top: 0, behavior: "smooth" });
  };
  const saveTemplate = (event: FormEvent) => {
    event.preventDefault();
    const input = { name: templateName.trim(), searchSpec: searchSpec() };
    mutation.mutate(() => editingId
      ? apiClient.updateCollectorSearchTemplate(editingId, input)
      : apiClient.createCollectorSearchTemplate(input), { onSuccess: resetEditor });
  };
  const publish = (template: CollectorSearchTemplate) => {
    if (limits) mutation.mutate(() => apiClient.createCollectionJob({ templateId: template.id, name: template.name, limits }));
  };
  const createSchedule = (event: FormEvent) => {
    event.preventDefault();
    if (!scheduleTemplate || !limits) return;
    mutation.mutate(() => apiClient.createCollectorSchedule({
      name: `${scheduleTemplate.name} ${scheduleKind === "once" ? "单次" : scheduleKind === "daily" ? "每日" : "每周"}计划`,
      templateId: scheduleTemplate.id, kind: scheduleKind,
      localTime: scheduleKind === "once" ? undefined : scheduleTime,
      weekday: scheduleKind === "weekly" ? Number(scheduleWeekday) : undefined,
      runAt: scheduleKind === "once" ? new Date(scheduleRunAt).toISOString() : undefined,
      limits,
    }), { onSuccess: () => setScheduleTemplate(null) });
  };

  return <div className="page-stack collector-page">
    <div className="page-heading action-heading">
      <div><h1>采集任务</h1><p>控制面管理搜索模板和串行队列，Windows Agent使用官方Chrome执行Bayt搜索、翻页和整页导出。</p></div>
      <Badge appearance="outline" color={queueQuery.data?.control.globallyPaused ? "danger" : "success"}>{queueQuery.data?.control.globallyPaused ? "全队列安全暂停" : "串行队列正常"}</Badge>
    </div>

    <section className="collector-security-strip">
      <ShieldCheckmark24Regular aria-hidden="true" />
      <div><strong>管理员登录保护</strong><span>模板、任务和计划变更使用当前网站管理员身份；Bayt Cookie和令牌始终只保存在154。</span></div>
    </section>
    {queueQuery.data?.control.globallyPaused && <div className="inline-error" role="alert"><strong>{queueQuery.data.control.pauseCode || "安全停止"}</strong><span>{queueQuery.data.control.pauseMessage || "需要人工确认后恢复任务"}</span><span>发生于：{queueQuery.data.control.pausedAt ? new Date(queueQuery.data.control.pausedAt).toLocaleString("zh-CN", { timeZone: "Asia/Shanghai" }) : "未知"}（北京时间）。历史停止不会自动清除。</span></div>}
    {mutation.isError && <div className="inline-error" role="alert">{mutation.error.message}</div>}

    <section className="section-panel collector-editor">
      <div className="section-heading">
        <div><h2>搜索条件编辑器</h2><p>筛选条件由154登录Bayt后动态同步；目录外参数和不稳定控件不会下发给Agent。</p></div>
        <div className="collector-heading-actions">{catalog && <Badge appearance="outline">目录 {catalog.version.slice(-8)}</Badge>}<Button icon={<ArrowSync24Regular />} disabled={mutation.isPending} onClick={() => mutation.mutate(() => apiClient.syncCollectorFilterCatalog())}>同步官网筛选项</Button></div>
      </div>
      {catalogQuery.isPending ? <ProgressBar /> : catalogQuery.isError ? <div className="inline-error" role="alert">{catalogQuery.error.message}<Button size="small" onClick={() => catalogQuery.refetch()}>重试</Button></div> : !catalog ? <div className="collector-catalog-empty"><strong>尚未同步筛选目录</strong><span>请确认154官方Chrome已人工登录，再点击“同步官网筛选项”。</span></div> :
        <form onSubmit={saveTemplate}>
          <div className="collector-editor-primary">
            <label><span>模板名称</span><Input value={templateName} onChange={(_, data) => setTemplateName(data.value)} placeholder="例如：高级后端工程师" required /></label>
            <label><span>搜索关键词</span><Input value={keyword} onChange={(_, data) => setKeyword(data.value)} placeholder="可按任务自由变化" required /></label>
            <label><span>官网排序</span><select value={sortKey} onChange={(event) => setSortKey(event.target.value)}><option value="">官网默认排序</option>{catalog.sorts.map((sort) => <option key={sort.key} value={sort.key}>{collectorLabel(sort.label)}</option>)}</select></label>
          </div>
          <FilterEditor catalog={catalog} selections={selections} setSelections={setSelections} />
          <SelectedConditions catalog={catalog} selections={selections} sortKey={sortKey} />
          <div className="collector-editor-actions">{editingId && <Button icon={<Dismiss24Regular />} onClick={resetEditor}>取消编辑</Button>}<Button appearance="primary" icon={<Save24Regular />} type="submit" disabled={mutation.isPending || !keyword.trim() || !templateName.trim()}>{editingId ? "保存修改" : "保存模板"}</Button></div>
        </form>}
    </section>

    <section className="section-panel">
      <div className="section-heading collector-template-heading"><div><h2>搜索模板库</h2><p>立即发布时生成不可变条件快照；后续编辑模板不会改变已排队任务。</p></div><LimitsEditor targetCount={targetCount} maxPages={maxPages} durationHours={durationHours} setTargetCount={setTargetCount} setMaxPages={setMaxPages} setDurationHours={setDurationHours} /></div>
      <div className="collector-soft-limit">人数/页数任务保留每日500人上限；持续时长任务按整页完成，不限制人数，但429、验证码、登录和文件校验仍会安全停止。</div>
      {templatesQuery.isPending ? <ProgressBar /> : templatesQuery.isError ? <div className="inline-error">{templatesQuery.error.message}</div> : templatesQuery.data?.items.length ? <div className="collector-template-list">{templatesQuery.data.items.map((template) =>
        <TemplateCard key={template.id} template={template} catalog={catalog} disabled={!limits || mutation.isPending}
          onEdit={() => editTemplate(template)} onCopy={() => mutation.mutate(() => apiClient.copyCollectorSearchTemplate(template.id))}
          onDelete={() => mutation.mutate(() => apiClient.deleteCollectorSearchTemplate(template.id))}
          onPublish={() => publish(template)} onSchedule={() => setScheduleTemplate(template)} />)}</div> : <div className="collector-empty">尚无搜索模板。先同步官网筛选项并保存第一组条件。</div>}
    </section>

    {scheduleTemplate && <section className="section-panel collector-schedule-editor">
      <div className="section-heading"><div><h2>配置计划</h2><p>{scheduleTemplate.name}，全部时间按北京时间执行。</p></div><Button appearance="subtle" icon={<Dismiss24Regular />} onClick={() => setScheduleTemplate(null)}>关闭</Button></div>
      <form onSubmit={createSchedule}>
        <label><span>计划类型</span><select value={scheduleKind} onChange={(event) => setScheduleKind(event.target.value as CollectorSchedule["kind"])}><option value="once">单次定时</option><option value="daily">每天</option><option value="weekly">每周</option></select></label>
        {scheduleKind === "once" ? <label><span>执行时间</span><Input type="datetime-local" value={scheduleRunAt} onChange={(_, data) => setScheduleRunAt(data.value)} required /></label> : <label><span>北京时间</span><Input type="time" value={scheduleTime} onChange={(_, data) => setScheduleTime(data.value)} required /></label>}
        {scheduleKind === "weekly" && <label><span>星期</span><select value={scheduleWeekday} onChange={(event) => setScheduleWeekday(event.target.value)}><option value="1">星期一</option><option value="2">星期二</option><option value="3">星期三</option><option value="4">星期四</option><option value="5">星期五</option><option value="6">星期六</option><option value="7">星期日</option></select></label>}
        <Button appearance="primary" icon={<CalendarClock24Regular />} type="submit" disabled={!limits || mutation.isPending}>保存计划</Button>
      </form>
    </section>}

    <section className="section-panel">
      <div className="section-heading"><div><h2>串行采集队列</h2><p>待执行任务可以调序或取消；运行任务只允许暂停。任何时刻最多一个任务持有租约。</p></div><div className="collector-queue-summary"><span>今日已导出 <strong>{queueQuery.data?.control.dailyExportedCount || 0}</strong>{queueQuery.data?.control.dailyLimit === null ? " / 不限" : ` / ${queueQuery.data?.control.dailyLimit ?? 500}`}</span><span>排队 <strong>{queueQuery.data?.control.queuedCount || 0}</strong></span></div></div>
      <AgentStrip agents={queueQuery.data?.agents || []} />
      {queueQuery.isPending ? <ProgressBar /> : queueQuery.isError ? <div className="inline-error">{queueQuery.error.message}<Button size="small" onClick={() => queueQuery.refetch()}>重试</Button></div> : <QueueTable jobs={queueQuery.data?.items || []} busy={mutation.isPending} action={(job, name) => mutation.mutate(() => apiClient.collectorJobAction(job.id, name))} />}
    </section>

    <section className="section-panel">
      <div className="section-heading"><div><h2>定时计划</h2><p>同一模板已有排队或运行实例时，定时触发只记录跳过，不重复入队。</p></div></div>
      <SchedulesTable schedules={schedulesQuery.data?.items || []} templates={templatesQuery.data?.items || []} mutate={(action) => mutation.mutate(action)} />
    </section>
  </div>;
}

function FilterEditor({ catalog, selections, setSelections }: { catalog: CollectorFilterCatalog; selections: SelectionMap; setSelections: (value: SelectionMap) => void }) {
  const update = (key: string, selection: CollectorFilterSelection | null) => { const next = { ...selections }; if (selection) next[key] = selection; else delete next[key]; setSelections(next); };
  return <div className="collector-filter-grid">{catalog.filters.map((filter) => {
    const current = selections[filter.key];
    if (!filter.supported) return <div className="collector-filter-item is-unsupported" key={filter.key}><div><strong>{collectorLabel(filter.label)}</strong><Badge appearance="outline">暂不支持</Badge></div><span title={filter.reason || undefined}>{collectorReason(filter.reason)}</span></div>;
    if (filter.controlType === "single") return <label className="collector-filter-item" key={filter.key}><span title={filter.label}>{collectorLabel(filter.label)}</span><select value={current?.optionKeys?.[0] || ""} onChange={(event) => update(filter.key, event.target.value ? { key: filter.key, optionKeys: [event.target.value] } : null)}><option value="">不限</option>{filter.options.map((option) => <option key={option.key} value={option.key} title={option.label}>{collectorLabel(option.label)}</option>)}</select></label>;
    if (filter.controlType === "multi") return <fieldset className="collector-filter-item" key={filter.key}><legend title={filter.label}>{collectorLabel(filter.label)}</legend><div className="collector-check-list">{filter.options.map((option) => <Checkbox key={option.key} label={collectorLabel(option.label)} checked={current?.optionKeys?.includes(option.key) || false} onChange={(_, data) => { const values = new Set(current?.optionKeys || []); if (data.checked) values.add(option.key); else values.delete(option.key); update(filter.key, values.size ? { key: filter.key, optionKeys: [...values] } : null); }} />)}</div></fieldset>;
    if (filter.controlType === "range") return <fieldset className="collector-filter-item" key={filter.key}><legend title={filter.label}>{collectorLabel(filter.label)}</legend><div className="collector-range"><Input type={filter.valueKind === "number" ? "number" : "text"} placeholder="最小值" value={current?.min === undefined ? "" : String(current.min)} onChange={(_, data) => update(filter.key, (data.value || current?.max !== undefined) ? { key: filter.key, min: data.value ? Number(data.value) : undefined, max: current?.max } : null)} /><Input type={filter.valueKind === "number" ? "number" : "text"} placeholder="最大值" value={current?.max === undefined ? "" : String(current.max)} onChange={(_, data) => update(filter.key, (data.value || current?.min !== undefined) ? { key: filter.key, min: current?.min, max: data.value ? Number(data.value) : undefined } : null)} /></div></fieldset>;
    return <label className="collector-filter-item" key={filter.key}><span title={filter.label}>{collectorLabel(filter.label)}</span><Input value={current?.value || ""} placeholder="输入官网可搜索值" onChange={(_, data) => update(filter.key, data.value ? { key: filter.key, value: data.value } : null)} /></label>;
  })}</div>;
}

function SelectedConditions({ catalog, selections, sortKey }: { catalog: CollectorFilterCatalog; selections: SelectionMap; sortKey: string }) {
  const labels = conditionLabels(catalog, Object.values(selections)); const sort = catalog.sorts.find((item) => item.key === sortKey);
  return <div className="collector-selected"><span>已选条件</span><div>{labels.length ? labels.map((label) => <Badge key={label} appearance="tint">{label}</Badge>) : <em>未选择筛选条件</em>}{sort && <Badge appearance="outline">排序：{collectorLabel(sort.label)}</Badge>}</div></div>;
}

function LimitsEditor({ targetCount, maxPages, durationHours, setTargetCount, setMaxPages, setDurationHours }: { targetCount: string; maxPages: string; durationHours: string; setTargetCount: (value: string) => void; setMaxPages: (value: string) => void; setDurationHours: (value: string) => void }) {
  return <div className="collector-limit-editor"><label><span>目标人数</span><Input type="number" min={1} max={500} value={targetCount} disabled={Boolean(durationHours)} onChange={(_, data) => { setTargetCount(data.value); if (data.value) setMaxPages(""); }} /></label><span>或</span><label><span>最大页数</span><Input type="number" min={1} max={10} value={maxPages} disabled={Boolean(durationHours)} onChange={(_, data) => { setMaxPages(data.value); if (data.value) setTargetCount(""); }} /></label><span>或</span><label><span>持续小时（人数不限）</span><Input type="number" min={1} max={48} value={durationHours} onChange={(_, data) => { setDurationHours(data.value); if (data.value) { setTargetCount(""); setMaxPages(""); } }} /></label></div>;
}

function TemplateCard({ template, catalog, disabled, onEdit, onCopy, onDelete, onPublish, onSchedule }: { template: CollectorSearchTemplate; catalog: CollectorFilterCatalog | null; disabled: boolean; onEdit: () => void; onCopy: () => void; onDelete: () => void; onPublish: () => void; onSchedule: () => void }) {
  const labels = catalog && template.searchSpec.filterSchemaVersion === catalog.version ? conditionLabels(catalog, template.searchSpec.filters) : []; const stale = !catalog || template.searchSpec.filterSchemaVersion !== catalog.version;
  return <article className="collector-template-card"><header><div><strong>{template.name}</strong><span>{template.searchSpec.keyword}</span></div>{stale ? <Badge color="warning">目录待更新</Badge> : <Badge appearance="outline">{labels.length}个筛选条件</Badge>}</header><div className="collector-template-tags">{labels.slice(0, 5).map((label) => <Badge key={label} appearance="tint">{label}</Badge>)}{labels.length > 5 && <span>另有{labels.length - 5}项</span>}</div><footer><Button size="small" icon={<Edit24Regular />} onClick={onEdit}>编辑</Button><Button size="small" icon={<Copy24Regular />} disabled={stale || disabled} onClick={onCopy}>复制</Button><Button size="small" icon={<Delete24Regular />} disabled={disabled} onClick={onDelete}>删除</Button><span /><Button size="small" icon={<CalendarClock24Regular />} disabled={stale || disabled} onClick={onSchedule}>配置计划</Button><Button size="small" appearance="primary" icon={<Add24Regular />} disabled={stale || disabled} onClick={onPublish}>立即发布</Button></footer></article>;
}

function QueueTable({ jobs, busy, action }: { jobs: CollectionQueueJob[]; busy: boolean; action: (job: CollectionQueueJob, action: "pause" | "resume" | "cancel" | "move-up" | "move-down") => void }) {
  if (!jobs.length) return <div className="collector-empty">队列为空。</div>;
  return <div className="data-table-wrap"><table className="data-table collector-queue-table"><thead><tr><th>排位</th><th>任务与条件</th><th>来源</th><th>状态</th><th>页进度</th><th>XLS / PDF</th><th>上传</th><th>搜索证据</th><th>操作</th></tr></thead><tbody>{jobs.map((job) => <tr key={job.id}><td>{job.queuePosition ? `#${job.queuePosition}` : activeStatuses.has(job.status) ? "执行中" : "完成"}</td><td><strong>{job.name}</strong><span className="table-subtext">{job.searchSpec.keyword}，{job.searchSpec.filters.length}个筛选条件</span></td><td>{job.source === "manual" ? "立即发布" : job.source === "schedule" ? "定时计划" : "历史迁移"}</td><td><QueueStatus status={job.status} /></td><td>{job.completedPages} / {job.limits.durationHours ? `${job.limits.durationHours}小时` : job.limits.maxPages || "自动"}<span className="table-subtext">{job.exportedCount}人{job.limits.durationHours ? "（不限人数）" : ""}</span></td><td>{job.xlsCount} / {job.pdfCount}</td><td>{job.uploadedCount}页</td><td>{job.searchId ? <><span className="mono">{job.searchId.slice(0, 12)}</span><span className="table-subtext">匹配{job.matchedCount ?? "未知"}</span></> : "待执行"}</td><td><div className="table-actions">{job.status === "queued" && <><Button size="small" icon={<ArrowUp24Regular />} aria-label="上移" disabled={busy} onClick={() => action(job, "move-up")} /><Button size="small" icon={<ArrowDown24Regular />} aria-label="下移" disabled={busy} onClick={() => action(job, "move-down")} /><Button size="small" icon={<Delete24Regular />} disabled={busy} onClick={() => action(job, "cancel")}>取消</Button></>}{job.status === "running" && <Button size="small" icon={<Pause24Regular />} disabled={busy} onClick={() => action(job, "pause")}>暂停</Button>}{["paused", "safety_stopped", "failed"].includes(job.status) && <Button size="small" icon={<Play24Regular />} disabled={busy} onClick={() => action(job, "resume")}>恢复</Button>}</div></td></tr>)}</tbody></table></div>;
}

function AgentStrip({ agents }: { agents: Array<{ id: string; name: string; status: string; chromeReady: boolean; loginState: string; lastHeartbeatAt: string }> }) {
  const agent = agents[0]; return <div className="collector-agent-strip"><div><span className={`collector-agent-dot ${agent?.status === "online" ? "is-online" : ""}`} /><strong>{agent?.name || "Windows Agent未连接"}</strong></div><span>Agent：{agent?.status === "online" ? "在线" : "离线"}</span><span>Chrome：{agent?.chromeReady ? "已连接" : "未就绪"}</span><span>Bayt：{agent?.loginState === "logged_in" ? "已登录" : agent?.loginState === "login_required" ? "需要登录" : "未知"}</span><span>心跳：{agent ? new Date(agent.lastHeartbeatAt).toLocaleString("zh-CN") : "无"}</span></div>;
}

function SchedulesTable({ schedules, templates, mutate }: { schedules: CollectorSchedule[]; templates: CollectorSearchTemplate[]; mutate: (action: () => Promise<unknown>) => void }) {
  const names = new Map(templates.map((template) => [template.id, template.name])); if (!schedules.length) return <div className="collector-empty">尚无定时计划。</div>;
  return <div className="data-table-wrap"><table className="data-table"><thead><tr><th>计划</th><th>模板</th><th>周期</th><th>下次执行</th><th>范围</th><th>状态</th><th>操作</th></tr></thead><tbody>{schedules.map((schedule) => <tr key={schedule.id}><td><strong>{schedule.name}</strong></td><td>{names.get(schedule.templateId) || schedule.templateId}</td><td>{schedule.kind === "once" ? "单次" : schedule.kind === "daily" ? `每天 ${schedule.localTime}` : `每周${weekdayText(schedule.weekday)} ${schedule.localTime}`}</td><td>{schedule.nextRunAt ? new Date(schedule.nextRunAt).toLocaleString("zh-CN") : "无"}</td><td>{schedule.limits.durationHours ? `${schedule.limits.durationHours}小时（人数不限）` : schedule.limits.targetCount ? `${schedule.limits.targetCount}人` : `${schedule.limits.maxPages}页`}</td><td><Badge color={schedule.enabled ? "success" : "subtle"}>{schedule.enabled ? "启用" : "停用"}</Badge></td><td><div className="table-actions"><Button size="small" onClick={() => mutate(() => apiClient.updateCollectorSchedule(schedule.id, { enabled: !schedule.enabled }))}>{schedule.enabled ? "停用" : "启用"}</Button><Button size="small" icon={<Delete24Regular />} onClick={() => mutate(() => apiClient.deleteCollectorSchedule(schedule.id))}>删除</Button></div></td></tr>)}</tbody></table></div>;
}

function QueueStatus({ status }: { status: CollectionQueueJob["status"] }) {
  const color = status === "completed" ? "success" : ["failed", "safety_stopped"].includes(status) ? "danger" : ["running", "queued", "pause_requested"].includes(status) ? "informative" : "warning";
  const text: Record<CollectionQueueJob["status"], string> = { queued: "排队中", running: "采集中", pause_requested: "暂停中", paused: "已暂停", completed: "已完成", cancelled: "已取消", safety_stopped: "安全停止", failed: "失败" };
  return <Badge appearance="tint" color={color}>{text[status]}</Badge>;
}

function hasSelectionValue(selection: CollectorFilterSelection): boolean { return Boolean(selection.optionKeys?.length || selection.value?.trim() || selection.min !== undefined || selection.max !== undefined); }
function conditionLabels(catalog: CollectorFilterCatalog, selections: CollectorFilterSelection[]): string[] { return selections.map((selection) => { const filter = catalog.filters.find((item) => item.key === selection.key); if (!filter) return selection.key; if (selection.optionKeys?.length) return `${collectorLabel(filter.label)}：${selection.optionKeys.map((key) => collectorLabel(filter.options.find((option) => option.key === key)?.label || key)).join("、")}`; if (selection.value) return `${collectorLabel(filter.label)}：${selection.value}`; return `${collectorLabel(filter.label)}：${selection.min ?? "不限"}至${selection.max ?? "不限"}`; }); }
function buildLimits(targetCount: string, maxPages: string, durationHours: string): CollectorLimits | null { const limits: CollectorLimits = {}; if (targetCount) limits.targetCount = Number(targetCount); if (maxPages) limits.maxPages = Number(maxPages); if (durationHours) limits.durationHours = Number(durationHours); if (limits.targetCount && (limits.targetCount < 1 || limits.targetCount > 500 || !Number.isInteger(limits.targetCount))) return null; if (limits.maxPages && (limits.maxPages < 1 || limits.maxPages > 10 || !Number.isInteger(limits.maxPages))) return null; if (limits.durationHours && (limits.durationHours < 1 || limits.durationHours > 48 || !Number.isInteger(limits.durationHours))) return null; if (limits.durationHours && (limits.targetCount || limits.maxPages)) return null; return limits.targetCount || limits.maxPages || limits.durationHours ? limits : null; }
function weekdayText(value: number | null): string { return ["", "一", "二", "三", "四", "五", "六", "日"][value || 0] || ""; }
