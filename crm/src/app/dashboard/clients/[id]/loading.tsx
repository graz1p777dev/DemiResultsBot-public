import { LoaderCircle, UserRound } from 'lucide-react'

export default function ClientLoading() {
  return (
    <div className="min-h-[calc(100vh-52px)] bg-[#f4f8fa] p-4 md:p-7">
      <div className="mx-auto max-w-7xl">
        <div className="flex min-h-[420px] items-center justify-center rounded-2xl border border-[#dbe8ee] bg-white shadow-sm">
          <div className="flex flex-col items-center text-center">
            <div className="relative flex h-16 w-16 items-center justify-center rounded-2xl bg-[#e8f5f8] text-[#075a78]">
              <UserRound size={28} />
              <LoaderCircle className="absolute -bottom-1 -right-1 animate-spin rounded-full bg-white p-1 text-[#1784a6]" size={24} />
            </div>
            <p className="mt-4 text-sm font-semibold text-[#17364c]">Открываем карточку клиента</p>
            <p className="mt-1 text-xs text-slate-500">Загружаем сделки и историю переписки…</p>
          </div>
        </div>
      </div>
    </div>
  )
}
