// 상위 명령(All-Hands) → 부서 × 프로젝트 하위 실행 프롬프트로 분해
// LLM 없이 규칙 + 1차 정적 필터 결과만으로 분해한다. 신호가 없는 프로젝트는 LLM 호출 0 으로 건너뛴다.
import { DEPARTMENTS, workerId } from '@voxelhq/shared'
import type { CommandPlan, DepartmentId, PlannedTask, ProjectConfig, ProjectDelta } from '@voxelhq/shared'

const KEYWORDS: Record<DepartmentId, RegExp> = {
  qa: /타입|type|\bts\b|린트|lint|테스트|test|버그|bug|에러|오류|error|접근성|a11y|accessib|픽스|fix/i,
  planning: /리팩토링|refactor|성능|perf|개선|아키텍처|architecture|구조|병목/i,
  infra: /보안|취약|vuln|의존성|dependenc|deps|빌드|build|\bci\b|\bcd\b|배포|deploy|패키지|package/i,
  docs: /문서|docs?\b|릴리즈|release|changelog|커밋|commit|요약|기록|아카이브|archive|히스토리|history/i,
}

/** "강제", "--all" 이 포함되면 정적 필터를 무시하고 전 프로젝트에 배정 */
const FORCE_RE = /--all|강제|force/i

const INFRA_FILE_RE = /(^|\/)(package\.json|pnpm-lock\.yaml|package-lock\.json|yarn\.lock|Dockerfile|\.github\/workflows\/.*|.*\.ya?ml)$/

const DEPT_GUIDE: Record<DepartmentId, string> = {
  qa: '실패한 검사(타입/린트/테스트) 로그에 나온 파일과 줄만 고치세요. 고친 뒤 해당 검사 명령을 다시 실행해 통과를 확인하세요.',
  planning: '변경된 파일 범위 안에서 리팩토링 포인트와 성능 병목을 찾고, 안전한 개선은 직접 적용하며 나머지는 docs/IMPROVEMENTS.md 에 제안으로 남기세요.',
  infra: 'package.json·lockfile·CI 설정만 다루세요. 빌드/감사 명령 결과를 근거로 취약 의존성과 빌드 스크립트를 보완하세요.',
  docs: '마지막 기록 이후의 git log 만 읽고 CHANGELOG.md 에 릴리즈 노트를 추가하세요. 소스 코드는 수정하지 마세요.',
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
    `[VoxelHQ · ${info.name} 실무 에이전트 · 담당 프로젝트: ${p.name}]`,
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
    '1. 위에 나온 파일·에러와 관련된 범위만 읽고 수정하세요. 저장소 전체를 훑지 마세요(토큰 절약).',
    '2. git commit / push 는 하지 마세요. 변경은 워킹 트리에만 남기면 팀장이 diff 를 취합해 사용자 승인을 받습니다.',
    `3. ${DEPT_GUIDE[dept]}`,
    '4. 마지막에 무엇을 바꿨는지 3줄 이내로 요약하세요.',
  )
  return lines.join('\n')
}

export function planCommand(
  commandId: string,
  text: string,
  projects: ProjectConfig[],
  deltas: Record<string, ProjectDelta>,
  state: PlannerState,
): CommandPlan {
  const rationale: string[] = []
  const departments = selectDepartments(text, rationale)
  const force = FORCE_RE.test(text)
  if (force) rationale.push('강제 실행 플래그 감지 → 정적 필터 무시')
  const tasks: PlannedTask[] = []
  for (const dept of departments) {
    for (const p of projects) {
      const d = deltas[p.id]
      const reason = force ? (d?.isGitRepo ? null : 'git 저장소를 읽을 수 없어 제외') : staticSignal(dept, text, d, state)
      tasks.push({
        agentId: workerId(dept, p.id),
        department: dept,
        projectId: p.id,
        prompt: reason ? '' : buildPrompt(text, dept, p, d, state),
        ...(reason ? { skipped: reason } : {}),
      })
    }
  }
  const active = tasks.filter((t) => !t.skipped).length
  rationale.push(`실행 ${active}건 / 건너뜀 ${tasks.length - active}건 (건너뛴 작업은 토큰 소모 0)`)
  return { commandId, text, createdAt: Date.now(), departments, tasks, rationale }
}
