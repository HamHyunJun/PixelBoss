// 연출 감독: 백엔드 상태(단계, PTY 상태, 델타)를 캐릭터 FSM 행동으로 변환
import { DEPARTMENTS, leaderId, workerId } from '@pixelboss/shared'
import type { AgentInfo, IssueInfo, CommandPlan, DepartmentId, OrchestratorPhase, ProjectDelta, PtyStatus } from '@pixelboss/shared'
import type { Character, IconKind } from './character'
import { BREAK_SPOTS, besideSpot, boardSpot, ceoMeetingSpot, ceoReportSpot, meetingSeat, type BreakKind, type BreakSpot } from './layout'
import type { DeskHandle, WorldHandle } from './world'

export interface DirectorInput {
  phase: OrchestratorPhase
  agents: Record<string, AgentInfo>
  deltas: Record<string, ProjectDelta>
  plan: CommandPlan | null
  issues: IssueInfo[]
}

const SCREEN: Record<PtyStatus, string> = {
  idle: '#2a3a55',
  queued: '#55555f',
  running: '#ff9f1a',
  waiting: '#ffcc00',
  done: '#34c759',
  error: '#ff3b30',
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms))

/** 정적 검사 실패를 어느 부서 실무자가 표시할지 */
const CHECK_OWNER: Record<string, DepartmentId> = { typecheck: 'qa', lint: 'qa', test: 'qa', build: 'infra', audit: 'infra', git: 'qa' }

export class Director {
  private seq = new Map<string, number>()
  private lastPhase: OrchestratorPhase | null = null
  private lastStatus = new Map<string, PtyStatus>()
  private lastAlert = new Map<string, boolean>()
  private boardSeq = 0
  private dispatching = new Set<string>()

  constructor(
    private chars: Map<string, Character>,
    private desks: Map<string, DeskHandle>,
    private world: WorldHandle,
  ) {}

  setWorld(world: WorldHandle) {
    this.world = world
  }

  /** 캐릭터별 연출 시퀀스 시작. 새 시퀀스가 시작되면 이전 것은 다음 await 에서 중단된다. */
  private run(id: string, fn: (alive: () => boolean, c: Character) => Promise<void>) {
    const c = this.chars.get(id)
    if (!c) return
    const token = (this.seq.get(id) ?? 0) + 1
    this.seq.set(id, token)
    void fn(() => this.seq.get(id) === token, c)
  }

  private alertFor(agent: AgentInfo, deltas: Record<string, ProjectDelta>) {
    if (agent.role !== 'worker' || !agent.projectId) return false
    const d = deltas[agent.projectId]
    return !!d?.checks.some((c) => !c.ok && (CHECK_OWNER[c.name] ?? 'qa') === agent.department)
  }

  /** 이 감독이 만들어진(페이지가 열린) 시각. 그 전에 생긴 이슈는 목록에만 올리고 보고 연출은 하지 않는다 */
  private readonly bootAt = Date.now() - 3000
  private knownIssues = new Set<string>()
  private issueQueue: IssueInfo[] = []
  private reporting = false
  private issueSeq = 0
  private breakers = new Set<string>()
  private usedSpots = new Set<string>()
  private breakClock = 0

  sync(s: DirectorInput) {
    if (s.phase !== this.lastPhase) {
      this.onPhase(s.phase, this.lastPhase, s)
      this.lastPhase = s.phase
    }
    for (const a of Object.values(s.agents)) {
      const prev = this.lastStatus.get(a.id)
      const alert = this.alertFor(a, s.deltas)
      if (prev !== a.status) {
        this.lastStatus.set(a.id, a.status)
        if (a.role === 'worker') this.onWorkerStatus(a, prev, alert)
      } else if (a.role === 'worker' && a.status === 'idle' && alert !== this.lastAlert.get(a.id)) {
        this.onWorkerStatus(a, prev, alert)
      }
      this.lastAlert.set(a.id, alert)
      const desk = this.desks.get(a.id)
      if (desk) desk.screen.material.color.set(a.status === 'idle' && alert ? '#7a1f1f' : SCREEN[a.status])
      if (a.role === 'leader') this.leaderIcon(a, s.phase)
    }
    this.trackIssues(s)
  }

