// 상위 명령(All-Hands) → 부서 × 프로젝트 하위 실행 프롬프트로 분해
// LLM 없이 규칙 + 1차 정적 필터 결과만으로 분해한다. 신호가 없는 프로젝트는 LLM 호출 0 으로 건너뛴다.
import { DEPARTMENTS, workerId } from '@pixelboss/shared'
import type { CheckResult, CommandPlan, DepartmentId, PlannedTask, ProjectConfig, ProjectDelta } from '@pixelboss/shared'

const KEYWORDS: Record<DepartmentId, RegExp> = {
  qa: /타입|type|\bts\b|린트|lint|테스트|test|버그|bug|에러|오류|error|접근성|a11y|accessib|픽스|fix/i,
  planning: /리팩토링|refactor|성능|perf|개선|아키텍처|architecture|구조|병목|아이디어|제안/i,
  dev: /구현|개발|코딩|기능|implement|develop|feature/i,
  infra: /보안|취약|vuln|의존성|dependenc|deps|빌드|build|\bci\b|\bcd\b|배포|deploy|패키지|package/i,
  docs: /문서|docs?\b|릴리즈|release|changelog|커밋|commit|요약|기록|아카이브|archive|히스토리|history/i,
}

/** "강제", "--all" 이 포함되면 정적 필터를 무시하고 전 프로젝트에 배정 */
const FORCE_RE = /--all|강제|force/i

const INFRA_FILE_RE = /(^|\/)(package\.json|pnpm-lock\.yaml|package-lock\.json|yarn\.lock|Dockerfile|\.github\/workflows\/.*|.*\.ya?ml)$/

/** 모든 부서는 먼저 '제안 보고'만 한다: 읽기 전용으로 살펴보고, 무엇을 어떻게 바꿀지 한글로 보고한다. 실제 수정은 사용자가 승인한 뒤 개발팀이 한다 */
const REPORT_FORMAT =
  '어떤 파일도 만들거나 수정하지 마세요(읽기 전용). 결과는 최종 답변에 한국어 보고서로만 쓰세요. ' +
  '변경안은 반드시 `### 제안 1. 제목`, `### 제안 2. 제목` 처럼 번호가 붙은 3단계 제목 한 줄로 시작하고, 그 아래에 ① 우선순위(상/중/하) ② 근거 또는 대상(파일:줄) ③ 무엇을 어떻게 바꿀지 ④ 기대 효과와 위험을 쓰세요. ' +
  '제목 앞에는 한두 문장의 서론만 허용하고, 제안과 무관한 맺음말은 쓰지 마세요. 사용자가 제안마다 개발팀이 구현할지 따로 결정합니다.'

const DEPT_GUIDE: Record<DepartmentId, string> = {
  qa: `실패한 검사(타입/린트/테스트) 로그에 나온 파일과 줄을 살펴, 어디를 어떻게 고치면 되는지 변경안을 보고하세요. ${REPORT_FORMAT}`,
  planning: `변경된 파일 범위에서 리팩토링 포인트·성능 병목·아키텍처 개선안을 찾아 보고하세요. ${REPORT_FORMAT}`,
  dev: `지시받은 기능·수정을 어느 파일을 어떻게 바꿔 구현할지 구현 계획을 보고하세요. ${REPORT_FORMAT}`,
  infra: `package.json·lockfile·CI 설정을 살펴 취약 의존성과 빌드 스크립트를 어떻게 보완할지 보고하세요. ${REPORT_FORMAT}`,
  docs: `마지막 기록 이후의 git log 를 읽고, CHANGELOG.md 에 어떤 릴리즈 노트를 추가할지 초안을 한국어로 보고하세요. ${REPORT_FORMAT}`,
}

export interface PlannerState {
  /** 문서팀이 마지막으로 기록한 HEAD (프로젝트별) */
  docsHead: Record<string, string>
}

function selectDepartments(text: string, rationale: string[]): DepartmentId[] {
  const hit = (Object.keys(KEYWORDS) as DepartmentId[]).filter((d) => KEYWORDS[d].test(text))
  if (hit.length) {
    rationale.push(`키워드 매칭 부서: ${hit.map((d) => DEPARTMENTS.find((x) => x.id === d)!.name).join(', ')}`)
    return hit
  }
  rationale.push('부서 키워드가 없어 4개 부서 모두 소집 (정적 필터로 대상은 최소화)')
  return ['qa', 'planning', 'infra', 'docs']
}

/** 지시문만으로 정해지는 호출 부서 (소집 단계에서 어느 팀장이 사장실에 갈지 미리 알기 위해 쓴다) */
export function departmentsFor(text: string): DepartmentId[] {
  return selectDepartments(text, [])
}

