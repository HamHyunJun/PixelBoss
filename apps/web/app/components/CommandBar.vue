<script setup lang="ts">
// 상단 "전체 소집 / 긴급 지시" 입력창 + 오케스트레이션 단계 표시
import { DEPARTMENTS } from '@pixelboss/shared'
import type { DepartmentId, OrchestratorPhase } from '@pixelboss/shared'

const emit = defineEmits<{ projects: []; schedules: []; history: []; issues: [] }>()
const { state, command, scan, setRunner } = useHQ()
const text = ref('')
const input = ref<HTMLInputElement>()
/** 실제 Claude 로 전환은 토큰이 드는 동작이라 한 번 더 눌러 확인한다 */
const armed = ref(false)
/** 호출할 부서 (비어 있으면 전체 소집 / 키워드로 자동 선택). 팀장 모달에서도 지정한다 */
const targets = useState<DepartmentId[]>('command-targets', () => [])
const approvalHidden = useState<boolean>('approval-hidden', () => false)

/** 부서가 실제로 할 수 있는 업무만 간단명령으로 제공한다 (planner.ts 의 DEPT_GUIDE 와 같은 범위) */
const DEPT_PRESETS: Record<DepartmentId, string[]> = {
  qa: ['모든 프로젝트 타입 에러 일괄 해결', '린트 오류 및 접근성 표준 위반 수정', '실패하는 테스트 원인 찾아 픽스'],
  planning: ['리팩토링 포인트와 성능 병목 분석', '아키텍처 개선안 제안', '구조 개선 가능한 부분 점검'],
  dev: ['요청한 기능 구현 (지시에 구현할 내용을 적어주세요)', '지정한 범위의 리팩토링 구현'],
  infra: ['의존성 보안 취약점 점검', '빌드 스크립트와 CI 설정 점검', '패키지 빌드 검증'],
  docs: ['이번 주 커밋 로그로 릴리즈 노트 작성', '마지막 기록 이후 변경 이력 요약'],
}
/** 부서를 고르지 않았을 때(전체 소집)는 부서별 대표 명령을 하나씩 보여준다 */
interface Preset {
  text: string
  color: string
}
const toPresets = (ids: DepartmentId[], limit = Infinity): Preset[] =>
  DEPARTMENTS.filter((d) => ids.includes(d.id)).flatMap((d) => DEPT_PRESETS[d.id].slice(0, limit).map((text) => ({ text, color: d.color })))
const ALL_PRESETS = toPresets(DEPARTMENTS.map((d) => d.id), 1)

const STEPS: { phase: OrchestratorPhase; label: string }[] = [
  { phase: 'assembling', label: '팀장 소집' },
  { phase: 'planning', label: '명령 분해' },
  { phase: 'dispatching', label: '업무 하달' },
  { phase: 'working', label: 'PTY 실행' },
  { phase: 'reviewing', label: '결과 취합' },
  { phase: 'awaiting-approval', label: '승인 대기' },
]
const stepIndex = computed(() => STEPS.findIndex((s) => s.phase === state.phase))
const busy = computed(() => state.phase !== 'idle')

const openIssues = computed(() => state.issues.filter((i) => i.status === 'open'))
const hasErrorIssue = computed(() => openIssues.value.some((i) => i.severity === 'error'))

const summary = computed(() => {
  const ds = Object.values(state.deltas)
  return {
    clean: ds.filter((d) => d.health === 'clean').length,
    changed: ds.filter((d) => d.health === 'changed').length,
    error: ds.filter((d) => d.health === 'error').length,
  }
})

/** 한 번에 한 부서만 호출한다. 선택된 부서를 다시 누르면 해제(전체)된다 */
const toggleTarget = (id: DepartmentId): void => {
  targets.value = targets.value.includes(id) ? [] : [id]
}

const presets = computed(() => (targets.value.length ? toPresets(targets.value) : ALL_PRESETS))
const placeholder = computed(() =>
  state.phase === 'awaiting-approval' ? '승인 대기 중입니다 — 📋 보고서에서 승인 또는 반려하면 다음 지시를 내릴 수 있습니다' : `예: ${presets.value[0]?.text}${targets.value.length ? '' : "  (정적 필터 무시: '강제' 포함)"}`,
)

const tagLabel = computed(() =>
  targets.value.length ? `📣 ${DEPARTMENTS.filter((d) => targets.value.includes(d.id)).map((d) => d.name.split(' ')[0]).join(' · ')} 호출` : '📣 전체 소집 / 긴급 지시',
)

const toggleRunner = (): void => {
  if (state.runnerMode === 'claude') return setRunner('mock')
  if (!armed.value) {
    armed.value = true
    setTimeout(() => (armed.value = false), 3000)
    return
  }
  armed.value = false
  setRunner('claude')
}

function submit(value = text.value) {
  if (!value.trim() || busy.value) return
  command(value, targets.value)
  text.value = ''
}

// 팀장 모달에서 "이 부서 호출"로 지정되면 바로 입력할 수 있게 포커스
watch(targets, (t) => t.length && input.value?.focus())
</script>

