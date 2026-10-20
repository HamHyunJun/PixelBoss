// PixelBoss 프론트엔드/백엔드 공용 타입 및 WebSocket 프로토콜 정의

/** 5대 전문 부서 (기획이 제안하고 개발이 구현한다) */
export type DepartmentId = 'qa' | 'planning' | 'dev' | 'infra' | 'docs'

export interface DepartmentInfo {
  id: DepartmentId
  name: string
  mission: string
  color: string
}

export const DEPARTMENTS: DepartmentInfo[] = [
  { id: 'qa', name: 'QA & 버그 대응팀', mission: '코드 이슈, 린트/타입 에러, 테스트 실패 감지 및 픽스', color: '#e05d5d' },
  { id: 'planning', name: '기획 & 개선안 제안팀', mission: '리팩토링 포인트, 성능 병목 감지, 아키텍처 개선안', color: '#4f8fe6' },
  { id: 'dev', name: '개발팀', mission: '승인된 개선안·요청 사항을 실제 코드로 구현', color: '#a06be0' },
  { id: 'infra', name: '인프라 & 빌드팀', mission: '의존성 보안 취약점, CI/CD 스크립트, 패키지 빌드 검증', color: '#e6a23c' },
  { id: 'docs', name: '문서화 & 히스토리 기록팀', mission: '커밋 로그 요약, 릴리즈 노트 생성, 아카이빙', color: '#5bbf7a' },
]

/** config/projects.json 의 프로젝트 항목 */
export interface ProjectConfig {
  id: string
  name: string
  /** 로컬 절대 경로 (상대 경로면 config 파일 기준으로 해석) */
  path: string
  github?: { owner: string; repo: string; baseBranch?: string }
  /** 1차 정적 필터에 쓰는 로컬 검사 명령 (LLM 호출 없음) */
  checks?: { typecheck?: string; lint?: string; test?: string; build?: string; audit?: string }
}

/** 폴더 탐색기 항목 */
export interface FsEntry {
  name: string
  path: string
  isGit: boolean
  hasPackage: boolean
}

export interface FsListing {
  path: string
  /** 루트면 없음 */
  parent?: string
  entries: FsEntry[]
  error?: string
}

/** PTY(실무 에이전트 터미널) 상태 */
export type PtyStatus = 'idle' | 'queued' | 'running' | 'waiting' | 'done' | 'error'

/** 1차 로컬 정적 필터 결과 */
export interface CheckResult {
  name: string
  ok: boolean
  /** 감지된 에러 수(추정) */
  errorCount: number
  /** 에러 로그 앞부분 (프롬프트에 넣을 수 있게 잘라둔 것) */
  excerpt: string
}

export interface ProjectDelta {
  projectId: string
  scannedAt: number
  isGitRepo: boolean
  branch: string
  head: string
  /** git status --porcelain 결과 */
  changedFiles: { status: string; file: string }[]
  diffStat: { files: number; insertions: number; deletions: number }
  checks: CheckResult[]
  githubOpenIssues?: number
  /** clean 이면 LLM 호출 대상에서 제외 */
  health: 'clean' | 'changed' | 'error'
  /** 마지막 스캔 대비 바뀌었는지 (변화 없으면 재검사도 생략) */
  fingerprint: string
}

export type AgentRole = 'worker' | 'leader'

export interface AgentInfo {
  id: string
  role: AgentRole
  department: DepartmentId
  /** worker 만: 전담 프로젝트 */
  projectId?: string
  name: string
  status: PtyStatus
  /** 현재 맡은 태스크 요약 */
  task?: string
  lastExitCode?: number | null
}

export type OrchestratorPhase =
  | 'idle'
  | 'assembling' // 팀장 회의실 소집
  | 'planning' // 상위 명령 분해
  | 'dispatching' // 팀장이 실무진에게 전달
  | 'working' // PTY 병렬 실행
  | 'reviewing' // 팀장 결과 취합
  | 'awaiting-approval' // 사용자 승인 대기

export interface PlannedTask {
  agentId: string
  department: DepartmentId
  projectId: string
  /** 실제 Claude Code 에 전달되는 하위 실행 프롬프트 */
  prompt: string
  /** 정적 필터로 제외된 경우 사유 (LLM 호출 0) */
  skipped?: string
  /** propose(기본): 파일을 건드리지 않고 한글 변경안만 보고 / execute·fix: 사용자가 승인한 제안을 별도 브랜치에 구현·수정 (개발팀) / review: QA 검수(읽기 전용) */
  mode?: 'propose' | 'execute' | 'fix' | 'review'
}

export interface CommandPlan {
  commandId: string
  text: string
  createdAt: number
  departments: DepartmentId[]
  tasks: PlannedTask[]
  /** 분해 근거 (어떤 키워드/신호로 판단했는지) */
  rationale: string[]
}

