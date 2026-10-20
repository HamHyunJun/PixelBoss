// 중앙 오케스트레이터: 상태 보관, 전체 소집 → 분해 → PTY 병렬 실행 → 결과 취합 → 승인/반려
import { randomUUID } from 'node:crypto'
import { copyFileSync, existsSync, mkdirSync, readFileSync, unlinkSync, writeFileSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { DEPARTMENTS, leaderId, workerId } from '@pixelboss/shared'
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
} from '@pixelboss/shared'
import { REPO_ROOT, saveProjects, type HQConfig } from './config.js'
import { detectDelta, diffSinceBaseline, git, runShell, takeBaseline, type Baseline, type WorkDiff } from './git.js'
import { countOpenIssues, openPullRequest } from './github.js'
import { departmentsFor, parseIdeas, planCommand, planHandoff, type PlannerState } from './planner.js'
import { describeProject } from './projects.js'
import { PtyManager, type SpawnSpec } from './pty-manager.js'
import { IssueTracker, type IssueInput } from './issues.js'
import { PipelineManager, type AgentRunOptions, type AgentRunResult } from './pipeline.js'
import { Scheduler } from './scheduler.js'

const DATA_DIR = resolve(REPO_ROOT, '.data')
const STATE_FILE = join(DATA_DIR, 'state.json')
const BIN_DIR = resolve(REPO_ROOT, 'apps/server/bin')
// 3D 연출(회의실 집결/업무 전달)이 보이도록 단계 사이에 두는 시간. 검증 시 PIXELBOSS_FAST=1 로 단축.
const FAST = process.env.PIXELBOSS_FAST === '1'
// 가장 먼 부서 팀장이 사장실 회의 테이블까지 걸어와 자리 잡을 시간
const ASSEMBLE_MS = FAST ? 300 : 12500
const DISPATCH_MS = FAST ? 300 : 5000
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms))
const DEPT_ORDER: DepartmentId[] = ['qa', 'infra', 'planning', 'dev', 'docs']

interface ProjectWork {
  baseline: Baseline
  diffs: WorkDiff[]
}

export class HQ {
  readonly pty: PtyManager
  readonly scheduler: Scheduler
  readonly pipelines: PipelineManager
  readonly issues: IssueTracker
  /** 서버가 켜진 뒤 첫 스캔이 끝났는지: 그 전에 발견된 기존 문제는 3D 보고 연출을 하지 않는다 */
  private firstScanDone = false
  /** 자리를 비운 사이 도착한 결과를 알린다 (OS 알림). 스케줄로 돌린 지시에만 쓴다 */
  onAttention?: (title: string, body: string) => void
  private scheduledRun = false
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
    this.issues = new IssueTracker((issue) => this.broadcast({ type: 'issue', issue }))
    this.pipelines = new PipelineManager({
      config,
      deltas: () => this.deltas,
      runAgent: (o) => this.runAgent(o),
      patchAgent: (id, patch) => this.patchAgent(id, patch),
      resetAgent: (id) => this.pty.resetToIdle(id),
      killAgent: (id) => this.pty.kill(id),
      toast: (level, message) => this.toast(level, message),
      attention: (title, body) => this.onAttention?.(title, body),
      issue: (input) => this.raiseIssue(input),
      emit: (pipeline) => this.broadcast({ type: 'pipeline', pipeline }),
      rescan: () => void this.scan(true),
    })
    this.scheduler = new Scheduler(this, config, () => this.broadcast({ type: 'snapshot', data: this.snapshot() }))
    mkdirSync(DATA_DIR, { recursive: true })
    if (existsSync(STATE_FILE)) this.state = { docsHead: {}, ...JSON.parse(readFileSync(STATE_FILE, 'utf8')) }

    for (const dept of DEPARTMENTS) {
      this.agents.set(leaderId(dept.id), { id: leaderId(dept.id), role: 'leader', department: dept.id, name: `${dept.name} 팀장`, status: 'idle' })
    }
    for (const p of config.projects) this.addWorkers(p)