/** 부서별 정적 신호. 신호가 없으면 사유 문자열을 돌려준다(=건너뜀) */
function staticSignal(dept: DepartmentId, text: string, d: ProjectDelta | undefined, state: PlannerState): string | null {
  if (!d || !d.isGitRepo) return 'git 저장소를 읽을 수 없어 제외'
  const failing = d.checks.filter((c) => !c.ok)
  switch (dept) {
    case 'qa': {
      const wanted = [
        [/타입|type|\bts\b/i, 'typecheck'],
        [/린트|lint/i, 'lint'],
        [/테스트|test/i, 'test'],
      ].filter(([re]) => (re as RegExp).test(text)).map(([, n]) => n as string)
      if (wanted.length) {
        return failing.some((c) => wanted.includes(c.name)) ? null : `${wanted.join('/')} 검사 통과 → Clean (LLM 호출 0)`
      }
      return failing.length || d.changedFiles.length ? null : '에러·변경 없음 → Clean (LLM 호출 0)'
    }
    case 'dev':
      return null // 사용자가 직접 지시한 구현은 정적 신호와 무관하게 실행한다
    case 'planning':
      return d.changedFiles.length ? null : '변경 파일 없음 → 검토 대상 아님 (LLM 호출 0)'
    case 'infra': {
      const buildFail = failing.some((c) => c.name === 'build' || c.name === 'audit')
      const infraChanged = d.changedFiles.some((f) => INFRA_FILE_RE.test(f.file))
      return buildFail || infraChanged ? null : '빌드/감사 통과, 의존성 변경 없음 (LLM 호출 0)'
    }
    case 'docs':
      return state.docsHead[d.projectId] === d.head ? '마지막 기록 이후 새 커밋 없음 (LLM 호출 0)' : null
  }
}

function buildPrompt(text: string, dept: DepartmentId, p: ProjectConfig, d: ProjectDelta | undefined, state: PlannerState) {
  const info = DEPARTMENTS.find((x) => x.id === dept)!
  const lines = [
    `[PixelBoss · ${info.name} 실무 에이전트 · 담당 프로젝트: ${p.name}]`,
    `상위 지시(사용자): ${text}`,
    `부서 임무: ${info.mission}`,
    '',
    '## 1차 정적 분석 결과 (오케스트레이터가 미리 수집, 다시 스캔할 필요 없음)',
    `- 브랜치: ${d?.branch ?? '?'} @ ${d?.head ?? '?'}`,
  ]
  if (d?.changedFiles.length) {
    lines.push(`- 커밋되지 않은 변경 파일 (${d.changedFiles.length}개):`)
    for (const f of d.changedFiles.slice(0, 30)) lines.push(`  - [${f.status}] ${f.file}`)
  } else lines.push('- 커밋되지 않은 변경 파일: 없음')
  const failing = d?.checks.filter((c) => !c.ok) ?? []
  if (failing.length) {
    lines.push('- 실패한 검사:')
    for (const c of failing) {
      const cmd = p.checks?.[c.name as keyof NonNullable<ProjectConfig['checks']>]
      lines.push(`  - ${c.name} (\`${cmd}\`, 에러 약 ${c.errorCount}건):`, '```', c.excerpt.slice(0, 800), '```')
    }
  } else lines.push('- 실패한 검사: 없음')
  if (dept === 'docs' && state.docsHead[p.id]) lines.push(`- 문서팀 마지막 기록 HEAD: ${state.docsHead[p.id]} (이후 커밋만 정리)`)
  lines.push(
    '',
    '## 작업 규칙',
    '1. 위에 나온 파일·에러와 관련된 범위만 읽으세요. 저장소 전체를 훑지 마세요(토큰 절약).',
    '2. 이번 단계는 제안 보고입니다. 코드나 파일을 수정하지 말고 git 명령도 쓰지 마세요.',
    `3. ${DEPT_GUIDE[dept]}`,
    '4. 최종 답변 전체가 사용자에게 보고서로 그대로 보여집니다. 도구 사용 과정이 아니라 변경안을 한국어 문장으로 정리하세요.',
  )
  return lines.join('\n')
}

export interface ParsedIdeas {
  intro: string
  ideas: { title: string; body: string }[]
}

/** `### 제안 N. 제목` 형식(아이디어·변경안도 허용)의 제목으로 보고서를 아이디어 단위로 나눈다. 형식이 없으면 전체를 아이디어 하나로 둔다 */
export function parseIdeas(text: string): ParsedIdeas {
  const IDEA_HEAD = /^#{2,4}\s+(?:(?:아이디어|제안|변경안|문제)\s*)?\d+[.):]?\s*(.+)$/
  const intro: string[] = []
  const found: { title: string; lines: string[] }[] = []
  let cur: { title: string; lines: string[] } | undefined
  for (const line of text.split('\n')) {
    const m = line.match(IDEA_HEAD)
    if (m) found.push((cur = { title: m[1]!.trim(), lines: [] }))
    else (cur ? cur.lines : intro).push(line)
  }
  if (!found.length) return { intro: '', ideas: text.trim() ? [{ title: '제안', body: text.trim() }] : [] }
  return { intro: intro.join('\n').trim(), ideas: found.map((i) => ({ title: i.title, body: i.lines.join('\n').trim() })) }
}

