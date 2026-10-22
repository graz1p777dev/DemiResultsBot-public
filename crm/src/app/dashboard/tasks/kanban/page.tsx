import { getTasksData } from '@/actions/tasks-kanban'
import TasksBoard from '@/components/tasks/TasksBoard'

export const dynamic = 'force-dynamic'

export default async function TasksKanbanPage() {
  const { tasks, employees, departments, clients, me } = await getTasksData()

  if (!me) {
    return <div className="p-8 text-sm text-gray-400">Нет доступа</div>
  }

  return (
    <div>
      <TasksBoard
        initialTasks={tasks}
        employees={employees}
        departments={departments}
        clients={clients}
        me={me}
      />
    </div>
  )
}
