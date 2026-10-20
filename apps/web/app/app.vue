<script setup lang="ts">
// PixelBoss 메인 화면: 3D 오피스 + 지시 입력창 + 모달/승인 카드
import type { ViewPreset } from '~/utils/voxel/engine'

const { state } = useHQ()
const office = ref<{ setView: (v: ViewPreset) => void }>()
const polar = ref(Math.PI / 4)
const selected = ref<string | null>(null)
const showProjects = ref(false)
const showSchedules = ref(false)
const showHistory = ref(false)
const showIssues = ref(false)
const openPipeline = ref<string | undefined>()
const approvalHidden = useState<boolean>('approval-hidden', () => false)
const selectedAgent = computed(() => (selected.value ? state.agents[selected.value] : undefined))

function onPick(agentId: string) {
  if (agentId === 'ceo') return // 사장은 에이전트가 아니라 모달이 없다
  selected.value = agentId
}

// 리포트 게시판을 누르면 이슈 보고(있으면) 또는 닫아둔 보고/승인 카드를 연다
const onBoard = (): void => {
  // 게시판에는 팀장들이 올린 이슈 보고와 결과 보고가 붙어 있다: 확인할 이슈가 있으면 그것부터 보여준다
  if (state.issues.some((i) => i.status === 'open')) showIssues.value = true
  else if (state.approval) approvalHidden.value = false
}

// 최종 결정을 기다리는 파이프라인이 새로 생기면 결정 모달을 바로 연다 (닫아도 진행판에서 다시 열 수 있다)
const waitingIds = computed(() => state.pipelines.filter((p) => p.status === 'waiting').map((p) => p.id))
watch(waitingIds, (now, before) => {
  const fresh = now.find((id) => !before.includes(id))
  if (fresh && !openPipeline.value) openPipeline.value = fresh
})

// 새 지시의 보고서는 닫아둔 상태여도 다시 자동으로 열린다
watch(
  () => state.approval?.commandId,
  () => (approvalHidden.value = false),
)
</script>

<template>
  <div class="hq">
    <VoxelOffice ref="office" @pick="onPick" @board="onBoard" @polar="polar = $event" />
    <CommandBar @projects="showProjects = true" @schedules="showSchedules = true" @history="showHistory = true" @issues="showIssues = true" />
    <PlanPanel @open="onPick" />
    <ReportModal v-if="state.approval && !approvalHidden" @close="approvalHidden = true" />
    <ViewControls :polar="polar" @view="office?.setView($event)" />

    <div v-if="!state.connected && !state.projects.length" class="boot panel">
      <b>백엔드에 연결하는 중…</b>
      <span class="muted">`pnpm dev` 로 서버(포트 4100)가 함께 실행 중인지 확인하세요.</span>
    </div>
    <div v-else-if="state.connected && !state.projects.length && !showProjects" class="boot panel">
      <b>등록된 프로젝트가 없습니다</b>
      <span class="muted">관리할 프로젝트 폴더를 추가하면 직원들이 배치됩니다.</span>
      <button class="primary" @click="showProjects = true">프로젝트 추가</button>
    </div>

    <ProjectModal v-if="showProjects" @close="showProjects = false" />
    <ScheduleModal v-if="showSchedules" @close="showSchedules = false" />
    <HistoryModal v-if="showHistory" @close="showHistory = false" />
    <IssuesModal v-if="showIssues" @close="showIssues = false" @open-agent="(id) => ((showIssues = false), onPick(id))" />
    <PipelineBoard @open="openPipeline = $event" />
    <PipelineModal v-if="openPipeline" :pipeline-id="openPipeline" @close="openPipeline = undefined" />

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
