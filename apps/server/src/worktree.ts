// 파이프라인용 git 브랜치 작업공간.
// 개발팀은 사용자의 작업 폴더가 아니라 `git worktree` 로 만든 별도 폴더·브랜치에서 일한다 (사용자의 미커밋 변경과 섞이지 않는다).
import { existsSync, mkdirSync, readdirSync, rmSync, statSync, symlinkSync } from 'node:fs'
import { dirname, join, relative, resolve } from 'node:path'
import { REPO_ROOT } from './config.js'
import { git, isArtifact } from './git.js'

export const WORKTREE_DIR = resolve(REPO_ROOT, '.data/worktrees')

export interface Workspace {
  path: string
  branch: string
  baseBranch: string
  baseSha: string
}

const IDENT = ['-c', 'user.name=PixelBoss', '-c', 'user.email=pixelboss@localhost']
const SKIP = new Set(['.git', 'node_modules', '.nuxt', '.output', '.next', 'dist', 'build', '.turbo', '.cache', 'coverage', '.data', '.omc'])

/** 원본 프로젝트의 node_modules 를 작업공간에 링크해 검사 명령(typecheck/lint/test)이 돌게 한다 (깊이 3까지) */
function linkDependencies(srcRoot: string, wtRoot: string, dir = srcRoot, depth = 0): void {
  if (depth > 3) return
  let names: string[]
  try {
    names = readdirSync(dir)
  } catch {
    return
  }
  for (const name of names) {
    const full = join(dir, name)
    if (name === 'node_modules') {
      const target = join(wtRoot, relative(srcRoot, full))
      if (existsSync(dirname(target)) && !existsSync(target)) {
        try {
          symlinkSync(full, target, 'dir')
        } catch {
          /* 링크 실패는 검사 실패로 드러난다 */
        }
      }
    } else if (!SKIP.has(name) && !name.startsWith('.')) {
      try {
        if (statSync(full).isDirectory()) linkDependencies(srcRoot, wtRoot, full, depth + 1)
      } catch {
        /* 접근 불가 폴더 */
      }
    }
  }
}

/** 현재 브랜치의 HEAD 에서 새 브랜치와 작업공간을 만든다 */
export async function createWorkspace(projectPath: string, id: string, label: string): Promise<Workspace> {
  const baseBranch = (await git(projectPath, ['rev-parse', '--abbrev-ref', 'HEAD'])).stdout.trim()
  if (!baseBranch || baseBranch === 'HEAD') throw new Error('현재 브랜치가 없습니다(detached HEAD). 브랜치를 체크아웃한 뒤 다시 시도하세요')
  const baseSha = (await git(projectPath, ['rev-parse', 'HEAD'])).stdout.trim()
  const branch = `pixelboss/${id}`
  const path = join(WORKTREE_DIR, `${label}-${id}`)
  mkdirSync(WORKTREE_DIR, { recursive: true })
  const r = await git(projectPath, ['worktree', 'add', '-b', branch, path, 'HEAD'])
  if (r.code !== 0) throw new Error(`작업 브랜치를 만들지 못했습니다: ${r.stderr.trim() || r.stdout.trim()}`)
  linkDependencies(projectPath, path)
  return { path, branch, baseBranch, baseSha }
}

/** 작업공간의 변경(에이전트 부산물 제외)을 브랜치에 커밋한다. 커밋할 게 없으면 false */
export async function commitAll(ws: Workspace, message: string): Promise<boolean> {
  await git(ws.path, ['add', '-A', '--', '.', ':(exclude).omc'])
  const staged = (await git(ws.path, ['diff', '--cached', '--name-only'])).stdout.split('\n').filter((f) => f && !isArtifact(f))
  if (!staged.length) return false
  const r = await git(ws.path, [...IDENT, 'commit', '-q', '-m', message])
  if (r.code !== 0) throw new Error(`브랜치 커밋 실패: ${r.stderr.trim() || r.stdout.trim()}`)
  return true
}

/** 기준 커밋 이후 브랜치에 쌓인 전체 변경 */
export async function branchDiff(ws: Workspace): Promise<{ files: string[]; diff: string; stat: { files: number; insertions: number; deletions: number } }> {
  const files = (await git(ws.path, ['diff', '--name-only', ws.baseSha, 'HEAD'])).stdout.split('\n').filter((f) => f && !isArtifact(f))
  let diff = files.length ? (await git(ws.path, ['diff', ws.baseSha, 'HEAD', '--', ...files])).stdout : ''
  const stat = { files: files.length, insertions: diff.match(/^\+(?!\+\+ )/gm)?.length ?? 0, deletions: diff.match(/^-(?!-- )/gm)?.length ?? 0 }
  if (diff.length > 200_000) diff = diff.slice(0, 200_000) + '\n… (diff 가 너무 길어 생략됨)'
  return { files, diff, stat }
}

export type MergeResult = { ok: true; sha: string } | { ok: false; reason: string }

/** 브랜치를 원래 브랜치에 합친다. 원래 브랜치가 체크아웃돼 있지 않거나 충돌/작업 중 변경과 겹치면 합치지 않고 이유를 돌려준다 */
export async function mergeBranch(projectPath: string, ws: Workspace, message: string): Promise<MergeResult> {
  const current = (await git(projectPath, ['rev-parse', '--abbrev-ref', 'HEAD'])).stdout.trim()
  if (current !== ws.baseBranch) return { ok: false, reason: `프로젝트가 지금 '${current}' 브랜치라 '${ws.baseBranch}' 에 자동으로 합치지 않았습니다` }
  const r = await git(projectPath, [...IDENT, 'merge', '--no-ff', '-m', message, ws.branch])
  if (r.code !== 0) {
    await git(projectPath, ['merge', '--abort'])
    return { ok: false, reason: `자동 병합이 막혔습니다(충돌이거나 작업 중인 변경과 겹침): ${(r.stderr || r.stdout).trim().split('\n')[0]}` }
  }
  return { ok: true, sha: (await git(projectPath, ['rev-parse', '--short', 'HEAD'])).stdout.trim() }
}

/** 작업 폴더를 지운다. deleteBranch 면 브랜치도 지운다(병합 전이면 강제) */
export async function removeWorkspace(projectPath: string, ws: Workspace, deleteBranch: boolean): Promise<void> {
  await git(projectPath, ['worktree', 'remove', '--force', ws.path])
  if (existsSync(ws.path)) rmSync(ws.path, { recursive: true, force: true })
  await git(projectPath, ['worktree', 'prune'])
  if (deleteBranch) await git(projectPath, ['branch', '-D', ws.branch])
}
