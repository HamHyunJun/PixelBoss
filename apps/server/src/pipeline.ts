// 파이프라인: 사용자가 승인한 제안 → 개발팀 구현(전용 브랜치) → QA 검수 → (QA 지적 수정 ↔ 재검수, 최대 2회) → 최종 반영 결정 → 문서팀 히스토리 기록
// - 사용자가 멈추는 곳은 두 군데: ① 기획 제안 선택(ReportModal) ② 최종 반영/폐기(여기). 나머지 진행은 타임라인과 알림으로만 알린다.
// - 개발팀은 `git worktree` 브랜치에서 일하므로 사용자의 작업 폴더·미커밋 변경은 건드리지 않는다. '반영'은 그 브랜치를 원래 브랜치에 합치는 것이다.
// - 히스토리는 PixelBoss 의 .data/history 에만 쓴다 (프로젝트 폴더에는 아무것도 쓰지 않는다).
import { randomUUID } from 'node:crypto'
import { existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from 'node:fs'
import { dirname, join, resolve, sep } from 'node:path'
import { DEPARTMENTS, workerId } from '@pixelboss/shared'
import type { AgentInfo, DepartmentId, HistoryItem, PipelineEvent, PipelineInfo, ProjectConfig, ProjectDelta } from '@pixelboss/shared'
import { REPO_ROOT, type HQConfig } from './config.js'
import { runChecks } from './git.js'
import type { IssueInput } from './issues.js'
import { buildDevPrompt, buildReviewPrompt, parseVerdict } from './planner.js'
import { branchDiff, commitAll, createWorkspace, mergeBranch, removeWorkspace, type Workspace } from './worktree.js'

const STATE_FILE = resolve(REPO_ROOT, '.data/pipelines.json')
const REJECT_DIR = resolve(REPO_ROOT, '.data/rejected')
export const HISTORY_DIR = resolve(REPO_ROOT, '.data/history')
/** QA 지적을 개발팀이 고치는 최대 횟수. 이후에도 문제가 남으면 자동으로 돌지 않고 사용자에게 넘긴다 */
const MAX_FIX_ROUNDS = 2
const KEEP_FINISHED = 30

export interface AgentRunOptions {
  runId: string
  label: string
  agentId: string
  department: DepartmentId
  project: ProjectConfig
  cwd: string
  commandText: string
  prompt: string
  mode: 'propose' | 'execute' | 'fix' | 'review'
}

export interface AgentRunResult {
  exitCode: number | null
  summary: string
  outputTail: string
  /** claude 실행기에서만 채워진다 (mock 은 비용 없음) */
  costUsd?: number
  turns?: number
}

/** 오케스트레이터가 파이프라인에 빌려주는 기능 */
export interface PipelineHost {
  config: HQConfig
  deltas: () => Record<string, ProjectDelta>
  runAgent: (o: AgentRunOptions) => Promise<AgentRunResult>
  patchAgent: (id: string, patch: Partial<AgentInfo>) => void
  resetAgent: (id: string) => void
  killAgent: (id: string) => void
  toast: (level: 'info' | 'warn' | 'error', message: string) => void
  attention: (title: string, body: string) => void
  emit: (info: PipelineInfo) => void
  rescan: () => void
  /** 개발 파이프라인의 실패·보류를 이슈로 올린다 (담당 팀장이 보고한다) */
  issue: (input: IssueInput) => void
}

interface Run extends PipelineInfo {
  ws?: Workspace
  proposal: string
  baselineFail: string[]
  stopped?: boolean
}

class Stopped extends Error {}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms))
const pad = (n: number): string => String(n).padStart(2, '0')
const stamp = (d: Date): string => `${d.getFullYear()}${pad(d.getMonth() + 1)}${pad(d.getDate())}-${pad(d.getHours())}${pad(d.getMinutes())}`

export class PipelineManager {
  private runs: Run[] = []

  constructor(private host: PipelineHost) {
    if (existsSync(STATE_FILE)) {
      try {
        this.runs = JSON.parse(readFileSync(STATE_FILE, 'utf8'))
      } catch {
        /* 손상된 기록은 무시 */
      }
    }
    // 서버가 꺼지면서 진행 중이던 파이프라인은 이어갈 수 없다: 에러 상태로 두고 사용자가 정리하게 한다
    for (const r of this.runs) {
      if (r.status === 'running') {
        r.status = 'error'
        r.events.push({ at: Date.now(), kind: 'system', title: '서버 재시작으로 중단됨', body: '작업 중이던 파이프라인은 이어갈 수 없습니다. 중단 버튼으로 브랜치를 정리하세요.', ok: false })
      }
    }
  }

