<script setup lang="ts">
import type { PtyStatus } from '@voxelhq/shared'

const props = defineProps<{ status: PtyStatus | 'clean' | 'changed' | 'alert' }>()
const LABEL: Record<string, string> = {
  idle: '유휴',
  queued: '대기열',
  running: '진행 중',
  waiting: '입력 대기',
  done: '완료',
  error: '오류',
  clean: '정상(Clean)',
  changed: '변경 있음',
  alert: '이슈 감지',
}
const label = computed(() => LABEL[props.status] ?? props.status)
</script>

<template>
  <span class="badge" :class="status">{{ label }}</span>
</template>

<style scoped lang="scss">
.badge {
  display: inline-flex;
  align-items: center;
  gap: 5px;
  padding: 2px 8px;
  border-radius: 999px;
  font-size: 12px;
  font-weight: 600;
  white-space: nowrap;
  background: rgba(255, 255, 255, 0.08);
  color: var(--muted);
  &::before {
    content: '';
    width: 7px;
    height: 7px;
    border-radius: 50%;
    background: currentColor;
  }
  &.running {
    color: var(--accent);
    background: rgba(255, 159, 26, 0.14);
  }
  &.waiting {
    color: var(--warn);
    background: rgba(255, 204, 0, 0.14);
  }
  &.done,
  &.clean {
    color: var(--ok);
    background: rgba(52, 199, 89, 0.14);
  }
  &.error,
  &.alert {
    color: var(--err);
    background: rgba(255, 69, 58, 0.14);
  }
  &.changed {
    color: var(--info);
    background: rgba(90, 200, 250, 0.14);
  }
}
</style>
