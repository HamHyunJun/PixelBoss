// config/projects.json(또는 projects.local.json) 로더
import { existsSync, readFileSync, writeFileSync } from 'node:fs'
import { dirname, isAbsolute, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import type { ProjectConfig, ScheduleConfig } from '@pixelboss/shared'

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
  schedules: ScheduleConfig[]
  /** 실제로 읽은 설정 파일 경로 */
  source: string
}

export const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '../../..')

export function loadConfig(): HQConfig {
  const candidates = [
    process.env.PIXELBOSS_CONFIG,
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
  const ids = new Set<string>()
  for (const p of projects) {
    if (!p.id || ids.has(p.id)) throw new Error(`프로젝트 id 가 없거나 중복입니다: ${p.id}`)
    ids.add(p.id)
  }

  // 환경 변수로 실행기 모드 전환 가능 (PIXELBOSS_RUNNER=claude)
  const mode = (process.env.PIXELBOSS_RUNNER ?? raw.runner?.mode ?? 'mock') as RunnerMode
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
    schedules: Array.isArray(raw.schedules) ? raw.schedules : [],
    source,
  }
}

/** 화면에서 바꾼 프로젝트 목록·실행기 모드를 설정 파일에 저장한다 (기본은 git 에 안 올라가는 projects.local.json) */
export function saveProjects(config: HQConfig): void {
  const raw = JSON.parse(readFileSync(config.source, 'utf8'))
  raw.projects = config.projects
  raw.schedules = config.schedules
  raw.runner = { ...raw.runner, mode: config.runner.mode }
  const target = process.env.PIXELBOSS_CONFIG ?? resolve(REPO_ROOT, 'config/projects.local.json')
  writeFileSync(target, JSON.stringify(raw, null, 2) + '\n')
  config.source = target
}
