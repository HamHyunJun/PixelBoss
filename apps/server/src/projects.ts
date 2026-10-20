// 프로젝트 등록 보조: 붙여넣은 경로 정리/검증, 검사 명령 자동 감지, 폴더 탐색
import { existsSync, readdirSync, readFileSync, realpathSync, statSync } from 'node:fs'
import { homedir } from 'node:os'
import { basename, dirname, join, resolve } from 'node:path'
import type { FsEntry, FsListing, ProjectConfig } from '@pixelboss/shared'
import { git } from './git.js'

/** 붙여넣은 경로 정리: 따옴표, file://, 공백 이스케이프(`\ `), ~ 를 풀어 절대 경로로 만든다 */
export function normalizePath(raw: string): string {
  let p = raw.trim().replace(/^(['"])(.*)\1$/, '$2')
  if (p.startsWith('file://')) p = decodeURIComponent(p.slice(7))
  p = p.replace(/\\ /g, ' ')
  if (p === '~' || p.startsWith('~/')) p = join(homedir(), p.slice(1))
  return resolve(p)
}

const isDir = (p: string): boolean => {
  try {
    return statSync(p).isDirectory()
  } catch {
    return false
  }
}

const SKIP_DIRS = new Set(['node_modules'])

/** 폴더 탐색기용 하위 폴더 목록 (숨김 폴더·node_modules 제외) */
export function listDir(raw?: string): FsListing {
  const path = raw?.trim() ? normalizePath(raw) : homedir()
  const parent = dirname(path) === path ? undefined : dirname(path)
  if (!isDir(path)) return { path, parent, entries: [], error: '폴더가 아니거나 존재하지 않습니다' }
  try {
    const entries: FsEntry[] = readdirSync(path)
      .filter((n) => !n.startsWith('.') && !SKIP_DIRS.has(n) && isDir(join(path, n)))
      .sort((a, b) => a.localeCompare(b))
      .map((name) => {
        const full = join(path, name)
        return { name, path: full, isGit: existsSync(join(full, '.git')), hasPackage: existsSync(join(full, 'package.json')) }
      })
    return { path, parent, entries }
  } catch (e) {
    return { path, parent, entries: [], error: `폴더를 읽을 수 없습니다: ${(e as NodeJS.ErrnoException).code ?? e}` }
  }
}

/** package.json scripts 로 검사 명령을 추정한다. test 기본 스크립트(echo "no test specified")는 제외 */
function detectChecks(dir: string): ProjectConfig['checks'] {
  let scripts: Record<string, string> = {}
  try {
    scripts = JSON.parse(readFileSync(join(dir, 'package.json'), 'utf8')).scripts ?? {}
  } catch {
    return undefined
  }
  const run = existsSync(join(dir, 'pnpm-lock.yaml')) ? 'pnpm run' : existsSync(join(dir, 'yarn.lock')) ? 'yarn' : 'npm run'
  const pick = (...names: string[]) => names.find((n) => scripts[n] && !/no test specified/.test(scripts[n]!))
  const checks: NonNullable<ProjectConfig['checks']> = {}
  const typecheck = pick('typecheck', 'type-check')
  const lint = pick('lint')
  const test = pick('test')
  if (typecheck) checks.typecheck = `${run} ${typecheck}`
  if (lint) checks.lint = `${run} ${lint}`
  if (test) checks.test = `${run} ${test}`
  return checks
}

async function detectGithub(dir: string): Promise<ProjectConfig['github']> {
  const r = await git(dir, ['remote', 'get-url', 'origin'])
  const m = r.code === 0 ? r.stdout.trim().match(/github\.com[:/]([^/]+)\/(.+?)(?:\.git)?$/) : null
  return m ? { owner: m[1]!, repo: m[2]! } : undefined
}

const slug = (s: string): string => s.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '') || 'project'

/** 경로를 검증하고 ProjectConfig 를 만든다. 실패하면 사용자에게 보여줄 메시지로 throw */
export async function describeProject(rawPath: string, name: string | undefined, existing: ProjectConfig[]): Promise<ProjectConfig> {
  if (!rawPath.trim()) throw new Error('폴더 경로를 입력해주세요')
  const input = normalizePath(rawPath)
  if (!isDir(input)) throw new Error(`폴더를 찾을 수 없습니다: ${input}`)
  const path = realpathSync(input)
  if (!existsSync(join(path, '.git'))) throw new Error(`git 저장소(.git)가 있는 프로젝트 루트여야 합니다: ${path}`)
  const same = existing.find((p) => {
    try {
      return realpathSync(p.path) === path
    } catch {
      return p.path === path
    }
  })
  if (same) throw new Error(`이미 등록된 프로젝트입니다: ${same.name}`)

  const base = slug(basename(path))
  const ids = new Set(existing.map((p) => p.id))
  let id = base
  for (let i = 2; ids.has(id); i++) id = `${base}-${i}`

  const github = await detectGithub(path)
  const checks = detectChecks(path)
  return { id, name: name?.trim() || basename(path), path, ...(github ? { github } : {}), ...(checks && Object.keys(checks).length ? { checks } : {}) }
}