    this.pty.on('data', (agentId: string, data: string) => this.broadcast({ type: 'pty:data', agentId, data }))
    this.pty.on('reset', (agentId: string) => this.broadcast({ type: 'pty:history', agentId, data: '' }))
    this.pty.on('status', (agentId: string, status: PtyStatus, exitCode: number | null) => {
      this.patchAgent(agentId, { status, lastExitCode: exitCode })
      this.refreshLeader(this.agents.get(agentId)!.department)
    })
  }

  private addWorkers(p: ProjectConfig) {
    for (const dept of DEPARTMENTS) {
      const id = workerId(dept.id, p.id)
      this.agents.set(id, { id, role: 'worker', department: dept.id, projectId: p.id, name: `${p.name} 담당`, status: 'idle' })
    }
  }

  /** 진행 중인 지시도 승인 대기도 없는 상태 */
  get idle(): boolean {
    return this.phase === 'idle'
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
      schedules: this.scheduler.info(),
      pipelines: this.pipelines.list(),
      issues: this.issues.list(),
      keepAwake: this.scheduler.keepAwake,
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

  /** mock ↔ claude 전환. claude 로 바꿀 때는 CLI 가 실제로 실행되는지 먼저 확인한다 */
  async setRunnerMode(mode: 'mock' | 'claude'): Promise<{ ok: true } | { ok: false; error: string }> {
    if (this.phase !== 'idle') return { ok: false, error: '진행 중인 지시가 끝난 뒤에 실행기를 바꿀 수 있습니다.' }
    if (mode === 'claude') {
      const r = await runShell(REPO_ROOT, `${this.config.runner.claudeBin} --version`, 15)
      if (r.code !== 0) return { ok: false, error: `Claude Code CLI(${this.config.runner.claudeBin})를 실행할 수 없습니다. 설치·로그인 상태를 확인하세요.` }
    }
    this.config.runner.mode = mode
    saveProjects(this.config)
    this.broadcast({ type: 'snapshot', data: this.snapshot() })
    return { ok: true }
  }

  /** 실무자 터미널을 클릭했을 때: 지시 실행 중이 아니면 담당 프로젝트 폴더에서 Claude Code 대화형 세션을 연다 */
  openSession(agentId: string) {
    const a = this.agents.get(agentId)
    const project = a?.role === 'worker' ? this.config.projects.find((p) => p.id === a.projectId) : undefined
    if (project) this.pty.openManual(agentId, project.path, this.config.runner.claudeBin)
  }

  // ───────────────────────── 프로젝트 등록/삭제 ─────────────────────────

  /** 지시·승인 대기 중에는 계획/리포트가 프로젝트를 참조하므로 목록을 바꾸지 않는다 */
  private projectsLocked(): string | undefined {
    return this.phase === 'idle' ? undefined : '진행 중인 지시가 끝난 뒤에 프로젝트를 변경할 수 있습니다.'
  }

  async addProject(rawPath: string, name?: string): Promise<{ ok: true; project: ProjectConfig } | { ok: false; error: string }> {
    const locked = this.projectsLocked()
    if (locked) return { ok: false, error: locked }
    try {
      const project = await describeProject(rawPath, name, this.config.projects)
      // await 중에 다른 요청이 목록을 바꿨을 수 있어 다시 확인
      if (this.phase !== 'idle') return { ok: false, error: '다른 변경이 진행 중입니다. 다시 시도해주세요.' }
      this.config.projects.push(project)
      this.addWorkers(project)
      saveProjects(this.config)
      this.broadcast({ type: 'snapshot', data: this.snapshot() })
      void this.scan(true) // 새 프로젝트 상태를 바로 반영
      return { ok: true, project }
    } catch (e) {
      return { ok: false, error: e instanceof Error ? e.message : String(e) }
    }
  }

  removeProject(projectId: string): { ok: true; project: ProjectConfig } | { ok: false; error: string } {
    const locked = this.projectsLocked()
    if (locked) return { ok: false, error: locked }
    if (this.pipelines.activeFor(projectId)) return { ok: false, error: '이 프로젝트의 개발 파이프라인이 진행 중입니다. 끝나거나 중단한 뒤 삭제하세요.' }
    const i = this.config.projects.findIndex((p) => p.id === projectId)
    if (i < 0) return { ok: false, error: '등록되지 않은 프로젝트입니다.' }
    const [project] = this.config.projects.splice(i, 1) as [ProjectConfig]
    for (const dept of DEPARTMENTS) {
      const id = workerId(dept.id, projectId)
      this.pty.forget(id)
      this.agents.delete(id)
      this.refreshLeader(dept.id)
    }
    delete this.deltas[projectId]
    this.issues.resolveProject(projectId)
    delete this.state.docsHead[projectId]
    this.saveState()
    saveProjects(this.config)
    this.broadcast({ type: 'snapshot', data: this.snapshot() })
    return { ok: true, project }
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
          if (!this.config.projects.includes(p)) return // 스캔 도중 삭제됨
          this.deltas[p.id] = d
          this.broadcast({ type: 'delta', delta: d })
          this.syncCheckIssues(p, d)
        }),
      )
    })().finally(() => {
      this.scanning = null
      this.firstScanDone = true
    })
    return this.scanning
  }

  // ───────────────────────── 이슈 보고 ─────────────────────────

  /** 문제를 올린다. 새 문제면 담당 팀장이 보고하러 움직이고(클라이언트 연출), 에러면 OS 알림도 띄운다 */
  raiseIssue(input: IssueInput): void {
    const silent = input.silent ?? false
    const isNew = this.issues.raise({ ...input, silent })
    if (isNew && !silent && input.severity === 'error') this.onAttention?.('PixelBoss 에러 보고', `${input.title}`)
  }

  /** 검사 실패(typecheck/lint/test/build/audit/git)를 이슈로 올리고, 다시 통과한 것은 해결 처리한다 */
  private syncCheckIssues(p: ProjectConfig, d: ProjectDelta): void {
    const owner: Record<string, DepartmentId> = { build: 'infra', audit: 'infra' }
    const failing = new Set<string>()
    for (const c of d.checks) {
      if (c.ok) continue
      const key = `check:${p.id}:${c.name}`
      failing.add(key)
      const git = c.name === 'git'
      this.raiseIssue({
        key,
        projectId: p.id,
        department: owner[c.name] ?? 'qa',
        kind: 'check',
        // git 저장소가 아니면 모든 기능이 막히므로 대표 보고, 나머지 검사 실패는 게시판에 게시한다
        severity: git ? 'error' : 'warn',
        route: git ? 'ceo' : 'board',
        title: git ? `${p.name}: git 저장소를 읽을 수 없습니다` : `${p.name}: ${c.name} 검사가 실패하고 있습니다`,
        detail: `${c.errorCount ? `에러 약 ${c.errorCount}건\n\n` : ''}${c.excerpt}`.trim(),
        silent: !this.firstScanDone,
      })
    }
    this.issues.syncChecks(p.id, failing)
  }

  // ───────────────────────── 전체 소집 파이프라인 ─────────────────────────

  async command(text: string, departments: DepartmentId[] = [], opts: { scheduled?: boolean } = {}) {
    text = text.trim()
    if (!text) return
    // 클라이언트가 보낸 값이므로 알려진 부서만, 중복 없이
    const only = DEPARTMENTS.map((d) => d.id).filter((id) => departments.includes(id))
    // 소집 단계부터 관계있는 팀장만 사장실에 가도록, 키워드로 정해지는 부서를 미리 계산한다
    const attendees = only.length ? only : departmentsFor(text)
    await this.execute(text, attendees, (commandId) => planCommand(commandId, text, this.config.projects, this.deltas, this.state, only), !!opts.scheduled)
  }

  /**
   * 사용자가 승인한 제안을 개발팀에 하달한다 (제안한 팀장 → 개발팀장 업무 전달 연출).
   * 연출(소집 → 분해 → 하달)이 끝나면 프로젝트마다 파이프라인(개발 → QA → 수정 → 최종 결정)을 시작하고 지시 단계는 바로 idle 로 돌려놓는다.
   */
  private async handoffToDev(items: { project: ProjectConfig; proposal: string }[]) {
    if (this.phase !== 'idle') {
      this.toast('warn', '진행 중인 지시가 있어 개발팀 하달을 시작하지 못했습니다. 끝난 뒤 다시 승인해주세요.')
      return
    }
    const commandId = randomUUID().slice(0, 8)
    const plan = planHandoff(commandId, items, this.deltas)
    this.plan = { ...plan, tasks: [], rationale: [] }
    this.broadcast({ type: 'plan', plan: this.plan })
    try {
      this.setPhase('assembling')
      await sleep(ASSEMBLE_MS)
      this.plan = plan
      this.setPhase('planning')
      this.broadcast({ type: 'plan', plan })
      for (const t of plan.tasks) this.patchAgent(t.agentId, { task: plan.text })
      await sleep(FAST ? 100 : 1500)
      this.setPhase('dispatching')
      await sleep(DISPATCH_MS)
      for (const t of plan.tasks) this.patchAgent(t.agentId, { task: undefined })
      this.pipelines.start(items, plan.text)
    } catch (e) {
      this.toast('error', `개발팀 하달 실패: ${String(e)}`)
    } finally {
      this.setPhase('idle')
    }
  }

  /** 소집 → 분해 → 하달 → PTY 병렬 실행 → 결과 취합. makePlan 이 지시 종류(직접 지시/하달)별 계획을 만든다 */
  private async execute(text: string, attendees: DepartmentId[], makePlan: (commandId: string) => CommandPlan, scheduled = false) {
    if (this.phase !== 'idle') {
      this.toast('warn', this.phase === 'awaiting-approval' ? '이전 지시의 승인 카드를 먼저 처리해주세요.' : '이미 진행 중인 지시가 있습니다.')
      return
    }
    this.scheduledRun = scheduled
    const commandId = randomUUID().slice(0, 8)
    this.approval = null
    this.work.clear()
    this.plan = { commandId, text, createdAt: Date.now(), departments: attendees, tasks: [], rationale: [] }
    // 3D 연출이 소집 대상을 알 수 있도록 분해 전에도 대상 부서를 내려보낸다
    this.broadcast({ type: 'plan', plan: this.plan })

    try {
      // 1) 팀장 소집 (3D: 팀장들이 회의실로 이동)
      this.setPhase('assembling')
      const [plan] = await Promise.all([this.scan().then(() => makePlan(commandId)), sleep(ASSEMBLE_MS)])

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
      this.raiseIssue({
        key: `system:command:${commandId}`,
        projectId: this.config.projects[0]?.id ?? '',
        department: 'qa',
        kind: 'system',
        severity: 'error',
        route: 'ceo',
        title: `지시 처리 중 오류가 발생했습니다`,
        detail: `지시: ${text}\n\n${e instanceof Error ? e.message : String(e)}`,
      })
      if (this.scheduledRun) this.onAttention?.('PixelBoss 오류', `예약 지시가 실패했습니다: ${String(e).slice(0, 120)}`)
      this.setPhase('idle')
    }
  }

  private async runTask(plan: CommandPlan, project: ProjectConfig, t: PlannedTask): Promise<ProjectReport> {
    const baseline = await takeBaseline(project.path)
    if (!this.work.has(project.id)) this.work.set(project.id, { baseline, diffs: [] })

    const res = await this.runAgent({ runId: plan.commandId, label: '', agentId: t.agentId, department: t.department, project, cwd: project.path, commandText: plan.text, prompt: t.prompt, mode: t.mode ?? 'propose' })
    const dept = DEPARTMENTS.find((x) => x.id === t.department)!
    const issueKey = `agent:${project.id}:${t.department}`
    if (res.exitCode !== 0) {
      this.raiseIssue({
        key: issueKey,
        projectId: project.id,
        department: t.department,
        kind: 'agent',
        severity: 'error',
        route: 'ceo',
        title: `${dept.name}: ${project.name} 작업이 실패했습니다 (exit ${res.exitCode})`,
        detail: `지시: ${plan.text}\n\n${res.outputTail.slice(-800)}`,
      })
    } else this.issues.resolve(issueKey)
    const diff = await diffSinceBaseline(project.path, baseline)
    this.work.get(project.id)!.diffs.push(diff)
    // 제안 모드의 정상 종료 보고서는 제안 단위로 나눈다: 제안마다 개발팀 하달 여부를 사용자가 정한다
    const parsed = (t.mode ?? 'propose') === 'propose' && res.exitCode === 0 ? parseIdeas(res.summary) : { intro: '', ideas: [] }
    const ideas = parsed.ideas.map((x, i) => ({ id: `${t.agentId}#${i + 1}`, ...x }))
    return {
      projectId: project.id,
      agentId: t.agentId,
      department: t.department,
      exitCode: res.exitCode,
      status: this.pty.getStatus(t.agentId),
      diffStat: diff.stat,
      files: [...diff.trackedFiles, ...diff.newFiles],
      diff: diff.diff,
      summary: res.summary,
      proposal: ideas.length > 0,
      intro: parsed.intro,
      ideas,
      outputTail: res.outputTail,
    }
  }

  /** 에이전트 한 번 실행: 작업 파일 작성 → PTY(mock 또는 Claude Code) 실행 → 최종 답변(한글 보고) 읽기. 같은 에이전트가 쓰는 중이면 끝날 때까지 기다린다 */
  async runAgent(o: AgentRunOptions): Promise<AgentRunResult> {
    const dept = DEPARTMENTS.find((d) => d.id === o.department)!
    const taskFile = join(DATA_DIR, 'tasks', o.runId, `${o.agentId.replace(':', '__')}${o.label ? `__${o.label}` : ''}.json`)
    mkdirSync(dirname(taskFile), { recursive: true })
    const d = this.deltas[o.project.id]
    writeFileSync(
      taskFile,
      JSON.stringify({
        command: o.commandText,
        department: o.department,
        departmentName: dept.name,
        projectId: o.project.id,
        projectName: o.project.name,
        prompt: o.prompt,
        mode: o.mode,
        context: { changedFiles: d?.changedFiles.map((f) => f.file) ?? [], errors: d?.checks.filter((c) => !c.ok) ?? [] },
      }),
    )
    const r = this.config.runner
    const resultFile = taskFile.replace(/\.json$/, '.result.txt')
    if (existsSync(resultFile)) unlinkSync(resultFile)
    const spec: SpawnSpec = {
      agentId: o.agentId,
      cwd: o.cwd,
      file: process.execPath,
      args: [join(BIN_DIR, r.mode === 'claude' ? 'claude-stream.mjs' : 'mock-claude.mjs')],
      env: { PIXELBOSS_TASK_FILE: taskFile, PIXELBOSS_RESULT_FILE: resultFile, PIXELBOSS_CLAUDE_BIN: r.claudeBin, PIXELBOSS_CLAUDE_ARGS: JSON.stringify([...r.claudeArgs, ...this.toolArgs(o.project, o.mode)]) },
      timeoutSec: r.timeoutSec,
      banner: `[PixelBoss] ${dept.name} → ${o.project.name} · 실행기: ${r.mode === 'claude' ? 'Claude Code CLI' : 'mock'}`,
    }
    while (this.pty.isBusy(o.agentId)) await sleep(500)
    this.pty.resetToIdle(o.agentId)
    const exitCode = await this.pty.run(spec)
    const summary = existsSync(resultFile) ? readFileSync(resultFile, 'utf8').trim() : ''
    return { exitCode, summary, outputTail: this.pty.getTail(o.agentId, 2000) }
  }

  /** 비대화형(-p) 실행의 도구 권한. 제안·검수 모드는 읽기 전용(Edit/Write/Bash 차단), 구현·수정(execute/fix)은 편집과 프로젝트 검사 명령을 허용한다 */
  private toolArgs(project: ProjectConfig, mode: AgentRunOptions['mode']): string[] {
    if (mode === 'propose' || mode === 'review') return ['--allowedTools', 'Read,Glob,Grep', '--disallowedTools', 'Edit,Write,NotebookEdit,Bash']
    if (this.config.runner.claudeArgs.includes('--allowedTools')) return []
    const checks = Object.values(project.checks ?? {}).filter(Boolean) as string[]
    return ['--allowedTools', ['Read', 'Edit', 'Write', 'Glob', 'Grep', ...checks.map((c) => `Bash(${c})`)].join(',')]
  }

  private finishWithReports(plan: CommandPlan, reports: ProjectReport[]) {
    this.approval = { commandId: plan.commandId, text: plan.text, createdAt: Date.now(), reports, skipped: plan.tasks.filter((t) => t.skipped) }
    this.broadcast({ type: 'approval', approval: this.approval })
    const pending = this.decisionKeys(this.approval).length
    if (this.scheduledRun) {
      this.onAttention?.('PixelBoss 보고서 도착', pending ? `“${plan.text.slice(0, 40)}” — 결정할 항목 ${pending}건이 기다립니다.` : `“${plan.text.slice(0, 40)}” — 결정할 제안이 없습니다.`)
    }
    if (pending) {
      this.setPhase('awaiting-approval')
    } else {
      this.approval.decided = true
      this.approval.decisionLog = ['변경된 파일이나 제안이 없어 결정할 항목이 없습니다.']
      this.broadcast({ type: 'approval', approval: this.approval })
      this.setPhase('idle')
    }
  }

  // ───────────────────────── 승인 / 반려 ─────────────────────────

  /** 사용자의 결정이 필요한 키: 코드 변경이 있는 프로젝트 id + 기획 아이디어 id 각각 */
  private decisionKeys(card: ApprovalCard): string[] {
    const projects = card.reports.filter((r) => r.files.length).map((r) => r.projectId)
    return [...new Set(projects), ...card.reports.flatMap((r) => r.ideas.map((i) => i.id))]
  }

  /** 승인/반려를 한꺼번에 적용한다. 코드 변경은 프로젝트별로 커밋/되돌리기, 기획 아이디어는 승인한 것만 개발팀에 하달한다 */
  async decide(commandId: string, decisions: Record<string, boolean>) {
    const card = this.approval
    if (!card || card.commandId !== commandId || card.decided || this.phase !== 'awaiting-approval') {
      this.toast('warn', '처리할 승인 카드가 없습니다.')
      return
    }
    const keys = this.decisionKeys(card)
    if (keys.some((k) => typeof decisions?.[k] !== 'boolean')) {
      this.toast('warn', '모든 항목의 승인/반려를 선택해주세요.')
      return
    }
    const log: string[] = []
    const handoff: { project: ProjectConfig; proposal: string }[] = []
    card.decisions = Object.fromEntries(keys.map((k) => [k, decisions[k] ? 'approved' : 'rejected'])) as NonNullable<ApprovalCard['decisions']>
    const projectIds = [...new Set(card.reports.map((r) => r.projectId))]
    for (const projectId of projectIds) {
      const project = this.config.projects.find((p) => p.id === projectId)
      if (!project) continue
      try {
        // 코드 변경: 프로젝트 단위로 커밋 또는 되돌리기
        const w = this.work.get(projectId)
        const tracked = [...new Set(w?.diffs.flatMap((d) => d.trackedFiles) ?? [])]
        const created = [...new Set(w?.diffs.flatMap((d) => d.newFiles) ?? [])].filter((f) => existsSync(join(project.path, f)))
        if (w && (tracked.length || created.length) && typeof decisions[projectId] === 'boolean') {
          log.push(decisions[projectId] ? await this.commitProject(project, card, [...tracked, ...created]) : await this.revertProject(project, card, w.baseline, tracked, created))
        }
        // 각 부서의 제안: 승인한 것만 모아 개발팀에 하달 (제안한 부서를 제목에 표시)
        const reports = card.reports.filter((r) => r.projectId === projectId)
        const ideas = reports.flatMap((r) => r.ideas)
        const picked = reports.flatMap((r) => r.ideas.filter((i) => decisions[i.id]).map((i) => `### [${DEPARTMENTS.find((d) => d.id === r.department)?.name ?? r.department}] ${i.title}\n${i.body}`))
        if (ideas.length) {
          log.push(`${project.name}: 제안 ${ideas.length}건 중 ${picked.length}건 승인${picked.length ? ' → 개발팀 하달' : ' (코드는 수정되지 않았습니다)'}`)
          if (picked.length) handoff.push({ project, proposal: picked.join('\n\n') })
        }
      } catch (e) {
        log.push(`${project.name}: 실패 — ${String(e)}`)
      }
    }
    card.decided = true
    card.decisionLog = log
    this.broadcast({ type: 'approval', approval: card })
    for (const a of this.agents.values()) if (a.role === 'worker') this.pty.resetToIdle(a.id)
    for (const a of this.agents.values()) if (a.task) this.patchAgent(a.id, { task: undefined })
    for (const d of DEPARTMENTS) this.refreshLeader(d.id)
    this.setPhase('idle')
    await this.scan()
    this.toast('info', handoff.length ? `승인한 제안을 ${handoff.length}개 프로젝트의 개발팀에 하달합니다.` : '결정을 적용했습니다.')
    if (handoff.length) void this.handoffToDev(handoff)
  }

  private async commitProject(p: ProjectConfig, card: ApprovalCard, files: string[]) {
    await git(p.path, ['add', '--', ...files])
    const hasIdentity = (await git(p.path, ['config', 'user.email'])).stdout.trim()
    const id = hasIdentity ? [] : ['-c', 'user.name=PixelBoss', '-c', 'user.email=pixelboss@localhost']
    const msg = `PixelBoss: ${card.text}\n\n지시 ID: ${card.commandId}\n` + card.reports.filter((r) => r.projectId === p.id && r.files.length).map((r) => `- ${r.department}: ${r.files.join(', ')}`).join('\n')
    const r = await git(p.path, [...id, 'commit', '-m', msg, '--', ...files])
    if (r.code !== 0) throw new Error(r.stderr || r.stdout)
    const head = (await git(p.path, ['rev-parse', '--short', 'HEAD'])).stdout.trim()
    // 문서팀이 이번 지시에 참여했다면 기록 지점 갱신
    if (card.reports.some((x) => x.projectId === p.id && x.department === 'docs')) {
      this.state.docsHead[p.id] = head
      this.saveState()
    }
    let pr = ''
    if (p.github && process.env.PIXELBOSS_GITHUB_PR === '1') {
      const branch = `pixelboss/${card.commandId}`
      const push = await git(p.path, ['push', 'origin', `HEAD:refs/heads/${branch}`])
      if (push.code === 0) pr = (await openPullRequest(p, branch, `PixelBoss: ${card.text}`, msg)) ?? ''
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
    this.scheduler.stop()
    this.pty.killAll()
  }
}