  // ───────────────────────── 쉬는 시간: 대기 중인 직원이 가끔 탕비실(커피·간식·식탁)이나 휴게 라운지로 간다 ─────────────────────────

  /** 엔진이 매 프레임 호출한다. 몇 초마다 대기 중인 직원 한 명을 쉬러 보낸다 */
  tick(dt: number) {
    this.breakClock += dt
    if (this.breakClock < 3) return
    this.breakClock = 0
    this.maybeStartBreak()
  }

  private maybeStartBreak() {
    // 지시·이슈 보고 연출 중에는 쉬지 않는다
    if (this.lastPhase !== 'idle' || this.reporting || this.issueQueue.length) return
    const workers = [...this.chars.values()].filter((c) => !c.leader)
    const limit = Math.min(4, Math.max(1, Math.round(workers.length / 8)))
    if (this.breakers.size >= limit || Math.random() > 0.5) return
    const ready = workers.filter(
      (c) => !this.breakers.has(c.agentId) && c.spot === c.home && !c.busy && c.icon === null && (this.lastStatus.get(c.agentId) ?? 'idle') === 'idle' && !this.lastAlert.get(c.agentId),
    )
    const who = ready[Math.floor(Math.random() * ready.length)]
    if (!who) return
    const stops = this.planBreak()
    if (stops.length) this.takeBreak(who, stops)
  }

  /** 어디서 무엇을 할지: 커피 → 자리에 앉아 마시기 / 물·간식·냉장고 / 라운지 소파 / 식탁 */
  private planBreak(): { spot: BreakSpot; ms: number }[] {
    const free = (kinds: BreakKind[]) => BREAK_SPOTS.filter((s) => kinds.includes(s.kind) && !this.usedSpots.has(s.id))
    const pick = <T,>(a: T[]): T | undefined => a[Math.floor(Math.random() * a.length)]
    const dwell = (min: number, max: number) => min + Math.random() * (max - min)
    const stops: { spot: BreakSpot; ms: number }[] = []
    const r = Math.random()
    if (r < 0.4) {
      const m = pick(free(['coffee']))
      if (m) stops.push({ spot: m, ms: dwell(3000, 4500) })
      const seat = pick(free(['stool', 'dining']))
      if (m && seat) stops.push({ spot: seat, ms: dwell(8000, 15000) })
    } else if (r < 0.58) {
      const m = pick(free(['water', 'vending', 'fridge']))
      if (m) stops.push({ spot: m, ms: dwell(2500, 4000) })
    } else if (r < 0.9) {
      const seat = pick(free(['sofa', 'armchair']))
      if (seat) stops.push({ spot: seat, ms: dwell(12000, 22000) })
    } else {
      const seat = pick(free(['stool', 'dining']))
      if (seat) stops.push({ spot: seat, ms: dwell(8000, 14000) })
    }
    return stops
  }

  private takeBreak(who: Character, stops: { spot: BreakSpot; ms: number }[]) {
    const id = who.agentId
    this.breakers.add(id)
    for (const s of stops) this.usedSpots.add(s.spot.id)
    // 일이 배정되면(다른 연출이 이 직원을 부르면) alive() 가 꺼지고 그쪽에서 자리로 돌려보낸다
    this.run(id, async (alive, c) => {
      try {
        for (const s of stops) {
          if (!(await c.goTo(s.spot)) || !alive()) return
          c.pose = s.spot.pose
          await sleep(s.ms)
          if (!alive()) return
        }
        await c.goHome()
      } finally {
        this.breakers.delete(id)
        for (const s of stops) this.usedSpots.delete(s.spot.id)
      }
    })
  }

  // ───────────────────────── 이슈 보고 연출: 담당자 → 팀장 → (게시판 | 대표) ─────────────────────────

  /** 새로 생긴 이슈를 대기열에 넣고, 지시가 진행 중이 아닐 때 한 건씩 보고 연출을 한다 */
  private trackIssues(s: DirectorInput) {
    for (const i of s.issues) {
      const key = `${i.id}@${i.at}` // 해결됐다가 다시 생기면 at 이 바뀌어 새 이슈로 본다
      if (this.knownIssues.has(key)) continue
      this.knownIssues.add(key)
      if (i.status === 'open' && !i.silent && i.at >= this.bootAt) this.issueQueue.push(i)
    }
    void this.drainIssues(s.phase)
  }

