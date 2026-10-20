<script setup lang="ts">
// VoxelHQ 메인 화면: 3D 오피스 + 지시 입력창 + 모달/승인 카드
import type { ViewPreset } from '~/utils/voxel/engine'

const { state } = useHQ()
const office = ref<{ setView: (v: ViewPreset) => void }>()
const polar = ref(Math.PI / 4)
const selected = ref<string | null>(null)
const selectedAgent = computed(() => (selected.value ? state.agents[selected.value] : undefined))

function onPick(agentId: string) {
  selected.value = agentId
}
</script>

<template>
  <div class="hq">
    <VoxelOffice ref="office" @pick="onPick" @polar="polar = $event" />
    <CommandBar />
    <PlanPanel @open="onPick" />
    <ApprovalPanel />
    <ViewControls :polar="polar" @view="office?.setView($event)" />

    <div v-if="!state.connected && !state.projects.length" class="boot panel">
      <b>백엔드에 연결하는 중…</b>
      <span class="muted">`pnpm dev` 로 서버(포트 4100)가 함께 실행 중인지 확인하세요.</span>
    </div>

    <WorkerModal v-if="selectedAgent?.role === 'worker'" :agent-id="selectedAgent.id" @close="selected = null" />
    <LeaderModal v-else-if="selectedAgent?.role === 'leader'" :agent-id="selectedAgent.id" @close="selected = null" @open-worker="onPick" />

    <div class="toasts">
      <div v-for="t in state.toasts" :key="t.id" class="toast panel" :class="t.level">{{ t.message }}</div>
    </div>
  </div>
</template>

<style scoped lang="scss">
.hq {
  position: fixed;
  inset: 0;
}
.boot {
  position: absolute;
  left: 50%;
  top: 50%;
  transform: translate(-50%, -50%);
  padding: 18px 22px;
  display: grid;
  gap: 6px;
  text-align: center;
  z-index: 20;
}
.toasts {
  position: absolute;
  right: 12px;
  bottom: 12px;
  display: grid;
  gap: 8px;
  z-index: 60;
}
.toast {
  padding: 10px 14px;
  font-size: 13px;
  max-width: 380px;
  &.warn {
    border-color: rgba(255, 204, 0, 0.5);
  }
  &.error {
    border-color: rgba(255, 69, 58, 0.6);
  }
}
</style>
