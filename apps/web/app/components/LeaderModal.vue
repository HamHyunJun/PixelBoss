<script setup lang="ts">
// 팀장 모달: 부서 통합 브리핑 대시보드 (소속 6개 프로젝트 상태 한눈에 보기)
import { DEPARTMENTS, workerId } from '@pixelboss/shared'
import type { DepartmentId } from '@pixelboss/shared'

const props = defineProps<{ agentId: string }>()
const emit = defineEmits<{ close: []; openWorker: [agentId: string] }>()
const { state } = useHQ()
const targets = useState<DepartmentId[]>('command-targets', () => [])

const leader = computed(() => state.agents[props.agentId]!)
const dept = computed(() => DEPARTMENTS.find((d) => d.id === leader.value.department)!)

const rows = computed(() =>
  state.projects.map((p) => {
    const id = workerId(dept.value.id, p.id)
    const agent = state.agents[id]
    const delta = state.deltas[p.id]
    const task = state.plan?.tasks.find((t) => t.agentId === id)
    const report = state.approval?.reports.find((r) => r.agentId === id)
    return { p, id, agent, delta, task, report }
  }),
)

const callDept = (): void => {
  targets.value = [dept.value.id]
  emit('close')
}

const stats = computed(() => {
  const r = rows.value
  return {
    running: r.filter((x) => x.agent?.status === 'running' || x.agent?.status === 'queued').length,
    done: r.filter((x) => x.agent?.status === 'done').length,
    error: r.filter((x) => x.agent?.status === 'error' || x.delta?.health === 'error').length,
    clean: r.filter((x) => x.delta?.health === 'clean').length,
    skipped: r.filter((x) => x.task?.skipped).length,
    changedLines: r.reduce((s, x) => s + (x.report ? x.report.diffStat.insertions + x.report.diffStat.deletions : 0), 0),
  }
})
</script>

<template>
  <BaseModal :title="`${dept.name} · 부서 통합 브리핑`" :subtitle="dept.mission" wide @close="emit('close')">
    <template #actions>
      <button :disabled="state.phase !== 'idle'" @click="callDept()">📣 이 부서 호출</button>
      <StatusBadge :status="leader.status" />
    </template>

    <div class="stats">
      <div class="stat"><b>{{ stats.running }}</b><span>진행 중</span></div>
      <div class="stat ok"><b>{{ stats.done }}</b><span>완료</span></div>
      <div class="stat err"><b>{{ stats.error }}</b><span>이슈</span></div>
      <div class="stat"><b>{{ stats.clean }}</b><span>Clean 프로젝트</span></div>
      <div class="stat"><b>{{ stats.skipped }}</b><span>LLM 호출 생략</span></div>
      <div class="stat"><b>{{ stats.changedLines }}</b><span>이번 변경 줄 수</span></div>
    </div>

    <table data-test="leader-table">
      <thead>
        <tr>
          <th>프로젝트</th>
          <th>정적 필터</th>
          <th>검사</th>
          <th>담당자</th>
          <th>이번 지시</th>
          <th>변경</th>
        </tr>
      </thead>
      <tbody>
        <tr v-for="r in rows" :key="r.id" @click="emit('openWorker', r.id)">
          <td>
            <b>{{ r.p.name }}</b>
            <div class="muted mono small">{{ r.p.github ? `${r.p.github.owner}/${r.p.github.repo}` : 'local' }}</div>
          </td>
          <td><StatusBadge v-if="r.delta" :status="r.delta.health" /><span v-else class="muted">스캔 전</span></td>
          <td class="small">
            <span v-for="c in r.delta?.checks ?? []" :key="c.name" :class="c.ok ? 'ok' : 'err'">{{ c.ok ? '✔' : '✖' }}{{ c.name }} </span>
          </td>
          <td><StatusBadge v-if="r.agent" :status="r.agent.status" /></td>
          <td class="small">
            <span v-if="r.task?.skipped" class="muted">생략 · {{ r.task.skipped }}</span>
            <span v-else-if="r.task">배정됨</span>
            <span v-else class="muted">—</span>
          </td>
          <td class="small mono">
            <template v-if="r.report">{{ r.report.files.length }}파일 <span class="ok">+{{ r.report.diffStat.insertions }}</span> <span class="err">-{{ r.report.diffStat.deletions }}</span></template>
            <span v-else class="muted">—</span>
          </td>
        </tr>
      </tbody>
    </table>
    <p class="muted small">행을 클릭하면 해당 실무 에이전트의 터미널을 엽니다.</p>
  </BaseModal>
</template>

<style scoped lang="scss">
.stats {
  display: grid;
  grid-template-columns: repeat(6, 1fr);
  gap: 8px;
  margin-bottom: 14px;
  .stat {
    background: rgba(255, 255, 255, 0.04);
    border: 1px solid var(--line);
    border-radius: 10px;
    padding: 10px 12px;
    b {
      display: block;
      font-size: 22px;
    }
    span {
      font-size: 12px;
      color: var(--muted);
    }
    &.ok b {
      color: var(--ok);
    }
    &.err b {
      color: var(--err);
    }
  }
}
table {
  width: 100%;
  border-collapse: collapse;
  th,
  td {
    text-align: left;
    padding: 9px 8px;
    border-bottom: 1px solid var(--line);
    vertical-align: middle;
  }
  th {
    font-size: 12px;
    color: var(--muted);
    font-weight: 600;
  }
  tbody tr {
    cursor: pointer;
    &:hover {
      background: rgba(255, 255, 255, 0.04);
    }
  }
}
.small {
  font-size: 12px;
}
.ok {
  color: var(--ok);
}
.err {
  color: var(--err);
}
</style>
