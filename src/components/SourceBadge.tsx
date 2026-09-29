import { Badge } from "@fluentui/react-components";

const labels: Record<string, string> = {
  EXCEL: "Excel",
  BAYT_PROFILE: "Bayt 页面",
  PDF: "PDF",
  MANUAL: "人工确认",
};

export function SourceBadge({ source }: { source: string }) {
  return <Badge appearance="tint" color="informative" size="small">{labels[source] || source}</Badge>;
}
