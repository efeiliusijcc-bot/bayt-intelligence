import { useEffect, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Badge, Button, Card, Field, Input, ProgressBar, Textarea } from "@fluentui/react-components";
import {
  ArrowSync24Regular,
  CheckmarkCircle24Regular,
  DocumentSearch24Regular,
  Edit24Regular,
  Play24Regular,
  ShieldCheckmark24Regular,
  Warning24Regular,
} from "@fluentui/react-icons";
import { Link } from "react-router-dom";
import { apiClient, displayText } from "../api";
import { ErrorState, LoadingState } from "../components/PageStates";
import type { ResearchCaseStatus, ResearchPolicy, ResearchRunStatus } from "../types";

const ACTIVE_RUN_STATUSES = new Set<ResearchRunStatus>(["SCORING", "QUEUED", "RUNNING"]);

const CASE_STATUS_LABELS: Record<ResearchCaseStatus, string> = {
  NOT_ELIGIBLE: "未达门槛",
  SCORED_ONLY: "已评分",
  WAITING_PROVIDER: "等待服务",
  DEFERRED_BUDGET: "下批处理",
  QUEUED: "等待搜索",
  SEARCHING: "搜索中",
  VERIFIED: "自动核验通过",
  NO_RELIABLE_RESULT: "无可靠结果",
  WRONG_PERSON: "排除同名者",
  REVIEW_REQUIRED: "需要复核",
  CONFLICT: "证据冲突",
  FAILED: "处理失败",
};

const RUN_STATUS_LABELS: Record<ResearchRunStatus, string> = {
  SCORING: "评分中",
  SCORED: "评分完成",
  QUEUED: "等待执行",
  RUNNING: "研究中",
  COMPLETED: "已完成",
  PARTIAL: "已暂停",
  FAILED: "失败",
  INTERRUPTED: "已中断",
};

function formatDateTime(value: string | null): string {
  if (!value) return "未提供";
  const parsed = new Date(value);
  return Number.isNaN(parsed.getTime()) ? value : new Intl.DateTimeFormat("zh-CN", { dateStyle: "short", timeStyle: "short", hour12: false }).format(parsed);
}

function statusClass(status: string): string {
  if (["VERIFIED", "COMPLETED", "SCORED"].includes(status)) return "is-success";
  if (["REVIEW_REQUIRED", "CONFLICT", "PARTIAL", "WAITING_PROVIDER"].includes(status)) return "is-warning";
  if (["FAILED", "INTERRUPTED"].includes(status)) return "is-danger";
  if (["SEARCHING", "RUNNING", "SCORING"].includes(status)) return "is-running";
  return "is-neutral";
}

