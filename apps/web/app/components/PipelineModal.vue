<script setup lang="ts">
// 파이프라인 상세: 진행 타임라인(개발·QA·수정 보고 전문)과 최종 반영 결정
import report from '~/utils/report'

const props = defineProps<{ pipelineId: string }>()
const emit = defineEmits<{ close: [] }>()
const { state, decidePipeline, stopPipeline } = useHQ()

const run = computed(() => state.pipelines.find((p) => p.id === props.pipelineId))
const project = computed(() => state.projects.find((p) => p.id === run.value?.projectId))
const files = computed(() => report.parseDiff(run.value?.final?.diff ?? ''))
const rawOpen = ref(new Set<string>())
const confirm = ref<'merge' | 'discard' | 'stop' | undefined>()

const ICON: Record<string, string> = { system: '⚙️', dev: '🛠', qa: '🧪', fix: '🔧', final: '✅', docs: '📚' }
const RESULT: Record<string, string> = {
  merged: '반영됨',
  blocked: '반영 보류 (브랜치만 남음)',
  discarded: '폐기·중단됨',
  failed: '실패',
  empty: '변경 없음',
}
const time = (t: number): string => new Date(t).toLocaleTimeString('ko-KR', { hour: '2-digit', minute: '2-digit', second: '2-digit' })
const toggle = (k: string): void => {
  if (rawOpen.value.has(k)) rawOpen.value.delete(k)
  else rawOpen.value.add(k)
}

/** 되돌릴 수 없는 동작은 한 번 더 눌러 확인한다 */
const ask = (kind: 'merge' | 'discard' | 'stop', fn: () => void): void => {
  if (confirm.value === kind) {
    confirm.value = undefined
    fn()
    return
  }
  confirm.value = kind
  setTimeout(() => confirm.value === kind && (confirm.value = undefined), 3000)
}
</script>

<template>
  <BaseModal v-if="run" :title="`${project?.name ?? run.projectId} · 개발 파이프라인`" :subtitle="`“${run.title}”`" wide @close="emit('close')">
    <template #actions>
      <span class="state" :class="run.result ?? run.status" data-test="pipeline-state">
        {{ run.result ? RESULT[run.result] : run.status === 'waiting' ? '⏳ 최종 결정 대기' : run.status === 'error' ? '⚠ 중단됨' : '진행 중…' }}
      </span>
    </template>

    <div data-test="pipeline-detail">
      <p class="meta mono muted small">
        브랜치 {{ run.branch || '(준비 중)' }} · 기준 {{ run.baseBranch || '-' }} · QA 지적 수정 {{ run.fixRound }}/{{ run.maxFixRounds }}회
      </p>

      <ol class="timeline">
        <li v-for="(e, i) in run.events" :key="i" :class="{ bad: e.ok === false, good: e.ok === true }">
          <div class="eh">
            <span aria-hidden="true">{{ ICON[e.kind] }}</span>
            <b>{{ e.title }}</b>
            <span class="muted small mono">{{ time(e.at) }}</span>
          </div>
          <MarkdownView :text="e.body" class="eb" />
        </li>
        <li v-if="run.status === 'running'" class="running"><span class="dot" /> 진행 중… 완료되면 여기에 보고가 추가됩니다</li>
      </ol>

      <!-- 최종 결정: QA 통과 후(또는 수정 횟수를 다 쓴 후) 한 번만 묻는다 -->
      <section v-if="run.final && run.stage === 'final'" class="final" data-test="pipeline-final">
        <h3>최종 반영 결정</h3>
        <p class="verdict" :class="run.final.qaPassed ? 'ok' : 'err'">
          {{ run.final.qaPassed ? '✔ QA 검수를 통과했습니다.' : '✖ QA 검수를 통과하지 못했습니다. 아래 보고를 읽고 직접 판단해주세요.' }}
        </p>
        <ul v-if="run.final.warnings.length" class="warns">
          <li v-for="w in run.final.warnings" :key="w">{{ w }}</li>
        </ul>
        <p class="mono small">변경 파일 {{ run.final.stat.files }}개 <i class="ok">+{{ run.final.stat.insertions }}</i> <i class="err">-{{ run.final.stat.deletions }}</i></p>
        <div v-for="f in files" :key="f.file" class="file">
          <div class="fhead">
            <span class="tag" :class="f.isNew ? 'new' : 'mod'">{{ f.isNew ? '신규' : '수정' }}</span>
            <b class="mono">{{ f.file }}</b>
            <span class="grow" />
            <span class="mono small"><i class="ok">+{{ f.insertions }}</i> <i class="err">-{{ f.deletions }}</i></span>
            <button class="link" @click="toggle(f.file)">{{ rawOpen.has(f.file) ? '접기' : '전체 diff 보기' }}</button>
          </div>
          <MarkdownView v-if="report.isDoc(f.file)" :lines="f.added" />
          <DiffView v-if="rawOpen.has(f.file) || !report.isDoc(f.file)" :diff="f.raw" :max-lines="rawOpen.has(f.file) ? 600 : 60" />
        </div>
        <p class="muted small">
          반영하면 브랜치 <code>{{ run.branch }}</code> 를 <code>{{ run.baseBranch }}</code> 에 병합합니다 (push 하지 않음). 폐기하면 브랜치를 지우고 패치만 보관합니다.
        </p>
      </section>
    </div>

    <template #footer>
      <template v-if="run.status === 'waiting'">
        <button class="danger" :class="{ armed: confirm === 'discard' }" data-test="pipeline-discard" @click="ask('discard', () => decidePipeline(run!.id, false))">
          {{ confirm === 'discard' ? '정말 폐기?' : '폐기' }}
        </button>
        <button class="primary" :class="{ armed: confirm === 'merge' }" data-test="pipeline-merge" @click="ask('merge', () => decidePipeline(run!.id, true))">
          {{ confirm === 'merge' ? `정말 ${run.baseBranch} 에 반영?` : '반영 (병합)' }}
        </button>
      </template>
      <template v-else-if="run.stage !== 'done'">
        <button class="danger" :class="{ armed: confirm === 'stop' }" data-test="pipeline-stop" @click="ask('stop', () => stopPipeline(run!.id))">
          {{ confirm === 'stop' ? '정말 중단하고 브랜치 정리?' : run.status === 'error' ? '정리 (중단)' : '중단' }}
        </button>
      </template>
      <button v-else @click="emit('close')">닫기</button>
    </template>
  </BaseModal>
