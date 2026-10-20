// VoxelHQ 백엔드 진입점: HTTP + WebSocket 브릿지
import { createServer } from 'node:http'
import { WebSocket, WebSocketServer } from 'ws'
import type { ClientMessage, ServerMessage } from '@voxelhq/shared'
import { loadConfig } from './config.js'
import { HQ } from './orchestrator.js'

const PORT = Number(process.env.VOXELHQ_PORT ?? 4100)
// PTY 에 키 입력을 보낼 수 있으므로 기본은 로컬 접속만 허용
const HOST = process.env.VOXELHQ_HOST ?? '127.0.0.1'

const config = loadConfig()
console.log(`[VoxelHQ] 설정: ${config.source}`)
console.log(`[VoxelHQ] 프로젝트 ${config.projects.length}개 · 실행기 ${config.runner.mode} · 동시 실행 ${config.runner.maxParallel}`)

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

const wss = new WebSocketServer({ server, path: '/ws' })

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
        void hq.command(String(msg.text ?? ''))
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
      case 'pty:input':
        hq.pty.write(msg.agentId, String(msg.data))
        break
      case 'pty:resize':
        hq.pty.resize(msg.agentId, Number(msg.cols), Number(msg.rows))
        break
      case 'approval:decide':
        void hq.decide(msg.commandId, !!msg.approve)
        break
    }
  })
  ws.on('close', () => subscriptions.delete(ws))
})

server.listen(PORT, HOST, () => {
  console.log(`[VoxelHQ] WebSocket 브릿지: ws://${HOST}:${PORT}/ws`)
  // 시작 시 1차 정적 스캔, 이후 주기적으로 반복 (LLM 호출 없음)
  void hq.scan().then(() => console.log('[VoxelHQ] 초기 델타 스캔 완료'))
  const timer = setInterval(() => void hq.scan(), config.scan.intervalSec * 1000)
  const stop = () => {
    clearInterval(timer)
    hq.shutdown()
    process.exit(0)
  }
  process.on('SIGINT', stop)
  process.on('SIGTERM', stop)
})
