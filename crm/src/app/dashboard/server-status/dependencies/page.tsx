import DependenciesClient from './DependenciesClient'

// Тонкая серверная обёртка. Нужна, чтобы Next всегда генерировал
// client-reference-manifest для этого сегмента: если page.tsx — сам по себе
// клиентский компонент без серверного родителя, манифест иногда не
// эмитится и маршрут падает с InvariantError на проде.
export const dynamic = 'force-dynamic'

export default function DependenciesPage() {
  return <DependenciesClient />
}