</template>

<style scoped lang="scss">
.state {
  align-self: center;
  font-size: 13px;
  font-weight: 700;
  padding: 4px 12px;
  border-radius: 999px;
  border: 1px solid currentColor;
  color: var(--info);
  &.waiting {
    color: var(--accent);
  }
  &.merged {
    color: var(--ok);
  }
  &.failed,
  &.error {
    color: var(--err);
  }
  &.discarded,
  &.blocked,
  &.empty {
    color: var(--muted);
  }
}
.meta {
  margin: 0 0 12px;
}
.small {
  font-size: 12px;
}
.timeline {
  list-style: none;
  margin: 0;
  padding: 0 0 0 14px;
  border-left: 2px solid var(--line);
  display: grid;
  gap: 14px;
  > li {
    position: relative;
    &::before {
      content: '';
      position: absolute;
      left: -21px;
      top: 6px;
      width: 10px;
      height: 10px;
      border-radius: 50%;
      background: var(--muted);
    }
    &.good::before {
      background: var(--ok);
    }
    &.bad::before {
      background: var(--err);
    }
    &.running::before {
      background: var(--accent);
      animation: pulse 1.2s ease-in-out infinite;
    }
  }
}
.running {
  color: var(--muted);
  font-size: 13px;
}
.eh {
  display: flex;
  align-items: center;
  gap: 8px;
  margin-bottom: 6px;
}
.final {
  margin-top: 22px;
  padding: 14px 16px;
  border: 1px solid var(--accent);
  border-radius: 12px;
  background: rgba(255, 159, 26, 0.06);
  h3 {
    font-size: 15px;
    margin-bottom: 8px;
  }
}
.verdict {
  margin: 0 0 8px;
  font-weight: 700;
  &.ok {
    color: var(--ok);
  }
  &.err {
    color: var(--err);
  }
}
.warns {
  margin: 0 0 10px;
  padding: 8px 12px 8px 28px;
  border-radius: 8px;
  background: rgba(255, 204, 0, 0.1);
  border: 1px solid rgba(255, 204, 0, 0.35);
  font-size: 13px;
  line-height: 1.55;
}
.file {
  margin: 10px 0;
}
.fhead {
  display: flex;
  align-items: center;
  gap: 10px;
  margin-bottom: 6px;
}
.grow {
  flex: 1;
}
.tag {
  font-size: 11px;
  padding: 1px 7px;
  border-radius: 6px;
  &.new {
    background: rgba(52, 199, 89, 0.16);
    color: var(--ok);
  }
  &.mod {
    background: rgba(90, 200, 250, 0.16);
    color: var(--info);
  }
}
i {
  font-style: normal;
  &.ok {
    color: var(--ok);
  }
  &.err {
    color: var(--err);
  }
}
.link {
  border: 0;
  background: transparent;
  color: var(--info);
  padding: 2px 4px;
  font-size: 12px;
  &:hover:not(:disabled) {
    background: transparent;
    text-decoration: underline;
  }
}
code {
  font-family: var(--mono);
  padding: 1px 5px;
  border-radius: 4px;
  background: rgba(255, 255, 255, 0.1);
}
.armed {
  box-shadow: 0 0 0 3px rgba(255, 159, 26, 0.35);
}
.danger.armed {
  background: var(--err);
  border-color: var(--err);
  color: #fff;
}
@keyframes pulse {
  50% {
    opacity: 0.4;
  }
}
@media (prefers-reduced-motion: reduce) {
  .running::before {
    animation: none;
  }
}
</style>
