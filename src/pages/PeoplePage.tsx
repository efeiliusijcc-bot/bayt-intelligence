import { useEffect, useMemo, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { Badge, Button, Card, Input, Select, Tooltip } from "@fluentui/react-components";
import {
  ChevronRight24Regular,
  DocumentPdf24Regular,
  Grid24Regular,
  Image24Regular,
  Search24Regular,
  Table24Regular,
} from "@fluentui/react-icons";
import { Link, useSearchParams } from "react-router-dom";
import { apiClient, displayText } from "../api";
import { EmptyState, ErrorState, LoadingState } from "../components/PageStates";
import { CollectionSourceLinks } from "../components/CollectionSourceLinks";
import type { PersonView } from "../types";

export function PeoplePage() {
  const [searchParams, setSearchParams] = useSearchParams();
  const [queryText, setQueryText] = useState(searchParams.get("q") || "");
  const [view, setView] = useState<"cards" | "table">((searchParams.get("view") as "cards" | "table") || "cards");

  useEffect(() => {
    const normalizedQuery = queryText.trim();
    const currentQuery = searchParams.get("q") || "";
    if (normalizedQuery === currentQuery) return;
    const timeout = window.setTimeout(() => {
      const next = new URLSearchParams(searchParams);
      if (normalizedQuery) next.set("q", normalizedQuery);
      else next.delete("q");
      next.set("page", "1");
      setSearchParams(next, { replace: true });
    }, 300);
    return () => window.clearTimeout(timeout);
  }, [queryText, searchParams, setSearchParams]);

  const apiParams = useMemo(() => {
    const params = new URLSearchParams(searchParams);
    params.delete("view");
    if (!params.has("pageSize")) params.set("pageSize", "12");
    return params;
  }, [searchParams]);
  const people = useQuery({ queryKey: ["people", apiParams.toString()], queryFn: () => apiClient.people(apiParams) });

  const updateParam = (key: string, value: string) => {
    const next = new URLSearchParams(searchParams);
    if (value) next.set(key, value);
    else next.delete(key);
    if (key !== "page") next.set("page", "1");
    setSearchParams(next);
  };
  const updateView = (nextView: "cards" | "table") => {
    setView(nextView);
    const next = new URLSearchParams(searchParams);
    next.set("view", nextView);
    setSearchParams(next, { replace: true });
  };

  return (
    <div className="page-stack">
      <div className="page-heading people-heading">
        <div><h1>人物库</h1><p>以唯一CV_ID归并人物，集中查看资料、头像和附件。</p></div>
        <div className="heading-count">共 <strong>{people.data?.total ?? "-"}</strong> 人</div>
      </div>
      <section className="filter-panel" aria-label="人物筛选">
        <Input
          value={queryText}
          onChange={(_, data) => setQueryText(data.value)}
          contentBefore={<Search24Regular />}
          placeholder="搜索姓名、CV_ID、机构、职位或技能"
          aria-label="搜索人物"
        />
        <Select value={searchParams.get("nationality") || ""} onChange={(_, data) => updateParam("nationality", data.value)} aria-label="按国籍筛选">
          <option value="">全部国籍</option>
          {people.data?.facets.nationalities.map((item) => <option value={item} key={item}>{item}</option>)}
        </Select>
        <Select value={searchParams.get("attachment") || ""} onChange={(_, data) => updateParam("attachment", data.value)} aria-label="按附件筛选">
          <option value="">全部附件状态</option>
          <option value="bayt">有Bayt PDF</option>
          <option value="original">有原始附件</option>
          <option value="missing">附件缺失</option>
        </Select>
        <Select value={searchParams.get("sort") || "name"} onChange={(_, data) => updateParam("sort", data.value)} aria-label="人物排序">
          <option value="name">按姓名排序</option>
          <option value="updated">按简历更新时间</option>
        </Select>
        <div className="view-toggle" role="group" aria-label="列表视图">
          <Tooltip content="卡片视图" relationship="label"><Button appearance={view === "cards" ? "primary" : "subtle"} icon={<Grid24Regular />} aria-label="卡片视图" onClick={() => updateView("cards")} /></Tooltip>
          <Tooltip content="表格视图" relationship="label"><Button appearance={view === "table" ? "primary" : "subtle"} icon={<Table24Regular />} aria-label="表格视图" onClick={() => updateView("table")} /></Tooltip>
        </div>
      </section>

      {people.isLoading ? <LoadingState label="正在加载人物列表" /> : people.isError ? (
        <ErrorState message={people.error.message} retry={() => people.refetch()} />
      ) : !people.data?.items.length ? (
        <EmptyState title="没有符合条件的人物" detail="调整搜索词或筛选条件后重试。" />
      ) : view === "cards" ? (
        <div className="people-grid">{people.data.items.map((person) => <PersonCard key={person.cvId} person={person} />)}</div>
      ) : (
        <PeopleTable people={people.data.items} />
      )}
      {people.data && people.data.total > people.data.pageSize && (
        <Pagination page={people.data.page} pageSize={people.data.pageSize} total={people.data.total} onChange={(page) => updateParam("page", String(page))} />
      )}
    </div>
  );
}

function PersonAvatar({ person }: { person: PersonView }) {
  const initials = person.displayName.split(/\s+/).slice(0, 2).map((part) => part[0]).join("").toUpperCase();
  return (
    <div className="person-avatar">
      {person.hasAvatar ? <img src={`/api/v1/people/${person.cvId}/avatar`} alt={`${displayText(person.displayName)}头像`} loading="lazy" /> : <span>{initials || "CV"}</span>}
    </div>
  );
}

export function PersonCard({ person }: { person: PersonView }) {
  const hasBaytPdf = person.attachments.some((item) => item.kind === "bayt_pdf" && item.status === "downloaded");
  const hasOriginal = person.attachments.some((item) => item.kind === "original" && item.status === "downloaded");
  return (
    <Card className="person-card">
      <div className="person-card-head">
        <PersonAvatar person={person} />
        <div className="person-title"><Link to={`/people/${person.cvId}`}>{displayText(person.displayName)}</Link><span>{displayText(person.headline)}</span><small>{[person.nationality, person.residence].filter(Boolean).map((value) => displayText(value)).join(" / ") || "所在地未提供"}</small></div>
      </div>
      <div className="person-meta"><span>Bayt CV ID</span><strong>{person.cvId}</strong><span>简历更新</span><strong>{person.lastCvUpdate || "未提供"}</strong></div>
      <div className="person-collection-source"><span>采集任务</span><CollectionSourceLinks person={person} /></div>
      <div className="skill-tags">
        {person.topSkills.slice(0, 5).map((skill) => <Badge key={skill.name} appearance="tint" color="informative">{displayText(skill.name)}</Badge>)}
        {person.skills.length > 5 && <span className="more-skills">+{person.skills.length - 5}</span>}
      </div>
      <div className="person-counts"><span>{person.experiences.length} 段经历</span><span>{person.educations.length} 项教育</span><span>{person.languages.length} 种语言</span></div>
      <div className="score-pair">
        <div><span>职业匹配</span><strong>{person.professionalScore === null ? "未评分" : `${person.professionalScore} / 100`}</strong></div>
        <div><span>研究优先级</span><strong>{researchScoreLabel(person)}</strong></div>
      </div>
      <div className="attachment-state">
        <span className={hasBaytPdf ? "is-available" : ""}><DocumentPdf24Regular />Bayt PDF {hasBaytPdf ? "已绑定" : "缺失"}</span>
        <span className={hasOriginal ? "is-available" : ""}><Image24Regular />原始附件 {hasOriginal ? "可用" : "缺失"}</span>
      </div>
      <div className="person-card-actions"><Link to={`/people/${person.cvId}`}><Button appearance="primary" icon={<ChevronRight24Regular />} iconPosition="after">查看详情</Button></Link></div>
    </Card>
  );
}

function PeopleTable({ people }: { people: PersonView[] }) {
  return (
    <div className="data-table-wrap">
      <table className="data-table people-table">
        <thead><tr><th>人物</th><th>CV_ID</th><th>当前职位</th><th>所在地</th><th>来源任务</th><th>职业分</th><th>研究分</th><th>Bayt PDF</th><th>更新时间</th><th>操作</th></tr></thead>
        <tbody>{people.map((person) => (
          <tr key={person.cvId}>
            <td><div className="table-person"><PersonAvatar person={person} /><strong>{displayText(person.displayName)}</strong></div></td>
            <td className="mono">{person.cvId}</td>
            <td>{displayText(person.headline)}</td>
            <td>{displayText(person.residence)}</td>
            <td><CollectionSourceLinks person={person} /></td>
            <td>{person.professionalScore === null ? "未评分" : `${person.professionalScore} / 100`}</td><td>{researchScoreLabel(person)}</td>
            <td>{person.attachments.some((item) => item.kind === "bayt_pdf" && item.status === "downloaded") ? "已绑定" : "缺失"}</td>
            <td>{person.lastCvUpdate || "未提供"}</td>
            <td><Link to={`/people/${person.cvId}`}><Button appearance="subtle">查看</Button></Link></td>
          </tr>
        ))}</tbody>
      </table>
    </div>
  );
}

function researchScoreLabel(person: PersonView): string {
  if (person.professionalScore === null) return "未评分";
  if (person.researchPriorityScore !== null) return `${person.researchPriorityScore} / 100`;
  return person.enrichmentStatus === "NOT_ELIGIBLE" ? "未达门槛" : "待研究";
}

function Pagination({ page, pageSize, total, onChange }: { page: number; pageSize: number; total: number; onChange: (page: number) => void }) {
  const pages = Math.ceil(total / pageSize);
  return <div className="pagination"><Button disabled={page <= 1} onClick={() => onChange(page - 1)}>上一页</Button><span>第 {page} / {pages} 页</span><Button disabled={page >= pages} onClick={() => onChange(page + 1)}>下一页</Button></div>;
}
