<script setup lang="ts">
// 상위 명령 분해 결과 (어떤 부서/프로젝트에 배정됐고, 무엇이 토큰 0 으로 생략됐는지)
import { DEPARTMENTS } from '@pixelboss/shared'

const { state } = useHQ()
const emit = defineEmits<{ open: [agentId: string] }>()
const collapsed = ref(false)

const groups = computed(() =>
  (state.plan?.departments ?? [])
    .map((d) => ({
      dept: DEPARTMENTS.find((x) => x.id === d)!,
      tasks: (state.plan?.tasks ?? []).filter((t) => t.department === d),
    }))
    // 소집만 되고 맡은 작업이 없는 팀(예: 하달만 하는 기획팀)은 목록에서 뺀다
    .filter((g) => g.tasks.length),
)
const projectName = (id: string) => state.projects.find((p) => p.id === id)?.name ?? id
</script>

<template>
  <aside v-if="state.plan && state.plan.tasks.length" class="plan panel" data-test="plan">
    <header @click="collapsed = !collapsed">
      <div>
        <div class="muted small">하향식 명령 분해</div>
        <b>“{{ state.plan.text }}”</b>
      </div>
      <span class="muted">{{ collapsed ? '▸' : '▾' }}</span>
    </header>
    <div v-if="!collapsed" class="content scroll">
      <ul class="why small muted">
        <li v-for="r in state.plan.rationale" :key="r">{{ r }}</li>
      </ul>
      <div v-for="g in groups" :key="g.dept.id" class="group">
        <div class="dept" :style="{ color: g.dept.color }">■ {{ g.dept.name }}</div>
        <div v-for="t in g.tasks" :key="t.agentId" class="task" :class="{ skipped: t.skipped }" @click="emit('open', t.agentId)">
          <span>{{ projectName(t.projectId) }}</span>
          <span v-if="t.skipped" class="small muted">{{ t.skipped }}</span>
          <StatusBadge v-else :status="state.agents[t.agentId]?.status ?? 'idle'" />
        </div>
      </div>
    </div>
  </aside>
</template>

<style scoped lang="scss">
.plan {
  position: absolute;
  left: 12px;
  top: 128px;
  width: 340px;
  max-height: calc(100vh - 330px);
  display: flex;
  flex-direction: column;
  z-index: 6;
}
header {
  display: flex;
  justify-content: space-between;
  gap: 8px;
  padding: 10px 12px;
  cursor: pointer;
  border-bottom: 1px solid var(--line);
}
.content {
  padding: 8px 12px 12px;
}
.why {
  margin: 0 0 8px;
  padding-left: 16px;
}
.small {
  font-size: 12px;
}
.group {
  margin-top: 8px;
}
.dept {
  font-weight: 700;
  font-size: 12px;
  margin-bottom: 4px;
}
.task {
  display: flex;
  justify-content: space-between;
  align-items: center;
  gap: 8px;
  padding: 5px 8px;
  border-radius: 6px;
  cursor: pointer;
  &:hover {
    background: rgba(255, 255, 255, 0.05);
  }
  &.skipped > span:first-child {
    color: var(--muted);
    text-decoration: line-through;
  }
}
</style>
