// VoxelHQ 프론트엔드/백엔드 공용 타입 및 WebSocket 프로토콜 정의

/** 4대 전문 부서 */
export type DepartmentId = 'qa' | 'planning' | 'infra' | 'docs'

export interface DepartmentInfo {
  id: DepartmentId
  name: string
  mission: string
  color: string
}

export const DEPARTMENTS: DepartmentInfo[] = [
  { id: 'qa', name: 'QA & 버그 대응팀', mission: '코드 이슈, 린트/타입 에러, 테스트 실패 감지 및 픽스', color: '#e05d5d' },
  { id: 'planning', name: '기획 & 개선안 제안팀', mission: '리팩토링 포인트, 성능 병목 감지, 아키텍처 개선안', color: '#4f8fe6' },
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

export interface ProjectReport {
  projectId: string
  agentId: string
  department: DepartmentId
  exitCode: number | null
  status: PtyStatus
  diffStat: { files: number; insertions: number; deletions: number }
  files: string[]
  diff: string
  /** PTY 출력 마지막 부분 (ANSI 제거) */
  outputTail: string
}

export interface ApprovalCard {
  commandId: string
  text: string
  createdAt: number
  reports: ProjectReport[]
  skipped: PlannedTask[]
  decided?: 'approved' | 'rejected'
  decisionLog?: string[]
}

export interface HQSnapshot {
  projects: ProjectConfig[]
  agents: AgentInfo[]
  deltas: Record<string, ProjectDelta>
  phase: OrchestratorPhase
  plan: CommandPlan | null
  approval: ApprovalCard | null
  runnerMode: string
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

/** 클라이언트 → 서버 */
export type ClientMessage =
  | { type: 'command'; text: string }
  | { type: 'scan' }
  | { type: 'pty:subscribe'; agentId: string }
  | { type: 'pty:unsubscribe'; agentId: string }
  | { type: 'pty:input'; agentId: string; data: string }
  | { type: 'pty:resize'; agentId: string; cols: number; rows: number }
  | { type: 'approval:decide'; commandId: string; approve: boolean }

export const workerId = (dept: DepartmentId, projectId: string) => `${dept}:${projectId}`
export const leaderId = (dept: DepartmentId) => `${dept}:leader`
