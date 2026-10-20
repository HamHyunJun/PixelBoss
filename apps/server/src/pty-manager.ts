// node-pty 다중 프로세스 관리자
// 실무 에이전트 1명 = PTY 세션 1개. 동시 실행 수는 maxParallel 로 제한하고 나머지는 대기열에 둔다.
import { EventEmitter } from 'node:events'
import { chmodSync } from 'node:fs'
import { createRequire } from 'node:module'
import { dirname, join } from 'node:path'
import * as pty from 'node-pty'
import type { PtyStatus } from '@pixelboss/shared'

// pnpm 이 prebuild 의 spawn-helper 실행 권한을 지우면 모든 PTY 실행이 posix_spawnp failed 로 실패한다. 시작할 때 복구한다.
try {
  const root = dirname(createRequire(import.meta.url).resolve('node-pty/package.json'))
  chmodSync(join(root, 'prebuilds', `${process.platform}-${process.arch}`, 'spawn-helper'), 0o755)
} catch {
  /* prebuild 가 없는 플랫폼(소스 빌드)이면 해당 없음 */
}

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
  /** 사용자가 직접 연 대화형 세션 (지시 실행 세션과 달리 상태·동시 실행 수에 포함하지 않는다) */
  manual?: boolean
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
    this.closeManual(s) // 지시가 오면 사용자가 열어둔 대화형 세션은 닫고 자리를 비운다
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
      this.append(s, `\r\n\x1b[31m[PixelBoss] PTY 실행 실패: ${String(e)}\x1b[0m\r\n`)
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
      this.append(s, `\r\n\x1b[31m[PixelBoss] ${spec.timeoutSec}초 제한 시간 초과로 종료합니다\x1b[0m\r\n`)
      proc.kill()
    }, spec.timeoutSec * 1000)

    proc.onExit(({ exitCode }) => {
      clearTimeout(s.idleTimer)
      clearTimeout(s.killTimer)
      s.proc = undefined
      s.exitCode = exitCode
      this.append(s, `\r\n\x1b[2m[PixelBoss] 프로세스 종료 (exit ${exitCode})\x1b[0m\r\n`)
      this.running--
      this.setStatus(s, exitCode === 0 ? 'done' : 'error')
      resolve(exitCode)
      this.pump()
    })
  }

  private closeManual(s: Session) {
    if (!s.manual) return
    s.manual = false
    s.proc?.kill()
    s.proc = undefined
  }

  /**
   * 사용자 셸을 프로젝트 폴더에서 열고 command(claude)를 실행한다. 셸 위에서 돌리므로 claude 가 없거나 종료돼도 터미널은 남는다.
   * 이미 세션이 살아 있거나 지시 실행 중이면 아무것도 하지 않는다.
   */
  openManual(agentId: string, cwd: string, command: string): boolean {
    const s = this.session(agentId)
    if (s.proc || this.isBusy(agentId)) return false
    let proc: pty.IPty
    try {
      proc = pty.spawn(process.env.SHELL || '/bin/zsh', ['-i'], {
        name: 'xterm-256color',
        cols: s.cols,
        rows: s.rows,
        cwd,
        env: { ...process.env, TERM: 'xterm-256color' } as Record<string, string>,
      })
    } catch (e) {
      this.append(s, `\r\n\x1b[31m[PixelBoss] 세션 열기 실패: ${String(e)}\x1b[0m\r\n`)
      return false
    }
    s.proc = proc
    s.manual = true
    this.append(s, `\x1b[38;5;214m[PixelBoss] ${cwd} 에서 대화형 세션을 엽니다\x1b[0m\r\n`)
    proc.onData((data) => s.proc === proc && this.append(s, data))
    proc.onExit(({ exitCode }) => {
      if (s.proc !== proc) return // 지시 실행이 이 세션을 닫고 새 PTY 를 시작한 경우
      s.proc = undefined
      s.manual = false
      this.append(s, `\r\n\x1b[2m[PixelBoss] 세션 종료 (exit ${exitCode}) — 터미널을 클릭하면 다시 열립니다\x1b[0m\r\n`)
    })
    setTimeout(() => s.proc === proc && proc.write(`${command}\r`), 300)
    return true
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

  /** 세션 기록을 지운다 (프로젝트 삭제용). 실행 중이면 무시한다 */
  forget(agentId: string) {
    const s = this.sessions.get(agentId)
    if (!s || this.isBusy(agentId)) return
    this.closeManual(s)
    this.sessions.delete(agentId)
  }

  /** 실행 중인 세션 하나를 종료한다 (파이프라인 중단용) */
  kill(agentId: string) {
    this.sessions.get(agentId)?.proc?.kill()
  }

  killAll() {
    for (const s of this.sessions.values()) s.proc?.kill()
  }
}
