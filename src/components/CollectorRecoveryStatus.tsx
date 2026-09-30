import type { CollectionQueueJob } from "../types";

export function CollectorRecoveryStatus({ recovery }: { recovery: CollectionQueueJob["recovery"] }) {
  if (!recovery) return null;
  const label = recovery.stage === "manual_required" ? "需要人工处理" : recovery.stage === "probing" ?
    recovery.kind === "verification" ? "正在自动验证" : "正在检查官网是否恢复" :
    recovery.kind === "rate_limit" ? "官网限流，自动等待" : "等待自动验证";
  const minutes = Math.max(0, Math.floor((Date.now() - Date.parse(recovery.startedAt)) / 60_000));
  return <div role="status" className="table-subtext"><strong>{label}</strong>
    <span> · 已等待 {minutes} 分钟 · 已检查 {recovery.attempts} 次</span>
    {recovery.stage !== "manual_required" && <span> · 下次检查 {new Date(recovery.nextCheckAt).toLocaleString("zh-CN", { timeZone: "Asia/Shanghai" })}（北京时间）；无需点击恢复</span>}
  </div>;
}
