// 중앙 오케스트레이터: 상태 보관, 전체 소집 → 분해 → PTY 병렬 실행 → 결과 취합 → 승인/반려
import { randomUUID } from 'node:crypto'
import { copyFileSync, existsSync, mkdirSync, readFileSync, unlinkSync, writeFileSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { DEPARTMENTS, leaderId, workerId } from '@voxelhq/shared'
import type {
  AgentInfo,
  ApprovalCard,
  CommandPlan,
  DepartmentId,
  HQSnapshot,
  OrchestratorPhase,
  PlannedTask,
  ProjectConfig,
  ProjectDelta,
  ProjectReport,
  PtyStatus,
  ServerMessage,
} from '@voxelhq/shared'
import { REPO_ROOT, type HQConfig } from './config.js'
import { detectDelta, diffSinceBaseline, git, takeBaseline, type Baseline, type WorkDiff } from './git.js'
import { countOpenIssues, openPullRequest } from './github.js'
import { planCommand, type PlannerState } from './planner.js'
import { PtyManager, type SpawnSpec } from './pty-manager.js'

const DATA_DIR = resolve(REPO_ROOT, '.data')
const STATE_FILE = join(DATA_DIR, 'state.json')
const BIN_DIR = resolve(REPO_ROOT, 'apps/server/bin')
// 3D 연출(회의실 집결/업무 전달)이 보이도록 단계 사이에 두는 시간. 검증 시 VOXELHQ_FAST=1 로 단축.
const FAST = process.env.VOXELHQ_FAST === '1'
const ASSEMBLE_MS = FAST ? 300 : 4500
const DISPATCH_MS = FAST ? 300 : 5000
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms))
const DEPT_ORDER: DepartmentId[] = ['qa', 'infra', 'planning', 'docs']

interface ProjectWork {
  baseline: Baseline
  diffs: WorkDiff[]
}

export class HQ {
  readonly pty: PtyManager
  private agents = new Map<string, AgentInfo>()
  private deltas: Record<string, ProjectDelta> = {}
  private phase: OrchestratorPhase = 'idle'
  private plan: CommandPlan | null = null
  private approval: ApprovalCard | null = null
  private work = new Map<string, ProjectWork>()
  private state: PlannerState = { docsHead: {} }
  private scanning: Promise<void> | null = null

  constructor(
    private config: HQConfig,
    private broadcast: (msg: ServerMessage) => void,
  ) {
    this.pty = new PtyManager(config.runner.maxParallel)
    mkdirSync(DATA_DIR, { recursive: true })
    if (existsSync(STATE_FILE)) this.state = { docsHead: {}, ...JSON.parse(readFileSync(STATE_FILE, 'utf8')) }

    for (const dept of DEPARTMENTS) {
      this.agents.set(leaderId(dept.id), { id: leaderId(dept.id), role: 'leader', department: dept.id, name: `${dept.name} 팀장`, status: 'idle' })
      for (const p of config.projects) {
        const id = workerId(dept.id, p.id)
        this.agents.set(id, { id, role: 'worker', department: dept.id, projectId: p.id, name: `${p.name} 담당`, status: 'idle' })
      }
    }

    this.pty.on('data', (agentId: string, data: string) => this.broadcast({ type: 'pty:data', agentId, data }))
    this.pty.on('reset', (agentId: string) => this.broadcast({ type: 'pty:history', agentId, data: '' }))
    this.pty.on('status', (agentId: string, status: PtyStatus, exitCode: number | null) => {
      this.patchAgent(agentId, { status, lastExitCode: exitCode })
      this.refreshLeader(this.agents.get(agentId)!.department)
    })
  }

  get runnerMode() {
    return this.config.runner.mode
  }

  snapshot(): HQSnapshot {
    return {
      projects: this.config.projects,
      agents: [...this.agents.values()],
      deltas: this.deltas,
      phase: this.phase,
      plan: this.plan,
      approval: this.approval,
      runnerMode: this.config.runner.mode,
    }
  }

  private saveState() {
    writeFileSync(STATE_FILE, JSON.stringify(this.state, null, 2))
  }

  private patchAgent(id: string, patch: Partial<AgentInfo>) {
    const a = this.agents.get(id)
    if (!a) return
    Object.assign(a, patch)
    this.broadcast({ type: 'agent', agent: a })
  }