export function ResearchPage() {
  const queryClient = useQueryClient();
  const research = useQuery({
    queryKey: ["research"],
    queryFn: apiClient.research,
    refetchInterval: (query) => query.state.data?.runs.some((run) => ACTIVE_RUN_STATUSES.has(run.status)) ? 1500 : false,
  });
  const runMutation = useMutation({
    mutationFn: (executeResearch: boolean) => apiClient.startResearchRun(executeResearch),
    onSuccess: async () => { await queryClient.invalidateQueries({ queryKey: ["research"] }); },
  });
  const policyMutation = useMutation({
    mutationFn: apiClient.updateResearchPolicy,
    onSuccess: async () => { await queryClient.invalidateQueries({ queryKey: ["research"] }); },
  });

  if (research.isLoading) return <LoadingState label="正在读取评分与研究状态" />;
  if (research.isError || !research.data) return <ErrorState message={research.error?.message || "研究服务不可用"} retry={() => research.refetch()} />;

  const data = research.data;
  const activeRun = data.runs.find((run) => ACTIVE_RUN_STATUSES.has(run.status));
  const runBusy = runMutation.isPending || Boolean(activeRun);
  const progress = activeRun?.scheduledTotal
    ? Math.min(1, activeRun.completedTotal / activeRun.scheduledTotal)
    : activeRun ? 0 : 1;

  return (
    <div className="page-stack research-page">
      <div className="page-heading research-heading">
        <div><h1>人工复核</h1><p>先按职业条件评分；只有达到门槛的人物才使用 Tavily，复杂冲突才调用一次 DeepSeek。</p></div>
        <div className="research-actions">
          <Button icon={<ArrowSync24Regular />} disabled={runBusy} onClick={() => runMutation.mutate(false)}>仅重新评分</Button>
          <Button appearance="primary" icon={<Play24Regular />} disabled={runBusy} onClick={() => runMutation.mutate(true)}>评分并研究达标人物</Button>
        </div>
      </div>

      <section className="provider-bar" aria-label="研究服务状态">
        <div><span className={data.providers.tavilyConfigured ? "provider-dot is-on" : "provider-dot"} /><strong>Tavily</strong><small>{data.providers.tavilyConfigured ? "已配置，仅搜索达标人物" : "未配置，当前只执行评分"}</small></div>
        <div><span className={data.providers.deepseekConfigured ? "provider-dot is-on" : "provider-dot"} /><strong>DeepSeek</strong><small>{data.providers.deepseekConfigured ? `${data.providers.deepseekModel}，仅处理复杂冲突` : "未配置，不影响确定性评分"}</small></div>
        <div className="provider-message"><ShieldCheckmark24Regular /><span>{data.message}</span></div>
      </section>

      {(activeRun || runMutation.isPending) && (
        <section className="research-run-progress" aria-live="polite">
          <div><strong>{activeRun ? RUN_STATUS_LABELS[activeRun.status] : "正在创建任务"}</strong><span>{activeRun ? `${activeRun.completedTotal}/${activeRun.scheduledTotal} 人完成研究；共 ${activeRun.scoredTotal} 人已评分` : "请稍候"}</span></div>
          <ProgressBar value={progress} />
        </section>
      )}
      {runMutation.isError && <div className="inline-error"><Warning24Regular />{runMutation.error.message}</div>}

      <section className="research-summary-grid" aria-label="研究统计">
        <SummaryCard label="人物总数" value={data.summary.peopleTotal} detail="当前人物库" />
        <SummaryCard label="已评分" value={data.summary.scored} detail="确定性职业评分" />
        <SummaryCard label="达到门槛" value={data.summary.eligible} detail={`当前门槛 ${data.policy.threshold} 分`} />
        <SummaryCard label="已搜索" value={data.summary.searched} detail="仅统计实际 Tavily 查询" />
        <SummaryCard label="自动核验" value={data.summary.verified} detail="A源或两个独立B源" tone="success" />
        <SummaryCard label="无可靠结果" value={data.summary.noReliableResult} detail="无需人工复核" />
        <SummaryCard label="待人工复核" value={data.summary.reviewRequired} detail="仅保留真实冲突" tone={data.summary.reviewRequired ? "warning" : "success"} />
        <SummaryCard label="等待服务" value={data.summary.waitingProvider} detail="未配置或服务暂停" tone={data.summary.waitingProvider ? "warning" : "neutral"} />
      </section>

      <div className="research-workspace">
        <PolicyEditor policy={data.policy} busy={policyMutation.isPending || runBusy} onSave={(policy) => policyMutation.mutate(policy)} error={policyMutation.error?.message || null} />
        <Card className="research-rule-card">
          <header><DocumentSearch24Regular /><div><h2>自动化判定边界</h2><p>用明确规则降低人工复核，同时不把同名当成同一人。</p></div></header>
          <ol>
            <li><strong>评分：</strong>职位25、技能30、经验20、资料完整15、更新时间10。</li>
            <li><strong>搜索：</strong>分数低于 {data.policy.threshold} 的人物不会调用 Tavily。</li>
            <li><strong>自动通过：</strong>一个A级来源，或两个独立B级来源，且身份分达标。</li>
            <li><strong>模型裁决：</strong>只给复杂冲突发送最小身份包与最多5条证据。</li>
            <li><strong>人工复核：</strong>仅在裁决后仍冲突或证据不足时保留。</li>
          </ol>
          <div className="research-safety-note"><CheckmarkCircle24Regular /><span>评分不使用国籍、年龄、性别等敏感属性；公开研究结果只辅助职业资料核验，不自动作出录用决定。</span></div>
        </Card>
      </div>

      <section className="research-table-card">
        <header><div><h2>人物评分与研究状态</h2><p>{data.items.length ? `按职业分从高到低显示 ${data.items.length} 人` : "尚未执行评分"}</p></div></header>
        {data.items.length ? (
          <div className="data-table-wrap">
            <table className="data-table research-table">
              <thead><tr><th>人物</th><th>当前职位</th><th>职业分</th><th>门槛</th><th>研究状态</th><th>证据</th><th>最近处理</th><th>操作</th></tr></thead>
              <tbody>{data.items.map((item) => (
                <tr key={item.cvId}>
                  <td><strong>{displayText(item.displayName)}</strong><small className="table-subline">{item.cvId}</small></td>
                  <td>{displayText(item.headline)}</td>
                  <td><strong className={item.eligible ? "score-pass" : ""}>{item.score}</strong><span className="score-denominator"> / 100</span></td>
                  <td>{item.threshold}</td>
                  <td><Badge appearance="outline" className={`research-status ${statusClass(item.status)}`}>{CASE_STATUS_LABELS[item.status]}</Badge></td>
                  <td>{item.acceptedEvidenceCount}/{item.evidenceCount}</td>
                  <td>{formatDateTime(item.updatedAt)}</td>
                  <td><Link to={`/people/${item.cvId}`}><Button appearance="subtle">查看解释</Button></Link></td>
                </tr>
              ))}</tbody>
            </table>
          </div>
        ) : (
          <div className="research-empty"><DocumentSearch24Regular /><strong>先运行一次确定性评分</strong><p>未配置 Tavily 也可以评分；低于门槛的人物不会产生任何外部搜索请求。</p></div>
        )}
      </section>

      <section className="research-table-card">
        <header><div><h2>最近任务</h2><p>任务中断后可重新运行；相同 Tavily 查询7天内命中缓存。</p></div></header>
        {data.runs.length ? <div className="data-table-wrap"><table className="data-table research-run-table"><thead><tr><th>任务</th><th>类型</th><th>状态</th><th>评分</th><th>达标</th><th>计划搜索</th><th>完成</th><th>人工复核</th><th>开始时间</th></tr></thead><tbody>{data.runs.slice(0, 10).map((run) => <tr key={run.id}><td className="mono">{run.id}</td><td>{run.executeResearch ? "评分+研究" : "仅评分"}</td><td><Badge appearance="outline" className={`research-status ${statusClass(run.status)}`}>{RUN_STATUS_LABELS[run.status]}</Badge>{run.error && <small className="table-error">{run.error}</small>}</td><td>{run.scoredTotal}</td><td>{run.eligibleTotal}</td><td>{run.scheduledTotal}</td><td>{run.completedTotal}</td><td>{run.reviewRequiredTotal}</td><td>{formatDateTime(run.createdAt)}</td></tr>)}</tbody></table></div> : <div className="research-empty is-compact"><p>暂无任务记录。</p></div>}
      </section>
    </div>
  );
}

