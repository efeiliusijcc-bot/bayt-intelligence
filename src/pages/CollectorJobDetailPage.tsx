import { useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { Badge, Button } from "@fluentui/react-components";
import { ArrowLeft24Regular, DocumentPdf24Regular } from "@fluentui/react-icons";
import { Link, useParams } from "react-router-dom";
import { apiClient, displayText } from "../api";
import { EmptyState, ErrorState, LoadingState } from "../components/PageStates";

export function CollectorJobDetailPage() {
  const { jobId = "" } = useParams();
  const [page, setPage] = useState(1);
  const [selectedCvId, setSelectedCvId] = useState("");
  const job = useQuery({ queryKey: ["collector-job", jobId], queryFn: () => apiClient.collectorJob(jobId), enabled: Boolean(jobId), refetchInterval: 15_000 });
  const people = useQuery({ queryKey: ["collector-job-people", jobId, page], queryFn: () => apiClient.collectorJobPeople(jobId, page), enabled: Boolean(jobId), refetchInterval: 15_000 });
  const preview = useQuery({ queryKey: ["collector-job-pdf", jobId, selectedCvId],
    queryFn: () => apiClient.previewUrl(`${jobId}:${selectedCvId}`), enabled: Boolean(jobId && selectedCvId), staleTime: 4 * 60_000 });
  if (job.isLoading || people.isLoading) return <LoadingState label="正在加载采集任务简历" />;
  if (job.isError || people.isError || !job.data || !people.data)
    return <ErrorState message={job.error?.message || people.error?.message || "采集任务不可用"} retry={() => { void job.refetch(); void people.refetch(); }} />;
  const current = job.data;
  const result = people.data;
  const maxPage = Math.max(1, Math.ceil(result.total / result.pageSize));
  return <div className="page-stack collector-job-detail">
    <Link to="/collector" className="back-link"><ArrowLeft24Regular />返回采集任务</Link>
    <div className="page-heading"><div><h1>{current.name}</h1><p>{current.searchSpec.keyword || current.searchSpec.name || "高级筛选"} · {current.id}</p></div><Badge appearance="tint">{current.status}</Badge></div>
    <section className="section-panel">
      <p>本机已校验 {current.collectedCount ?? current.exportedCount} 人；已上传 {current.uploadedCount} 页，待上传 {Math.max(0, (current.collectedPages ?? current.completedPages) - current.uploadedCount)} 页。{current.collectionFinishedAt ? "采集已结束，上传和入库独立继续。" : ""}</p>
      {current.deliveryError && <div className="inline-error" role="alert">{current.deliveryError}</div>}
      <div className="section-heading"><div><h2>简历复核</h2><p>只列出 108 已完成校验入库、且 Bayt PDF 可用的人物。点击人物可直接打开简历附件。</p></div></div>
      <div className="collector-review-stats"><div><span>已导出检查点</span><strong>{result.exportedCount}</strong></div><div><span>待入库人数</span><strong>{result.pendingImportCount}</strong></div><div><span>可复核人数</span><strong>{result.total}</strong></div><div><span>待处理／阻断页</span><strong>{result.pendingPages}／{result.blockedPages}</strong></div></div>
      {!result.items.length ? <EmptyState title="暂无可复核简历" detail="任务未产生已展示页面时，不会把未入库或PDF缺失的人物计入成果。" /> :
        <div className="data-table-wrap"><table className="data-table"><thead><tr><th>人物</th><th>CV_ID</th><th>当前职位</th><th>页码</th><th>入库时间</th><th>简历</th></tr></thead><tbody>{result.items.map(({ person, page: sourcePage, importedAt }) =>
          <tr key={person.cvId}><td><Link className="collector-job-link" to={`/people/${encodeURIComponent(person.cvId)}`}>{displayText(person.displayName)}</Link></td><td className="mono">{person.cvId}</td><td>{displayText(person.headline)}</td><td>第 {sourcePage} 页</td><td>{new Date(importedAt).toLocaleString("zh-CN")}</td><td><Button size="small" icon={<DocumentPdf24Regular />} onClick={() => setSelectedCvId(person.cvId)}>复核本任务PDF</Button></td></tr>)}</tbody></table></div>}
      {selectedCvId && <div className="collector-job-pdf"><div><strong>CV_ID {selectedCvId} · 本任务原始批次PDF</strong><Button size="small" onClick={() => void preview.refetch()}>刷新预览</Button></div>
        {preview.isLoading ? <LoadingState label="正在申请PDF预览" /> : preview.isError ? <ErrorState message={preview.error.message} retry={() => void preview.refetch()} /> : preview.data ? <iframe src={preview.data.url} title={`CV_ID ${selectedCvId} 任务简历预览`} /> : null}</div>}
      {result.total > result.pageSize && <div className="pagination"><Button disabled={page <= 1} onClick={() => setPage(page - 1)}>上一页</Button><span>第 {page} / {maxPage} 页</span><Button disabled={page >= maxPage} onClick={() => setPage(page + 1)}>下一页</Button></div>}
    </section>
  </div>;
}
