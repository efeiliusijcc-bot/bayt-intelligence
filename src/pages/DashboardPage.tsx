import { useQuery } from "@tanstack/react-query";
import { Button, Skeleton, SkeletonItem, Tooltip } from "@fluentui/react-components";
import {
  ArrowReset24Regular,
  ArrowTrending24Regular,
  CalendarClock24Regular,
  CheckmarkCircle24Regular,
  Database24Regular,
  DocumentData24Regular,
  Lightbulb24Regular,
  PeopleTeam24Regular,
  PersonClock24Regular,
  ShieldCheckmark24Regular,
  Warning24Regular,
} from "@fluentui/react-icons";
import {
  DonutChart,
  HorizontalBarChartWithAxis,
  ResponsiveContainer,
  VerticalBarChart,
} from "@fluentui/react-charts";
import { useSearchParams } from "react-router-dom";
import { apiClient } from "../api";
import type { AnalyticsDistributionItem, AnalyticsOption, DashboardAnalyticsData } from "../types";

const FILTER_KEYS = ["batch", "source", "country", "updatedRange"] as const;
const BLUE = "#17699f";
const DONUT_COLORS = ["#0e5687", "#367aa5", "#5d94b6", "#82adc7", "#a9c7d9", "#c4d8e4", "#748596"];