  list(): PipelineInfo[] {
    return this.runs.map((r) => this.info(r))
  }

  /** 이 프로젝트에 끝나지 않은 파이프라인이 있는지 (프로젝트 삭제·중복 시작 방지) */
  activeFor(projectId: string): boolean {
    return this.runs.some((r) => r.projectId === projectId && r.stage !== 'done')
  }

  /** 승인된 제안이 있는 프로젝트마다 파이프라인을 시작한다 */
  start(items: { project: ProjectConfig; proposal: string }[], title: string): void {
    for (const { project, proposal } of items) {
      if (this.activeFor(project.id)) {
        this.host.toast('warn', `${project.name}: 이미 진행 중인 개발 파이프라인이 있어 이번 제안은 시작하지 않았습니다.`)
        continue
      }
      const run: Run = {
        id: randomUUID().slice(0, 8),
        projectId: project.id,
        title,
        stage: 'dev',
        status: 'running',
        fixRound: 0,
        maxFixRounds: MAX_FIX_ROUNDS,
        branch: '',
        baseBranch: '',
        events: [],
        startedAt: Date.now(),
        proposal,
        baselineFail: [],
      }
      this.runs.push(run)
      this.publish(run)
      void this.run(run, project)
    }
  }

  /** 최종 결정: approve=반영(원래 브랜치에 병합) / 아니면 폐기 */
  async decide(id: string, approve: boolean): Promise<void> {
    const r = this.runs.find((x) => x.id === id)
    if (!r || r.stage !== 'final' || r.status !== 'waiting') {
      this.host.toast('warn', '최종 결정을 기다리는 파이프라인이 아닙니다.')
      return
    }
    const project = this.project(r)
    if (!project || !r.ws) return this.close(r, project, 'failed', '프로젝트나 작업 브랜치를 찾을 수 없습니다.')
    r.status = 'running'
    this.publish(r)
    if (!approve) {
      const d = await branchDiff(r.ws)
      mkdirSync(join(REJECT_DIR, r.id), { recursive: true })
      writeFileSync(join(REJECT_DIR, r.id, `${project.id}.patch`), d.diff)
      return this.close(r, project, 'discarded', '사용자가 폐기했습니다. 변경은 반영되지 않았고 패치는 .data/rejected 에 보관했습니다.')
    }
    const m = await mergeBranch(project.path, r.ws, `PixelBoss: ${r.title}\n\n파이프라인 ${r.id} (QA 수정 ${r.fixRound}회)`)
    if (m.ok) return this.close(r, project, 'merged', `'${r.baseBranch}' 에 병합했습니다 (${m.sha}).`)
    this.close(r, project, 'blocked', `${m.reason}. 브랜치 '${r.branch}' 는 남겨 두었으니 직접 합치거나 삭제하세요.`)
  }

  /** 진행 중이거나 막힌 파이프라인을 중단하고 정리한다 */
  async stop(id: string): Promise<void> {
    const r = this.runs.find((x) => x.id === id)
    if (!r || r.status === 'finished') return
    const project = this.project(r)
    if (r.status === 'running') {
      r.stopped = true
      this.host.killAgent(workerId('dev', r.projectId))
      this.host.killAgent(workerId('qa', r.projectId))
      return // 실행 루프가 Stopped 를 받아 정리한다
    }
    await this.close(r, project, 'discarded', '사용자가 중단했습니다.')
  }

  // ───────────────────────── 실행 루프 ─────────────────────────

