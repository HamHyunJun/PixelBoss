<script setup lang="ts">
// 개발 파이프라인 진행판: 승인된 제안이 프로젝트별로 '구현 → QA 검수 → (수정) → 최종 결정 → 기록' 어디까지 왔는지 한눈에 보여준다
import type { PipelineInfo } from '@pixelboss/shared'

const emit = defineEmits<{ open: [id: string] }>()
const { state } = useHQ()
const collapsed = ref(false)

const RESULT: Record<string, string> = { merged: '반영됨', blocked: '반영 보류', discarded: '폐기됨', failed: '실패', empty: '변경 없음' }

/** 화면에는 진행 중인 것 전부 + 최근에 끝난 것 몇 개만 보인다 */
const runs = computed(() => {
  const all = [...state.pipelines].sort((a, b) => b.startedAt - a.startedAt)
  const active = all.filter((p) => p.stage !== 'done')
  return [...active, ...all.filter((p) => p.stage === 'done').slice(0, 3)]
})
const waiting = computed(() => state.pipelines.filter((p) => p.status === 'waiting').length)
const projectName = (id: string): string => state.projects.find((p) => p.id === id)?.name ?? id

interface Step {
  label: string
  state: 'done' | 'active' | 'todo'
}
const ORDER = { dev: 0, qa: 1, fix: 2, final: 3, docs: 4, done: 5 }
const steps = (p: PipelineInfo): Step[] => {
  const cur = ORDER[p.stage]
  const st = (idx: number): Step['state'] => (cur > idx ? 'done' : cur === idx ? 'active' : 'todo')
  const list: Step[] = [
    { label: '구현', state: st(0) },
    { label: p.fixRound > 0 && p.stage === 'qa' ? 'QA 재검수' : 'QA', state: st(1) },
  ]
  // 수정 단계는 QA 가 문제를 지적한 뒤에만 나타난다
  if (p.fixRound > 0 || p.stage === 'fix') list.push({ label: `수정 ${p.fixRound}/${p.maxFixRounds}`, state: p.stage === 'fix' ? 'active' : 'done' })
  list.push({ label: '최종', state: st(3) }, { label: '기록', state: st(4) })
  return list
}
const latest = (p: PipelineInfo): string => p.events.at(-1)?.title ?? ''
</script>

<template>
  <aside v-if="runs.length" class="board panel" data-test="pipeline-board">
    <header @click="collapsed = !collapsed">
      <b>🛠 개발 파이프라인 <span class="muted">{{ runs.length }}</span></b>
      <span v-if="waiting" class="need">결정 대기 {{ waiting }}</span>
      <span class="muted">{{ collapsed ? '▸' : '▾' }}</span>
    </header>
    <ul v-if="!collapsed" class="scroll">
      <li v-for="p in runs" :key="p.id">
        <button class="item" :class="{ need: p.status === 'waiting', err: p.status === 'error' }" :data-pipeline="p.id" @click="emit('open', p.id)">
          <div class="top">
            <b>{{ projectName(p.projectId) }}</b>
            <span v-if="p.result" class="res" :class="p.result">{{ RESULT[p.result] }}</span>
            <span v-else-if="p.status === 'waiting'" class="res need">결정 대기</span>
            <span v-else-if="p.status === 'error'" class="res failed">중단됨</span>
          </div>
          <ol class="steps">
            <li v-for="s in steps(p)" :key="s.label" :class="s.state">{{ s.label }}</li>
          </ol>
          <div class="muted small last">{{ latest(p) }}</div>
        </button>
      </li>
    </ul>
  </aside>
</template>

<style scoped lang="scss">
.board {
  position: absolute;
  right: 12px;
  top: 128px;
  width: 330px;
  max-height: calc(100vh - 330px);
  display: flex;
  flex-direction: column;
  z-index: 6;
}
header {
  display: flex;
  align-items: center;
  gap: 8px;
  padding: 10px 12px;
  cursor: pointer;
  border-bottom: 1px solid var(--line);
  b {
    flex: 1;
    font-size: 13px;
  }
}
.need {
  font-size: 11px;
  font-weight: 700;
  color: #1d1300;
  background: var(--accent);
  padding: 2px 8px;
  border-radius: 999px;
}
ul {
  list-style: none;
  margin: 0;
  padding: 8px;
  display: grid;
  gap: 8px;
  overflow: auto;
}
.item {
  width: 100%;
  display: grid;
  gap: 6px;
  text-align: left;
  padding: 8px 10px;
  border-radius: 10px;
  transition: border-color 0.15s, background 0.15s, transform 0.1s;
  &:active {
    transform: scale(0.99);
  }
  &.need {
    border-color: var(--accent);
    background: rgba(255, 159, 26, 0.1);
  }
  &.err {
    border-color: rgba(255, 69, 58, 0.5);
  }
}
.top {
  display: flex;
  align-items: center;
  gap: 8px;
  b {
    flex: 1;
    font-size: 13px;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }
}
.res {
  font-size: 11px;
  padding: 1px 8px;
  border-radius: 999px;
  border: 1px solid currentColor;
  &.merged {
    color: var(--ok);
  }
  &.discarded,
  &.blocked,
  &.empty {
    color: var(--muted);
  }
  &.failed {
    color: var(--err);
  }
  &.need {
    color: var(--accent);
  }
}
.steps {
  display: flex;
  gap: 4px;
  margin: 0;
  padding: 0;
  list-style: none;
  font-size: 11px;
  li {
    padding: 2px 7px;
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
.small {
  font-size: 12px;
}
.last {
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
@keyframes pulse {
  50% {
    opacity: 0.7;
  }
}
@media (prefers-reduced-motion: reduce) {
  .steps li.active {
    animation: none;
  }
}
</style>