  /** 팀장 상태 = 소속 6명 상태 집계 */
  private refreshLeader(dept: DepartmentId) {
    const workers = [...this.agents.values()].filter((a) => a.department === dept && a.role === 'worker')
    const st = workers.map((w) => w.status)
    const status: PtyStatus = st.includes('error')
      ? 'error'
      : st.includes('waiting')
        ? 'waiting'
        : st.some((s) => s === 'running' || s === 'queued')
          ? 'running'
          : st.includes('done')
            ? 'done'
            : 'idle'
    this.patchAgent(leaderId(dept), { status })
  }

  private setPhase(phase: OrchestratorPhase) {
    this.phase = phase
    this.broadcast({ type: 'phase', phase, commandId: this.plan?.commandId })
  }

  private toast(level: 'info' | 'warn' | 'error', message: string) {
    this.broadcast({ type: 'toast', level, message })
  }

  // ───────────────────────── 1차 정적 필터 스캔 ─────────────────────────

  /** 전 프로젝트 델타 감지. 변경 없는 프로젝트는 검사 명령도 다시 돌리지 않는다. */
  scan(force = false): Promise<void> {
    if (this.scanning) return this.scanning
    this.scanning = (async () => {
      await Promise.all(
        this.config.projects.map(async (p) => {
          const d = await detectDelta(p, { runChecks: this.config.scan.runChecks, checkTimeoutSec: this.config.scan.checkTimeoutSec, force })
          const issues = await countOpenIssues(p)
          if (issues !== undefined) d.githubOpenIssues = issues
          this.deltas[p.id] = d
          this.broadcast({ type: 'delta', delta: d })
        }),
      )
    })().finally(() => (this.scanning = null))
    return this.scanning
  }

  // ───────────────────────── 전체 소집 파이프라인 ─────────────────────────

  async command(text: string) {
    text = text.trim()
    if (!text) return
    if (this.phase !== 'idle') {
      this.toast('warn', this.phase === 'awaiting-approval' ? '이전 지시의 승인 카드를 먼저 처리해주세요.' : '이미 진행 중인 지시가 있습니다.')
      return
    }
    const commandId = randomUUID().slice(0, 8)
    this.approval = null
    this.work.clear()
    this.plan = { commandId, text, createdAt: Date.now(), departments: [], tasks: [], rationale: [] }

    try {
      // 1) 팀장 소집 (3D: 팀장들이 회의실로 이동)
      this.setPhase('assembling')
      const [plan] = await Promise.all([this.scan().then(() => planCommand(commandId, text, this.config.projects, this.deltas, this.state)), sleep(ASSEMBLE_MS)])

      // 2) 상위 명령 분해
      this.plan = plan
      this.setPhase('planning')
      this.broadcast({ type: 'plan', plan })
      const active = plan.tasks.filter((t) => !t.skipped)
      for (const t of active) this.patchAgent(t.agentId, { task: text })
      await sleep(FAST ? 100 : 1500)

      // 3) 팀장이 실무진에게 전달 (3D: 팀장 복귀 후 담당자에게 이동)
      this.setPhase('dispatching')
      await sleep(DISPATCH_MS)

      if (active.length === 0) {
        this.toast('info', '정적 필터 결과 모든 프로젝트가 Clean 입니다. LLM 호출 없이 종료합니다.')
        this.finishWithReports(plan, [])
        return
      }

      // 4) PTY 병렬 실행: 프로젝트끼리는 병렬, 같은 프로젝트 안에서는 부서 순서대로 직렬
      //    (같은 워킹 트리를 동시에 고치면 diff 귀속이 섞이므로)
      this.setPhase('working')
      const byProject = new Map<string, PlannedTask[]>()
      for (const t of active) byProject.set(t.projectId, [...(byProject.get(t.projectId) ?? []), t])
      for (const t of active) this.pty.resetToIdle(t.agentId)
      for (const list of byProject.values()) list.sort((a, b) => DEPT_ORDER.indexOf(a.department) - DEPT_ORDER.indexOf(b.department))
      for (const list of byProject.values()) for (const t of list) this.patchAgent(t.agentId, { status: 'queued' })

      const reports: ProjectReport[] = []
      await Promise.all(
        [...byProject.entries()].map(async ([projectId, list]) => {
          const project = this.config.projects.find((p) => p.id === projectId)!
          for (const t of list) reports.push(await this.runTask(plan, project, t))
        }),
      )

      // 5) 팀장 결과 취합 (수정 후 상태를 다시 스캔해 브리핑에 반영)
      this.setPhase('reviewing')
      await Promise.all([this.scan(), sleep(FAST ? 100 : 2500)])
      this.finishWithReports(plan, reports)
    } catch (e) {
      this.toast('error', `오케스트레이션 실패: ${String(e)}`)
      this.setPhase('idle')
    }
  }