  private async run(r: Run, project: ProjectConfig): Promise<void> {
    const wtProject = (): ProjectConfig => ({ ...project, path: r.ws!.path })
    const timeout = this.host.config.scan.checkTimeoutSec
    try {
      this.ev(r, 'system', '작업 브랜치 준비', '개발팀이 쓸 전용 브랜치와 작업 폴더를 만듭니다.')
      r.ws = await createWorkspace(project.path, r.id, project.id)
      r.branch = r.ws.branch
      r.baseBranch = r.ws.baseBranch
      const dirty = this.host.deltas()[project.id]?.changedFiles.length ?? 0
      this.ev(r, 'system', '작업 브랜치 준비 완료', `브랜치 \`${r.branch}\` (기준: \`${r.baseBranch}\`)` + (dirty ? `\n작업 중인 미커밋 변경 ${dirty}개는 개발 브랜치에 포함되지 않습니다.` : ''))

      // 개발 전부터 실패하던 검사를 파악해 둔다 (이번 변경 때문에 새로 실패한 것만 문제로 본다)
      const base = await runChecks(wtProject(), timeout)
      r.baselineFail = base.filter((c) => !c.ok).map((c) => c.name)
      this.guard(r)

      // 1) 개발팀 구현
      this.stage(r, 'dev')
      const dev = await this.agent(r, project, 'dev', 'execute', '구현', buildDevPrompt(project, r.proposal))
      if (dev.exitCode !== 0) return this.close(r, project, 'failed', `개발팀 작업이 실패했습니다 (exit ${dev.exitCode}). 출력을 확인하세요.`, dev.outputTail)
      if (!(await commitAll(r.ws, `PixelBoss dev: ${r.title}`))) return this.close(r, project, 'empty', '개발팀이 파일을 바꾸지 않았습니다. 변경할 내용이 없어 종료합니다.')
      let devSummary = dev.summary
      const first = await branchDiff(r.ws)
      this.ev(r, 'dev', '개발팀 구현 완료', `${devSummary || '(보고 없음)'}\n\n변경 파일 ${first.stat.files}개 (+${first.stat.insertions} / -${first.stat.deletions})`, true)

      // 2) QA 검수 ↔ 개발팀 수정 (최대 MAX_FIX_ROUNDS 회)
      let passed = false
      const warnings: string[] = []
      if (!Object.values(project.checks ?? {}).some(Boolean)) warnings.push('프로젝트에 검사 명령(typecheck/lint/test)이 없어 QA 검수가 에이전트의 코드 검토에만 의존합니다. 신뢰도가 낮습니다.')
      if (r.baselineFail.length) warnings.push(`개발 전부터 실패하던 검사: ${r.baselineFail.join(', ')} (이번 변경으로 새로 실패한 것만 문제로 봅니다)`)
      for (;;) {
        this.stage(r, 'qa')
        const checks = await runChecks(wtProject(), timeout)
        const newFail = checks.filter((c) => !c.ok && !r.baselineFail.includes(c.name))
        const d = await branchDiff(r.ws)
        const qa = await this.agent(r, project, 'qa', 'review', `검수 ${r.fixRound + 1}`, buildReviewPrompt(project, r.proposal, devSummary, d.files, d.diff, checks, r.baselineFail))
        const verdict = qa.exitCode === 0 ? parseVerdict(qa.summary) : undefined
        passed = newFail.length === 0 && verdict === 'pass'
        const checkLine = checks.length ? checks.map((c) => `${c.ok ? '✔' : r.baselineFail.includes(c.name) ? '△' : '✖'} ${c.name}`).join('  ') : '검사 명령 없음'
        this.ev(r, 'qa', passed ? 'QA 검수 통과' : 'QA 검수: 수정 필요', `검사 결과: ${checkLine}\n\n${qa.summary || '(QA 보고 없음)'}` + (verdict === undefined && qa.exitCode === 0 ? '\n\n(QA 보고에 판정 줄이 없어 수정 필요로 처리했습니다)' : ''), passed)
        if (passed) break
        if (r.fixRound >= r.maxFixRounds) {
          warnings.push(`QA 수정 요청을 ${r.maxFixRounds}회 했지만 문제가 남아 있습니다. 직접 확인하고 결정해주세요.`)
          break
        }
        // QA 지적 → 개발팀 수정 요청
        r.fixRound++
        this.stage(r, 'fix')
        const failing = newFail.map((c) => `${c.name}: ${c.excerpt.slice(0, 400)}`)
        const fix = await this.agent(r, project, 'dev', 'fix', `수정 ${r.fixRound}`, buildDevPrompt(project, r.proposal, { issues: qa.summary, failingChecks: failing }))
        if (fix.exitCode !== 0) return this.close(r, project, 'failed', `개발팀 수정 작업이 실패했습니다 (exit ${fix.exitCode}).`, fix.outputTail)
        const changed = await commitAll(r.ws, `PixelBoss dev fix ${r.fixRound}: ${r.title}`)
        devSummary = fix.summary
        this.ev(r, 'fix', `개발팀 수정 ${r.fixRound}회 완료`, `${fix.summary || '(보고 없음)'}` + (changed ? '' : '\n\n(이번 수정에서 바뀐 파일이 없습니다)'), changed)
        if (!changed) {
          warnings.push('개발팀이 QA 지적을 수정하지 못했습니다(변경 없음).')
          break
        }
      }

      // 3) 최종 결정 대기 (여기서 사용자에게 멈춘다)
      const fin = await branchDiff(r.ws)
      r.final = { ...fin, qaPassed: passed, warnings }
      r.stage = 'final'
      r.status = 'waiting'
      this.ev(r, 'final', passed ? '최종 반영 여부를 결정해주세요' : '자동 수정으로 해결하지 못했습니다. 결정해주세요', `변경 파일 ${fin.stat.files}개 (+${fin.stat.insertions} / -${fin.stat.deletions}). ${passed ? 'QA 검수를 통과했습니다.' : 'QA 검수를 통과하지 못했습니다.'}`, passed)
      this.host.attention('PixelBoss 최종 반영 결정', `${project.name}: ${passed ? 'QA 통과 — 반영 여부를 결정해주세요.' : 'QA 문제가 남아 있어 결정이 필요합니다.'}`)
    } catch (e) {
      if (e instanceof Stopped) return this.close(r, project, 'discarded', '사용자가 중단했습니다.')
      this.close(r, project, 'failed', `파이프라인 오류: ${e instanceof Error ? e.message : String(e)}`)
    }
  }