/** 이름이나 id 비교용: 소문자로 바꾸고 공백·기호를 뺀다 (예: "Tax-Kit" == "taxkit") */
const norm = (v: string): string => v.toLowerCase().replace(/[^0-9a-z가-힣]/g, '')

/** 지시문에 이름(또는 id)이 들어 있는 프로젝트만 골라낸다. 하나도 없으면 빈 배열 = 전체 프로젝트 */
export function matchProjects(text: string, projects: ProjectConfig[]): ProjectConfig[] {
  const t = norm(text)
  return projects.filter((p) => [p.name, p.id].some((n) => norm(n).length >= 3 && t.includes(norm(n))))
}

export function planCommand(
  commandId: string,
  text: string,
  projects: ProjectConfig[],
  deltas: Record<string, ProjectDelta>,
  state: PlannerState,
  only: DepartmentId[] = [],
): CommandPlan {
  const rationale: string[] = []
  const departments = only.length ? only : selectDepartments(text, rationale)
  if (only.length) rationale.push(`지정 부서만 호출: ${only.map((d) => DEPARTMENTS.find((x) => x.id === d)!.name).join(', ')}`)
  const force = FORCE_RE.test(text)
  if (force) rationale.push('강제 실행 플래그 감지 → 정적 필터 무시')
  // 지시문에 프로젝트 이름이 있으면 그 프로젝트만 대상으로 한다 (없으면 등록된 전체 프로젝트)
  const named = matchProjects(text, projects)
  const scope = named.length ? named : projects
  if (named.length) rationale.push(`지시문에 프로젝트 이름이 있어 ${named.map((p) => p.name).join(', ')} 만 대상으로 합니다 (나머지 ${projects.length - named.length}개 프로젝트는 제외)`)
  const tasks: PlannedTask[] = []
  for (const dept of departments) {
    for (const p of scope) {
      const d = deltas[p.id]
      const reason = force ? (d?.isGitRepo ? null : 'git 저장소를 읽을 수 없어 제외') : staticSignal(dept, text, d, state)
      tasks.push({
        agentId: workerId(dept, p.id),
        department: dept,
        projectId: p.id,
        prompt: reason ? '' : buildPrompt(text, dept, p, d, state),
        mode: 'propose',
        ...(reason ? { skipped: reason } : {}),
      })
    }
  }
  const active = tasks.filter((t) => !t.skipped).length
  rationale.push(`실행 ${active}건 / 건너뜀 ${tasks.length - active}건 (건너뛴 작업은 토큰 소모 0)`)
  return { commandId, text, createdAt: Date.now(), departments, tasks, rationale }
}

/** 개발팀 구현 프롬프트 (승인된 제안 → 별도 브랜치에 구현). fix 가 있으면 QA 지적을 고치는 수정 요청이다 */
export function buildDevPrompt(p: ProjectConfig, proposal: string, fix?: { issues: string; failingChecks: string[] }): string {
  const checks = Object.values(p.checks ?? {}).filter(Boolean)
  const lines = [
    `[PixelBoss · 개발팀 실무 에이전트 · 담당 프로젝트: ${p.name}]`,
    fix ? 'QA팀이 검수에서 지적한 문제를 수정합니다. 아래 승인된 제안의 범위 안에서 지적된 문제만 고치세요.' : '각 부서가 제안하고 사용자가 승인한 변경안을 구현합니다. 작업 폴더는 사용자의 작업 폴더가 아니라 전용 브랜치입니다.',
    '',
    '## 승인된 제안',
    proposal.slice(0, 12000),
  ]
  if (fix) {
    lines.push('', '## QA 지적 사항', fix.issues.slice(0, 8000))
    if (fix.failingChecks.length) lines.push('', '## 새로 실패한 검사', ...fix.failingChecks.map((c) => `- ${c}`))
  }
  lines.push(
    '',
    '## 작업 규칙',
    fix ? '1. 지적된 문제와 새로 실패한 검사를 고치는 데 필요한 변경만 하세요. 새 기능이나 범위 밖 리팩토링은 하지 마세요.' : '1. 위 제안에 나온 범위만 구현하세요. 목록에 없는 리팩토링·기능 추가는 하지 마세요.',
    `2. 가능한 한 작은 변경으로 하고, 프로젝트 검사 명령${checks.length ? ` (${checks.map((c) => `\`${c}\``).join(', ')})` : ''}이 있으면 다시 실행해 통과를 확인하세요.`,
    '3. git commit / push 는 하지 마세요. 변경은 작업 폴더에만 남기면 PixelBoss 가 브랜치에 기록합니다.',
    '4. 마지막에 무엇을 바꿨고 어떤 제안은 건너뛰었는지(이유 포함) 한국어로 5줄 이내로 요약하세요. 이 요약이 사용자 보고서에 그대로 표시됩니다.',
  )
  return lines.join('\n')
}