<template>
  <header class="bar panel">
    <div class="brand">
      <img class="logo" src="/logo.svg" alt="" width="34" height="34" />
      <div>
        <div class="title">PixelBoss</div>
        <div class="sub muted">AI Virtual Company</div>
      </div>
    </div>

    <form class="cmd" @submit.prevent="submit()">
      <span class="tag">{{ tagLabel }}</span>
      <input ref="input" v-model="text" :disabled="busy" :placeholder="placeholder" title="지시하면 각 부서가 먼저 한글 변경안을 보고합니다. 진행할 제안을 고르면 개발팀이 구현합니다." data-test="command-input" />
      <button class="primary" type="submit" :disabled="busy || !text.trim() || !state.connected" data-test="command-submit">소집</button>
    </form>

    <div class="meta">
      <span class="conn" :class="{ on: state.connected }">{{ state.connected ? '연결됨' : '재연결 중…' }}</span>
      <button
        class="runner"
        :class="{ real: state.runnerMode === 'claude', armed }"
        :disabled="busy || !state.connected"
        :title="state.runnerMode === 'claude' ? '실제 Claude Code 로 실행 중 (토큰 사용). 누르면 Mock 으로 전환' : 'Mock 실행기: 가짜 결과, 토큰 0. 누르면 실제 Claude Code 로 전환'"
        data-test="runner-toggle"
        @click="toggleRunner()"
      >
        {{ armed ? '토큰 사용 · 한 번 더 누르면 전환' : state.runnerMode === 'claude' ? 'Claude Code' : 'Mock 실행기' }}
      </button>
      <button
        v-if="openIssues.length"
        class="issue"
        :class="{ err: hasErrorIssue }"
        data-test="open-issues"
        title="담당자가 팀장에게 올린 에러·문제 보고"
        @click="emit('issues')"
      >
        🚨 이슈 {{ openIssues.length }}
      </button>
      <button
        v-if="state.approval"
        class="report"
        :class="{ pending: state.phase === 'awaiting-approval' }"
        data-test="open-report"
        title="팀장 취합 보고서 / 승인 카드 다시 열기"
        @click="approvalHidden = false"
      >
        📋 보고서
      </button>
      <button data-test="open-history" title="문서팀이 남긴 작업 히스토리" @click="emit('history')">📚 히스토리</button>
      <button data-test="open-schedules" title="정해진 시각에 자동으로 지시를 내려 보고서를 받습니다" @click="emit('schedules')">
        ⏰ 스케줄 {{ state.schedules.filter((s) => s.enabled).length }}
      </button>
      <button data-test="open-projects" title="프로젝트 추가·삭제" @click="emit('projects')">📁 프로젝트 {{ state.projects.length }}</button>
      <button :disabled="busy" title="git status/diff 와 검사 명령으로 다시 스캔 (LLM 호출 없음)" @click="scan()">↻ 스캔</button>
    </div>

    <div class="row2">
      <div class="targets" role="group" aria-label="호출 부서">
        <button class="chip" :aria-pressed="!targets.length" :class="{ on: !targets.length }" @click="targets = []">전체</button>
        <button
          v-for="d in DEPARTMENTS"
          :key="d.id"
          class="chip dept"
          :aria-pressed="targets.includes(d.id)"
          :class="{ on: targets.includes(d.id) }"
          :style="{ '--dept': d.color }"
          :title="`${d.name}만 호출`"
          @click="toggleTarget(d.id)"
        >
          {{ d.name.split(' ')[0] }}
        </button>
      </div>
      <div class="presets" role="group" aria-label="간단 명령">
        <button
          v-for="p in presets"
          :key="p.text"
          class="chip"
          :style="{ '--dept': p.color }"
          :title="p.text"
          :disabled="busy || !state.connected"
          @click="submit(p.text)"
        >
          {{ p.text }}
        </button>
      </div>
      <div class="health">
        <span class="h ok">Clean {{ summary.clean }}</span>
        <span class="h ch">변경 {{ summary.changed }}</span>
        <button class="h er" :disabled="!summary.error" title="에러가 난 프로젝트와 원인 보기" data-test="health-errors" @click="emit('issues')">에러 {{ summary.error }}</button>
      </div>
      <ol class="steps" data-test="phase">
        <li v-for="(s, i) in STEPS" :key="s.phase" :class="{ active: i === stepIndex, done: stepIndex > i }">{{ s.label }}</li>
      </ol>
    </div>
  </header>
</template>