  private async drainIssues(phase: OrchestratorPhase) {
    if (this.reporting || phase !== 'idle') return
    this.reporting = true
    try {
      // 보고 중에 새로 들어온 이슈도 이어서 처리한다. 한꺼번에 많이 쌓여도 연출은 한 번에 최대 4건까지만 한다
      let done = 0
      while (this.issueQueue.length && this.lastPhase === 'idle') {
        if (done++ >= 4) {
          this.issueQueue.length = 0
          break
        }
        await this.reportIssue(this.issueQueue.shift()!)
      }
    } finally {
      this.reporting = false
    }
  }

  private reportIssue(issue: IssueInfo): Promise<void> {
    const dept = issue.department
    return new Promise<void>((resolve) => {
      const leader = this.chars.get(leaderId(dept))
      if (!leader) return resolve()
      this.run(leaderId(dept), async (alive, c) => {
        try {
          // 1) 팀장이 담당 직원에게 가서 문제를 듣는다
          const worker = this.chars.get(workerId(dept, issue.projectId))
          if (worker) {
            if (!(await c.goTo(besideSpot(worker.home, dept))) || !alive()) return
            c.pose = 'talk'
            await sleep(1600)
            if (!alive()) return
          }
          // 2) 에러는 대표에게 직접, 경고는 게시판에 게시
          if (issue.route === 'board') {
            if (!(await c.goTo(boardSpot(this.issueSeq++))) || !alive()) return
            c.pose = 'post'
            await sleep(900)
            if (!alive()) return
            this.world.addPaper('#ff453a')
            await sleep(500)
          } else {
            if (!(await c.goTo(ceoReportSpot())) || !alive()) return
            c.pose = 'talk'
            const boss = this.chars.get('ceo')
            if (boss) boss.pose = 'sittalk'
            await sleep(2800)
            if (boss) boss.pose = boss.spot.sit ? 'typing' : 'stand'
            if (!alive()) return
          }
          await c.goHome()
        } finally {
          resolve()
        }
      })
    })
  }

  private leaderIcon(a: AgentInfo, phase: OrchestratorPhase) {
    const c = this.chars.get(a.id)
    if (!c) return
    let icon: IconKind = null
    if (phase === 'assembling' || phase === 'planning') icon = 'meeting'
    else if (a.status === 'running' || a.status === 'queued') icon = 'working'
    else if (a.status === 'error') icon = 'alert'
    else if (a.status === 'waiting') icon = 'waiting'
    else if (a.status === 'done') icon = 'done'
    c.setIcon(icon)
  }

  /** 사장은 소집(assembling)부터 명령 분해(planning)까지 회의 테이블 상석에 앉아 면담을 주재하고, 이후 책상으로 돌아간다 */
  private bossFollows(phase: OrchestratorPhase) {
    const boss = this.chars.get('ceo')
    if (!boss) return
    if (phase === 'assembling') {
      this.run('ceo', async (alive, c) => {
        await c.goTo(ceoMeetingSpot())
        if (alive()) c.pose = 'sittalk'
      })
    } else if (phase !== 'planning' && boss.spot !== boss.home) {
      this.run('ceo', async (_a, c) => void (await c.goHome()))
    }
  }