/** QA 검수 프롬프트 (읽기 전용). 마지막에 `판정: 통과` 또는 `판정: 수정 필요` 한 줄이 반드시 있어야 한다 */
export function buildReviewPrompt(p: ProjectConfig, proposal: string, devSummary: string, files: string[], diff: string, checks: CheckResult[], preexisting: string[]): string {
  const lines = [
    `[PixelBoss · QA팀 실무 에이전트 · 담당 프로젝트: ${p.name}]`,
    '개발팀이 구현한 변경을 검수합니다. 작업 폴더는 개발 전용 브랜치입니다.',
    '',
    '## 승인된 제안',
    proposal.slice(0, 6000),
    '',
    '## 개발팀 보고',
    devSummary.slice(0, 3000) || '(보고 없음)',
    '',
    `## 변경된 파일 (${files.length}개)`,
    ...files.slice(0, 40).map((f) => `- ${f}`),
    '',
    '## 프로젝트 검사 결과 (PixelBoss 가 방금 실행함)',
  ]
  if (!checks.length) lines.push('- 설정된 검사 명령이 없습니다. 코드 검토만으로 판단해야 하므로 더 엄격하게 보세요.')
  for (const c of checks) {
    lines.push(`- ${c.name}: ${c.ok ? '통과' : preexisting.includes(c.name) ? '실패 (개발 전부터 실패하던 검사)' : '새로 실패'}`)
    if (!c.ok) lines.push('```', c.excerpt.slice(0, 800), '```')
  }
  lines.push(
    '',
    '## 변경 diff',
    '```diff',
    diff.slice(0, 20000),
    '```',
    '',
    '## 검수 규칙',
    '1. 어떤 파일도 만들거나 수정하지 말고(읽기 전용) git 명령도 쓰지 마세요. 필요한 파일은 Read 로 확인하세요.',
    '2. 승인된 제안대로 구현됐는지, 버그·누락·깨진 동작·새로 실패한 검사가 있는지 확인하세요. 취향 차원의 스타일 지적은 하지 마세요.',
    '3. 최종 답변은 한국어 보고서입니다. 문제가 있으면 `### 문제 1. 제목` 처럼 번호 붙은 3단계 제목으로 쓰고, 각각 파일:줄, 무엇이 왜 문제인지, 어떻게 고치면 되는지를 쓰세요.',
    '4. 마지막 줄은 반드시 `판정: 통과` 또는 `판정: 수정 필요` 둘 중 하나로 끝내세요. 새로 실패한 검사가 있으면 반드시 `판정: 수정 필요` 입니다.',
  )
  return lines.join('\n')
}

/** QA 보고서의 마지막 판정 */
export function parseVerdict(text: string): 'pass' | 'fail' | undefined {
  const m = [...text.matchAll(/판정\s*[:：]\s*\**\s*(통과|수정\s*필요)/g)].pop()
  return m ? (m[1] === '통과' ? 'pass' : 'fail') : undefined
}

/** 승인된 제안을 개발팀 구현 작업으로 바꾼다 (업무 전달 연출용 계획). 실제 실행은 파이프라인이 별도 브랜치에서 한다 */
export function planHandoff(commandId: string, items: { project: ProjectConfig; proposal: string }[], deltas: Record<string, ProjectDelta>): CommandPlan {
  const tasks: PlannedTask[] = items.map(({ project: p, proposal }) => ({
    agentId: workerId('dev', p.id),
    department: 'dev',
    projectId: p.id,
    prompt: buildDevPrompt(p, proposal),
    mode: 'execute',
  }))
  void deltas
  return {
    commandId,
    text: '승인된 제안 구현 (제안한 부서 → 개발팀 하달)',
    createdAt: Date.now(),
    // 제안한 팀장이 개발팀장에게 업무를 넘기는 장면을 위해 두 팀장을 모두 소집한다
    departments: ['planning', 'dev'],
    tasks,
    rationale: [`사용자가 승인한 제안이 있는 ${tasks.length}개 프로젝트 → 개발팀이 전용 브랜치에서 구현 → QA 검수 → 최종 반영 결정`],
  }
}
