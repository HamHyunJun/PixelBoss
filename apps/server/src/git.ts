// 로컬 git CLI 래퍼 + 1차 정적 필터(델타 감지) 모듈
// 원칙: 여기서는 절대 LLM 을 호출하지 않는다. git/타입검사/린트 결과만으로 대상 프로젝트를 선별한다.
import { execFile, spawn } from 'node:child_process'
import { createHash } from 'node:crypto'
import { existsSync } from 'node:fs'
import { join } from 'node:path'
import type { CheckResult, ProjectConfig, ProjectDelta } from '@pixelboss/shared'

export interface ExecResult {
  code: number
  stdout: string
  stderr: string
}

export function git(cwd: string, args: string[], maxBuffer = 20 * 1024 * 1024): Promise<ExecResult> {
  return new Promise((resolve) => {
    execFile('git', args, { cwd, maxBuffer, env: { ...process.env, GIT_TERMINAL_PROMPT: '0' } }, (err, stdout, stderr) => {
      const code = err ? (typeof (err as NodeJS.ErrnoException).code === 'number' ? Number((err as NodeJS.ErrnoException).code) : 1) : 0
      resolve({ code, stdout: String(stdout), stderr: String(stderr) })
    })
  })
}

/** 셸 명령을 타임아웃과 함께 실행 (검사 스크립트용) */
export function runShell(cwd: string, command: string, timeoutSec: number): Promise<ExecResult> {
  return new Promise((resolve) => {
    const child = spawn(command, { cwd, shell: true, env: { ...process.env, FORCE_COLOR: '0', CI: '1' } })
    let stdout = ''
    let stderr = ''
    const cap = (s: string, d: Buffer) => (s.length > 200_000 ? s : s + d.toString())
    child.stdout.on('data', (d) => (stdout = cap(stdout, d)))
    child.stderr.on('data', (d) => (stderr = cap(stderr, d)))
    const timer = setTimeout(() => child.kill('SIGKILL'), timeoutSec * 1000)
    child.on('close', (code) => {
      clearTimeout(timer)
      resolve({ code: code ?? 124, stdout, stderr })
    })
    child.on('error', (e) => {
      clearTimeout(timer)
      resolve({ code: 127, stdout, stderr: stderr + String(e) })
    })
  })
}

/** 에이전트·훅이 프로젝트 안에 남기는 작업 부산물(.omc/ 등)은 변경 파일로 보지 않는다 */
export const isArtifact = (file: string): boolean => /(^|\/)\.omc(\/|$)/.test(file)

export function parseStatus(porcelain: string) {
  return porcelain
    .split('\n')
    .filter(Boolean)
    .map((line) => ({ status: line.slice(0, 2).trim() || '?', file: line.slice(3) }))
    .filter((f) => !isArtifact(f.file))
}

export function parseShortStat(text: string) {
  const files = Number(/(\d+) files? changed/.exec(text)?.[1] ?? 0)
  const insertions = Number(/(\d+) insertions?/.exec(text)?.[1] ?? 0)
  const deletions = Number(/(\d+) deletions?/.exec(text)?.[1] ?? 0)
  return { files, insertions, deletions }
}

function countErrors(output: string, code: number): number {
  if (code === 0) return 0
  const n = output.split('\n').filter((l) => /error|fail|✖|×/i.test(l)).length
  return Math.max(1, n)
}

export async function runChecks(project: ProjectConfig, timeoutSec: number): Promise<CheckResult[]> {
  const entries = Object.entries(project.checks ?? {}).filter(([, cmd]) => !!cmd) as [string, string][]
  return Promise.all(
    entries.map(async ([name, cmd]) => {
      const r = await runShell(project.path, cmd, timeoutSec)
      const out = `${r.stdout}\n${r.stderr}`.trim()
      return { name, ok: r.code === 0, errorCount: countErrors(out, r.code), excerpt: r.code === 0 ? '' : out.slice(0, 1500) }
    }),
  )
}

/** 이전 스캔 결과를 기억해서, 핑거프린트가 같으면 검사 명령도 다시 돌리지 않는다 */
const lastDeltas = new Map<string, ProjectDelta>()

