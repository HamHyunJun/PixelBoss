<script setup lang="ts">
// 최종 변경 승인 카드: 팀장이 취합한 git diff + 실행 결과
import { DEPARTMENTS } from '@voxelhq/shared'

const { state, decide } = useHQ()
const open = ref<string | null>(null)
const hidden = ref(false)

const card = computed(() => state.approval)
const withChanges = computed(() => card.value?.reports.filter((r) => r.files.length) ?? [])
const noChanges = computed(() => card.value?.reports.filter((r) => !r.files.length) ?? [])
const total = computed(() => withChanges.value.reduce((s, r) => ({ ins: s.ins + r.diffStat.insertions, del: s.del + r.diffStat.deletions, files: s.files + r.files.length }), { ins: 0, del: 0, files: 0 }))
const deptName = (id: string) => DEPARTMENTS.find((d) => d.id === id)?.name ?? id
const projectName = (id: string) => state.projects.find((p) => p.id === id)?.name ?? id
watch(
  () => card.value?.commandId,
  () => (hidden.value = false),
)
</script>

<template>
  <aside v-if="card && !hidden" class="approval panel" data-test="approval">
    <header>
      <div>
        <div class="muted small">{{ card.decided ? '처리 완료' : '팀장 취합 · 최종 변경 승인' }}</div>
        <b>“{{ card.text }}”</b>
      </div>
      <button class="x" @click="hidden = true">✕</button>
    </header>
    <div class="sum">
      <span><b>{{ withChanges.length }}</b> 작업에서 변경</span>
      <span class="mono">{{ total.files }}파일 <i class="ok">+{{ total.ins }}</i> <i class="err">-{{ total.del }}</i></span>
      <span class="muted">생략 {{ card.skipped.length }}건 (토큰 0)</span>
    </div>
    <div class="list scroll">
      <div v-for="r in withChanges" :key="r.agentId" class="item">
        <button class="row" @click="open = open === r.agentId ? null : r.agentId">
          <span>
            <b>{{ projectName(r.projectId) }}</b>
            <span class="muted small"> · {{ deptName(r.department) }}</span>
          </span>
          <span class="mono small"><i class="ok">+{{ r.diffStat.insertions }}</i> <i class="err">-{{ r.diffStat.deletions }}</i> {{ open === r.agentId ? '▾' : '▸' }}</span>
        </button>
        <div v-if="open === r.agentId" class="detail">
          <div class="small muted files">{{ r.files.join(', ') }}</div>
          <DiffView :diff="r.diff" :max-lines="200" />
        </div>
      </div>
      <div v-if="noChanges.length" class="small muted nochg">변경 없음: {{ noChanges.map((r) => projectName(r.projectId)).join(', ') }}</div>
      <div v-if="card.reports.some((r) => r.status === 'error')" class="small err">일부 세션이 오류로 끝났습니다. 해당 담당자 터미널을 확인하세요.</div>
    </div>
    <footer v-if="!card.decided && state.phase === 'awaiting-approval'">
      <button class="danger" data-test="reject" @click="decide(card.commandId, false)">반려 (되돌리기)</button>
      <button class="primary" data-test="approve" @click="decide(card.commandId, true)">승인 · 커밋</button>
    </footer>
    <footer v-else-if="card.decisionLog?.length" class="log small">
      <div :class="card.decided === 'approved' ? 'ok' : 'err'">{{ card.decided === 'approved' ? '✔ 승인됨' : '↩ 반려됨' }}</div>
      <div v-for="l in card.decisionLog" :key="l" class="muted">{{ l }}</div>
    </footer>
  </aside>
</template>

<style scoped lang="scss">
.approval {
  position: absolute;
  right: 12px;
  top: 128px;
  width: 420px;
  max-height: calc(100vh - 150px);
  display: flex;
  flex-direction: column;
  z-index: 6;
  border-color: rgba(255, 159, 26, 0.4);
}
header {
  display: flex;
  justify-content: space-between;
  gap: 8px;
  padding: 12px 14px 8px;
  .x {
    border: 0;
    background: none;
    padding: 0 4px;
  }
}
.sum {
  display: flex;
  gap: 12px;
  padding: 0 14px 10px;
  font-size: 12px;
  border-bottom: 1px solid var(--line);
}
.list {
  padding: 8px 10px;
  flex: 1;
}
.item {
  margin-bottom: 4px;
}
.row {
  width: 100%;
  display: flex;
  justify-content: space-between;
  align-items: center;
  border: 0;
  background: rgba(255, 255, 255, 0.04);
  text-align: left;
}
.detail {
  padding: 6px 2px 8px;
  .files {
    margin-bottom: 6px;
  }
}
.nochg {
  margin-top: 8px;
}
footer {
  display: flex;
  gap: 8px;
  justify-content: flex-end;
  padding: 10px 14px;
  border-top: 1px solid var(--line);
  &.log {
    flex-direction: column;
    align-items: flex-start;
    gap: 3px;
  }
}
.small {
  font-size: 12px;
}
i {
  font-style: normal;
}
.ok {
  color: var(--ok);
}
.err {
  color: var(--err);
}
</style>