  private onPhase(phase: OrchestratorPhase, prev: OrchestratorPhase | null, s: DirectorInput) {
    this.bossFollows(phase)
    const leaders = DEPARTMENTS.map((d) => d.id)
    if (phase === 'assembling') {
      this.world.clearPapers()
      this.boardSeq = 0
      // 소집: 지정 부서가 있으면 그 팀장만, 없으면 모든 팀장이 사장실 회의 테이블로 (사장과 면담)
      const called = s.plan?.departments.length ? s.plan.departments : leaders
      for (const dept of called) {
        this.run(leaderId(dept), async (alive, c) => {
          await c.goTo(meetingSeat(dept))
          if (alive()) c.pose = 'talk'
        })
      }
    } else if (phase === 'dispatching') {
      // 태스크 하달: 팀장이 부서로 복귀해 담당 실무자에게 차례로 다가가 업무 전달
      for (const dept of leaders) {
        const targets = (s.plan?.tasks ?? []).filter((t) => t.department === dept && !t.skipped).map((t) => t.agentId)
        const id = leaderId(dept)
        // 소집되지 않아 자리에 앉아 있고 전달할 일도 없는 팀장은 그대로 둔다 (불필요하게 일어났다 앉지 않도록)
        if (!targets.length && this.chars.get(id)?.spot === this.chars.get(id)?.home) continue
        this.dispatching.add(id)
        this.run(id, async (alive, c) => {
          try {
            await this.deliver(alive, c, dept, targets)
          } finally {
            this.dispatching.delete(id)
          }
        })
      }
    } else if (phase === 'reviewing') {
      // 결과 취합: 작업이 있었던 부서 팀장이 게시판을 확인하고 복귀
      for (const dept of leaders) {
        const had = (s.plan?.tasks ?? []).some((t) => t.department === dept && !t.skipped)
        if (!had) continue
        this.run(leaderId(dept), async (alive, c) => {
          if (!(await c.goTo(boardSpot(this.boardSeq++))) || !alive()) return
          c.pose = 'post'
          await sleep(900)
          if (alive()) await c.goHome()
        })
      }
    } else if (phase === 'idle' || phase === 'awaiting-approval' || phase === 'working') {
      // 업무 전달 중인 팀장은 그대로 두고, 회의실·게시판에 남은 팀장만 자리로 복귀
      for (const dept of leaders) {
        const id = leaderId(dept)
        const c = this.chars.get(id)
        if (c && !this.dispatching.has(id) && c.spot !== c.home) this.run(id, async (_a, ch) => void (await ch.goHome()))
      }
    }
  }

  private async deliver(alive: () => boolean, c: Character, dept: DepartmentId, targets: string[]) {
    for (const wid of targets) {
      const w = this.chars.get(wid)
      if (!w) continue
      if (!(await c.goTo(besideSpot(w.home, dept))) || !alive()) return
      c.pose = 'talk'
      w.setIcon('meeting')
      await sleep(targets.length > 3 ? 450 : 700)
      if (w.icon === 'meeting') w.setIcon(null)
      if (!alive()) return
    }
    await c.goHome()
  }

  private onWorkerStatus(a: AgentInfo, prev: PtyStatus | undefined, alert: boolean) {
    const color = DEPARTMENTS.find((d) => d.id === a.department)!.color
    switch (a.status) {
      case 'queued':
        this.run(a.id, async (_alive, c) => {
          c.setIcon('queued')
          if (c.spot !== c.home) await c.goHome()
        })
        break
      case 'running':
        // 작업/수정 중: 자리에서 타이핑 + 주황 톱니바퀴
        this.run(a.id, async (_alive, c) => {
          c.setIcon('working')
          if (c.spot !== c.home) await c.goHome()
        })
        break
      case 'waiting':
        this.chars.get(a.id)?.setIcon('waiting')
        break
      case 'done':
        // 완료: 녹색 체크 → 게시판에 서류 부착 → 복귀
        this.run(a.id, async (alive, c) => {
          c.setIcon('done')
          if (!(await c.goTo(boardSpot(this.boardSeq++ % 6))) || !alive()) return
          c.pose = 'post'
          await sleep(800)
          if (!alive()) return
          this.world.addPaper(color)
          await c.goHome()
        })
        break
      case 'error':
        // 이슈 발생: 빨간 느낌표만 띄우고 자리를 지킨다. 팀장이 찾아와 듣고 게시판/대표에게 보고한다(이슈 보고 연출)
        this.run(a.id, async (_alive, c) => {
          c.setIcon('alert')
          if (c.spot !== c.home) await c.goHome()
        })
        break
      case 'idle':
        this.run(a.id, async (_alive, c) => {
          // 정적 스캔으로 문제가 감지되면 느낌표를 켜 두고, 해결되면 끈다
          c.setIcon(alert ? 'alert' : null)
          if (c.spot !== c.home) await c.goHome()
        })
        break
    }
  }
}