function SummaryCard({ label, value, detail, tone = "neutral" }: { label: string; value: number; detail: string; tone?: "neutral" | "success" | "warning" }) {
  return <Card className={`research-summary-card tone-${tone}`}><span>{label}</span><strong>{value}</strong><small>{detail}</small></Card>;
}

function splitKeywords(value: string): string[] {
  return [...new Set(value.split(/[，,\n]/).map((item) => item.trim()).filter(Boolean))];
}

function PolicyEditor({ policy, busy, onSave, error }: { policy: ResearchPolicy; busy: boolean; onSave: (policy: ResearchPolicy) => void; error: string | null }) {
  const [draft, setDraft] = useState({
    targetRole: policy.targetRole,
    threshold: String(policy.threshold),
    minimumExperienceYears: String(policy.minimumExperienceYears),
    maxCandidatesPerRun: String(policy.maxCandidatesPerRun),
    titleKeywords: policy.titleKeywords.join(", "),
    skillKeywords: policy.skillKeywords.join(", "),
  });
  useEffect(() => {
    setDraft({
      targetRole: policy.targetRole,
      threshold: String(policy.threshold),
      minimumExperienceYears: String(policy.minimumExperienceYears),
      maxCandidatesPerRun: String(policy.maxCandidatesPerRun),
      titleKeywords: policy.titleKeywords.join(", "),
      skillKeywords: policy.skillKeywords.join(", "),
    });
  }, [policy.updatedAt]);
  const save = () => onSave({
    ...policy,
    targetRole: draft.targetRole,
    threshold: Number(draft.threshold),
    minimumExperienceYears: Number(draft.minimumExperienceYears),
    maxCandidatesPerRun: Number(draft.maxCandidatesPerRun),
    titleKeywords: splitKeywords(draft.titleKeywords),
    skillKeywords: splitKeywords(draft.skillKeywords),
  });
  return (
    <Card className="research-policy-card">
      <header><Edit24Regular /><div><h2>评分策略</h2><p>修改后从下一次任务生效；既有分数不会静默改写。</p></div></header>
      <div className="policy-form">
        <Field label="目标职位"><Input value={draft.targetRole} onChange={(_, data) => setDraft((value) => ({ ...value, targetRole: data.value }))} /></Field>
        <Field label="研究门槛（0-100）"><Input type="number" min={0} max={100} value={draft.threshold} onChange={(_, data) => setDraft((value) => ({ ...value, threshold: data.value }))} /></Field>
        <Field label="最低经验年限"><Input type="number" min={0} max={60} value={draft.minimumExperienceYears} onChange={(_, data) => setDraft((value) => ({ ...value, minimumExperienceYears: data.value }))} /></Field>
        <Field label="单次最多搜索人数"><Input type="number" min={1} max={100} value={draft.maxCandidatesPerRun} onChange={(_, data) => setDraft((value) => ({ ...value, maxCandidatesPerRun: data.value }))} /></Field>
        <Field label="职位关键词" className="policy-wide"><Textarea resize="vertical" value={draft.titleKeywords} onChange={(_, data) => setDraft((value) => ({ ...value, titleKeywords: data.value }))} /></Field>
        <Field label="技能关键词" className="policy-wide"><Textarea resize="vertical" value={draft.skillKeywords} onChange={(_, data) => setDraft((value) => ({ ...value, skillKeywords: data.value }))} /></Field>
      </div>
      <div className="policy-footer"><span>权重：职位25，技能30，经验20，完整度15，更新时间10</span><Button appearance="primary" disabled={busy} onClick={save}>保存策略</Button></div>
      {error && <div className="inline-error"><Warning24Regular />{error}</div>}
    </Card>
  );
}
