import { Link } from "react-router-dom";
import type { PersonView } from "../types";

export function CollectionSourceLinks({ person }: { person: PersonView }) {
  const tasks = person.collectionTasks || [];
  return <span className="collection-sources">
    {tasks.length ? tasks.map((task) => <Link key={task.id} to={`/collector/jobs/${encodeURIComponent(task.id)}`} title={`第 ${task.page} 页采集`}>
      {task.name}
    </Link>) : <span>未知来源</span>}
  </span>;
}
