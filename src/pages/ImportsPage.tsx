import { useState, type FormEvent } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Badge, Button, Input, ProgressBar } from "@fluentui/react-components";
import {
  ArrowUpload24Regular,
  CheckmarkCircle24Regular,
  ChevronRight24Regular,
  Document24Regular,
  Info24Regular,
  Warning24Regular,
} from "@fluentui/react-icons";
import { Link, useParams } from "react-router-dom";
import { apiClient, displayText } from "../api";
import { EmptyState, ErrorState, LoadingState } from "../components/PageStates";
import type { ImportBatch } from "../types";

export function ImportsPage() {
  const queryClient = useQueryClient();
  const imports = useQuery({ queryKey: ["imports"], queryFn: apiClient.imports });
  const incoming = useQuery({ queryKey: ["incoming-batches"], queryFn: apiClient.incomingBatches, refetchInterval: 30_000 });
  const [showUpload, setShowUpload] = useState(false);
  const [result, setResult] = useState<ImportBatch | null>(null);
  const preflight = useMutation({
    mutationFn: apiClient.preflight,
    onSuccess: (batch) => {
      setResult(batch);
      queryClient.invalidateQueries({ queryKey: ["imports"] });
      queryClient.invalidateQueries({ queryKey: ["dashboard"] });
    },
  });
  const submit = (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    preflight.mutate(new FormData(event.currentTarget));
  };
  return (
    <div className="page-stack">
      <div className="page-heading"><div><h1>导入任务</h1><p>上传Excel和PDF ZIP，先完成CV_ID与附件完整性预检。</p></div><Button appearance="primary" icon={<ArrowUpload24Regular />} onClick={() => { setShowUpload((value) => !value); setResult(null); }}>新建导入</Button></div>
      {showUpload && (
        <section className="section-panel import-wizard">
          <div className="wizard-steps"><span className="is-active">上传文件</span><span>数据预检</span><span>确认导入</span><span>处理完成</span></div>
          <form onSubmit={submit} className="upload-form">
            <label><span>批次名称</span><Input name="name" defaultValue="Bayt 人物导入" maxLength={80} /></label>
            <label className="file-drop"><Document24Regular /><strong>Excel 文件</strong><span>支持Bayt导出的XLS或XLSX，最大30MB</span><input type="file" name="excel" accept=".xls,.xlsx" required /></label>
            <label className="file-drop"><Document24Regular /><strong>ZIP 附件包</strong><span>仅识别带CV_ID的PDF，最大30MB</span><input type="file" name="attachments" accept=".zip,application/zip" required /></label>
            {preflight.isError && <div className="inline-error"><Warning24Regular />{preflight.error.message}</div>}
            <div className="form-actions"><Button type="button" onClick={() => setShowUpload(false)}>取消</Button><Button type="submit" appearance="primary" disabled={preflight.isPending}>{preflight.isPending ? "正在预检" : "开始预检"}</Button></div>
          </form>
          {preflight.isPending && <div className="preflight-progress"><ProgressBar /><span>正在解析Excel并检查ZIP内PDF完整性，请稍候。</span></div>}
          {result && <><PreflightSummary batch={result} /><div className="preflight-next"><span>预检结果已保存，请进入批次详情确认导入。</span><Link to={`/imports/${result.id}`}><Button appearance="primary" icon={<ChevronRight24Regular />} iconPosition="after">进入确认</Button></Link></div></>}
        </section>
      )}
      <section className="section-panel">
        <div className="section-heading"><div><h2>本机采集接收状态</h2><p>整页校验后自动接收、入库和展示；不触发公开研究。</p></div></div>
        {incoming.isLoading ? <LoadingState label="正在读取接收状态" /> : incoming.isError ?
          <ErrorState message={incoming.error.message} retry={() => incoming.refetch()} /> : incoming.data?.items.length ?
          <div className="batch-list">{incoming.data.items.map((item) => (
            <div className="batch-row" key={`${item.runId}/${item.page}`}>
              <span className="batch-row-main"><strong>{item.runId} · 第 {item.page} 页</strong><span>{item.reason || `更新时间 ${new Date(item.updatedAt).toLocaleString("zh-CN")}`}</span></span>
              <div><span>简历</span><strong>{item.count}</strong></div>
              <Badge appearance="tint" color={item.status === "displayed" ? "success" : item.status === "blocked" ? "danger" : "informative"}>
                {{ pending: "待处理", processing: "处理中", displayed: "已展示", blocked: "已阻断" }[item.status]}
              </Badge>
              {item.importBatchId && <Link to={`/imports/${item.importBatchId}`}>查看批次</Link>}
            </div>
          ))}</div> : <EmptyState title="暂无本机批次" detail="本机上传完整一页后会自动出现在这里。" />}
      </section>
      <section className="section-panel">
        <div className="section-heading"><div><h2>导入批次</h2><p>内置样本批次只用于展示真实50/50预检结果。</p></div></div>
        {imports.isLoading ? <LoadingState label="正在加载导入批次" /> : imports.isError ? <ErrorState message={imports.error.message} retry={() => imports.refetch()} /> : imports.data?.items.length ? (
          <div className="batch-list">{imports.data.items.map((batch) => <BatchRow key={batch.id} batch={batch} />)}</div>
        ) : <EmptyState title="还没有导入批次" detail="创建批次后，预检结果会显示在这里。" />}
      </section>
    </div>
  );
}

