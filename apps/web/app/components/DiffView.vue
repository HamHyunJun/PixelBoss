<script setup lang="ts">
// 간단한 unified diff 하이라이터
const props = defineProps<{ diff: string; maxLines?: number }>()
const lines = computed(() => {
  const all = props.diff.split('\n')
  const max = props.maxLines ?? 400
  const shown = all.slice(0, max).map((l) => ({
    text: l,
    cls: l.startsWith('+++') || l.startsWith('---') ? 'file' : l.startsWith('@@') ? 'hunk' : l.startsWith('diff ') ? 'head' : l.startsWith('+') ? 'add' : l.startsWith('-') ? 'del' : '',
  }))
  if (all.length > max) shown.push({ text: `… ${all.length - max}줄 더 있음`, cls: 'hunk' })
  return shown
})
</script>

<template>
  <pre class="diff scroll mono"><span v-for="(l, i) in lines" :key="i" :class="l.cls">{{ l.text }}
</span></pre>
</template>

<style scoped lang="scss">
.diff {
  margin: 0;
  max-height: 320px;
  background: #0d1117;
  border: 1px solid var(--line);
  border-radius: 8px;
  padding: 8px 10px;
  font-size: 12px;
  line-height: 1.5;
  span {
    display: block;
    white-space: pre-wrap;
    word-break: break-all;
  }
  .add {
    color: #7ee787;
    background: rgba(46, 160, 67, 0.12);
  }
  .del {
    color: #ffa198;
    background: rgba(248, 81, 73, 0.12);
  }
  .hunk {
    color: #79c0ff;
  }
  .file,
  .head {
    color: #d2a8ff;
    font-weight: 600;
  }
}
</style>
