import { useQuery } from "@tanstack/react-query";
import { Badge } from "@fluentui/react-components";
import {
  Database24Regular,
  DocumentSearch24Regular,
  Info24Regular,
  Settings24Regular,
  ShieldCheckmark24Regular,
} from "@fluentui/react-icons";
import { apiClient } from "../api";

export function SettingsPage() {
  const research = useQuery({ queryKey: ["research-settings"], queryFn: apiClient.research });
  const providers = research.data?.providers;
  const scoringReady = Boolean(research.data?.policy);

  return (
    <div className="page-stack settings-page">
      <div className="page-heading"><div><h1>系统设置</h1><p>查看数据接入、安全控制、评分策略和研究服务的实际运行状态。</p></div></div>
      {research.isError && <div className="inline-error" role="alert">研究服务状态读取失败，数据源与附件安全设置仍可正常查看。</div>}
      <div className="settings-grid">
        <SettingCard icon={Database24Regular} title="Bayt数据源" status="已连接" active><p>平台以受控方式读取采集数据库和候选人文件目录。</p><ul><li>CV_ID作为人物唯一主键</li><li>Excel续行由后端统一归并</li><li>头像占位图不重复保存</li></ul></SettingCard>
        <SettingCard icon={ShieldCheckmark24Regular} title="附件安全" status="已启用" active><p>附件物理路径不会下发到前端，预览与下载均经过服务端授权。</p><ul><li>预览链接5分钟失效</li><li>预览与下载操作写入审计</li><li>文件只允许来自受控目录</li></ul></SettingCard>
        <SettingCard icon={Settings24Regular} title="评分规则" status={research.isPending ? "读取中" : scoringReady ? "已配置" : "不可用"} active={scoringReady}><p>{scoringReady ? `当前研究门槛为 ${research.data?.policy.threshold} 分，规则由服务端统一执行。` : "暂时无法读取评分策略。"}</p><ul><li>职业评分与研究结果独立保存</li><li>规则不使用国籍、年龄或性别</li><li>修改后从下一次任务开始生效</li></ul></SettingCard>
        <SettingCard icon={DocumentSearch24Regular} title="Tavily公开研究" status={research.isPending ? "读取中" : providers?.tavilyConfigured ? "已配置" : "未配置"} active={Boolean(providers?.tavilyConfigured)}><p>{providers?.tavilyConfigured ? "服务端已配置Tavily，仅对达到评分门槛的人物执行公开信息搜索。" : "Tavily当前未配置，不影响确定性职业评分。"}</p><ul><li>API Key不会下发到浏览器</li><li>低于门槛的人物不产生搜索请求</li><li>搜索证据与摘要保留来源关联</li></ul></SettingCard>
        <SettingCard icon={Info24Regular} title="DeepSeek辅助裁决" status={research.isPending ? "读取中" : providers?.deepseekConfigured ? "已配置" : "未配置"} active={Boolean(providers?.deepseekConfigured)}><p>{providers?.deepseekConfigured ? `当前模型：${providers.deepseekModel || "服务端默认模型"}。只在复杂证据冲突时调用。` : "DeepSeek当前未配置，规则评分与Tavily搜索仍可独立运行。"}</p><ul><li>只发送最小身份包</li><li>单次最多使用5条候选证据</li><li>不自动作出录用或淘汰决定</li></ul></SettingCard>
      </div>
    </div>
  );
}

function SettingCard({ icon: Icon, title, status, active, children }: { icon: React.ComponentType; title: string; status: string; active: boolean; children: React.ReactNode }) {
  const tone = active ? "success" : status === "读取中" ? "informative" : "warning";
  return <section className="setting-card"><div className="setting-card-head"><span><Icon /></span><div><h2>{title}</h2><Badge appearance="outline" color={tone}>{status}</Badge></div></div><div className="setting-card-body">{children}</div></section>;
}