export function DashboardPage() {
  const [searchParams, setSearchParams] = useSearchParams();
  const normalizedFilters = new URLSearchParams();
  for (const key of FILTER_KEYS) {
    const value = searchParams.get(key);
    if (value && value !== "all") normalizedFilters.set(key, value);
  }
  const filterKey = normalizedFilters.toString();
  const dashboard = useQuery({
    queryKey: ["dashboard-analytics", filterKey],
    queryFn: () => apiClient.dashboardAnalytics(normalizedFilters),
  });

  const updateFilter = (key: typeof FILTER_KEYS[number], value: string) => {
    const next = new URLSearchParams(searchParams);
    if (!value || value === "all") next.delete(key);
    else next.set(key, value);
    setSearchParams(next, { replace: false });
  };
  const resetFilters = () => setSearchParams(new URLSearchParams(), { replace: false });

  if (dashboard.isPending) return <DashboardSkeleton />;
  if (dashboard.isError || !dashboard.data) {
    return (
      <div className="dashboard-error page-state is-error" role="alert">
        <Warning24Regular aria-hidden="true" />
        <strong>人员画像暂时无法加载</strong>
        <p>{dashboard.error?.message || "统计接口不可用，请稍后重试。"}</p>
        <div><Button appearance="primary" onClick={() => dashboard.refetch()}>重试</Button><Button onClick={resetFilters}>重置筛选</Button></div>
      </div>
    );
  }

  const data = dashboard.data;
  const applied = data.scope.appliedFilters;
  const charts: Array<{ key: keyof DashboardAnalyticsData["distributions"]; title: string; type: "horizontal" | "donut" | "vertical"; className?: string }> = [
    { key: "countries", title: "国家/地区分布", type: "horizontal" },
    { key: "seniority", title: "职业层级分布", type: "donut" },
    { key: "functions", title: "职能方向 Top 10", type: "horizontal" },
    { key: "experience", title: "工作经验分布", type: "vertical" },
    { key: "skills", title: "高频技能 Top 15", type: "horizontal", className: "is-skills" },
    { key: "education", title: "学历分布", type: "donut", className: "is-education" },
    { key: "languages", title: "语言分布", type: "horizontal", className: "is-languages" },
    { key: "updated", title: "简历更新时间分布", type: "vertical", className: "is-updated" },
  ];

  return (
    <div className="dashboard-page" data-testid="analytics-dashboard">
      <header className="dashboard-heading">
        <div><h1>人员总体画像</h1><p>统一呈现当前已采集人员的结构、能力与数据完整度，帮助全面理解人才库现状。</p></div>
        <span><CalendarClock24Regular aria-hidden="true" />统计时间：{formatDateTime(data.generatedAt)}</span>
      </header>

      <section className="dashboard-filterbar" aria-label="人员画像筛选">
        <FilterSelect label="数据批次" value={applied.batch} options={data.filterOptions.batches} onChange={(value) => updateFilter("batch", value)} />
        <FilterSelect label="数据来源" value={applied.source} options={data.filterOptions.sources} onChange={(value) => updateFilter("source", value)} />
        <FilterSelect label="国家/地区" value={applied.country} options={data.filterOptions.countries} onChange={(value) => updateFilter("country", value)} />
        <FilterSelect label="简历更新时间" value={applied.updatedRange} options={data.filterOptions.updatedRanges} onChange={(value) => updateFilter("updatedRange", value)} />
        <Button appearance="secondary" icon={<ArrowReset24Regular />} onClick={resetFilters} disabled={FILTER_KEYS.every((key) => applied[key] === "all")}>重置筛选</Button>
      </section>

      <section className="analytics-kpi-grid" aria-label="关键指标">
        <KpiCard icon={PeopleTeam24Regular} tone="blue" label="人物总数" value={String(data.kpis.peopleTotal)} detail="已归并唯一 CV_ID" tooltip="筛选范围内的唯一候选人数" />
        <KpiCard icon={ShieldCheckmark24Regular} tone="green" label="资料完整率" value={formatPercent(data.kpis.coreCompletenessPercentage)} detail={`${data.kpis.coreComplete} / ${data.kpis.peopleTotal} 人完整9项核心资料`} tooltip="姓名、职位、国籍、居住地、学历、经历、技能、语言和简历更新时间全部齐全" />
        <KpiCard icon={DocumentData24Regular} tone="purple" label="原始附件覆盖" value={`${data.kpis.originalAvailable} / ${data.kpis.peopleTotal}`} detail={`覆盖率 ${formatPercent(data.kpis.originalCoveragePercentage)}`} tooltip={`Bayt标准PDF ${data.kpis.baytPdfAvailable}份；真实头像 ${data.kpis.avatarsAvailable}人`} />
        <KpiCard icon={ArrowTrending24Regular} tone="blue" label="近90天更新" value={String(data.kpis.updatedWithin90Days)} detail={`占比 ${formatPercent(data.kpis.updatedWithin90DaysPercentage)}`} tooltip="含今天、1-7天、8-30天及31-90天更新的简历" />
        <KpiCard icon={Lightbulb24Regular} tone="orange" label="研究候选" value="未启用" detail="尚未配置研究筛选" tooltip="研究与评分功能未配置，不产生模拟结果" muted />
        <KpiCard icon={PersonClock24Regular} tone="cyan" label="待人工复核" value={String(data.kpis.reviewPending)} detail={`占比 ${formatPercent(data.kpis.reviewPendingPercentage)}`} tooltip="核心资料不完整，或标准/原始附件映射缺失的人物" />
      </section>

      <section className="analytics-chart-grid" aria-label="人员画像统计图">
        {charts.map((chart) => (
          <ChartCard
            key={chart.key}
            title={chart.title}
            data={data.distributions[chart.key]}
            type={chart.type}
            className={chart.className}
            total={data.scope.peopleTotal}
            testId={`chart-${chart.key}`}
          />
        ))}
      </section>

      <section className="dashboard-footer-grid">
        <RecentBatches batches={data.recentBatches} />
        <ProcessingStages stages={data.processingStages} />
      </section>
      <p className="dashboard-generated-at">数据统计时间：{formatDateTime(data.generatedAt)}（北京时间）</p>
    </div>
  );
}

function FilterSelect({ label, value, options, onChange }: { label: string; value: string; options: AnalyticsOption[]; onChange: (value: string) => void }) {
  return (
    <label className="dashboard-filter">
      <span>{label}</span>
      <select aria-label={label} value={value} onChange={(event) => onChange(event.target.value)}>
        {options.map((option) => <option key={option.value} value={option.value}>{option.label}</option>)}
      </select>
    </label>
  );
}

function KpiCard({ icon: Icon, tone, label, value, detail, tooltip, muted = false }: {
  icon: typeof PeopleTeam24Regular;
  tone: "blue" | "green" | "purple" | "orange" | "cyan";
  label: string;
  value: string;
  detail: string;
  tooltip: string;
  muted?: boolean;
}) {
  return (
    <article className={`analytics-kpi-card tone-${tone}`}>
      <span className="analytics-kpi-icon"><Icon aria-hidden="true" /></span>
      <div><span className="analytics-kpi-label">{label}</span><strong className={muted ? "is-muted" : ""}>{value}</strong><small>{detail}</small></div>
      <Tooltip content={tooltip} relationship="description"><button className="kpi-info" type="button" aria-label={`${label}口径说明`}>i</button></Tooltip>
    </article>
  );
}

