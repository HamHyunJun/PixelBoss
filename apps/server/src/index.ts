// PixelBoss 백엔드 진입점: HTTP + WebSocket 브릿지
import { execFile } from 'node:child_process'
import { createServer } from 'node:http'
import { WebSocket, WebSocketServer } from 'ws'
import type { ClientMessage, ServerMessage } from '@pixelboss/shared'
import { loadConfig } from './config.js'
import { listHistory, readHistory } from './pipeline.js'
import { listDir } from './projects.js'
import { HQ } from './orchestrator.js'

const PORT = Number(process.env.PIXELBOSS_PORT ?? 4100)
// PTY 에 키 입력을 보낼 수 있으므로 기본은 로컬 접속만 허용
const HOST = process.env.PIXELBOSS_HOST ?? '127.0.0.1'

const config = loadConfig()
console.log(`[PixelBoss] 설정: ${config.source}`)
console.log(`[PixelBoss] 프로젝트 ${config.projects.length}개 · 실행기 ${config.runner.mode} · 동시 실행 ${config.runner.maxParallel}`)

/** 소켓별 터미널 구독 목록 (pty:data 는 구독한 소켓에만 보낸다) */
const subscriptions = new Map<WebSocket, Set<string>>()

function send(ws: WebSocket, msg: ServerMessage) {
  if (ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify(msg))
}

function broadcast(msg: ServerMessage) {
  const raw = JSON.stringify(msg)
  for (const [ws, subs] of subscriptions) {
    if (ws.readyState !== WebSocket.OPEN) continue
    if ((msg.type === 'pty:data' || msg.type === 'pty:history') && !subs.has(msg.agentId)) continue
    ws.send(raw)
  }
}

const hq = new HQ(config, broadcast)

// 자리를 비운 사이 도착한 보고서를 macOS 알림으로 알린다 (다른 OS 에서는 토스트만)
hq.onAttention = (title, body) => {
  broadcast({ type: 'toast', level: 'info', message: `${title}: ${body}` })
  if (process.platform === 'darwin') execFile('osascript', ['-e', `display notification ${JSON.stringify(body)} with title ${JSON.stringify(title)}`], () => {})
}

const server = createServer((req, res) => {
  if (req.url === '/api/health') {
    res.writeHead(200, { 'content-type': 'application/json' })
    res.end(JSON.stringify({ ok: true, runner: hq.runnerMode }))
    return
  }
  if (req.url === '/api/snapshot') {
    res.writeHead(200, { 'content-type': 'application/json' })
    res.end(JSON.stringify(hq.snapshot()))
    return
  }
  res.writeHead(404).end()
})

// 폴더 목록 조회·프로젝트 등록이 가능하므로, 기본(로컬 전용) 설정에서는 다른 사이트의 접속을 막는다
const LOCAL_ORIGIN = /^https?:\/\/(localhost|127\.0\.0\.1|\[::1\])(:\d+)?$/
const LOCAL_ONLY = !process.env.PIXELBOSS_HOST
const wss = new WebSocketServer({
  server,
  path: '/ws',
  verifyClient: ({ origin }: { origin?: string }) => !LOCAL_ONLY || !origin || LOCAL_ORIGIN.test(origin),
})

