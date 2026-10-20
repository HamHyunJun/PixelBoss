<script setup lang="ts">
// xterm.js 터미널: 백엔드 PTY 출력을 실시간 스트리밍하고 키 입력을 PTY 로 전달
import { Terminal } from '@xterm/xterm'
import { FitAddon } from '@xterm/addon-fit'

const props = defineProps<{ agentId: string }>()
const { subscribePty, input, resize, openSession } = useHQ()
const el = ref<HTMLDivElement>()
let term: Terminal | null = null
let unsubscribe: (() => void) | null = null
let ro: ResizeObserver | null = null
let placeholder = false

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
  // 터미널을 클릭(포커스)하면 실행 중인 프로세스가 없을 때 담당 프로젝트 폴더에서 Claude Code 세션이 열린다
  term.textarea?.addEventListener('focus', () => openSession(props.agentId))
  unsubscribe = subscribePty(props.agentId, (data, reset) => {
    if (reset) term?.reset()
    if (data && placeholder) {
      term?.reset()
      placeholder = false
    }
    if (data) term?.write(data)
    else if (reset) {
      placeholder = true
      term?.write('\x1b[2m이 터미널을 클릭하면 담당 프로젝트 폴더에서 Claude Code 세션이 열립니다.\r\n지시가 배정되면 실행 출력이 여기에 표시됩니다.\x1b[0m\r\n')
    }
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
  /* 모달(화면 높이 - 48px) 안에서 헤더·제목·안내 문구를 뺀 나머지를 최대한 쓴다 */
  height: max(420px, calc(100vh - 300px));
  background: #0d1117;
  border-radius: 8px;
  padding: 8px;
  border: 1px solid var(--line);
}
</style>
