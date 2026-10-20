// 연출 감독: 백엔드 상태(단계, PTY 상태, 델타)를 캐릭터 FSM 행동으로 변환
import { DEPARTMENTS, leaderId } from '@voxelhq/shared'
import type { AgentInfo, CommandPlan, DepartmentId, OrchestratorPhase, ProjectDelta, PtyStatus } from '@voxelhq/shared'
import type { Character, IconKind } from './character'
import { besideSpot, boardSpot, meetingSeat, meetingStandSpot } from './layout'
import type { DeskHandle, WorldHandle } from './world'

export interface DirectorInput {
  phase: OrchestratorPhase
  agents: Record<string, AgentInfo>
  deltas: Record<string, ProjectDelta>
  plan: CommandPlan | null
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
  private meetSeq = 0
  private dispatching = new Set<string>()

  constructor(
    private chars: Map<string, Character>,
    private desks: Map<string, DeskHandle>,
    private world: WorldHandle,
  ) {}

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

  private onPhase(phase: OrchestratorPhase, prev: OrchestratorPhase | null, s: DirectorInput) {
    const leaders = DEPARTMENTS.map((d) => d.id)
    if (phase === 'assembling') {
      this.world.clearPapers()
      this.boardSeq = 0
      // 전체 소집: 모든 팀장이 회의실 테이블로
      for (const dept of leaders) {
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
        // 이슈 발생: 빨간 느낌표 → 회의실 보고 → 복귀
        this.run(a.id, async (alive, c) => {
          c.setIcon('alert')
          if (!(await c.goTo(meetingStandSpot(this.meetSeq++))) || !alive()) return
          c.pose = 'talk'
          await sleep(2500)
          if (alive()) await c.goHome()
        })
        break
      case 'idle':
        this.run(a.id, async (alive, c) => {
          if (!alert) {
            c.setIcon(null)
            if (c.spot !== c.home) await c.goHome()
            return
          }
          // 정적 스캔으로 버그 감지: 느낌표 점등 후 회의실에 보고하고 복귀
          c.setIcon('alert')
          if (prev === 'done' || prev === 'error') return
          if (!(await c.goTo(meetingStandSpot(this.meetSeq++))) || !alive()) return
          c.pose = 'talk'
          await sleep(2200)
          if (alive()) await c.goHome()
        })
        break
    }
  }
}