  private async runTask(plan: CommandPlan, project: ProjectConfig, t: PlannedTask): Promise<ProjectReport> {
    const baseline = await takeBaseline(project.path)
    if (!this.work.has(project.id)) this.work.set(project.id, { baseline, diffs: [] })

    const dept = DEPARTMENTS.find((d) => d.id === t.department)!
    const taskFile = join(DATA_DIR, 'tasks', plan.commandId, `${t.agentId.replace(':', '__')}.json`)
    mkdirSync(dirname(taskFile), { recursive: true })
    const d = this.deltas[project.id]
    writeFileSync(
      taskFile,
      JSON.stringify({
        command: plan.text,
        department: t.department,
        departmentName: dept.name,
        projectId: project.id,
        projectName: project.name,
        prompt: t.prompt,
        context: { changedFiles: d?.changedFiles.map((f) => f.file) ?? [], errors: d?.checks.filter((c) => !c.ok) ?? [] },
      }),
    )

    const r = this.config.runner
    const spec: SpawnSpec = {
      agentId: t.agentId,
      cwd: project.path,
      file: process.execPath,
      args: [join(BIN_DIR, r.mode === 'claude' ? 'claude-stream.mjs' : 'mock-claude.mjs')],
      env: { VOXELHQ_TASK_FILE: taskFile, VOXELHQ_CLAUDE_BIN: r.claudeBin, VOXELHQ_CLAUDE_ARGS: JSON.stringify([...r.claudeArgs, ...this.allowedToolsArgs(project)]) },
      timeoutSec: r.timeoutSec,
      banner: `[VoxelHQ] ${dept.name} → ${project.name} · 실행기: ${r.mode === 'claude' ? 'Claude Code CLI' : 'mock'}`,
    }
    const exitCode = await this.pty.run(spec)
    const diff = await diffSinceBaseline(project.path, baseline)
    this.work.get(project.id)!.diffs.push(diff)
    return {
      projectId: project.id,
      agentId: t.agentId,
      department: t.department,
      exitCode,
      status: this.pty.getStatus(t.agentId),
      diffStat: diff.stat,
      files: [...diff.trackedFiles, ...diff.newFiles],
      diff: diff.diff,
      outputTail: this.pty.getTail(t.agentId, 2000),
    }
  }

  /** 비대화형(-p) 실행에서도 프로젝트 검사 명령은 승인 없이 돌릴 수 있게 허용 목록을 만든다 */
  private allowedToolsArgs(project: ProjectConfig): string[] {
    if (this.config.runner.claudeArgs.includes('--allowedTools')) return []
    const checks = Object.values(project.checks ?? {}).filter(Boolean) as string[]
    return ['--allowedTools', ['Read', 'Edit', 'Write', 'Glob', 'Grep', ...checks.map((c) => `Bash(${c})`)].join(',')]
  }

  private finishWithReports(plan: CommandPlan, reports: ProjectReport[]) {
    this.approval = { commandId: plan.commandId, text: plan.text, createdAt: Date.now(), reports, skipped: plan.tasks.filter((t) => t.skipped) }
    this.broadcast({ type: 'approval', approval: this.approval })
    if (reports.some((r) => r.files.length)) {
      this.setPhase('awaiting-approval')
    } else {
      this.approval.decided = 'approved'
      this.approval.decisionLog = ['변경된 파일이 없어 승인할 항목이 없습니다.']
      this.broadcast({ type: 'approval', approval: this.approval })
      this.setPhase('idle')
    }
  }

  // ───────────────────────── 승인 / 반려 ─────────────────────────

