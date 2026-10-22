import fs from 'node:fs'
import { execSync } from 'node:child_process'
import { NextResponse } from 'next/server'
import { isOwnerRequest } from '@/lib/server-monitor-auth'
import type { DependenciesInfo, DependencyItem } from '@/types/server-status'

export const dynamic = 'force-dynamic'
export const runtime = 'nodejs'

const APP_DIR = process.cwd()

function sh(cmd: string): string | null {
  try {
    return execSync(cmd, { encoding: 'utf8', timeout: 8000, maxBuffer: 4 * 1024 * 1024 }).trim() || null
  } catch {
    return null
  }
}

// Версии медленно не меняются — кэш на весь процесс с TTL, чтобы не дёргать
// pip freeze и docker images на каждую загрузку страницы.
let cache: { data: DependenciesInfo; at: number } | null = null
const TTL_MS = 5 * 60 * 1000

function packageJsonDeps(key: 'dependencies' | 'devDependencies'): DependencyItem[] {
  try {
    const pkg = JSON.parse(fs.readFileSync(`${APP_DIR}/package.json`, 'utf8'))
    const deps = pkg[key] ?? {}
    return Object.entries(deps)
      .map(([name, version]) => ({ name, version: String(version) }))
      .sort((a, b) => a.name.localeCompare(b.name))
  } catch {
    return []
  }
}

function botDeps(): DependencyItem[] {
  const out = sh('docker exec demi-bot-backend-1 pip freeze')
  if (!out) return []
  return out
    .split('\n')
    .map((line) => {
      const [name, version] = line.split('==')
      return { name: name?.trim() ?? line, version: version?.trim() ?? '' }
    })
    .filter((d) => d.name)
    .sort((a, b) => a.name.localeCompare(b.name))
}

function dockerImages(): DependencyItem[] {
  const out = sh(`docker images --format '{{.Repository}}\t{{.Tag}}\t{{.Size}}'`)
  if (!out) return []
  return out
    .split('\n')
    .map((line) => {
      const [repo, tag, size] = line.split('\t')
      return { name: `${repo}:${tag}`, version: size ?? '' }
    })
    .filter((d) => d.name && !d.name.startsWith('<none>'))
    .sort((a, b) => a.name.localeCompare(b.name))
}

export async function GET() {
  if (!(await isOwnerRequest())) {
    return NextResponse.json({ error: 'Forbidden' }, { status: 403 })
  }
  if (cache && Date.now() - cache.at < TTL_MS) {
    return NextResponse.json(cache.data)
  }
  const data: DependenciesInfo = {
    crm: packageJsonDeps('dependencies'),
    crmDev: packageJsonDeps('devDependencies'),
    bot: botDeps(),
    images: dockerImages(),
    generatedAt: new Date().toISOString(),
  }
  cache = { data, at: Date.now() }
  return NextResponse.json(data)
}
