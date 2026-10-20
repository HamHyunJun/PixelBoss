<script setup lang="ts">
// 실무 에이전트 모달: 실시간 작업 상태, 에러 로그, Claude Code PTY 터미널(xterm.js)
import { DEPARTMENTS } from '@pixelboss/shared'

const props = defineProps<{ agentId: string }>()
const emit = defineEmits<{ close: [] }>()
const { state } = useHQ()

const agent = computed(() => state.agents[props.agentId]!)
const dept = computed(() => DEPARTMENTS.find((d) => d.id === agent.value.department)!)
const project = computed(() => state.projects.find((p) => p.id === agent.value.projectId))
const delta = computed(() => (agent.value.projectId ? state.deltas[agent.value.projectId] : undefined))
const task = computed(() => state.plan?.tasks.find((t) => t.agentId === props.agentId))
const report = computed(() => state.approval?.reports.find((r) => r.agentId === props.agentId))
const failing = computed(() => delta.value?.checks.filter((c) => !c.ok) ?? [])
const showPrompt = ref(false)
</script>

<template>
  <BaseModal :title="`${dept.name} · ${project?.name ?? ''} 담당`" :subtitle="project?.path" wide @close="emit('close')">
    <template #actions>
      <StatusBadge :status="agent.status" data-test="worker-status" />
    </template>

    <div class="grid">
      <section class="info">
        <h4>프로젝트 상태 <span class="muted">(1차 정적 필터)</span></h4>
        <div v-if="delta" class="kv">
          <span class="muted">상태</span><StatusBadge :status="delta.health" />
          <span class="muted">브랜치</span><span class="mono">{{ delta.branch }} @ {{ delta.head }}</span>
          <span class="muted">변경 파일</span><span>{{ delta.changedFiles.length }}개 (+{{ delta.diffStat.insertions }} / -{{ delta.diffStat.deletions }})</span>
          <template v-if="project?.github">
            <span class="muted">GitHub</span>
            <span class="mono">{{ project.github.owner }}/{{ project.github.repo }}<template v-if="delta.githubOpenIssues !== undefined"> · 열린 이슈 {{ delta.githubOpenIssues }}</template></span>
          </template>
          <span class="muted">스캔</span><span>{{ new Date(delta.scannedAt).toLocaleTimeString() }}</span>
        </div>
        <ul v-if="delta?.changedFiles.length" class="files mono">
          <li v-for="f in delta.changedFiles.slice(0, 12)" :key="f.file"><b>{{ f.status }}</b> {{ f.file }}</li>
        </ul>

        <h4>검사 결과</h4>
        <div class="checks">
          <span v-for="c in delta?.checks ?? []" :key="c.name" class="check" :class="{ fail: !c.ok }">{{ c.ok ? '✔' : '✖' }} {{ c.name }}<template v-if="!c.ok"> ({{ c.errorCount }})</template></span>
          <span v-if="!delta?.checks.length" class="muted">설정된 검사 없음</span>
        </div>
        <template v-if="failing.length">
          <h4>에러 로그</h4>
          <pre v-for="c in failing" :key="c.name" class="log mono scroll">{{ c.excerpt }}</pre>
        </template>

        <h4>현재 태스크</h4>
        <p v-if="task?.skipped" class="muted">이번 지시에서 제외됨 — {{ task.skipped }}</p>
        <template v-else-if="task">
          <p>{{ state.plan?.text }}</p>
          <button class="link" @click="showPrompt = !showPrompt">{{ showPrompt ? '하위 프롬프트 숨기기' : '전달된 하위 실행 프롬프트 보기' }}</button>
          <pre v-if="showPrompt" class="log mono scroll">{{ task.prompt }}</pre>
        </template>
        <p v-else class="muted">배정된 태스크 없음</p>
      </section>

      <section class="term-wrap">
        <h4>Claude Code PTY 세션 <span class="muted">· cwd {{ project?.path }}</span></h4>
        <TerminalView :agent-id="agentId" />
        <p class="muted hint">터미널을 클릭하면 담당 프로젝트 폴더에서 Claude Code 세션이 열려 직접 입력할 수 있습니다. 지시가 배정되면 자동으로 닫히고 실행 출력으로 바뀝니다.</p>
        <template v-if="report?.files.length">
          <h4>이번 작업 변경분 · {{ report.files.length }}개 파일 (+{{ report.diffStat.insertions }} / -{{ report.diffStat.deletions }})</h4>
          <DiffView :diff="report.diff" />
        </template>
      </section>
    </div>
  </BaseModal>
</template>

<style scoped lang="scss">
.grid {
  display: grid;
  grid-template-columns: 320px 1fr;
  gap: 18px;
}
@media (max-width: 900px) {
  .grid {
    grid-template-columns: 1fr;
  }
}
h4 {
  margin: 14px 0 8px;
  font-size: 13px;
  &:first-child {
    margin-top: 0;
  }
}
.kv {
  display: grid;
  grid-template-columns: 72px 1fr;
  gap: 6px 10px;
  align-items: center;
  font-size: 13px;
}
.files {
  margin: 8px 0 0;
  padding: 8px 10px;
  list-style: none;
  font-size: 12px;
  background: rgba(0, 0, 0, 0.2);
  border-radius: 8px;
  b {
    color: var(--info);
    display: inline-block;
    width: 22px;
  }
}
.checks {
  display: flex;
  gap: 6px;
  flex-wrap: wrap;
  .check {
    font-size: 12px;
    padding: 3px 8px;
    border-radius: 6px;
    background: rgba(52, 199, 89, 0.12);
    color: var(--ok);
    &.fail {
      background: rgba(255, 69, 58, 0.12);
      color: var(--err);
    }
  }
}
.log {
  margin: 0 0 8px;
  max-height: 180px;
  padding: 8px 10px;
  background: #0d1117;
  border-radius: 8px;
  font-size: 11.5px;
  white-space: pre-wrap;
  color: #ffb4ab;
}
.link {
  border: 0;
  background: none;
  padding: 0;
  color: var(--info);
  font-size: 12px;
  margin-bottom: 8px;
}
p {
  margin: 0 0 8px;
}
.hint {
  font-size: 12px;
  margin-top: 6px;
}
</style>
