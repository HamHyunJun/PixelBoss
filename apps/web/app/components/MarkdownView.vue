<script setup lang="ts">
// 헤딩·목록·문단·인라인 코드만 읽기 좋게 보여주는 최소 마크다운 뷰 (v-html 미사용)
import report from '~/utils/report'

const props = defineProps<{ text?: string; lines?: string[] }>()
const blocks = computed(() => report.renderMarkdown(props.lines ?? (props.text ?? '').split('\n')))
</script>

<template>
  <div class="md">
    <template v-for="(b, i) in blocks" :key="i">
      <h4 v-if="b.kind === 'h'" :class="`lv${Math.min(b.level, 3)}`">
        <template v-for="(s, j) in b.segs" :key="j"><code v-if="s.code">{{ s.text }}</code><template v-else>{{ s.text }}</template></template>
      </h4>
      <p v-else :class="{ li: b.kind === 'li' }">
        <template v-for="(s, j) in b.segs" :key="j"><code v-if="s.code">{{ s.text }}</code><template v-else>{{ s.text }}</template></template>
      </p>
    </template>
  </div>
</template>

<style scoped lang="scss">
.md {
  padding: 12px 16px;
  border-radius: 8px;
  background: rgba(0, 0, 0, 0.22);
  border: 1px solid var(--line);
  line-height: 1.7;
  font-size: 14px;
  h4 {
    margin: 14px 0 4px;
    &.lv1 {
      font-size: 17px;
    }
    &.lv2 {
      font-size: 15.5px;
    }
    &.lv3 {
      font-size: 14.5px;
      color: var(--accent);
    }
    &:first-child {
      margin-top: 0;
    }
  }
  p {
    margin: 3px 0;
    &.li {
      padding-left: 16px;
      position: relative;
      &::before {
        content: '•';
        position: absolute;
        left: 4px;
        color: var(--muted);
      }
    }
  }
  code {
    font-family: var(--mono);
    font-size: 12.5px;
    padding: 1px 5px;
    border-radius: 4px;
    background: rgba(255, 255, 255, 0.09);
  }
}
</style>