  /** 에이전트 한 번 실행 (작업 폴더는 항상 전용 브랜치) */
  private async agent(r: Run, project: ProjectConfig, dept: 'dev' | 'qa', mode: 'execute' | 'fix' | 'review', label: string, prompt: string) {
    const agentId = workerId(dept, project.id)
    this.host.patchAgent(agentId, { task: `${DEPARTMENTS.find((d) => d.id === dept)!.name} · ${label}` })
    try {
      const res = await this.host.runAgent({ runId: r.id, label: `${dept}-${label}`, agentId, department: dept, project, cwd: r.ws!.path, commandText: r.title, prompt, mode })
      this.guard(r)
      return res
    } finally {
      this.host.patchAgent(agentId, { task: undefined })
      this.host.resetAgent(agentId)
    }
  }

  private guard(r: Run): void {
    if (r.stopped) throw new Stopped()
  }

  // ───────────────────────── 마무리: 정리 → 문서팀 기록 ─────────────────────────

  private async close(r: Run, project: ProjectConfig | undefined, result: NonNullable<Run['result']>, note: string, outputTail?: string): Promise<void> {
    const name = project?.name ?? r.projectId
    r.status = 'running'
    this.ev(r, 'system', { merged: '반영 완료', blocked: '반영 보류 (자동 병합 불가)', discarded: '폐기·중단', failed: '실패', empty: '변경 없음' }[result], note + (outputTail ? `\n\n\`\`\`\n${outputTail.slice(-600)}\n\`\`\`` : ''), result === 'merged')
    if (project && r.ws) {
      try {
        await removeWorkspace(project.path, r.ws, result !== 'blocked')
      } catch (e) {
        this.ev(r, 'system', '작업 폴더 정리 실패', String(e), false)
      }
    }
    // 문서팀이 PixelBoss 쪽에만 히스토리를 남긴다
    r.stage = 'docs'
    this.publish(r)
    const docs = workerId('docs', r.projectId)
    this.host.patchAgent(docs, { status: 'running', task: '히스토리 기록' })
    try {
      const file = this.writeHistory(r, project, result)
      this.ev(r, 'docs', '문서팀 히스토리 기록 완료', `\`${file}\` (PixelBoss 의 .data/history, 프로젝트 폴더에는 쓰지 않았습니다)`, true)
    } catch (e) {
      this.ev(r, 'docs', '히스토리 기록 실패', String(e), false)
    }
    await sleep(1200)
    this.host.patchAgent(docs, { status: 'done' })
    setTimeout(() => this.host.patchAgent(docs, { status: 'idle', task: undefined }), 4000)

    if (result === 'failed' || result === 'blocked') {
      this.host.issue({
        key: `pipeline:${r.id}`,
        projectId: r.projectId,
        department: 'dev',
        kind: 'pipeline',
        severity: result === 'failed' ? 'error' : 'warn',
        route: result === 'failed' ? 'ceo' : 'board',
        title: `${name}: 개발 파이프라인이 ${result === 'failed' ? '실패했습니다' : '자동 반영되지 못했습니다'}`,
        detail: note,
      })
    }
    r.result = result
    r.stage = 'done'
    r.status = result === 'failed' ? 'error' : 'finished'
    r.finishedAt = Date.now()
    r.ws = undefined
    this.publish(r)
    this.trim()
    this.host.rescan()
  }