<style scoped lang="scss">
.bar {
  position: absolute;
  top: 12px;
  left: 12px;
  right: 12px;
  display: grid;
  grid-template-columns: auto 1fr auto;
  gap: 10px 16px;
  align-items: center;
  padding: 10px 14px;
  z-index: 10;
}
.brand {
  display: flex;
  align-items: center;
  gap: 10px;
  .logo {
    width: 34px;
    height: 34px;
    border-radius: 8px;
    image-rendering: pixelated;
  }
  .title {
    font-weight: 800;
    font-size: 16px;
    letter-spacing: 0.3px;
  }
  .sub {
    font-size: 11px;
  }
}
.cmd {
  display: flex;
  align-items: center;
  gap: 8px;
  background: rgba(0, 0, 0, 0.25);
  border: 1px solid var(--line);
  border-radius: 10px;
  padding: 4px 4px 4px 10px;
  .tag {
    font-size: 12px;
    font-weight: 700;
    color: var(--accent);
    white-space: nowrap;
  }
  input {
    flex: 1;
    min-width: 0;
    background: transparent;
    border: 0;
    outline: 0;
    color: var(--text);
    font: inherit;
    font-size: 15px;
    padding: 6px 4px;
  }
}
.meta {
  .issue {
    background: rgba(255, 204, 0, 0.16);
    border-color: rgba(255, 204, 0, 0.5);
    color: var(--warn);
    font-weight: 700;
    &.err {
      background: rgba(255, 69, 58, 0.2);
      border-color: var(--err);
      color: #ff8a82;
      animation: pulse 1.6s ease-in-out infinite;
    }
  }
  .report.pending {
    background: var(--accent);
    border-color: var(--accent);
    color: #1d1300;
    font-weight: 700;
    animation: pulse 1.2s ease-in-out infinite;
  }
  display: flex;
  align-items: center;
  gap: 8px;
  font-size: 12px;
  .conn {
    color: var(--err);
    &.on {
      color: var(--ok);
    }
  }
  .runner {
    padding: 3px 8px;
    border-radius: 6px;
    background: rgba(255, 255, 255, 0.08);
    transition: background 0.15s, color 0.15s, transform 0.1s;
    &.real {
      background: rgba(52, 199, 89, 0.18);
      color: var(--ok);
    }
    &.armed {
      background: var(--accent);
      border-color: var(--accent);
      color: #1d1300;
      font-weight: 700;
    }
    &:active:not(:disabled) {
      transform: scale(0.96);
    }
  }
}
.row2 {
  grid-column: 1 / -1;
  display: flex;
  gap: 12px;
  align-items: center;
}
.targets {
  display: flex;
  gap: 6px;
  .chip {
    font-size: 12px;
    padding: 3px 10px;
    border-radius: 999px;
    transition: background 0.15s, border-color 0.15s, transform 0.1s;
    &:active {
      transform: scale(0.95);
    }
    &.on {
      background: rgba(255, 159, 26, 0.18);
      border-color: var(--accent);
    }
    &.dept.on {
      background: color-mix(in srgb, var(--dept) 28%, transparent);
      border-color: var(--dept);
    }
  }
}
.targets {
  flex: none;
}
/* 간단 명령은 항상 한 줄: 넘치면 가로로 스크롤하고 가장자리를 흐리게 처리한다 */
.presets {
  flex: 1;
  min-width: 120px;
  display: flex;
  gap: 6px;
  overflow-x: auto;
  scrollbar-width: none;
  padding: 2px 0;
  mask-image: linear-gradient(to right, transparent 0, #000 8px, #000 calc(100% - 20px), transparent 100%);
  &::-webkit-scrollbar {
    display: none;
  }
  .chip {
    flex: none;
    font-size: 12px;
    padding: 3px 10px 3px 8px;
    border-radius: 999px;
    white-space: nowrap;
    border-left: 3px solid var(--dept);
    transition: background 0.15s, transform 0.1s;
    &:active:not(:disabled) {
      transform: scale(0.96);
    }
  }
}
.health,
.steps {
  flex: none;
}
.health {
  display: flex;
  gap: 6px;
  font-size: 12px;
  .h {
    padding: 2px 8px;
    border: 0;
    font: inherit;
    border-radius: 6px;
    background: rgba(255, 255, 255, 0.06);
  }
  .ok {
    color: var(--ok);
  }
  .ch {
    color: var(--info);
  }
  .er {
    color: var(--err);
  }
}
.steps {
  margin: 0 0 0 auto;
  padding: 0;
  list-style: none;
  display: flex;
  gap: 4px;
  font-size: 12px;
  li {
    padding: 3px 9px;
    border-radius: 6px;
    background: rgba(255, 255, 255, 0.05);
    color: var(--muted);
    &.done {
      color: var(--ok);
    }
    &.active {
      background: var(--accent);
      color: #1d1300;
      font-weight: 700;
      animation: pulse 1.2s ease-in-out infinite;
    }
  }
}
@keyframes pulse {
  50% {
    opacity: 0.7;
  }
}
/* 좁은 화면에서는 상태 요약(Clean/변경/에러)을 숨겨 간단 명령 공간을 확보한다 */
@media (max-width: 1450px) {
  .health {
    display: none;
  }
}
@media (max-width: 1100px) {
  .bar {
    grid-template-columns: 1fr;
  }
  .steps {
    margin-left: 0;
  }
  .row2 {
    flex-wrap: wrap;
  }
}
</style>
