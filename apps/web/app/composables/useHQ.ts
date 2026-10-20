// 백엔드 WebSocket 브릿지와 연결된 전역 상태 저장소
import type {
  AgentInfo,
  ApprovalCard,
  ClientMessage,
  CommandPlan,
  DepartmentId,
  FsListing,
  HQSnapshot,
  HistoryItem,
  IssueInfo,
  PipelineInfo,
  OrchestratorPhase,
  ProjectConfig,
  ProjectDelta,
  ScheduleConfig,
  ScheduleInfo,
  ServerMessage,
} from '@pixelboss/shared'

export interface Toast {
  id: number
  level: 'info' | 'warn' | 'error'
  message: string
}

interface HQState {
  connected: boolean
  projects: ProjectConfig[]
  agents: Record<string, AgentInfo>
  deltas: Record<string, ProjectDelta>
  phase: OrchestratorPhase
  plan: CommandPlan | null
  approval: ApprovalCard | null
  runnerMode: string
  schedules: ScheduleInfo[]
  pipelines: PipelineInfo[]
  issues: IssueInfo[]
  keepAwake: boolean
  history: HistoryItem[]
  historyDoc?: { id: string; markdown: string }
  /** 폴더 탐색기 최근 응답 */
  fs?: FsListing
  toasts: Toast[]
}

type PtyListener = (data: string, reset: boolean) => void

const state = reactive<HQState>({
  connected: false,
  projects: [],
  agents: {},
  deltas: {},
  phase: 'idle',
  plan: null,
  approval: null,
  runnerMode: '',
  schedules: [],
  pipelines: [],
  issues: [],
  keepAwake: false,
  history: [],
  toasts: [],
})

let ws: WebSocket | null = null
let started = false
let toastSeq = 0
const ptyListeners = new Map<string, Set<PtyListener>>()

function wsUrl() {
  const configured = useRuntimeConfig().public.wsUrl as string
  if (configured) return configured
  const proto = location.protocol === 'https:' ? 'wss' : 'ws'
  return `${proto}://${location.hostname}:4100/ws`
}

function pushToast(level: Toast['level'], message: string) {
  const t = { id: ++toastSeq, level, message }
  state.toasts.push(t)
  setTimeout(() => {
    const i = state.toasts.findIndex((x) => x.id === t.id)
    if (i >= 0) state.toasts.splice(i, 1)
  }, 5000)
}

function applySnapshot(s: HQSnapshot) {
  state.projects = s.projects
  state.agents = Object.fromEntries(s.agents.map((a) => [a.id, a]))
  state.deltas = s.deltas
  state.phase = s.phase
  state.plan = s.plan
  state.approval = s.approval
  state.runnerMode = s.runnerMode
  state.schedules = s.schedules
  state.pipelines = s.pipelines
  state.issues = s.issues
  state.keepAwake = s.keepAwake
}

function handle(msg: ServerMessage) {
  switch (msg.type) {
    case 'snapshot':
      applySnapshot(msg.data)
      break
    case 'agent':
      state.agents[msg.agent.id] = msg.agent
      break
    case 'delta':
      state.deltas[msg.delta.projectId] = msg.delta
      break
    case 'phase':
      state.phase = msg.phase
      break
    case 'plan':
      state.plan = msg.plan
      break
    case 'approval':
      state.approval = msg.approval
      break
    case 'toast':
      pushToast(msg.level, msg.message)
      break
    case 'fs:list':
      state.fs = msg.listing
      break
    case 'pipeline': {
      const i = state.pipelines.findIndex((p) => p.id === msg.pipeline.id)
      if (i >= 0) state.pipelines[i] = msg.pipeline
      else state.pipelines.push(msg.pipeline)
      break
    }
    case 'issue': {
      const i = state.issues.findIndex((x) => x.id === msg.issue.id)
      if (i >= 0) state.issues[i] = msg.issue
      else state.issues.push(msg.issue)
      break
    }
    case 'history:list':
      state.history = msg.items
      break
    case 'history:doc':
      state.historyDoc = { id: msg.id, markdown: msg.markdown }
      break
    case 'pty:history':
    case 'pty:data':
      ptyListeners.get(msg.agentId)?.forEach((fn) => fn(msg.data, msg.type === 'pty:history'))
      break
  }
}

function send(msg: ClientMessage) {
  if (ws?.readyState === WebSocket.OPEN) ws.send(JSON.stringify(msg))
}

function connect() {
  ws = new WebSocket(wsUrl())
  ws.onopen = () => {
    state.connected = true
    // 재접속 시 열려 있던 터미널 구독 복구
    for (const id of ptyListeners.keys()) send({ type: 'pty:subscribe', agentId: id })
  }
  ws.onmessage = (ev) => handle(JSON.parse(ev.data))
  ws.onclose = () => {
    state.connected = false
    setTimeout(connect, 1500)
  }
}

export function useHQ() {
  if (!started && import.meta.client) {
    started = true
    connect()
  }
  return {
    state: readonly(state) as HQState,
    command: (text: string, departments?: DepartmentId[]) => send({ type: 'command', text, departments }),
    scan: () => send({ type: 'scan' }),
    decide: (commandId: string, decisions: Record<string, boolean>) => send({ type: 'approval:decide', commandId, decisions }),
    listDir: (path?: string) => send({ type: 'fs:list', path }),
    addProject: (path: string, name?: string) => send({ type: 'project:add', path, name }),
    decidePipeline: (id: string, approve: boolean) => send({ type: 'pipeline:decide', id, approve }),
    stopPipeline: (id: string) => send({ type: 'pipeline:stop', id }),
    ackIssue: (id: string, acknowledged: boolean) => send({ type: 'issue:ack', id, acknowledged }),
    listHistory: () => send({ type: 'history:list' }),
    readHistory: (id: string) => send({ type: 'history:read', id }),
    saveSchedule: (schedule: Omit<ScheduleConfig, 'id'> & { id?: string }) => send({ type: 'schedule:save', schedule }),
    removeSchedule: (id: string) => send({ type: 'schedule:remove', id }),
    runSchedule: (id: string) => send({ type: 'schedule:run', id }),
    setRunner: (mode: 'mock' | 'claude') => send({ type: 'runner:set', mode }),
    removeProject: (projectId: string) => send({ type: 'project:remove', projectId }),
    openSession: (agentId: string) => send({ type: 'pty:open', agentId }),
    input: (agentId: string, data: string) => send({ type: 'pty:input', agentId, data }),
    resize: (agentId: string, cols: number, rows: number) => send({ type: 'pty:resize', agentId, cols, rows }),
    /** 터미널 스트림 구독. 반환된 함수로 해제 */
    subscribePty(agentId: string, fn: PtyListener) {
      let set = ptyListeners.get(agentId)
      if (!set) ptyListeners.set(agentId, (set = new Set()))
      set.add(fn)
      send({ type: 'pty:subscribe', agentId })
      return () => {
        set!.delete(fn)
        if (!set!.size) {
          ptyListeners.delete(agentId)
          send({ type: 'pty:unsubscribe', agentId })
        }
      }
    },
  }
}
