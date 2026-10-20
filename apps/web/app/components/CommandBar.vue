<script setup lang="ts">
// 상단 "전체 소집 / 긴급 지시" 입력창 + 오케스트레이션 단계 표시
import type { OrchestratorPhase } from '@voxelhq/shared'

const { state, command, scan } = useHQ()
const text = ref('')

const PRESETS = ['모든 프로젝트 타입 에러 일괄 해결', '버그 픽스 및 접근성 표준 검사 적용', '의존성 보안 취약점 점검', '이번 주 커밋 로그로 릴리즈 노트 작성']

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

const summary = computed(() => {
  const ds = Object.values(state.deltas)
  return {
    clean: ds.filter((d) => d.health === 'clean').length,
    changed: ds.filter((d) => d.health === 'changed').length,
    error: ds.filter((d) => d.health === 'error').length,
  }
})

function submit(value = text.value) {
  if (!value.trim() || busy.value) return
  command(value)
  text.value = ''
}
</script>

<template>
  <header class="bar panel">
    <div class="brand">
      <div class="logo">▣</div>
      <div>
        <div class="title">VoxelHQ</div>
        <div class="sub muted">AI Virtual Company</div>
      </div>
    </div>

    <form class="cmd" @submit.prevent="submit()">
      <span class="tag">📣 전체 소집 / 긴급 지시</span>
      <input v-model="text" :disabled="busy" placeholder="예: 모든 프로젝트 타입 에러 일괄 해결  (정적 필터 무시: '강제' 포함)" data-test="command-input" />
      <button class="primary" type="submit" :disabled="busy || !text.trim() || !state.connected" data-test="command-submit">소집</button>
    </form>

    <div class="meta">
      <span class="conn" :class="{ on: state.connected }">{{ state.connected ? '연결됨' : '재연결 중…' }}</span>
      <span class="runner" :title="'실행기: ' + state.runnerMode">{{ state.runnerMode === 'claude' ? 'Claude Code' : 'Mock 실행기' }}</span>
      <button :disabled="busy" title="git status/diff 와 검사 명령으로 다시 스캔 (LLM 호출 없음)" @click="scan()">↻ 스캔</button>
    </div>

    <div class="row2">
      <div class="presets">
        <button v-for="p in PRESETS" :key="p" class="chip" :disabled="busy || !state.connected" @click="submit(p)">{{ p }}</button>
      </div>
      <div class="health">
        <span class="h ok">Clean {{ summary.clean }}</span>
        <span class="h ch">변경 {{ summary.changed }}</span>
        <span class="h er">에러 {{ summary.error }}</span>
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
    display: grid;
    place-items: center;
    background: linear-gradient(135deg, #ff9f1a, #ff5e3a);
    border-radius: 8px;
    font-size: 20px;
    color: #1d1300;
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
  }
}
.row2 {
  grid-column: 1 / -1;
  display: flex;
  gap: 12px;
  align-items: center;
  flex-wrap: wrap;
}
.presets {
  display: flex;
  gap: 6px;
  flex-wrap: wrap;
  .chip {
    font-size: 12px;
    padding: 3px 10px;
    border-radius: 999px;
  }
}
.health {
  display: flex;
  gap: 6px;
  font-size: 12px;
  .h {
    padding: 2px 8px;
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
@media (max-width: 1100px) {
  .bar {
    grid-template-columns: 1fr;
  }
  .steps {
    margin-left: 0;
  }
}
</style>
