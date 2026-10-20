<script setup lang="ts">
// 3D 복셀 오피스 캔버스. 백엔드 상태가 바뀔 때마다 연출 감독(Director)에 전달한다.
import { DEPARTMENTS } from '@pixelboss/shared'
import { VoxelEngine, type ViewPreset } from '~/utils/voxel/engine'

const emit = defineEmits<{ pick: [agentId: string]; board: []; polar: [value: number] }>()
const { state } = useHQ()
const el = ref<HTMLDivElement>()
let engine: VoxelEngine | null = null

/** 호버 툴팁: 담당 직원 머리 위에 담당 프로젝트명을 띄운다 */
const hover = ref<{ agentId: string; x: number; y: number }>()
const tip = computed(() => {
  if (hover.value?.agentId === 'ceo') return { x: hover.value.x, y: hover.value.y, color: '#f2c744', title: '사장', sub: '전체 소집 면담을 주재합니다' }
  const agent = hover.value && state.agents[hover.value.agentId]
  if (!hover.value || !agent) return undefined
  const dept = DEPARTMENTS.find((d) => d.id === agent.department)!
  const project = state.projects.find((p) => p.id === agent.projectId)
  return {
    x: hover.value.x,
    y: hover.value.y,
    color: dept.color,
    title: agent.role === 'leader' ? `${dept.name} 팀장` : (project?.name ?? agent.name),
    sub: agent.role === 'leader' ? dept.mission : dept.name,
  }
})

function syncState() {
  engine?.setProjects(state.projects)
  engine?.sync({ phase: state.phase, agents: state.agents, deltas: state.deltas, plan: state.plan, issues: state.issues })
}

function boot() {
  if (engine || !el.value || !state.connected) return
  engine = new VoxelEngine(el.value, state.projects)
  engine.onPick = (id) => emit('pick', id)
  engine.onPickBoard = () => emit('board')
  engine.onPolarChange = (p) => emit('polar', p)
  engine.onHover = (h) => {
    const prev = hover.value
    // 같은 위치면 갱신하지 않아 매 프레임 리렌더를 피한다
    if (!h ? !prev : prev?.agentId === h.agentId && prev.x === h.x && prev.y === h.y) return
    hover.value = h
  }
  emit('polar', engine.controls.getPolarAngle())
  syncState()
  // 디버그/검증용 핸들
  ;(window as unknown as { __pixelboss: VoxelEngine }).__pixelboss = engine
}

onMounted(boot)
watch(() => state.connected, boot)
watch(() => [state.phase, state.projects, state.agents, state.deltas, state.plan, state.issues], syncState, { deep: true })
onBeforeUnmount(() => engine?.dispose())

defineExpose({ setView: (v: ViewPreset) => engine?.setView(v) })
</script>

<template>
  <div ref="el" class="office" />
  <div v-if="tip" class="tip" role="tooltip" :style="{ transform: `translate(${tip.x}px, ${tip.y}px)`, '--dept': tip.color }">
    <div class="body">
      <b>{{ tip.title }}</b>
      <span>{{ tip.sub }}</span>
    </div>
  </div>
</template>

<style scoped lang="scss">
.office {
  position: absolute;
  inset: 0;
  cursor: grab;
  &:active {
    cursor: grabbing;
  }
}
.tip {
  position: absolute;
  left: 0;
  top: 0;
  z-index: 15;
  pointer-events: none;
  .body {
    transform: translate(-50%, calc(-100% - 6px));
    display: grid;
    gap: 1px;
    max-width: 260px;
    padding: 6px 10px;
    border-radius: 8px;
    border: 1px solid var(--dept);
    background: rgba(18, 22, 33, 0.94);
    box-shadow: 0 6px 18px rgba(0, 0, 0, 0.4);
    text-align: center;
    white-space: nowrap;
    animation: tip-in 0.12s ease-out;
    b {
      font-size: 13px;
    }
    span {
      font-size: 11px;
      color: var(--muted);
      overflow: hidden;
      text-overflow: ellipsis;
    }
    // 말풍선 꼬리
    &::after {
      content: '';
      position: absolute;
      left: 50%;
      bottom: -5px;
      width: 8px;
      height: 8px;
      background: rgba(18, 22, 33, 0.94);
      border-right: 1px solid var(--dept);
      border-bottom: 1px solid var(--dept);
      transform: translateX(-50%) rotate(45deg);
    }
  }
}
@keyframes tip-in {
  from {
    opacity: 0;
    scale: 0.92;
  }
}
@media (prefers-reduced-motion: reduce) {
  .tip .body {
    animation: none;
  }
}
</style>
