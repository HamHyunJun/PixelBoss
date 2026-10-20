// 스케줄러: 정해진 요일·시각에 지시를 자동으로 내린다.
// - 30초마다 확인하고, 서버가 늦게 깨어나도(잠자기 등) 같은 날 6시간 안이면 한 번 따라잡는다.
// - 지시는 읽기 전용 제안 보고서만 만들므로 자리를 비워도 파일이 바뀌지 않는다. 결정은 사용자가 돌아와서 한다.
// - 이전 보고서가 승인 대기 중이거나 다른 지시가 진행 중이면 끝날 때까지 기다렸다가(같은 날 안에서) 실행한다.
import { spawn, type ChildProcess } from 'node:child_process'
import { randomUUID } from 'node:crypto'
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { dirname, resolve } from 'node:path'
import { DEPARTMENTS } from '@pixelboss/shared'
import type { ScheduleConfig, ScheduleInfo } from '@pixelboss/shared'
import { REPO_ROOT, saveProjects, type HQConfig } from './config.js'
import type { HQ } from './orchestrator.js'

const STATE_FILE = resolve(REPO_ROOT, '.data/schedule-state.json')
const TICK_MS = 30_000
/** 예정 시각이 지난 뒤 이 시간 안에 서버가 살아나야 따라잡는다 (아침 보고를 밤에 받지 않도록) */
const CATCH_UP_MIN = 360

interface RunState {
  /** 마지막으로 처리한 날짜 'YYYY-MM-DD' (실행했거나 놓쳐서 건너뛴 날) */
  lastDate?: string
  lastRunAt?: number
  lastStatus?: string
}

const ymd = (d: Date): string => `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`
const minutesOf = (time: string): number => Number(time.slice(0, 2)) * 60 + Number(time.slice(3, 5))

export class Scheduler {
  private state: Record<string, RunState> = {}
  private timer?: NodeJS.Timeout
  private awake?: ChildProcess

  constructor(
    private hq: HQ,
    private config: HQConfig,
    private onChange: () => void,
  ) {
    if (existsSync(STATE_FILE)) {
      try {
        this.state = JSON.parse(readFileSync(STATE_FILE, 'utf8'))
      } catch {
        /* 손상된 기록은 무시 */
      }
    }
  }

  start(): void {
    this.syncKeepAwake()
    this.tick()
    this.timer = setInterval(() => this.tick(), TICK_MS)
  }

  stop(): void {
    clearInterval(this.timer)
    this.awake?.kill()
  }

  get keepAwake(): boolean {
    return !!this.awake && !this.awake.killed
  }

  info(now = new Date()): ScheduleInfo[] {
    return this.config.schedules.map((s) => ({ ...s, ...this.state[s.id], nextRunAt: s.enabled ? this.nextRun(s, now) : undefined }))
  }

  // ───────────────────────── 저장/삭제/즉시 실행 ─────────────────────────

  save(input: Omit<ScheduleConfig, 'id'> & { id?: string }): { ok: true } | { ok: false; error: string } {
    const time = String(input.time ?? '')
    if (!/^([01]\d|2[0-3]):[0-5]\d$/.test(time)) return { ok: false, error: '시각은 09:00 같은 24시간 형식으로 입력해주세요.' }
    const days = [...new Set((input.days ?? []).map(Number))].filter((d) => Number.isInteger(d) && d >= 0 && d <= 6).sort()
    if (!days.length) return { ok: false, error: '실행할 요일을 하나 이상 선택해주세요.' }
    const text = String(input.text ?? '').trim()
    if (!text || text.length > 500) return { ok: false, error: '지시 내용을 입력해주세요 (500자 이내).' }
    const known = new Set<string>(DEPARTMENTS.map((d) => d.id))
    const departments = (input.departments ?? []).filter((d) => known.has(d))
    const schedule: ScheduleConfig = {
      id: input.id && this.config.schedules.some((s) => s.id === input.id) ? input.id : randomUUID().slice(0, 8),
      name: String(input.name ?? '').trim().slice(0, 40) || `${time} 정기 보고`,
      time,
      days,
      text,
      departments,
      enabled: !!input.enabled,
    }
    const i = this.config.schedules.findIndex((s) => s.id === schedule.id)
    if (i >= 0) this.config.schedules[i] = schedule
    else this.config.schedules.push(schedule)
    // 오늘 이미 지난 시각으로 만들거나 고치면 바로 실행하지 않고 다음 예정일부터 실행한다
    const now = new Date()
    delete this.state[schedule.id]
    if (now.getHours() * 60 + now.getMinutes() >= minutesOf(time)) this.state[schedule.id] = { lastDate: ymd(now), lastStatus: '오늘 시각이 이미 지나 다음 예정일부터 실행합니다' }
    this.persist()
    return { ok: true }
  }