/** 부서 보고서에서 나눈 제안 한 건 (사용자가 제안마다 진행/보류를 정한다) */
export interface ProposalIdea {
  /** 보고서 안에서 유일한 id (결정 키) */
  id: string
  title: string
  body: string
}

export interface ProjectReport {
  projectId: string
  agentId: string
  department: DepartmentId
  exitCode: number | null
  status: PtyStatus
  diffStat: { files: number; insertions: number; deletions: number }
  files: string[]
  diff: string
  /** 에이전트의 최종 답변(한글). 제안 모드에서는 '무엇을 어떻게 바꿀지'에 대한 변경안 보고서 본문이다 */
  summary: string
  /** 제안 보고서인지: 승인한 제안은 개발팀에 하달된다 (이 단계에서는 코드·파일이 수정되지 않는다) */
  proposal: boolean
  /** 제안 목록 앞의 서론(선택 대상 아님)과 제안별 본문 */
  intro: string
  ideas: ProposalIdea[]
  /** PTY 출력 마지막 부분 (ANSI 제거) */
  outputTail: string
}

export interface ApprovalCard {
  commandId: string
  text: string
  createdAt: number
  reports: ProjectReport[]
  skipped: PlannedTask[]
  /** 모든 프로젝트의 결정이 적용되면 true */
  decided?: boolean
  /** 결정 키별 결과. 키는 코드 변경이면 프로젝트 id, 기획 아이디어면 아이디어 id (승인: 커밋/개발팀 하달, 반려: 되돌리기/보류) */
  decisions?: Record<string, 'approved' | 'rejected'>
  decisionLog?: string[]
}

/** 정해진 요일·시각에 자동으로 내리는 지시 */
export interface ScheduleConfig {
  id: string
  name: string
  /** 24시간제 'HH:MM' (서버가 도는 컴퓨터의 로컬 시간) */
  time: string
  /** 0=일 … 6=토 */
  days: number[]
  text: string
  /** 비우면 키워드로 자동 선택/전체 소집 */
  departments: DepartmentId[]
  enabled: boolean
}

export interface ScheduleInfo extends ScheduleConfig {
  lastRunAt?: number
  /** 마지막 실행/건너뜀 결과 한 줄 */
  lastStatus?: string
  nextRunAt?: number
}

// ───────────────────────── 파이프라인: 승인된 제안 → 개발 → QA 검수 → (수정 ↔ 재검수) → 최종 반영 → 문서 기록 ─────────────────────────

/** 진행 단계. dev=구현 중, qa=검수 중, fix=QA 지적 수정 중, final=최종 반영 결정 대기, docs=기록 중 */
export type PipelineStage = 'dev' | 'qa' | 'fix' | 'final' | 'docs' | 'done'

export interface PipelineEvent {
  at: number
  kind: 'system' | 'dev' | 'qa' | 'fix' | 'final' | 'docs'
  title: string
  /** 한글 보고 본문 (마크다운) */
  body: string
  ok?: boolean
}

export interface PipelineFinal {
  files: string[]
  stat: { files: number; insertions: number; deletions: number }
  diff: string
  /** QA 가 통과시켰는지. false 면 수정 횟수를 다 썼는데도 문제가 남았다는 뜻이다 */
  qaPassed: boolean
  warnings: string[]
}

export interface PipelineInfo {
  id: string
  projectId: string
  /** 이 파이프라인을 시작시킨 지시 */
  title: string
  stage: PipelineStage
  /** running: 에이전트가 작업 중 / waiting: 사용자의 최종 결정 대기 / finished: 끝남 / error: 실패·중단 */
  status: 'running' | 'waiting' | 'finished' | 'error'
  /** 지금까지 쓴 QA 지적 수정 횟수 */
  fixRound: number
  maxFixRounds: number
  branch: string
  baseBranch: string
  events: PipelineEvent[]
  final?: PipelineFinal
  /** 끝났을 때의 결과: merged(반영) / blocked(자동 병합 불가, 브랜치만 남김) / discarded(폐기·중단) / failed(실패) / empty(변경 없음) */
  result?: 'merged' | 'blocked' | 'discarded' | 'failed' | 'empty'
  startedAt: number
  finishedAt?: number
}

export interface HistoryItem {
  /** `<projectId>/<파일명>` */
  id: string
  projectId: string
  title: string
  date: string
  result: string
}

// ───────────────────────── 이슈 보고: 담당자 → 팀장 → (게시판 | 대표) ─────────────────────────

