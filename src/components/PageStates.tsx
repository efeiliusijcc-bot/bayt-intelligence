import { Button, Spinner } from "@fluentui/react-components";
import { ErrorCircle24Regular, FolderOpen24Regular } from "@fluentui/react-icons";

export function LoadingState({ label = "正在加载数据" }: { label?: string }) {
  return <div className="page-state"><Spinner label={label} size="medium" /></div>;
}

export function ErrorState({ message, retry }: { message: string; retry?: () => void }) {
  return (
    <div className="page-state is-error" role="alert">
      <ErrorCircle24Regular aria-hidden="true" />
      <strong>数据加载失败</strong>
      <p>{message}</p>
      {retry && <Button onClick={retry}>重新加载</Button>}
    </div>
  );
}

export function EmptyState({ title, detail, action }: { title: string; detail: string; action?: React.ReactNode }) {
  return (
    <div className="page-state is-empty">
      <FolderOpen24Regular aria-hidden="true" />
      <strong>{title}</strong>
      <p>{detail}</p>
      {action}
    </div>
  );
}