export async function detectDelta(
  project: ProjectConfig,
  opts: { runChecks: boolean; checkTimeoutSec: number; force?: boolean },
): Promise<ProjectDelta> {
  const cwd = project.path
  const base: ProjectDelta = {
    projectId: project.id,
    scannedAt: Date.now(),
    isGitRepo: false,
    branch: '',
    head: '',
    changedFiles: [],
    diffStat: { files: 0, insertions: 0, deletions: 0 },
    checks: [],
    health: 'error',
    fingerprint: '',
  }
  if (!existsSync(cwd) || !existsSync(join(cwd, '.git'))) {
    return { ...base, checks: [{ name: 'git', ok: false, errorCount: 1, excerpt: `git 저장소가 아닙니다: ${cwd}` }] }
  }

  const [status, head, branch, stat] = await Promise.all([
    git(cwd, ['status', '--porcelain', '--untracked-files=all']),
    git(cwd, ['rev-parse', '--short', 'HEAD']),
    git(cwd, ['rev-parse', '--abbrev-ref', 'HEAD']),
    git(cwd, ['diff', 'HEAD', '--shortstat']),
  ])
  const changedFiles = parseStatus(status.stdout)
  const diffHash = changedFiles.length ? (await git(cwd, ['diff', 'HEAD'])).stdout : ''
  const fingerprint = createHash('sha1')
    .update(head.stdout + status.stdout + diffHash)
    .digest('hex')
    .slice(0, 12)

  const prev = lastDeltas.get(project.id)
  let checks: CheckResult[]
  if (!opts.force && prev && prev.fingerprint === fingerprint) {
    checks = prev.checks // 변화 없음 → 검사 생략
  } else {
    checks = opts.runChecks ? await runChecks(project, opts.checkTimeoutSec) : []
  }

  const hasError = checks.some((c) => !c.ok)
  const delta: ProjectDelta = {
    ...base,
    isGitRepo: true,
    branch: branch.stdout.trim(),
    head: head.stdout.trim(),
    changedFiles,
    diffStat: parseShortStat(stat.stdout),
    checks,
    githubOpenIssues: prev?.githubOpenIssues,
    health: hasError ? 'error' : changedFiles.length ? 'changed' : 'clean',
    fingerprint,
  }
  lastDeltas.set(project.id, delta)
  return delta
}

// ───────────────────────── 작업 전/후 스냅샷 (리포트·승인·반려용) ─────────────────────────

export interface Baseline {
  /** 작업 시작 시점의 워킹트리 상태를 담은 커밋 (사용자의 기존 변경 포함) */
  sha: string
  untracked: Set<string>
}

export async function takeBaseline(cwd: string): Promise<Baseline> {
  // git stash create 는 워킹트리를 건드리지 않고 스냅샷 커밋만 만든다
  const stash = (await git(cwd, ['stash', 'create', 'pixelboss-baseline'])).stdout.trim()
  const sha = stash || (await git(cwd, ['rev-parse', 'HEAD'])).stdout.trim()
  const untracked = (await git(cwd, ['ls-files', '--others', '--exclude-standard'])).stdout.split('\n').filter(Boolean)
  return { sha, untracked: new Set(untracked) }
}

export interface WorkDiff {
  trackedFiles: string[]
  newFiles: string[]
  diff: string
  stat: { files: number; insertions: number; deletions: number }
}

/** 기준 스냅샷 이후 에이전트가 만든 변경만 추출 */
export async function diffSinceBaseline(cwd: string, b: Baseline): Promise<WorkDiff> {
  const names = (await git(cwd, ['diff', '--name-only', b.sha])).stdout.split('\n').filter((f) => f && !isArtifact(f))
  const nowUntracked = (await git(cwd, ['ls-files', '--others', '--exclude-standard'])).stdout.split('\n').filter((f) => f && !isArtifact(f))
  const newFiles = nowUntracked.filter((f) => !b.untracked.has(f))
  let diff = names.length ? (await git(cwd, ['diff', b.sha, '--', ...names])).stdout : ''
  for (const f of newFiles) {
    const r = await git(cwd, ['diff', '--no-index', '--', '/dev/null', f])
    diff += r.stdout
  }
  const stat = {
    files: names.length + newFiles.length,
    insertions: diff.match(/^\+(?!\+\+ )/gm)?.length ?? 0,
    deletions: diff.match(/^-(?!-- )/gm)?.length ?? 0,
  }
  if (diff.length > 200_000) diff = diff.slice(0, 200_000) + '\n… (diff 가 너무 길어 생략됨)'
  return { trackedFiles: names, newFiles, diff, stat }
}
