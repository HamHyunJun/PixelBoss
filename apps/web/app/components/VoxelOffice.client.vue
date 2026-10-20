<script setup lang="ts">
// 3D 복셀 오피스 캔버스. 백엔드 상태가 바뀔 때마다 연출 감독(Director)에 전달한다.
import { VoxelEngine, type ViewPreset } from '~/utils/voxel/engine'

const emit = defineEmits<{ pick: [agentId: string]; polar: [value: number] }>()
const { state } = useHQ()
const el = ref<HTMLDivElement>()
let engine: VoxelEngine | null = null

function syncState() {
  engine?.sync({ phase: state.phase, agents: state.agents, deltas: state.deltas, plan: state.plan })
}

function boot() {
  if (engine || !el.value || !state.projects.length) return
  engine = new VoxelEngine(el.value, state.projects)
  engine.onPick = (id) => emit('pick', id)
  engine.onPolarChange = (p) => emit('polar', p)
  emit('polar', engine.controls.getPolarAngle())
  syncState()
  // 디버그/검증용 핸들
  ;(window as unknown as { __voxelhq: VoxelEngine }).__voxelhq = engine
}

onMounted(boot)
watch(() => state.projects.length, boot)
watch(() => [state.phase, state.agents, state.deltas, state.plan], syncState, { deep: true })
onBeforeUnmount(() => engine?.dispose())

defineExpose({ setView: (v: ViewPreset) => engine?.setView(v) })
</script>

<template>
  <div ref="el" class="office" />
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
</style>