wss.on('connection', (ws) => {
  subscriptions.set(ws, new Set())
  send(ws, { type: 'snapshot', data: hq.snapshot() })

  ws.on('message', (raw) => {
    let msg: ClientMessage
    try {
      msg = JSON.parse(String(raw))
    } catch {
      return
    }
    const subs = subscriptions.get(ws)!
    switch (msg.type) {
      case 'command':
        void hq.command(String(msg.text ?? ''), Array.isArray(msg.departments) ? msg.departments : [])
        break
      case 'scan':
        void hq.scan(true)
        break
      case 'pty:subscribe':
        subs.add(msg.agentId)
        send(ws, { type: 'pty:history', agentId: msg.agentId, data: hq.pty.getHistory(msg.agentId) })
        break
      case 'pty:unsubscribe':
        subs.delete(msg.agentId)
        break
      case 'pty:open':
        // 셸을 여는 기능이라 로컬 전용(기본) 설정에서만 허용한다
        if (LOCAL_ONLY) hq.openSession(String(msg.agentId))
        else send(ws, { type: 'toast', level: 'warn', message: '외부 접속을 허용한 설정(PIXELBOSS_HOST)에서는 대화형 세션을 열 수 없습니다.' })
        break
      case 'pty:input':
        hq.pty.write(msg.agentId, String(msg.data))
        break
      case 'pty:resize':
        hq.pty.resize(msg.agentId, Number(msg.cols), Number(msg.rows))
        break
      case 'approval:decide':
        void hq.decide(msg.commandId, msg.decisions ?? {})
        break
      case 'fs:list':
        send(ws, { type: 'fs:list', listing: listDir(msg.path) })
        break
      case 'project:add':
        void hq.addProject(String(msg.path ?? ''), msg.name ? String(msg.name) : undefined).then((r) => {
          if (r.ok) broadcast({ type: 'toast', level: 'info', message: `프로젝트 추가: ${r.project.name}` })
          else send(ws, { type: 'toast', level: 'error', message: r.error })
        })
        break
      case 'runner:set':
        if (msg.mode === 'mock' || msg.mode === 'claude') {
          void hq.setRunnerMode(msg.mode).then((r) => {
            if (r.ok) broadcast({ type: 'toast', level: 'info', message: msg.mode === 'claude' ? '실제 Claude Code 로 실행합니다 (토큰 사용)' : 'Mock 실행기로 전환했습니다 (토큰 0)' })
            else send(ws, { type: 'toast', level: 'error', message: r.error })
          })
        }
        break
      case 'schedule:save': {
        const r = hq.scheduler.save(msg.schedule)
        send(ws, r.ok ? { type: 'toast', level: 'info', message: '스케줄을 저장했습니다.' } : { type: 'toast', level: 'error', message: r.error })
        break
      }
      case 'schedule:remove': {
        const r = hq.scheduler.remove(String(msg.id))
        if (!r.ok) send(ws, { type: 'toast', level: 'error', message: r.error })
        break
      }
      case 'schedule:run':
        void hq.scheduler.runNow(String(msg.id)).then((r) => {
          if (!r.ok) send(ws, { type: 'toast', level: 'error', message: r.error })
        })
        break
      case 'pipeline:decide':
        void hq.pipelines.decide(String(msg.id), !!msg.approve)
        break
      case 'pipeline:stop':
        void hq.pipelines.stop(String(msg.id))
        break
      case 'issue:ack':
        hq.issues.ack(String(msg.id), !!msg.acknowledged)
        break
      case 'history:list':
        send(ws, { type: 'history:list', items: listHistory() })
        break
      case 'history:read': {
        const markdown = readHistory(String(msg.id))
        if (markdown !== undefined) send(ws, { type: 'history:doc', id: String(msg.id), markdown })
        else send(ws, { type: 'toast', level: 'error', message: '히스토리 기록을 찾을 수 없습니다.' })
        break
      }
      case 'project:remove': {
        const r = hq.removeProject(String(msg.projectId))
        if (r.ok) broadcast({ type: 'toast', level: 'info', message: `프로젝트 삭제: ${r.project.name}` })
        else send(ws, { type: 'toast', level: 'error', message: r.error })
        break
      }
    }
  })
  ws.on('close', () => subscriptions.delete(ws))
})

server.listen(PORT, HOST, () => {
  console.log(`[PixelBoss] WebSocket 브릿지: ws://${HOST}:${PORT}/ws`)
  // 시작 시 1차 정적 스캔, 이후 주기적으로 반복 (LLM 호출 없음)
  void hq.scan().then(() => console.log('[PixelBoss] 초기 델타 스캔 완료'))
  hq.scheduler.start()
  const timer = setInterval(() => void hq.scan(), config.scan.intervalSec * 1000)
  const stop = () => {
    clearInterval(timer)
    hq.shutdown()
    process.exit(0)
  }
  process.on('SIGINT', stop)
  process.on('SIGTERM', stop)
})
