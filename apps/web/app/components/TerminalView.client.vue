<script setup lang="ts">
// xterm.js 터미널: 백엔드 PTY 출력을 실시간 스트리밍하고 키 입력을 PTY 로 전달
import { Terminal } from '@xterm/xterm'
import { FitAddon } from '@xterm/addon-fit'

const props = defineProps<{ agentId: string }>()
const { subscribePty, input, resize } = useHQ()
const el = ref<HTMLDivElement>()
let term: Terminal | null = null
let unsubscribe: (() => void) | null = null
let ro: ResizeObserver | null = null

onMounted(() => {
  term = new Terminal({
    fontFamily: '"JetBrains Mono", Menlo, Consolas, "DejaVu Sans Mono", monospace',
    fontSize: 13,
    cursorBlink: true,
    convertEol: false,
    scrollback: 5000,
    theme: { background: '#0d1117', foreground: '#d6deeb', cursor: '#ff9f1a' },
  })
  const fit = new FitAddon()
  term.loadAddon(fit)
  term.open(el.value!)
  fit.fit()
  resize(props.agentId, term.cols, term.rows)
  term.onData((d) => input(props.agentId, d))
  unsubscribe = subscribePty(props.agentId, (data, reset) => {
    if (reset) term?.reset()
    if (data) term?.write(data)
    else if (reset) term?.write('\x1b[2m(아직 실행된 세션이 없습니다. 전체 소집 명령이 배정되면 여기에 Claude Code 출력이 표시됩니다)\x1b[0m\r\n')
  })
  ro = new ResizeObserver(() => {
    fit.fit()
    resize(props.agentId, term!.cols, term!.rows)
  })
  ro.observe(el.value!)
})

onBeforeUnmount(() => {
  unsubscribe?.()
  ro?.disconnect()
  term?.dispose()
})
</script>

<template>
  <div ref="el" class="term" data-test="terminal" />
</template>

<style scoped lang="scss">
.term {
  height: 340px;
  background: #0d1117;
  border-radius: 8px;
  padding: 8px;
  border: 1px solid var(--line);
}
</style>
