<script setup lang="ts">
// 카메라 피치 프리셋 + 현재 각도 + 범례
import type { ViewPreset } from '~/utils/voxel/engine'

defineProps<{ polar: number }>()
const emit = defineEmits<{ view: [preset: ViewPreset] }>()
</script>

<template>
  <div class="view panel">
    <div class="presets">
      <button @click="emit('view', 'top')">⬇ 탑뷰</button>
      <button @click="emit('view', 'iso')">◩ 45° 아이소</button>
      <button @click="emit('view', 'side')">⬆ 사이드</button>
    </div>
    <div class="pitch">
      <span class="muted">피치</span>
      <div class="track"><div class="knob" :style="{ left: `${(polar / (Math.PI / 2)) * 100}%` }" /></div>
      <span class="mono" data-test="pitch">{{ Math.round(90 - (polar * 180) / Math.PI) }}°</span>
    </div>
    <div class="hint muted">드래그 ↓ 탑뷰 · ↑ 수평뷰 · 좌우 회전 · 휠 줌 · 우클릭 이동</div>
    <div class="legend">
      <span><i class="gear" />작업 중</span>
      <span><i class="alert" />이슈</span>
      <span><i class="check" />완료</span>
      <span><i class="wait" />입력 대기</span>
    </div>
  </div>
</template>

<style scoped lang="scss">
.view {
  position: absolute;
  left: 12px;
  bottom: 12px;
  padding: 10px 12px;
  display: grid;
  gap: 8px;
  z-index: 5;
  font-size: 12px;
  width: 300px;
}
.presets {
  display: flex;
  gap: 6px;
  button {
    flex: 1;
    font-size: 12px;
    padding: 5px 6px;
  }
}
.pitch {
  display: flex;
  align-items: center;
  gap: 8px;
  .track {
    flex: 1;
    height: 4px;
    background: rgba(255, 255, 255, 0.12);
    border-radius: 2px;
    position: relative;
  }
  .knob {
    position: absolute;
    top: -4px;
    width: 12px;
    height: 12px;
    margin-left: -6px;
    background: var(--accent);
    border-radius: 3px;
  }
}
.legend {
  display: flex;
  gap: 10px;
  flex-wrap: wrap;
  span {
    display: flex;
    align-items: center;
    gap: 5px;
  }
  i {
    width: 10px;
    height: 10px;
    border-radius: 2px;
    display: inline-block;
  }
  .gear {
    background: #ff9f1a;
  }
  .alert {
    background: #ff3b30;
  }
  .check {
    background: #34c759;
  }
  .wait {
    background: #ffcc00;
  }
}
</style>
