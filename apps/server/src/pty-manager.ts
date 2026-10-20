// node-pty 다중 프로세스 관리자
// 실무 에이전트 1명 = PTY 세션 1개. 동시 실행 수는 maxParallel 로 제한하고 나머지는 대기열에 둔다.
import { EventEmitter } from 'node:events'
import * as pty from 'node-pty'
import type { PtyStatus } from '@voxelhq/shared'

export interface SpawnSpec {
  agentId: string
  cwd: string
  file: string
  args: string[]
  env?: Record<string, string>
  timeoutSec: number
  /** 터미널 첫 줄에 찍을 안내 문구 */
  banner?: string
}

interface Session {
  agentId: string
  status: PtyStatus
  history: string
  proc?: pty.IPty
  cols: number
  rows: number
  idleTimer?: NodeJS.Timeout
  killTimer?: NodeJS.Timeout
  exitCode?: number | null
}

const HISTORY_LIMIT = 256 * 1024
// 대화형 프롬프트(입력 대기)로 보이는 출력 패턴
const WAITING_PATTERNS = [/\(y\/n\)/i, /\[y\/n\]/i, /do you want to/i, /press enter/i, /❯\s*\d\./, /입력 대기/, /\(예\/아니오\)/]

const stripAnsi = (s: string) => s.replace(/\x1b\[[0-9;?]*[ -/]*[@-~]|\x1b\][^\x07]*\x07/g, '')

export class PtyManager extends EventEmitter {
  private sessions = new Map<string, Session>()
  private queue: { spec: SpawnSpec; resolve: (code: number | null) => void }[] = []
  private running = 0

  constructor(private maxParallel: number) {
    super()
  }

  private session(agentId: string): Session {
    let s = this.sessions.get(agentId)
    if (!s) {
      s = { agentId, status: 'idle', history: '', cols: 120, rows: 30 }
      this.sessions.set(agentId, s)
    }
    return s
  }

  getHistory(agentId: string) {
    return this.sessions.get(agentId)?.history ?? ''
  }

  getStatus(agentId: string): PtyStatus {
    return this.sessions.get(agentId)?.status ?? 'idle'
  }

  /** ANSI 를 제거한 출력 마지막 부분 */
  getTail(agentId: string, chars = 3000) {
    return stripAnsi(this.getHistory(agentId)).slice(-chars)
  }

  isBusy(agentId: string) {
    const st = this.getStatus(agentId)
    return st === 'running' || st === 'waiting' || st === 'queued'
  }

  private setStatus(s: Session, status: PtyStatus) {
    if (s.status === status) return
    s.status = status
    this.emit('status', s.agentId, status, s.exitCode ?? null)
  }

  private append(s: Session, data: string) {
    s.history += data
    if (s.history.length > HISTORY_LIMIT) s.history = s.history.slice(-HISTORY_LIMIT)
    this.emit('data', s.agentId, data)
  }

  /** PTY 를 띄우고 종료 코드를 돌려준다. 동시 실행 한도를 넘으면 대기열에 들어간다. */
  run(spec: SpawnSpec): Promise<number | null> {
    const s = this.session(spec.agentId)
    if (this.isBusy(spec.agentId)) return Promise.reject(new Error(`${spec.agentId} 는 이미 작업 중입니다`))
    s.history = ''
    s.exitCode = undefined
    this.emit('reset', spec.agentId)
    return new Promise((resolve) => {
      this.queue.push({ spec, resolve })
      this.setStatus(s, 'queued')
      this.pump()
    })
  }

  private pump() {
    while (this.running < this.maxParallel && this.queue.length) {
      const job = this.queue.shift()!
      this.start(job.spec, job.resolve)
    }
  }

  private start(spec: SpawnSpec, resolve: (code: number | null) => void) {
    const s = this.session(spec.agentId)
    this.running++
    if (spec.banner) this.append(s, `\x1b[38;5;214m${spec.banner}\x1b[0m\r\n`)
    let proc: pty.IPty
    try {
      proc = pty.spawn(spec.file, spec.args, {
        name: 'xterm-256color',
        cols: s.cols,
        rows: s.rows,
        cwd: spec.cwd,
        env: { ...process.env, ...spec.env, TERM: 'xterm-256color', FORCE_COLOR: '1' } as Record<string, string>,
      })
    } catch (e) {
      this.append(s, `\r\n\x1b[31m[VoxelHQ] PTY 실행 실패: ${String(e)}\x1b[0m\r\n`)
      this.running--
      s.exitCode = 127
      this.setStatus(s, 'error')
      resolve(127)
      this.pump()
      return
    }
    s.proc = proc
    this.setStatus(s, 'running')

    proc.onData((data) => {
      this.append(s, data)
      if (s.status === 'waiting') this.setStatus(s, 'running')
      // 출력이 잠시 멈췄을 때 마지막 줄이 질문 형태면 '입력 대기'로 본다
      clearTimeout(s.idleTimer)
      s.idleTimer = setTimeout(() => {
        const lastLine = stripAnsi(s.history).trimEnd().split('\n').pop() ?? ''
        if (s.proc && WAITING_PATTERNS.some((re) => re.test(lastLine))) this.setStatus(s, 'waiting')
      }, 1200)
    })

    s.killTimer = setTimeout(() => {
      this.append(s, `\r\n\x1b[31m[VoxelHQ] ${spec.timeoutSec}초 제한 시간 초과로 종료합니다\x1b[0m\r\n`)
      proc.kill()
    }, spec.timeoutSec * 1000)

    proc.onExit(({ exitCode }) => {
      clearTimeout(s.idleTimer)
      clearTimeout(s.killTimer)
      s.proc = undefined
      s.exitCode = exitCode
      this.append(s, `\r\n\x1b[2m[VoxelHQ] 프로세스 종료 (exit ${exitCode})\x1b[0m\r\n`)
      this.running--
      this.setStatus(s, exitCode === 0 ? 'done' : 'error')
      resolve(exitCode)
      this.pump()
    })
  }

  write(agentId: string, data: string) {
    this.sessions.get(agentId)?.proc?.write(data)
  }

  resize(agentId: string, cols: number, rows: number) {
    const s = this.session(agentId)
    s.cols = Math.max(20, Math.min(400, cols | 0))
    s.rows = Math.max(5, Math.min(200, rows | 0))
    try {
      s.proc?.resize(s.cols, s.rows)
    } catch {
      /* 이미 종료된 PTY */
    }
  }

  /** 완료/에러 상태를 유휴로 되돌린다 (승인·반려 후) */
  resetToIdle(agentId: string) {
    const s = this.sessions.get(agentId)
    if (s && !this.isBusy(agentId)) this.setStatus(s, 'idle')
  }

  killAll() {
    for (const s of this.sessions.values()) s.proc?.kill()
  }
}