function ChartCard({ title, data, type, className = "", total, testId }: {
  title: string;
  data: AnalyticsDistributionItem[];
  type: "horizontal" | "donut" | "vertical";
  className?: string;
  total: number;
  testId: string;
}) {
  const hasData = total > 0 && data.some((item) => item.count > 0);
  const summary = data.filter((item) => item.count > 0).map((item) => `${item.label}${item.count}人，占${formatPercent(item.percentage)}`).join("；");
  return (
    <article className={`analytics-chart-card ${className}`} data-testid={testId}>
      <header><h2>{title}</h2><span>单位：人</span></header>
      <p className="sr-only" data-testid={`${testId}-summary`}>{hasData ? `${title}：${summary}` : `${title}：当前筛选下暂无数据`}</p>
      {!hasData ? <div className="chart-empty"><Database24Regular aria-hidden="true" /><span>当前筛选下暂无数据</span></div> : (
        <div className={`chart-scroll ${type === "donut" ? "is-donut" : ""}`}>
          <div className={`chart-stage chart-${type}`}>
            {type === "horizontal" && (
              <ResponsiveContainer width="100%" height="100%" minWidth={330} minHeight={150}>
                <HorizontalBarChartWithAxis
                  data={[...data].reverse().map((item) => ({
                    x: item.count,
                    y: item.label,
                    legend: item.label,
                    color: BLUE,
                    xAxisCalloutData: `${item.count} 人（${formatPercent(item.percentage)}）`,
                    yAxisCalloutData: item.label,
                    barLabel: `${item.count}`,
                    callOutAccessibilityData: { ariaLabel: `${item.label} ${item.count}人，占${formatPercent(item.percentage)}` },
                  }))}
                  yAxisPadding={0.35}
                  colors={[BLUE]}
                  useSingleColor
                  hideLegend
                  showYAxisLables
                  showYAxisLablesTooltip
                  noOfCharsToTruncate={data.length > 10 ? 18 : 12}
                  xAxisTickCount={4}
                  margins={{ top: 8, right: 28, bottom: 24, left: data.length > 10 ? 132 : 94 }}
                  reflowProps={{ mode: "min-width" }}
                />
              </ResponsiveContainer>
            )}
            {type === "vertical" && (
              <ResponsiveContainer width="100%" height="100%" minWidth={420} minHeight={150}>
                <VerticalBarChart
                  data={data.map((item) => ({
                    x: item.label,
                    y: item.count,
                    legend: item.label,
                    color: BLUE,
                    xAxisCalloutData: item.label,
                    yAxisCalloutData: `${item.count} 人（${formatPercent(item.percentage)}）`,
                    barLabel: String(item.count),
                    callOutAccessibilityData: { ariaLabel: `${item.label} ${item.count}人，占${formatPercent(item.percentage)}` },
                  }))}
                  colors={[BLUE]}
                  useSingleColor
                  hideLegend
                  barWidth="auto"
                  yAxisTickCount={4}
                  xAxis={{ tickLayout: "auto" }}
                  margins={{ top: 18, right: 12, bottom: 34, left: 34 }}
                  reflowProps={{ mode: "min-width" }}
                />
              </ResponsiveContainer>
            )}
            {type === "donut" && (
              <div className="donut-layout">
                <div className="donut-visual">
                  <ResponsiveContainer width="100%" height="100%" minWidth={90} minHeight={110}>
                    <DonutChart
                      data={{
                        chartTitle: title,
                        chartData: data.map((item, index) => ({
                          legend: `${item.label}  ${item.count}（${formatPercent(item.percentage)}）`,
                          data: item.count,
                          color: DONUT_COLORS[index % DONUT_COLORS.length],
                          xAxisCalloutData: item.label,
                          yAxisCalloutData: `${item.count} 人（${formatPercent(item.percentage)}）`,
                          callOutAccessibilityData: { ariaLabel: `${item.label} ${item.count}人，占${formatPercent(item.percentage)}` },
                        })),
                      }}
                      innerRadius={30}
                      valueInsideDonut={total}
                      hideLabels
                      hideLegend
                      height={132}
                      width={132}
                    />
                  </ResponsiveContainer>
                </div>
                <ul className="donut-legend" aria-label={`${title}图例`}>
                  {data.map((item, index) => (
                    <li key={item.key}><span style={{ backgroundColor: DONUT_COLORS[index % DONUT_COLORS.length] }} aria-hidden="true" /><strong>{item.label}</strong><em>{item.count}（{formatPercent(item.percentage)}）</em></li>
                  ))}
                </ul>
              </div>
            )}
          </div>
        </div>
      )}
      {hasData && type !== "donut" && <div className="chart-legend"><span aria-hidden="true" />人数（悬停查看占比）</div>}
    </article>
  );
}