export interface IssueInfo {
  /** 같은 문제는 같은 id 를 쓴다 (예: `check:taxkit:lint`) */
  id: string
  projectId: string
  /** 보고를 올리는 담당 부서 (팀장이 이 부서의 팀장이다) */
  department: DepartmentId
  kind: 'check' | 'agent' | 'pipeline' | 'system'
  /** error: 대표에게 직접 보고 / warn: 게시판에 게시 */
  severity: 'error' | 'warn'
  title: string
  detail: string
  at: number
  route: 'board' | 'ceo'
  /** open: 확인 전 / acknowledged: 사용자가 확인함 / resolved: 다시 정상이 되어 자동으로 해결됨 */
  status: 'open' | 'acknowledged' | 'resolved'
  /** 서버가 켜지고 첫 스캔에서 이미 있던 문제: 목록에는 올리지만 3D 보고 연출은 하지 않는다 */
  silent?: boolean
}

export interface HQSnapshot {
  projects: ProjectConfig[]
  agents: AgentInfo[]
  deltas: Record<string, ProjectDelta>
  phase: OrchestratorPhase
  plan: CommandPlan | null
  approval: ApprovalCard | null
  runnerMode: string
  schedules: ScheduleInfo[]
  pipelines: PipelineInfo[]
  issues: IssueInfo[]
  /** 스케줄이 켜져 있는 동안 맥의 잠자기를 막고 있는지 */
  keepAwake: boolean
}

/** 서버 → 클라이언트 */
export type ServerMessage =
  | { type: 'snapshot'; data: HQSnapshot }
  | { type: 'agent'; agent: AgentInfo }
  | { type: 'delta'; delta: ProjectDelta }
  | { type: 'phase'; phase: OrchestratorPhase; commandId?: string }
  | { type: 'plan'; plan: CommandPlan }
  | { type: 'approval'; approval: ApprovalCard }
  | { type: 'pty:data'; agentId: string; data: string }
  | { type: 'pty:history'; agentId: string; data: string }
  | { type: 'toast'; level: 'info' | 'warn' | 'error'; message: string }
  | { type: 'fs:list'; listing: FsListing }
  | { type: 'pipeline'; pipeline: PipelineInfo }
  | { type: 'issue'; issue: IssueInfo }
  | { type: 'history:list'; items: HistoryItem[] }
  | { type: 'history:doc'; id: string; markdown: string }

/** 클라이언트 → 서버 */
export type ClientMessage =
  /** departments 를 주면 그 부서 팀장만 호출한다 (비우면 키워드로 자동 선택/전체 소집) */
  | { type: 'command'; text: string; departments?: DepartmentId[] }
  | { type: 'scan' }
  | { type: 'pty:subscribe'; agentId: string }
  | { type: 'pty:unsubscribe'; agentId: string }
  /** 지시 실행 중이 아닐 때 담당 프로젝트 폴더에서 대화형 Claude Code 세션을 연다 */
  | { type: 'pty:open'; agentId: string }
  | { type: 'pty:input'; agentId: string; data: string }
  | { type: 'pty:resize'; agentId: string; cols: number; rows: number }
  /** decisions: 결정 키(코드 변경=프로젝트 id, 아이디어=아이디어 id) → 승인 여부. 결정이 필요한 모든 키를 담아야 한다 */
  | { type: 'approval:decide'; commandId: string; decisions: Record<string, boolean> }
  | { type: 'fs:list'; path?: string }
  | { type: 'project:add'; path: string; name?: string }
  | { type: 'project:remove'; projectId: string }
  | { type: 'schedule:save'; schedule: Omit<ScheduleConfig, 'id'> & { id?: string } }
  | { type: 'schedule:remove'; id: string }
  /** 파이프라인 최종 결정: approve=true 면 브랜치를 원래 브랜치에 합친다(반영), false 면 폐기 */
  | { type: 'pipeline:decide'; id: string; approve: boolean }
  /** 진행 중인 파이프라인을 중단하고 브랜치를 정리한다 */
  | { type: 'pipeline:stop'; id: string }
  /** 이슈를 확인함(acknowledged=true)으로 표시하거나 다시 연다 */
  | { type: 'issue:ack'; id: string; acknowledged: boolean }
  | { type: 'history:list' }
  | { type: 'history:read'; id: string }
  /** 시각과 상관없이 지금 한 번 실행 (오늘 실행 기록에는 남기지 않는다) */
  | { type: 'schedule:run'; id: string }
  /** 실행기 전환: mock(가짜, 토큰 0) ↔ claude(실제 Claude Code, 토큰 사용) */
  | { type: 'runner:set'; mode: 'mock' | 'claude' }

export const workerId = (dept: DepartmentId, projectId: string) => `${dept}:${projectId}`
export const leaderId = (dept: DepartmentId) => `${dept}:leader`