  private writeHistory(r: Run, project: ProjectConfig | undefined, result: string): string {
    const label: Record<string, string> = { merged: '반영됨', blocked: '반영 보류(브랜치만 남음)', discarded: '폐기/중단', failed: '실패', empty: '변경 없음' }
    const name = project?.name ?? r.projectId
    const when = new Date(r.startedAt)
    const dir = join(HISTORY_DIR, r.projectId)
    mkdirSync(dir, { recursive: true })
    const file = `${stamp(when)}-${r.id}.md`
    const time = (t: number): string => new Date(t).toLocaleTimeString('ko-KR', { hour: '2-digit', minute: '2-digit', second: '2-digit' })
    const body = [
      `# ${r.title} — ${name}`,
      '',
      `- 결과: ${label[result] ?? result}`,
      `- 시작: ${when.toLocaleString('ko-KR')}`,
      `- 브랜치: ${r.branch || '-'} (기준 ${r.baseBranch || '-'})`,
      `- QA 지적 수정 횟수: ${r.fixRound}회`,
      '',
      '## 승인된 제안',
      '',
      r.proposal,
      '',
      '## 진행 기록',
      '',
      ...r.events.flatMap((e) => [`### ${time(e.at)} · ${e.title}`, '', e.body, '']),
    ].join('\n')
    writeFileSync(join(dir, file), body)
    return `${r.projectId}/${file}`
  }

  // ───────────────────────── 보조 ─────────────────────────

  private project(r: Run): ProjectConfig | undefined {
    return this.host.config.projects.find((p) => p.id === r.projectId)
  }

  private stage(r: Run, stage: Run['stage']): void {
    r.stage = stage
    this.publish(r)
  }

  private ev(r: Run, kind: PipelineEvent['kind'], title: string, body: string, ok?: boolean): void {
    r.events.push({ at: Date.now(), kind, title, body, ...(ok === undefined ? {} : { ok }) })
    this.publish(r)
  }

  private info(r: Run): PipelineInfo {
    const { ws: _ws, proposal: _p, baselineFail: _b, stopped: _s, ...info } = r
    return info
  }

  private publish(r: Run): void {
    this.save()
    this.host.emit(this.info(r))
  }

  private save(): void {
    mkdirSync(dirname(STATE_FILE), { recursive: true })
    writeFileSync(STATE_FILE, JSON.stringify(this.runs, null, 2))
  }

  /** 끝난 기록은 최근 KEEP_FINISHED 개만 남긴다 */
  private trim(): void {
    const finished = this.runs.filter((r) => r.status === 'finished' || (r.status === 'error' && r.stage === 'done'))
    for (const r of finished.slice(0, Math.max(0, finished.length - KEEP_FINISHED))) this.runs.splice(this.runs.indexOf(r), 1)
    this.save()
  }
}

// ───────────────────────── 히스토리 조회 ─────────────────────────

export function listHistory(): HistoryItem[] {
  if (!existsSync(HISTORY_DIR)) return []
  const items: HistoryItem[] = []
  for (const projectId of readdirSync(HISTORY_DIR)) {
    const dir = join(HISTORY_DIR, projectId)
    let files: string[] = []
    try {
      files = readdirSync(dir).filter((f) => f.endsWith('.md'))
    } catch {
      continue
    }
    for (const f of files) {
      const text = readFileSync(join(dir, f), 'utf8')
      const m = f.match(/^(\d{4})(\d{2})(\d{2})-(\d{2})(\d{2})/)
      items.push({
        id: `${projectId}/${f}`,
        projectId,
        title: text.split('\n')[0]?.replace(/^#\s*/, '') ?? f,
        date: m ? `${m[1]}-${m[2]}-${m[3]} ${m[4]}:${m[5]}` : '',
        result: text.match(/^- 결과: (.+)$/m)?.[1] ?? '',
      })
    }
  }
  return items.sort((a, b) => b.date.localeCompare(a.date))
}

/** id 는 `<projectId>/<파일명>` 이어야 하고 히스토리 폴더 밖은 읽지 않는다 */
export function readHistory(id: string): string | undefined {
  const full = resolve(HISTORY_DIR, id)
  if (!full.startsWith(HISTORY_DIR + sep) || !full.endsWith('.md') || !existsSync(full)) return undefined
  return readFileSync(full, 'utf8')
}
