<script setup lang="ts">
// 이슈 보고: 에러·진행상 문제를 한곳에서 확인한다. 담당 직원을 일일이 눌러볼 필요 없이 팀장이 올린 보고(게시판 / 대표)를 모아 보여준다
import { DEPARTMENTS, workerId } from '@pixelboss/shared'
import type { IssueInfo } from '@pixelboss/shared'

const emit = defineEmits<{ close: []; openAgent: [agentId: string] }>()
const { state, ackIssue } = useHQ()

const open = ref(new Set<string>())

const bySeverity = (a: IssueInfo, b: IssueInfo): number => (a.severity === b.severity ? b.at - a.at : a.severity === 'error' ? -1 : 1)
const needs = computed(() => state.issues.filter((i) => i.status === 'open').sort(bySeverity))
const acked = computed(() => state.issues.filter((i) => i.status === 'acknowledged').sort(bySeverity))
const resolved = computed(() => state.issues.filter((i) => i.status === 'resolved').sort((a, b) => b.at - a.at).slice(0, 8))

const projectName = (id: string): string => state.projects.find((p) => p.id === id)?.name ?? id
const deptName = (id: string): string => DEPARTMENTS.find((d) => d.id === id)?.name ?? id
const time = (t: number): string => new Date(t).toLocaleString('ko-KR', { month: 'numeric', day: 'numeric', hour: '2-digit', minute: '2-digit' })
const toggle = (id: string): void => {
  if (open.value.has(id)) open.value.delete(id)
  else open.value.add(id)
}
const hasAgent = (i: IssueInfo): boolean => !!state.agents[workerId(i.department, i.projectId)]
</script>

<template>
  <BaseModal title="이슈 보고" subtitle="담당자가 팀장에게 올린 에러·문제입니다. 에러는 팀장이 대표에게 직접 보고하고, 경고는 리포트 게시판에 게시합니다" wide @close="emit('close')">
    <p v-if="!needs.length && !acked.length" class="ok-note" role="status">✔ 확인할 이슈가 없습니다.</p>

    <section v-if="needs.length">
      <h3>확인 필요 <span class="count">{{ needs.length }}</span></h3>
      <article v-for="i in needs" :key="i.id" class="card" :class="i.severity" :data-issue="i.id">
        <header>
          <span class="sev" :class="i.severity">{{ i.severity === 'error' ? '에러' : '경고' }}</span>
          <b>{{ i.title }}</b>
        </header>
        <p class="meta muted small">
          {{ projectName(i.projectId) }} · {{ deptName(i.department) }} · {{ time(i.at) }} ·
          <span class="route">{{ i.route === 'ceo' ? '👔 팀장이 대표에게 보고' : '📋 팀장이 게시판에 게시' }}</span>
        </p>
        <pre v-if="i.detail" class="detail mono scroll" :class="{ short: !open.has(i.id) }">{{ i.detail }}</pre>
        <div class="actions">
          <button v-if="i.detail.length > 240" class="link" @click="toggle(i.id)">{{ open.has(i.id) ? '접기' : '전체 보기' }}</button>
          <span class="grow" />
          <button v-if="hasAgent(i)" @click="emit('openAgent', workerId(i.department, i.projectId))">담당자 보기</button>
          <button class="primary" :data-test="`ack-${i.id}`" @click="ackIssue(i.id, true)">확인함</button>
        </div>
      </article>
    </section>

    <section v-if="acked.length">
      <h3>확인함 <span class="count">{{ acked.length }}</span> <span class="muted small">— 문제가 해결되면 자동으로 사라집니다</span></h3>
      <article v-for="i in acked" :key="i.id" class="card done">
        <header>
          <span class="sev" :class="i.severity">{{ i.severity === 'error' ? '에러' : '경고' }}</span>
          <b>{{ i.title }}</b>
          <span class="grow" />
          <button class="link" @click="ackIssue(i.id, false)">다시 열기</button>
        </header>
      </article>
    </section>

    <section v-if="resolved.length">
      <h3>최근 해결됨</h3>
      <ul class="resolved">
        <li v-for="i in resolved" :key="i.id" class="muted small">✔ {{ i.title }} · {{ time(i.at) }}</li>
      </ul>
    </section>
  </BaseModal>
</template>

<style scoped lang="scss">
h3 {
  margin: 16px 0 8px;
  font-size: 14px;
  &:first-of-type {
    margin-top: 0;
  }
}
.count {
  font-size: 12px;
  padding: 1px 8px;
  border-radius: 999px;
  background: rgba(255, 255, 255, 0.1);
}
.ok-note {
  padding: 12px;
  border-radius: 10px;
  color: var(--ok);
  background: rgba(52, 199, 89, 0.08);
  border: 1px solid rgba(52, 199, 89, 0.3);
}
.small {
  font-size: 12px;
}
.card {
  margin-bottom: 10px;
  padding: 12px 14px;
  border: 1px solid var(--line);
  border-left: 3px solid var(--warn);
  border-radius: 10px;
  background: rgba(255, 255, 255, 0.03);
  &.error {
    border-left-color: var(--err);
    background: rgba(255, 69, 58, 0.05);
  }
  &.done {
    opacity: 0.65;
    padding: 8px 12px;
  }
  header {
    display: flex;
    align-items: center;
    gap: 10px;
    b {
      font-size: 14px;
    }
  }
}
.sev {
  font-size: 11px;
  font-weight: 700;
  padding: 1px 8px;
  border-radius: 999px;
  &.error {
    background: var(--err);
    color: #fff;
  }
  &.warn {
    background: var(--warn);
    color: #2a2000;
  }
}
.meta {
  margin: 6px 0;
}
.route {
  color: var(--info);
}
.detail {
  margin: 6px 0;
  padding: 8px 10px;
  font-size: 12px;
  line-height: 1.5;
  white-space: pre-wrap;
  word-break: break-word;
  background: #0d1117;
  border: 1px solid var(--line);
  border-radius: 8px;
  &.short {
    max-height: 96px;
    overflow: hidden;
  }
}
.actions {
  display: flex;
  align-items: center;
  gap: 8px;
}
.grow {
  flex: 1;
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
.resolved {
  list-style: none;
  margin: 0;
  padding: 0;
  display: grid;
  gap: 4px;
}
</style>
