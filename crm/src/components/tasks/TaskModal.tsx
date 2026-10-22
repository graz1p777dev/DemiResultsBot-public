'use client'

import { useState, useTransition } from 'react'
import { X, Trash2 } from 'lucide-react'
import { toast } from 'sonner'
import { Button } from '../ui/button'
import { Input } from '../ui/input'
import { Label } from '../ui/label'
import { Textarea } from '../ui/textarea'
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '../ui/select'
import Modal from '../Modal'
import { createTask, updateTask, deleteTask } from '@/actions/tasks-kanban'
import type {
  TaskWithRelations,
  TaskEmployee,
  TaskStatus,
  TaskPriority,
  TaskViewer,
} from '@/types'
import {
  TASK_COLUMNS,
  TASK_PRIORITY,
  TASK_PRIORITY_ORDER,
} from './task-config'

interface Props {
  task: TaskWithRelations | null
  isNew: boolean
  defaultStatus?: TaskStatus
  employees: TaskEmployee[]
  departments: { id: string; name: string }[]
  me: TaskViewer
  onClose: () => void
  onSaved: () => void
}

interface FormState {
  title: string
  description: string
  status: TaskStatus
  priority: TaskPriority
  assignee_id: string
  due_date: string
}

export default function TaskModal({
  task,
  isNew,
  defaultStatus,
  employees,
  me,
  onClose,
  onSaved,
}: Props) {
  const [isPending, startTransition] = useTransition()
  const [isDeleting, setIsDeleting] = useState(false)
  const canDelete = !isNew && (me.role === 'owner' || task?.created_by === me.id)

  const [form, setForm] = useState<FormState>(() => ({
    title: task?.title ?? '',
    description: task?.description ?? '',
    status: task?.status ?? defaultStatus ?? 'todo',
    priority: task?.priority ?? 'medium',
    assignee_id: task?.assignee_id ?? '',
    due_date: task?.due_date ?? '',
  }))

  const set = <K extends keyof FormState>(k: K, v: FormState[K]) =>
    setForm((f) => ({ ...f, [k]: v }))

  const selectedAssignee = employees.find((employee) => employee.id === form.assignee_id)

  const handleSave = () => {
    if (!form.title.trim()) {
      toast.error('Введите название задачи')
      return
    }
    const payload = {
      title: form.title,
      description: form.description || null,
      status: form.status,
      priority: form.priority,
      visibility: 'private' as const,
      assignee_id: form.assignee_id || null,
      department_id: null,
      due_date: form.due_date || null,
      member_ids: [],
    }
    startTransition(async () => {
      const res = isNew
        ? await createTask(payload)
        : await updateTask(task!.id, payload)
      if (res.success) {
        toast.success(isNew ? 'Задача создана' : 'Изменения сохранены')
        onSaved()
        onClose()
      } else {
        toast.error(res.error)
      }
    })
  }

  const handleDelete = () => {
    if (!task) return
    startTransition(async () => {
      const res = await deleteTask(task.id)
      if (res.success) {
        toast.success('Задача удалена')
        onSaved()
        onClose()
      } else {
        toast.error(res.error)
      }
    })
  }

  return (
    <Modal onClose={onClose}>
      <div className="flex max-h-[88vh] w-[min(560px,92vw)] flex-col overflow-hidden rounded-2xl bg-white shadow-2xl">
        {/* Шапка */}
        <div className="flex items-center justify-between border-b border-gray-100 px-6 py-4">
          <h2 className="text-base font-bold text-gray-900">
            {isNew ? 'Новая задача' : 'Задача'}
          </h2>
          <button
            onClick={onClose}
            className="rounded-lg p-1.5 text-gray-400 transition-colors hover:bg-gray-100 hover:text-gray-600"
          >
            <X size={18} />
          </button>
        </div>

        {/* Тело */}
        <div className="flex-1 space-y-4 overflow-y-auto px-6 py-5 scroll-hidden">
          <div className="space-y-1.5">
            <Label>Название</Label>
            <Input
              autoFocus
              value={form.title}
              onChange={(e) => set('title', e.target.value)}
              placeholder="Что нужно сделать?"
              maxLength={300}
            />
          </div>

          <div className="space-y-1.5">
            <Label>Описание</Label>
            <Textarea
              value={form.description}
              onChange={(e) => set('description', e.target.value)}
              placeholder="Детали, ссылки, критерии готовности…"
              rows={3}
            />
          </div>

          <div className="grid grid-cols-2 gap-3">
            <div className="space-y-1.5">
              <Label>Этап</Label>
              <Select value={form.status} onValueChange={(v) => set('status', v as TaskStatus)}>
                <SelectTrigger><SelectValue /></SelectTrigger>
                <SelectContent>
                  {TASK_COLUMNS.map((c) => (
                    <SelectItem key={c.key} value={c.key}>{c.label}</SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
            <div className="space-y-1.5">
              <Label>Приоритет</Label>
              <Select value={form.priority} onValueChange={(v) => set('priority', v as TaskPriority)}>
                <SelectTrigger><SelectValue /></SelectTrigger>
                <SelectContent>
                  {TASK_PRIORITY_ORDER.map((p) => (
                    <SelectItem key={p} value={p}>{TASK_PRIORITY[p].label}</SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
          </div>

          <div className="grid grid-cols-2 gap-3">
            <div className="space-y-1.5">
              <Label>Исполнитель</Label>
              <Select
                value={form.assignee_id || 'none'}
                onValueChange={(v) => set('assignee_id', v && v !== 'none' ? v : '')}
              >
                <SelectTrigger>
                  <SelectValue>{selectedAssignee?.name ?? 'Без исполнителя'}</SelectValue>
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="none">Без исполнителя</SelectItem>
                  {employees.map((e) => (
                    <SelectItem key={e.id} value={e.id}>{e.name}</SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
            <div className="space-y-1.5">
              <Label>Срок</Label>
              <Input
                type="date"
                value={form.due_date}
                onChange={(e) => set('due_date', e.target.value)}
              />
            </div>
          </div>

          <p className="rounded-xl bg-sky-50 px-3 py-2 text-[12px] text-sky-800">
            {task?.context_type === 'client'
              ? `Клиентская задача${task.client_name ? `: ${task.client_name}` : ''}. Её видят сотрудники, связанные с клиентом, исполнитель и владелец CRM.`
              : 'Внутреннюю задачу видят её автор, выбранный исполнитель и владелец CRM.'}
          </p>
        </div>

        {/* Низ */}
        <div className="flex items-center justify-between border-t border-gray-100 px-6 py-4">
          {canDelete ? (
            isDeleting ? (
              <div className="flex items-center gap-2">
                <span className="text-[12px] text-gray-500">Удалить?</span>
                <Button variant="destructive" size="sm" onClick={handleDelete} disabled={isPending}>
                  Да
                </Button>
                <Button variant="ghost" size="sm" onClick={() => setIsDeleting(false)} disabled={isPending}>
                  Нет
                </Button>
              </div>
            ) : (
              <Button
                variant="ghost"
                size="sm"
                onClick={() => setIsDeleting(true)}
                disabled={isPending}
                className="text-red-500 hover:bg-red-50 hover:text-red-600"
              >
                <Trash2 size={15} className="mr-1" />
                Удалить
              </Button>
            )
          ) : (
            <span />
          )}
          <div className="flex items-center gap-2">
            <Button variant="outline" onClick={onClose} disabled={isPending}>
              Отмена
            </Button>
            <Button onClick={handleSave} disabled={isPending} className="brand-gradient text-white">
              {isPending ? 'Сохранение…' : isNew ? 'Создать' : 'Сохранить'}
            </Button>
          </div>
        </div>
      </div>
    </Modal>
  )
}
