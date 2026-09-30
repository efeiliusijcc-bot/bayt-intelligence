import { useEffect, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { Badge, Button, ProgressBar, Tab, TabList, type SelectTabData, type SelectTabEvent } from "@fluentui/react-components";
import {
  ArrowDownload24Regular,
  ArrowLeft24Regular,
  CheckmarkCircle24Regular,
  DocumentBulletList24Regular,
  DocumentPdf24Regular,
  Eye24Regular,
  Info24Regular,
  Open24Regular,
} from "@fluentui/react-icons";
import { Link, useParams, useSearchParams } from "react-router-dom";
import { ApiError, apiClient, displayText, formatBytes } from "../api";
import { ErrorState, LoadingState } from "../components/PageStates";
import { SourceBadge } from "../components/SourceBadge";
import { CollectionSourceLinks } from "../components/CollectionSourceLinks";
import type { AttachmentView, PersonView, ResearchCaseDetail, ResearchCaseStatus } from "../types";

type DetailTab = "overview" | "experience" | "skills" | "attachments" | "scoring" | "research" | "audit";

export function PersonDetailPage() {
  const { cvId = "" } = useParams();
  const [params] = useSearchParams();
  const [tab, setTab] = useState<DetailTab>(params.get("tab") === "attachments" ? "attachments" : "overview");
  const person = useQuery({ queryKey: ["person", cvId], queryFn: () => apiClient.person(cvId), enabled: Boolean(cvId) });
  if (person.isLoading) return <LoadingState label="正在加载人物详情" />;
  if (person.isError || !person.data) return <ErrorState message={person.error?.message || "人物资料不可用"} retry={() => person.refetch()} />;
  const data = person.data;
  return (
    <div className="page-stack detail-page">
      <Link to="/people" className="back-link"><ArrowLeft24Regular />返回人物库</Link>
      <section className="person-detail-header">
        <DetailAvatar person={data} />
        <div className="detail-identity"><h1>{displayText(data.displayName)}</h1><p>{displayText(data.headline)} / {displayText(data.residence)}</p><div className="header-badges"><Badge appearance="outline">CV_ID {data.cvId}</Badge><Badge appearance="outline">更新 {data.lastCvUpdate || "未提供"}</Badge>{data.sourceTags.map((source) => <SourceBadge key={source} source={source} />)}</div></div>
        <div className="detail-collection-source"><span>来源任务</span><CollectionSourceLinks person={data} /></div>
        <div className="header-scores"><div><span>职业匹配</span><strong>{data.professionalScore === null ? "未评分" : `${data.professionalScore} / 100`}</strong></div><div><span>研究优先级</span><strong>{data.researchPriorityScore === null ? (data.professionalScore === null ? "未评分" : "未达门槛") : `${data.researchPriorityScore} / 100`}</strong></div></div>
      </section>
      <section className="detail-tabs-panel">
        <TabList selectedValue={tab} onTabSelect={(_event: SelectTabEvent, data: SelectTabData) => setTab(data.value as DetailTab)} className="detail-tabs">
          <Tab value="overview">人物概览</Tab><Tab value="experience">职业经历</Tab><Tab value="skills">技能与教育</Tab><Tab value="attachments">简历附件</Tab><Tab value="scoring">评分解释</Tab><Tab value="research">公开信息</Tab><Tab value="audit">审计记录</Tab>
        </TabList>
        <div className="tab-content">
          {tab === "overview" && <OverviewTab person={data} />}
          {tab === "experience" && <ExperienceTab person={data} />}
          {tab === "skills" && <SkillsTab person={data} />}
          {tab === "attachments" && <AttachmentsTab person={data} />}
          {tab === "scoring" && <ScoringTab cvId={data.cvId} />}
          {tab === "research" && <ResearchTab cvId={data.cvId} />}
          {tab === "audit" && <AuditTab cvId={data.cvId} />}
        </div>
      </section>
    </div>
  );
}

const researchStatusLabels: Record<ResearchCaseStatus, string> = {
  NOT_ELIGIBLE: "未达到研究门槛",
  SCORED_ONLY: "已评分，尚未执行公开搜索",
  WAITING_PROVIDER: "等待Tavily服务",
  DEFERRED_BUDGET: "已顺延到下一批",
  QUEUED: "等待公开搜索",
  SEARCHING: "正在搜索",
  VERIFIED: "公开身份已自动核验",
  NO_RELIABLE_RESULT: "未找到可靠公开结果",
  WRONG_PERSON: "已排除同名人物",
  REVIEW_REQUIRED: "需要人工复核",
  CONFLICT: "公开证据存在冲突",
  FAILED: "研究处理失败",
};

function useResearchCase(cvId: string) {
  return useQuery({ queryKey: ["research-case", cvId], queryFn: () => apiClient.researchCase(cvId) });
}

function researchCaseState(query: ReturnType<typeof useResearchCase>) {
  if (query.isLoading) return <LoadingState label="正在读取评分解释" />;
  if (query.isError) {
    if (query.error instanceof ApiError && query.error.code === "RESEARCH_CASE_NOT_FOUND") {
      return <NotConfigured title="尚未执行评分" detail="请先在“人工复核”页面运行确定性评分；未配置Tavily也可以评分。" />;
    }
    return <ErrorState message={query.error.message} retry={() => query.refetch()} />;
  }
  return null;
}

function ScoringTab({ cvId }: { cvId: string }) {
  const research = useResearchCase(cvId);
  const state = researchCaseState(research);
  if (state || !research.data) return state;
  const data = research.data;
  const breakdown = [
    { label: "职位相关度", value: data.scoreBreakdown.title, maximum: 25, detail: data.scoreBreakdown.matchedTitleKeywords.join("、") || "未命中职位关键词" },
    { label: "技能匹配", value: data.scoreBreakdown.skills, maximum: 30, detail: data.scoreBreakdown.matchedSkillKeywords.join("、") || "未命中技能关键词" },
    { label: "工作经验", value: data.scoreBreakdown.experience, maximum: 20, detail: `${data.scoreBreakdown.experienceYears} 年累计经验` },
    { label: "职业资料完整度", value: data.scoreBreakdown.completeness, maximum: 15, detail: "只检查职业资料字段，不使用敏感属性" },
    { label: "简历更新时间", value: data.scoreBreakdown.freshness, maximum: 10, detail: "按简历最后更新时间分段" },
  ];
  return (
    <div className="score-explanation">
      <section className="score-overview">
        <div><span>职业匹配分</span><strong>{data.score}<small>/100</small></strong><Badge appearance="outline" color={data.eligible ? "success" : "subtle"}>{data.eligible ? `达到 ${data.threshold} 分门槛` : `低于 ${data.threshold} 分门槛`}</Badge></div>
        <div><h2>评分用途</h2><p>该分数只决定是否进入公开资料搜索，不自动作出录用、淘汰或薪酬决定。</p><ProgressBar value={data.score / 100} /></div>
      </section>
      <section className="score-breakdown-list">
        {breakdown.map((item) => <article key={item.label}><div><strong>{item.label}</strong><span>{item.value} / {item.maximum}</span></div><ProgressBar value={item.maximum ? item.value / item.maximum : 0} /><p>{item.detail}</p></article>)}
      </section>
      <div className="score-boundary"><Info24Regular /><span>评分字段仅包含职位、技能、经验、职业资料完整度和更新时间；国籍、年龄、性别等属性不参与评分。</span></div>
    </div>
  );
}

function ResearchTab({ cvId }: { cvId: string }) {
  const research = useResearchCase(cvId);
  const state = researchCaseState(research);
  if (state || !research.data) return state;
  return <ResearchCaseContent data={research.data} />;
}

export function ResearchCaseContent({ data }: { data: ResearchCaseDetail }) {
  return (
    <div className="public-research-detail">
      <section className="research-decision-card">
        <div><span>当前状态</span><strong>{researchStatusLabels[data.status]}</strong></div>
        <div><span>身份置信度</span><strong>{data.identityConfidence === null ? "未形成" : `${Math.round(data.identityConfidence * 100)}%`}</strong></div>
        <div><span>已采纳证据</span><strong>{data.acceptedEvidenceCount} / {data.evidenceCount}</strong></div>
        <div><span>裁决方式</span><strong>{data.modelUsed || "确定性规则"}</strong></div>
      </section>
      <section className="research-synthesis-card">
        <header>
          <div><DocumentBulletList24Regular aria-hidden="true" /><div><h2>研究摘要</h2><p>先读结论，再通过下方信源核对依据。</p></div></div>
          <Badge appearance="outline">证据规则生成</Badge>
        </header>
        <div className="synthesis-conclusion"><span>综合结论</span><strong>{data.synthesis.conclusion}</strong></div>
        <div className="synthesis-profile-grid">
          <article><h3>职业画像</h3><p>{data.synthesis.careerProfile}</p></article>
          <article><h3>匹配要点</h3>{data.synthesis.highlights.length ? <ul>{data.synthesis.highlights.map((item) => <li key={item}>{item}</li>)}</ul> : <p>当前没有可提炼的评分命中项。</p>}</article>
        </div>
        <div className="synthesis-findings">
          <h3>公开信息摘要</h3>
          {data.synthesis.publicFindings.length ? data.synthesis.publicFindings.map((finding, index) => (
            <article key={`${finding.evidenceIds.join("-")}-${index}`} className={finding.certainty === "confirmed" ? "is-confirmed" : "is-possible"}>
              {finding.certainty === "confirmed" ? <CheckmarkCircle24Regular aria-hidden="true" /> : <Info24Regular aria-hidden="true" />}
              <div><strong>{finding.certainty === "confirmed" ? "已确认事实" : "候选线索，尚未确认"}</strong><p>{finding.text}</p><div>{finding.evidenceIds.map((sourceId) => <a key={sourceId} href={`#evidence-${sourceId}`}>[{sourceId}]</a>)}</div></div>
            </article>
          )) : <p className="synthesis-empty">没有达到摘要门槛的公开信息，低相关搜索结果不会写入人物事实。</p>}
        </div>
        {data.synthesis.gaps.length > 0 && <div className="synthesis-gaps"><h3>信息缺口与注意事项</h3><ul>{data.synthesis.gaps.map((gap) => <li key={gap}>{gap}</li>)}</ul></div>}
        <footer>摘要仅使用简历职业字段和已保存的公开信源，不推断联系方式、私人关系或敏感属性。</footer>
      </section>
      {data.conflicts.length > 0 && <section className="research-conflicts"><h2>待处理冲突</h2>{data.conflicts.map((conflict) => <p key={conflict}><Info24Regular />{conflict}</p>)}</section>}
      <section className="public-evidence-section">
        <header><div><h2>公开来源证据</h2><p>只有一个A级来源或两个独立B级来源且身份分达标，才能自动核验通过。</p></div><Badge appearance="outline">最近搜索 {data.searchedAt ? new Date(data.searchedAt).toLocaleDateString("zh-CN") : "未执行"}</Badge></header>
        {data.evidence.length ? <div className="evidence-list">{data.evidence.map((evidence) => <article id={`evidence-${evidence.sourceId}`} key={evidence.sourceId} className={evidence.accepted ? "is-accepted" : ""}><div className="evidence-head"><div><Badge appearance="filled" color={evidence.sourceLevel === "A" ? "success" : evidence.sourceLevel === "B" ? "informative" : "subtle"}>{evidence.sourceLevel}级来源</Badge><strong>{displayText(evidence.title)}</strong></div><span>身份分 {Math.round(evidence.identityScore * 100)}%</span></div><p>{displayText(evidence.snippet, "来源未返回可展示摘要")}</p><footer><code>{evidence.sourceId}</code><span>{evidence.domain}</span><a href={evidence.url} target="_blank" rel="noopener noreferrer">查看公开来源 <Open24Regular /></a></footer></article>)}</div> : <NotConfigured title="没有可靠公开证据" detail={!data.eligible ? "该人物未达到公开搜索门槛，因此没有调用Tavily。" : data.searchedAt ? "已完成搜索，但没有保存达到身份核验标准的公开来源。" : "该人物已达到评分门槛，但尚未执行Tavily公开搜索。"} />}
      </section>
    </div>
  );
}

function DetailAvatar({ person }: { person: PersonView }) {
  const initials = person.displayName.split(/\s+/).slice(0, 2).map((part) => part[0]).join("").toUpperCase();
  return <div className="detail-avatar">{person.hasAvatar ? <img src={`/api/v1/people/${person.cvId}/avatar`} alt={`${displayText(person.displayName)}头像`} /> : <span>{initials}</span>}</div>;
}

function OverviewTab({ person }: { person: PersonView }) {
  return (
    <div className="detail-grid">
      <section className="detail-section"><h2>基础信息</h2><dl className="definition-grid"><Definition label="原始姓名" value={person.displayName} source="EXCEL" /><Definition label="国籍" value={person.nationality} source="EXCEL" /><Definition label="当前所在地" value={person.residence} source="EXCEL" /><Definition label="目标职位" value={person.headline} source="EXCEL" /><Definition label="简历更新时间" value={person.lastCvUpdate} source="EXCEL" /><Definition label="联系方式状态" value="Bayt 未公开联系方式" /></dl></section>
      <section className="detail-section"><h2>职业摘要</h2><dl className="definition-grid"><Definition label="工作经历" value={`${person.experiences.length} 段`} /><Definition label="教育经历" value={`${person.educations.length} 项`} /><Definition label="技能" value={`${person.skills.length} 项`} /><Definition label="语言" value={`${person.languages.length} 种`} /><Definition label="标准PDF" value={person.attachments.some((item) => item.kind === "bayt_pdf" && item.status === "downloaded") ? "已绑定" : "缺失"} /><Definition label="原始附件" value={person.attachments.some((item) => item.kind === "original" && item.status === "downloaded") ? "可用" : "缺失"} /></dl></section>
      {person.summary && <section className="detail-section detail-summary"><h2>个人简介</h2><p>{displayText(person.summary)}</p><div className="source-line"><SourceBadge source="BAYT_PROFILE" /></div></section>}
    </div>
  );
}

function Definition({ label, value, source }: { label: string; value: string | null; source?: string }) {
  return <div><dt>{label}</dt><dd>{displayText(value)}</dd>{source && <SourceBadge source={source} />}</div>;
}

function ExperienceTab({ person }: { person: PersonView }) {
  return person.experiences.length ? (
    <div className="timeline">
      {person.experiences.map((experience, index) => (
        <article className="timeline-item" key={`${experience.organization}-${index}`}>
          <div className="timeline-marker" aria-hidden="true" />
          <div><div className="timeline-head"><div><h2>{displayText(experience.position, "职位未提供")}</h2><p>{displayText(experience.organization)}</p></div><Badge appearance="outline">{experience.years ? `${experience.years} 年` : "任职时间未提供"}</Badge></div><div className="source-line"><SourceBadge source={experience.source} /><span>原始数据未提供精确起止日期，不进行日期推算。</span></div></div>
        </article>
      ))}
    </div>
  ) : <NotConfigured title="没有职业经历数据" detail="Excel和当前页面资料中没有可展示的经历。" />;
}

function SkillsTab({ person }: { person: PersonView }) {
  const groups = person.skills.reduce<Record<string, typeof person.skills>>((result, skill) => {
    const key = skill.level || "未标注熟练度";
    (result[key] ||= []).push(skill);
    return result;
  }, {});
  return (
    <div className="detail-grid">
      <section className="detail-section skill-section"><h2>技能</h2>{Object.entries(groups).map(([level, skills]) => <div className="skill-group" key={level}><h3>{displayText(level)}</h3><div>{skills.map((skill) => <Badge appearance="tint" color="informative" key={skill.name}>{displayText(skill.name)}</Badge>)}</div></div>)}</section>
      <section className="detail-section"><h2>教育</h2><div className="education-list">{person.educations.length ? person.educations.map((education, index) => <article key={index}><strong>{displayText(education.description)}</strong><SourceBadge source={education.source} /></article>) : <p>未提供教育信息</p>}</div></section>
      <section className="detail-section"><h2>语言</h2><div className="language-list">{person.languages.length ? person.languages.map((language) => <div key={language.name}><strong>{displayText(language.name)}</strong><span>{displayText(language.level, "熟练度未提供")}</span><SourceBadge source={language.source} /></div>) : <p>未提供语言信息</p>}</div></section>
    </div>
  );
}

function AttachmentsTab({ person }: { person: PersonView }) {
  const [selectedId, setSelectedId] = useState(person.attachments.find((item) => item.kind === "bayt_pdf" && item.previewable)?.id || person.attachments.find((item) => item.previewable)?.id || "");
  const selected = person.attachments.find((item) => item.id === selectedId) || null;
  const preview = useQuery({ queryKey: ["attachment-preview", selectedId], queryFn: () => apiClient.previewUrl(selectedId), enabled: Boolean(selected?.previewable), staleTime: 4 * 60 * 1000 });
  useEffect(() => { if (selectedId && !person.attachments.some((item) => item.id === selectedId)) setSelectedId(""); }, [person.cvId]);
  const download = async (attachment: AttachmentView) => {
    const result = await apiClient.downloadUrl(attachment.id);
    window.location.assign(result.url);
  };
  return (
    <div className="attachment-layout">
      <aside className="attachment-list"><h2>人物附件</h2><p>附件按来源分类，不把所有PDF标记为原始简历。</p>{person.attachments.filter((item) => item.status !== "skipped").map((attachment) => (
        <button key={attachment.id} className={`attachment-item ${selectedId === attachment.id ? "is-selected" : ""}`} onClick={() => setSelectedId(attachment.id)}>
          <DocumentPdf24Regular /><span><strong>{attachment.label}</strong><small>{displayText(attachment.originalName, "标准化文件名")} / {formatBytes(attachment.sizeBytes)}</small></span><Badge appearance="outline" color={attachment.status === "downloaded" ? "success" : "subtle"}>{attachment.status === "downloaded" ? "可用" : "不可用"}</Badge>
        </button>
      ))}</aside>
      <section className="pdf-panel">
        <div className="pdf-toolbar"><div><strong>{selected?.label || "附件预览"}</strong><span>{selected?.previewable ? "短期预览链接，有效期5分钟" : "当前文件不可在线预览"}</span></div><div>{selected?.previewable && <Button icon={<Eye24Regular />} onClick={() => preview.refetch()}>刷新预览</Button>}{selected?.status === "downloaded" && <Button icon={<ArrowDownload24Regular />} onClick={() => download(selected)}>下载</Button>}{preview.data?.url && <a href={preview.data.url} target="_blank" rel="noopener noreferrer"><Button icon={<Open24Regular />}>新窗口</Button></a>}</div></div>
        <div className="pdf-viewport">
          {!selected ? <NotConfigured title="请选择附件" detail="从左侧附件列表选择可预览文件。" /> : !selected.previewable ? <NotConfigured title="当前格式不可在线预览" detail="可下载原文件；DOCX同时提供PDF转换副本时请选择转换版。" /> : preview.isLoading ? <LoadingState label="正在申请短期预览链接" /> : preview.isError ? <ErrorState message={preview.error.message} retry={() => preview.refetch()} /> : preview.data ? <iframe src={preview.data.url} title={`${selected.label}预览`} /> : null}
        </div>
      </section>
    </div>
  );
}

function AuditTab({ cvId }: { cvId: string }) {
  const audit = useQuery({ queryKey: ["audit", cvId], queryFn: () => apiClient.audit(cvId) });
  if (audit.isLoading) return <LoadingState label="正在读取审计记录" />;
  if (audit.isError) return <ErrorState message={audit.error.message} retry={() => audit.refetch()} />;
  return <div className="audit-list">{audit.data?.items.length ? audit.data.items.map((item, index) => <div className="audit-row" key={String(item.id || index)}><span>{String(item.created_at || "")}</span><strong>{auditAction(String(item.action || ""))}</strong><small>{String(item.actor || "本地用户")}</small></div>) : <NotConfigured title="暂无审计记录" detail="预览、下载和人物查看操作会记录在这里。" />}</div>;
}

function auditAction(action: string): string {
  const labels: Record<string, string> = { VIEW_PERSON: "查看人物", PREVIEW_ATTACHMENT: "申请附件预览", STREAM_ATTACHMENT_PREVIEW: "在线预览附件", REQUEST_ATTACHMENT_DOWNLOAD: "申请附件下载", DOWNLOAD_ATTACHMENT: "下载附件" };
  return labels[action] || action;
}

function NotConfigured({ title, detail }: { title: string; detail: string }) {
  return <div className="not-configured"><Info24Regular aria-hidden="true" /><div><strong>{title}</strong><p>{detail}</p></div></div>;
}