function RecentBatches({ batches }: { batches: DashboardAnalyticsData["recentBatches"] }) {
  return (
    <article className="dashboard-bottom-card recent-batches-card">
      <header><div><h2>最近导入/采集批次</h2><p>仅显示已完成且目标人数不少于50人的正式批次。</p></div><a href="/imports">查看全部 ›</a></header>
      {batches.length ? (
        <div className="recent-batches-table" role="table" aria-label="最近采集批次">
          <div role="row" className="recent-batch-head"><span role="columnheader">批次名称</span><span role="columnheader">来源</span><span role="columnheader">完成时间</span><span role="columnheader">新增</span><span role="columnheader">去重后</span><span role="columnheader">完整率</span><span role="columnheader">状态</span></div>
          {batches.map((batch) => (
            <div role="row" className="recent-batch-row" key={batch.id}>
              <span role="cell"><strong>{batch.label}</strong><small>{batch.query}</small></span>
              <span role="cell">Bayt采集</span>
              <span role="cell">{formatDateTime(batch.completedAt)}</span>
              <span role="cell">{batch.addedCount}</span>
              <span role="cell">{batch.deduplicatedTotal}</span>
              <span role="cell">{formatPercent(batch.completenessPercentage)}</span>
              <span role="cell"><em><CheckmarkCircle24Regular aria-hidden="true" />已完成</em></span>
            </div>
          ))}
        </div>
      ) : <div className="chart-empty"><Database24Regular aria-hidden="true" /><span>暂无符合条件的正式批次</span></div>}
    </article>
  );
}

function ProcessingStages({ stages }: { stages: DashboardAnalyticsData["processingStages"] }) {
  return (
    <article className="dashboard-bottom-card processing-card">
      <header><div><h2>数据处理状态</h2><p>状态直接来自当前数据库与文件映射结果。</p></div></header>
      <div className="processing-stage-grid">
        {stages.map((stage) => (
          <div key={stage.id} className={`processing-stage is-${stage.status}`}>
            <span>{stage.status === "healthy" ? <CheckmarkCircle24Regular aria-hidden="true" /> : <Warning24Regular aria-hidden="true" />}</span>
            <strong>{stage.label}</strong>
            <em>{stage.status === "healthy" ? "正常" : "待复核"}</em>
            <small>{stage.summary}</small>
          </div>
        ))}
      </div>
    </article>
  );
}

function DashboardSkeleton() {
  return (
    <div className="dashboard-page" aria-label="正在加载人员画像">
      <Skeleton className="dashboard-heading-skeleton"><SkeletonItem size={28} /><SkeletonItem size={12} /></Skeleton>
      <Skeleton className="dashboard-filterbar skeleton-filterbar"><SkeletonItem /><SkeletonItem /><SkeletonItem /><SkeletonItem /><SkeletonItem /></Skeleton>
      <div className="analytics-kpi-grid">{Array.from({ length: 6 }, (_, index) => <Skeleton key={index} className="analytics-kpi-card skeleton-card"><SkeletonItem shape="circle" size={32} /><SkeletonItem /><SkeletonItem /></Skeleton>)}</div>
      <div className="analytics-chart-grid">{Array.from({ length: 8 }, (_, index) => <Skeleton key={index} className="analytics-chart-card skeleton-chart"><SkeletonItem size={16} /><SkeletonItem /></Skeleton>)}</div>
      <div className="dashboard-footer-grid"><Skeleton className="dashboard-bottom-card skeleton-bottom"><SkeletonItem /><SkeletonItem /></Skeleton><Skeleton className="dashboard-bottom-card skeleton-bottom"><SkeletonItem /><SkeletonItem /></Skeleton></div>
    </div>
  );
}

function formatPercent(value: number): string {
  return `${value.toFixed(1)}%`;
}

function formatDateTime(value: string): string {
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return value;
  return new Intl.DateTimeFormat("zh-CN", {
    timeZone: "Asia/Shanghai",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    hour12: false,
  }).format(date).replaceAll("/", "-");
}
