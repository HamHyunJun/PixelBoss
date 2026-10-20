// config/projects.json(또는 projects.local.json) 로더
import { existsSync, readFileSync } from 'node:fs'
import { dirname, isAbsolute, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import type { ProjectConfig } from '@voxelhq/shared'

export type RunnerMode = 'mock' | 'claude'

export interface HQConfig {
  runner: {
    mode: RunnerMode
    maxParallel: number
    claudeBin: string
    claudeArgs: string[]
    timeoutSec: number
  }
  scan: { intervalSec: number; runChecks: boolean; checkTimeoutSec: number }
  projects: ProjectConfig[]
  /** 실제로 읽은 설정 파일 경로 */
  source: string
}

export const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '../../..')

export function loadConfig(): HQConfig {
  const candidates = [
    process.env.VOXELHQ_CONFIG,
    resolve(REPO_ROOT, 'config/projects.local.json'),
    resolve(REPO_ROOT, 'config/projects.json'),
  ].filter(Boolean) as string[]
  const source = candidates.find((p) => existsSync(p))
  if (!source) throw new Error(`설정 파일을 찾을 수 없습니다: ${candidates.join(', ')}`)

  const raw = JSON.parse(readFileSync(source, 'utf8'))
  const baseDir = dirname(source)
  const projects: ProjectConfig[] = (raw.projects ?? []).map((p: ProjectConfig) => ({
    ...p,
    path: isAbsolute(p.path) ? p.path : resolve(baseDir, p.path),
  }))
  if (projects.length === 0) throw new Error('projects 가 비어 있습니다')
  const ids = new Set<string>()
  for (const p of projects) {
    if (!p.id || ids.has(p.id)) throw new Error(`프로젝트 id 가 없거나 중복입니다: ${p.id}`)
    ids.add(p.id)
  }

  // 환경 변수로 실행기 모드 전환 가능 (VOXELHQ_RUNNER=claude)
  const mode = (process.env.VOXELHQ_RUNNER ?? raw.runner?.mode ?? 'mock') as RunnerMode
  return {
    runner: {
      mode: mode === 'claude' ? 'claude' : 'mock',
      maxParallel: raw.runner?.maxParallel ?? 6,
      claudeBin: raw.runner?.claudeBin ?? 'claude',
      claudeArgs: raw.runner?.claudeArgs ?? ['--permission-mode', 'acceptEdits'],
      timeoutSec: raw.runner?.timeoutSec ?? 900,
    },
    scan: {
      intervalSec: raw.scan?.intervalSec ?? 300,
      runChecks: raw.scan?.runChecks ?? true,
      checkTimeoutSec: raw.scan?.checkTimeoutSec ?? 120,
    },
    projects,
    source,
  }
}