  remove(id: string): { ok: true } | { ok: false; error: string } {
    const i = this.config.schedules.findIndex((s) => s.id === id)
    if (i < 0) return { ok: false, error: '등록되지 않은 스케줄입니다.' }
    this.config.schedules.splice(i, 1)
    delete this.state[id]
    this.persist()
    return { ok: true }
  }

  /** 지금 한 번 실행 (예정 시각 기록은 건드리지 않는다) */
  async runNow(id: string): Promise<{ ok: true } | { ok: false; error: string }> {
    const s = this.config.schedules.find((x) => x.id === id)
    if (!s) return { ok: false, error: '등록되지 않은 스케줄입니다.' }
    if (!this.hq.idle) return { ok: false, error: '진행 중인 지시가 있거나 승인 대기 중입니다. 먼저 처리해주세요.' }
    void this.hq.command(s.text, s.departments, { scheduled: true })
    return { ok: true }
  }

  // ───────────────────────── 실행 판단 ─────────────────────────

  private tick(now = new Date()): void {
    let changed = false
    for (const s of this.config.schedules) {
      if (!s.enabled || !s.days.includes(now.getDay())) continue
      const st = (this.state[s.id] ??= {})
      if (st.lastDate === ymd(now)) continue
      const late = now.getHours() * 60 + now.getMinutes() - minutesOf(s.time)
      if (late < 0) continue
      if (late > CATCH_UP_MIN) {
        // 서버가 꺼져 있거나 잠들어 있어서 놓친 경우: 그날은 건너뛰고 기록만 남긴다
        Object.assign(st, { lastDate: ymd(now), lastStatus: `${s.time} 예정이었지만 서버가 꺼져 있어 건너뜀` })
        changed = true
        continue
      }
      if (!this.hq.idle) {
        const waiting = '이전 지시/승인 대기가 끝나면 실행합니다'
        if (st.lastStatus !== waiting) {
          st.lastStatus = waiting
          changed = true
        }
        continue
      }
      Object.assign(st, { lastDate: ymd(now), lastRunAt: Date.now(), lastStatus: late > 2 ? `${late}분 늦게 실행함 (서버가 늦게 깨어남)` : '실행함' })
      void this.hq.command(s.text, s.departments, { scheduled: true })
      changed = true
    }
    if (changed) {
      this.saveState()
      this.onChange()
    }
  }

  /** 오늘 이후 가장 가까운 실행 시각 (ms) */
  private nextRun(s: ScheduleConfig, now: Date): number | undefined {
    for (let add = 0; add < 8; add++) {
      const d = new Date(now)
      d.setDate(d.getDate() + add)
      d.setHours(Number(s.time.slice(0, 2)), Number(s.time.slice(3, 5)), 0, 0)
      if (!s.days.includes(d.getDay())) continue
      if (d.getTime() > now.getTime() || (add === 0 && this.state[s.id]?.lastDate !== ymd(now))) return d.getTime()
    }
    return undefined
  }

  // ───────────────────────── 내부 ─────────────────────────

  private persist(): void {
    saveProjects(this.config)
    this.saveState()
    this.syncKeepAwake()
    this.onChange()
  }

  private saveState(): void {
    mkdirSync(dirname(STATE_FILE), { recursive: true })
    writeFileSync(STATE_FILE, JSON.stringify(this.state, null, 2))
  }

  /** 켜진 스케줄이 있는 동안 맥의 유휴/시스템 잠자기를 막는다 (서버가 끝나면 caffeinate 도 같이 끝난다). 덮개를 닫으면 소용없다 */
  private syncKeepAwake(): void {
    const need = process.platform === 'darwin' && this.config.schedules.some((s) => s.enabled)
    if (need && !this.keepAwake) {
      this.awake = spawn('caffeinate', ['-i', '-s', '-w', String(process.pid)], { stdio: 'ignore' })
      this.awake.on('error', () => (this.awake = undefined))
      this.awake.on('exit', () => (this.awake = undefined))
    } else if (!need && this.awake) {
      this.awake.kill()
      this.awake = undefined
    }
  }
}