function BatchRow({ batch }: { batch: ImportBatch }) {
  const clean = batch.missingAttachmentCount + batch.extraAttachmentCount + batch.duplicatedCvIdCount + batch.invalidPdfCount === 0;
  return (
    <Link to={`/imports/${batch.id}`} className="batch-row">
      <span className={`batch-row-icon ${clean ? "is-success" : "is-warning"}`}>{clean ? <CheckmarkCircle24Regular /> : <Warning24Regular />}</span>
      <div className="batch-row-main"><strong>{batch.name}</strong><span>{batch.id} / {new Date(batch.createdAt).toLocaleString("zh-CN")}</span></div>
      <div><span>Excel人物</span><strong>{batch.excelPersonCount}</strong></div><div><span>PDF</span><strong>{batch.attachmentCount}</strong></div><div><span>匹配</span><strong>{batch.matchedCount}</strong></div><div><span>差异</span><strong>{batch.missingAttachmentCount + batch.extraAttachmentCount}</strong></div>
      <Badge color={batch.status === "COMPLETED" ? "success" : "informative"} appearance="tint">{batch.status === "COMPLETED" ? "已完成" : "预检通过"}</Badge><ChevronRight24Regular />
    </Link>
  );
}

export function ImportBatchPage() {
  const { batchId = "" } = useParams();
  const queryClient = useQueryClient();
  const batch = useQuery({ queryKey: ["import", batchId], queryFn: () => apiClient.importBatch(batchId), enabled: Boolean(batchId) });
  const commit = useMutation({
    mutationFn: () => apiClient.commitImport(batchId),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["import", batchId] });
      queryClient.invalidateQueries({ queryKey: ["imports"] });
      queryClient.invalidateQueries({ queryKey: ["people"] });
      queryClient.invalidateQueries({ queryKey: ["dashboard"] });
    },
  });
  if (batch.isLoading) return <LoadingState label="正在加载批次详情" />;
  if (batch.isError || !batch.data) return <ErrorState message={batch.error?.message || "批次不可用"} retry={() => batch.refetch()} />;
  const data = batch.data;
  const blocking = data.issues.some((issue) => issue.level === "BLOCKING");
  return (
    <div className="page-stack">
      <div className="page-heading"><div><Link to="/imports" className="back-link">返回导入任务</Link><h1>{data.name}</h1><p>{data.id} / 创建于 {new Date(data.createdAt).toLocaleString("zh-CN")}</p></div>{data.source === "USER_UPLOAD" && data.status === "READY" && <Button appearance="primary" disabled={blocking || commit.isPending} onClick={() => commit.mutate()}>{commit.isPending ? "正在导入" : "确认导入"}</Button>}</div>
      {data.source === "BUILT_IN_SAMPLE" && <div className="inline-notice"><Info24Regular /><span>这是已验证的50人真实预检样本，不会提交到当前人物库。需要入库时请在“新建导入”中重新上传文件。</span></div>}
      {commit.isError && <div className="inline-error"><Warning24Regular />{commit.error.message}</div>}
      <PreflightSummary batch={data} />
      <section className="section-panel"><div className="section-heading"><div><h2>人物与PDF匹配</h2><p>使用CV_ID进行唯一匹配，不以姓名作为主键。</p></div><Badge appearance="outline">{data.matches.length} 条</Badge></div><MatchTable batch={data} /></section>
    </div>
  );
}

function PreflightSummary({ batch }: { batch: ImportBatch }) {
  const stats = [
    ["Excel中人物", batch.excelPersonCount], ["Excel唯一CV_ID", batch.excelUniqueCvIdCount], ["ZIP中PDF", batch.attachmentCount], ["ZIP唯一CV_ID", batch.attachmentUniqueCvIdCount], ["成功匹配", batch.matchedCount], ["缺少附件", batch.missingAttachmentCount], ["多余附件", batch.extraAttachmentCount], ["重复CV_ID", batch.duplicatedCvIdCount], ["无效PDF", batch.invalidPdfCount],
  ];
  const allClear = batch.issues.length === 0;
  return (
    <section className="preflight-summary">
      <div className="preflight-head"><span className={allClear ? "is-success" : "is-warning"}>{allClear ? <CheckmarkCircle24Regular /> : <Warning24Regular />}</span><div><h2>{allClear ? "预检通过" : "预检完成，存在问题"}</h2><p>{allClear ? "Excel与PDF已按CV_ID完整匹配，可以进入导入。" : "请先处理阻塞问题，警告项可按业务判断继续。"}</p></div></div>
      <div className="preflight-stats">{stats.map(([label, value]) => <div key={String(label)}><span>{label}</span><strong>{value}</strong></div>)}</div>
      {batch.issues.length > 0 && <div className="issue-list">{batch.issues.map((issue) => <div key={issue.code} className={issue.level === "BLOCKING" ? "is-blocking" : "is-warning"}><Warning24Regular /><span><strong>{issue.code}</strong>{issue.message}</span></div>)}</div>}
    </section>
  );
}

function MatchTable({ batch }: { batch: ImportBatch }) {
  return <div className="data-table-wrap"><table className="data-table"><thead><tr><th>CV_ID</th><th>Excel人物</th><th>PDF文件</th><th>匹配方式</th><th>状态</th></tr></thead><tbody>{batch.matches.map((match) => <tr key={match.cvId}><td className="mono">{match.cvId}</td><td>{displayText(match.displayName, "未提供姓名")}</td><td className="file-cell">{displayText(match.pdfFile, "缺失")}</td><td>{match.method === "CV_ID_EXACT" ? "CV_ID精确匹配" : "未匹配"}</td><td><Badge appearance="tint" color={match.status === "SUCCESS" ? "success" : "danger"}>{match.status === "SUCCESS" ? "成功" : "缺失"}</Badge></td></tr>)}</tbody></table></div>;
}