  async decide(commandId: string, approve: boolean) {
    const card = this.approval
    if (!card || card.commandId !== commandId || card.decided || this.phase !== 'awaiting-approval') {
      this.toast('warn', '처리할 승인 카드가 없습니다.')
      return
    }
    const log: string[] = []
    for (const [projectId, w] of this.work) {
      const project = this.config.projects.find((p) => p.id === projectId)!
      const tracked = [...new Set(w.diffs.flatMap((d) => d.trackedFiles))]
      const created = [...new Set(w.diffs.flatMap((d) => d.newFiles))].filter((f) => existsSync(join(project.path, f)))
      if (!tracked.length && !created.length) continue
      try {
        log.push(approve ? await this.commitProject(project, card, [...tracked, ...created]) : await this.revertProject(project, card, w.baseline, tracked, created))
      } catch (e) {
        log.push(`${project.name}: 실패 — ${String(e)}`)
      }
    }
    card.decided = approve ? 'approved' : 'rejected'
    card.decisionLog = log
    this.broadcast({ type: 'approval', approval: card })
    for (const a of this.agents.values()) if (a.role === 'worker') this.pty.resetToIdle(a.id)
    for (const a of this.agents.values()) if (a.task) this.patchAgent(a.id, { task: undefined })
    for (const d of DEPARTMENTS) this.refreshLeader(d.id)
    this.setPhase('idle')
    await this.scan()
    this.toast('info', approve ? '변경 사항을 커밋했습니다.' : '변경 사항을 되돌렸습니다 (패치는 .data/rejected 에 보관).')
  }

  private async commitProject(p: ProjectConfig, card: ApprovalCard, files: string[]) {
    await git(p.path, ['add', '--', ...files])
    const hasIdentity = (await git(p.path, ['config', 'user.email'])).stdout.trim()
    const id = hasIdentity ? [] : ['-c', 'user.name=VoxelHQ', '-c', 'user.email=voxelhq@localhost']
    const msg = `VoxelHQ: ${card.text}\n\n지시 ID: ${card.commandId}\n` + card.reports.filter((r) => r.projectId === p.id && r.files.length).map((r) => `- ${r.department}: ${r.files.join(', ')}`).join('\n')
    const r = await git(p.path, [...id, 'commit', '-m', msg, '--', ...files])
    if (r.code !== 0) throw new Error(r.stderr || r.stdout)
    const head = (await git(p.path, ['rev-parse', '--short', 'HEAD'])).stdout.trim()
    // 문서팀이 이번 지시에 참여했다면 기록 지점 갱신
    if (card.reports.some((x) => x.projectId === p.id && x.department === 'docs')) {
      this.state.docsHead[p.id] = head
      this.saveState()
    }
    let pr = ''
    if (p.github && process.env.VOXELHQ_GITHUB_PR === '1') {
      const branch = `voxelhq/${card.commandId}`
      const push = await git(p.path, ['push', 'origin', `HEAD:refs/heads/${branch}`])
      if (push.code === 0) pr = (await openPullRequest(p, branch, `VoxelHQ: ${card.text}`, msg)) ?? ''
      else pr = `푸시 실패: ${push.stderr.trim()}`
    }
    return `${p.name}: ${files.length}개 파일 커밋 (${head})${pr ? ` · ${pr}` : ''}`
  }

  private async revertProject(p: ProjectConfig, card: ApprovalCard, baseline: Baseline, tracked: string[], created: string[]) {
    // 되돌리기 전에 패치와 새 파일을 보관 → 언제든 복구 가능
    const dir = join(DATA_DIR, 'rejected', card.commandId, p.id)
    mkdirSync(dir, { recursive: true })
    if (tracked.length) writeFileSync(join(dir, 'changes.patch'), (await git(p.path, ['diff', baseline.sha, '--', ...tracked])).stdout)
    for (const f of created) {
      const dest = join(dir, 'new-files', f)
      mkdirSync(dirname(dest), { recursive: true })
      copyFileSync(join(p.path, f), dest)
    }
    // 기준 스냅샷(작업 직전 상태, 사용자의 기존 미커밋 변경 포함)으로 복원
    for (const f of tracked) {
      const r = await git(p.path, ['checkout', baseline.sha, '--', f])
      if (r.code !== 0) await git(p.path, ['rm', '-f', '--cached', '--', f]).then(() => existsSync(join(p.path, f)) && unlinkSync(join(p.path, f)))
    }
    // checkout 으로 인덱스에 올라간 내용은 내려서 작업 전처럼 미스테이징 상태로 둔다
    if (tracked.length) await git(p.path, ['reset', '-q', '--', ...tracked])
    for (const f of created) unlinkSync(join(p.path, f))
    return `${p.name}: ${tracked.length + created.length}개 파일 복원 (보관: .data/rejected/${card.commandId}/${p.id})`
  }

  shutdown() {
    this.pty.killAll()
  }
}
