<script setup lang="ts">
// 팀장 취합 보고서: 정 가운데 모달에서 결과를 읽고, 프로젝트마다 승인/반려를 따로 정한다
// - 모든 부서의 1차 보고는 한글 '제안'이다: 제안마다 본문을 읽고 '진행'(개발팀이 구현) 또는 '보류'를 따로 고른다 (이 단계에서는 코드·파일이 수정되지 않는다)
// - 진행을 고른 제안을 개발팀이 구현하면 2차 보고서가 오고, 프로젝트별로 diff 를 확인해 '승인 · 커밋' 또는 '반려 (되돌리기)'를 고른다
import { DEPARTMENTS } from '@pixelboss/shared'
import type { ProjectReport } from '@pixelboss/shared'
import report, { type FileDiff } from '~/utils/report'

const emit = defineEmits<{ close: [] }>()
const { state, decide } = useHQ()

interface ReportView {
  r: ProjectReport
  files: FileDiff[]
}

interface ProjectGroup {
  projectId: string
  name: string
  path: string
  items: ReportView[]
  hasChanges: boolean
  hasProposal: boolean
  /** 사용자의 결정이 필요한 프로젝트 */
  needsDecision: boolean
}

const choice = ref<Record<string, boolean | undefined>>({})
const rawOpen = ref(new Set<string>())
const outputOpen = ref(new Set<string>())

const card = computed(() => state.approval!)
const pending = computed(() => !card.value.decided && state.phase === 'awaiting-approval')
const deptName = (id: string): string => DEPARTMENTS.find((d) => d.id === id)?.name ?? id
const deptColor = (id: string): string => DEPARTMENTS.find((d) => d.id === id)?.color ?? '#888'

const groups = computed<ProjectGroup[]>(() => {
  const map = new Map<string, ProjectGroup>()
  for (const r of card.value.reports) {
    const p = state.projects.find((x) => x.id === r.projectId)
    const g = map.get(r.projectId) ?? { projectId: r.projectId, name: p?.name ?? r.projectId, path: p?.path ?? '', items: [], hasChanges: false, hasProposal: false, needsDecision: false }
    g.items.push({ r, files: report.parseDiff(r.diff) })
    g.hasChanges ||= r.files.length > 0
    g.hasProposal ||= r.proposal
    g.needsDecision = g.hasChanges || g.hasProposal
    map.set(r.projectId, g)
  }
  return [...map.values()]
})

/** 결정이 필요한 모든 키: 코드 변경이 있는 프로젝트 id + 제안 id */
const keys = computed(() => groups.value.flatMap((g) => [...(g.hasChanges ? [g.projectId] : []), ...g.items.flatMap((it) => it.r.ideas.map((i) => i.id))]))
const decidedCount = computed(() => keys.value.filter((k) => choice.value[k] !== undefined).length)
const allDecided = computed(() => keys.value.length > 0 && decidedCount.value === keys.value.length)
const total = computed(() =>
  card.value.reports.reduce(
    (s, r) => ({ files: s.files + r.files.length, ins: s.ins + r.diffStat.insertions, del: s.del + r.diffStat.deletions, proposals: s.proposals + r.ideas.length }),
    { files: 0, ins: 0, del: 0, proposals: 0 },
  ),
)
const totalCost = computed<number | undefined>(() => {
  const costs = card.value.reports.flatMap((r) => (r.costUsd === undefined ? [] : [r.costUsd]))
  return costs.length ? costs.reduce((a, b) => a + b, 0) : undefined
})
const hasError = computed(() => card.value.reports.some((r) => r.status === 'error'))

const decisionOf = (key: string): string | undefined => card.value.decisions?.[key]
const groupIdeas = (g: ProjectGroup): string[] => g.items.flatMap((it) => it.r.ideas.map((i) => i.id))

const toggle = (set: Set<string>, key: string): void => {
  if (set.has(key)) set.delete(key)
  else set.add(key)
}
const setAll = (approve: boolean): void => {
  choice.value = Object.fromEntries(keys.value.map((k) => [k, approve]))
}
/** 한 프로젝트의 아이디어를 한꺼번에 진행/보류로 고른다 */
const setIdeas = (g: ProjectGroup, approve: boolean): void => {
  for (const id of groupIdeas(g)) choice.value[id] = approve
}
const apply = (): void => {
  decide(card.value.commandId, Object.fromEntries(keys.value.map((k) => [k, choice.value[k]!])))
  // 진행한 제안은 개발 파이프라인으로 넘어가 진행판에서 이어서 본다 (결과는 📋 보고서로 다시 열 수 있다)
  emit('close')
}

// 새 보고서가 오면 선택을 초기화
watch(
  () => card.value.commandId,
  () => (choice.value = {}),
)
</script>

<template>
  <BaseModal title="팀장 취합 보고서" :subtitle="`“${card.text}” · ${new Date(card.createdAt).toLocaleString()}`" wide @close="emit('close')">
    <template #actions>
      <span class="state" :class="card.decided ? 'done' : 'pending'" data-test="report-state">{{ card.decided ? '✔ 처리 완료' : '⏳ 결정 대기' }}</span>
    </template>

    <div data-test="approval">
      <div class="stats">
        <div class="stat"><b>{{ total.proposals }}</b><span>제안</span></div>
        <div class="stat"><b>{{ total.files }}</b><span>변경 파일</span></div>
        <div class="stat ok"><b>+{{ total.ins }}</b><span>추가 줄</span></div>
        <div class="stat err"><b>-{{ total.del }}</b><span>삭제 줄</span></div>
        <div class="stat"><b>{{ card.skipped.length }}</b><span>생략 (토큰 0)</span></div>
        <div v-if="totalCost !== undefined" class="stat" data-test="report-cost"><b>${{ totalCost.toFixed(2) }}</b><span>이번 실행 비용</span></div>
      </div>

      <p v-if="hasError" class="notice err" role="alert">일부 세션이 오류로 끝났습니다. 아래 에이전트 출력을 확인하세요.</p>
      <p v-if="!groups.length" class="muted empty">이번 지시로 실행된 작업이 없습니다.</p>

      <article v-for="g in groups" :key="g.projectId" class="project" :data-project="g.projectId">
        <header class="phead">
          <div class="ptitle">
            <h3>{{ g.name }}</h3>
            <span class="mono muted path">{{ g.path }}</span>
          </div>
          <template v-if="g.hasChanges">
            <span v-if="decisionOf(g.projectId)" class="badge" :class="decisionOf(g.projectId)">{{ decisionOf(g.projectId) === 'approved' ? '✔ 승인 · 커밋' : '↩ 반려 (되돌리기)' }}</span>
            <div v-else-if="pending" class="seg" role="radiogroup" :aria-label="`${g.name} 코드 변경 결정`">
              <button role="radio" class="no" :class="{ on: choice[g.projectId] === false }" :aria-checked="choice[g.projectId] === false" :data-test="`reject-${g.projectId}`" @click="choice[g.projectId] = false">반려 (되돌리기)</button>
              <button role="radio" class="yes" :class="{ on: choice[g.projectId] === true }" :aria-checked="choice[g.projectId] === true" :data-test="`approve-${g.projectId}`" @click="choice[g.projectId] = true">승인 · 커밋</button>
            </div>
          </template>
          <template v-else-if="groupIdeas(g).length">
            <span v-if="pending" class="quick small">
              <button class="link" @click="setIdeas(g, true)">모두 진행</button>
              <button class="link" @click="setIdeas(g, false)">모두 보류</button>
            </span>
          </template>
          <span v-else class="muted small">결정할 항목 없음</span>
        </header>
        <p v-if="g.hasChanges && pending" class="effect small muted">승인하면 변경을 커밋합니다 (push 하지 않음). 반려하면 에이전트가 바꾼 내용을 되돌립니다.</p>

        <section v-for="it in g.items" :key="it.r.agentId" class="work" :style="{ '--dept': deptColor(it.r.department) }">
          <div class="whead">
            <b class="dept">{{ deptName(it.r.department) }}</b>
            <StatusBadge :status="it.r.status" />
            <span v-if="it.r.exitCode" class="muted small">exit {{ it.r.exitCode }}</span>
            <span v-if="it.r.costUsd !== undefined" class="muted small mono">{{ it.r.turns }}턴 · ${{ it.r.costUsd.toFixed(4) }}</span>
            <span class="grow" />
            <span v-if="it.files.length" class="mono small"><i class="ok">+{{ it.r.diffStat.insertions }}</i> <i class="err">-{{ it.r.diffStat.deletions }}</i> · {{ it.r.files.length }}개 파일</span>
          </div>

          <!-- 기획팀: 아이디어마다 본문을 읽고 진행/보류를 따로 고른다 -->
          <template v-if="it.r.proposal">
            <MarkdownView v-if="it.r.intro" :text="it.r.intro" class="intro" />
            <p class="label">💡 {{ deptName(it.r.department) }}의 제안 {{ it.r.ideas.length }}건 <span class="muted">— 코드·파일은 아직 수정되지 않았습니다. 진행할 제안만 고르면 개발팀이 구현합니다.</span></p>
            <div v-for="(idea, n) in it.r.ideas" :key="idea.id" class="idea" :class="{ yes: choice[idea.id] === true, no: choice[idea.id] === false }" :data-idea="idea.id">
              <div class="ihead">
                <b>제안 {{ n + 1 }}. {{ idea.title }}</b>
                <span class="grow" />
                <span v-if="decisionOf(idea.id)" class="badge sm" :class="decisionOf(idea.id)">{{ decisionOf(idea.id) === 'approved' ? '✔ 개발팀에 진행' : '↩ 보류' }}</span>
                <div v-else-if="pending" class="seg" role="radiogroup" :aria-label="`제안 ${n + 1} 결정`">
                  <button role="radio" class="no" :class="{ on: choice[idea.id] === false }" :aria-checked="choice[idea.id] === false" :data-test="`reject-${idea.id}`" @click="choice[idea.id] = false">보류</button>
                  <button role="radio" class="yes" :class="{ on: choice[idea.id] === true }" :aria-checked="choice[idea.id] === true" :data-test="`approve-${idea.id}`" @click="choice[idea.id] = true">진행</button>
                </div>
              </div>
              <MarkdownView :text="idea.body" data-test="report-idea" />
            </div>
          </template>
          <template v-else-if="it.r.summary">
            <p class="label">📝 에이전트 보고</p>
            <MarkdownView :text="it.r.summary" data-test="report-summary" />
          </template>
          <p v-else-if="!it.files.length" class="muted small">보고 내용과 변경된 파일이 없습니다.</p>

          <div v-for="f in it.files" :key="f.file" class="file">
            <div class="fhead">
              <span class="tag" :class="f.isNew ? 'new' : 'mod'">{{ f.isNew ? '신규' : '수정' }}</span>
              <b class="mono">{{ f.file }}</b>
              <span class="grow" />
              <span class="mono small"><i class="ok">+{{ f.insertions }}</i> <i class="err">-{{ f.deletions }}</i></span>
              <button class="link" @click="toggle(rawOpen, it.r.agentId + f.file)">{{ rawOpen.has(it.r.agentId + f.file) ? '접기' : '전체 diff 보기' }}</button>
            </div>
            <!-- 문서는 이번에 추가된 내용을 읽기 좋게, 코드는 diff 로 보여준다 -->
            <MarkdownView v-if="report.isDoc(f.file)" :lines="f.added" data-test="report-doc" />
            <DiffView v-if="rawOpen.has(it.r.agentId + f.file) || !report.isDoc(f.file)" :diff="f.raw" :max-lines="rawOpen.has(it.r.agentId + f.file) ? 600 : 80" />
          </div>

          <button class="link" @click="toggle(outputOpen, it.r.agentId)">{{ outputOpen.has(it.r.agentId) ? '에이전트 출력 닫기' : '에이전트 출력 보기' }}</button>
          <pre v-if="outputOpen.has(it.r.agentId)" class="out mono scroll">{{ report.tailLines(it.r.outputTail).join('\n') }}</pre>
        </section>
      </article>

      <details v-if="card.skipped.length" class="skipped">
        <summary>건너뛴 작업 {{ card.skipped.length }}건 (정적 필터, LLM 호출 0)</summary>
        <ul>
          <li v-for="t in card.skipped" :key="t.agentId">
            <b>{{ state.projects.find((p) => p.id === t.projectId)?.name ?? t.projectId }}</b>
            <span class="muted"> · {{ deptName(t.department) }} — {{ t.skipped }}</span>
          </li>
        </ul>
      </details>

      <div v-if="card.decisionLog?.length" class="log small">
        <div v-for="l in card.decisionLog" :key="l" class="muted">{{ l }}</div>
      </div>
    </div>

    <template #footer>
      <template v-if="pending">
        <span class="muted small hint">{{ decidedCount }} / {{ keys.length }} 항목 결정됨 — 제안마다 따로 선택할 수 있습니다</span>
        <button data-test="reject-all" @click="setAll(false)">전체 반려·보류</button>
        <button data-test="approve-all" @click="setAll(true)">전체 승인</button>
        <button class="primary" data-test="apply" :disabled="!allDecided" @click="apply()">결정 적용</button>
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
  &.pending {
    color: var(--accent);
  }
  &.done {
    color: var(--ok);
  }
}
.stats {
  display: grid;
  grid-template-columns: repeat(auto-fit, minmax(110px, 1fr));
  gap: 10px;
  margin-bottom: 14px;
}
.stat {
  display: grid;
  gap: 2px;
  padding: 10px 12px;
  border: 1px solid var(--line);
  border-radius: 10px;
  background: rgba(255, 255, 255, 0.03);
  b {
    font-size: 20px;
  }
  span {
    font-size: 12px;
    color: var(--muted);
  }
  &.ok b {
    color: var(--ok);
  }
  &.err b {
    color: var(--err);
  }
}
.notice {
  margin: 0 0 12px;
  padding: 8px 12px;
  border-radius: 8px;
  background: rgba(255, 69, 58, 0.1);
  border: 1px solid rgba(255, 69, 58, 0.4);
  font-size: 13px;
}
.empty {
  padding: 8px 4px;
}
.project {
  margin-bottom: 22px;
}
.phead {
  display: flex;
  align-items: center;
  gap: 12px;
  margin-bottom: 6px;
}
.ptitle {
  flex: 1;
  min-width: 0;
  display: flex;
  align-items: baseline;
  gap: 10px;
  h3 {
    font-size: 17px;
  }
  .path {
    font-size: 12px;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }
}
.effect {
  margin: 0 0 8px;
}
.quick {
  display: flex;
  gap: 4px;
}
.intro {
  margin-bottom: 8px;
}
.idea {
  margin: 10px 0;
  padding: 10px 12px;
  border: 1px solid var(--line);
  border-radius: 10px;
  background: rgba(255, 255, 255, 0.02);
  transition: border-color 0.15s, background 0.15s, opacity 0.15s;
  &.yes {
    border-color: var(--accent);
    background: rgba(255, 159, 26, 0.06);
  }
  &.no {
    opacity: 0.55;
  }
}
.ihead {
  display: flex;
  align-items: center;
  gap: 10px;
  margin-bottom: 8px;
  b {
    font-size: 14px;
  }
}
.seg {
  display: flex;
  button {
    border-radius: 0;
    padding: 6px 14px;
    transition: background 0.15s, border-color 0.15s, color 0.15s, transform 0.1s;
    &:first-child {
      border-radius: 8px 0 0 8px;
    }
    &:last-child {
      border-radius: 0 8px 8px 0;
      margin-left: -1px;
    }
    &:active {
      transform: scale(0.97);
    }
    &.no.on {
      background: rgba(255, 69, 58, 0.4);
      border-color: var(--err);
      color: #fff;
      font-weight: 700;
    }
    &.yes.on {
      background: var(--accent);
      border-color: var(--accent);
      color: #1d1300;
      font-weight: 700;
    }
  }
}
.badge {
  &.sm {
    font-size: 12px;
    padding: 2px 10px;
  }
  font-size: 13px;
  font-weight: 700;
  padding: 4px 12px;
  border-radius: 999px;
  border: 1px solid currentColor;
  &.approved {
    color: var(--ok);
  }
  &.rejected {
    color: var(--err);
  }
}
.work {
  margin-bottom: 10px;
  padding: 12px 14px;
  border: 1px solid var(--line);
  border-left: 3px solid var(--dept);
  border-radius: 10px;
  background: rgba(255, 255, 255, 0.025);
}
.whead,
.fhead {
  display: flex;
  align-items: center;
  gap: 10px;
}
.label {
  margin: 10px 0 6px;
  font-size: 13px;
  font-weight: 700;
}
.dept {
  color: var(--dept);
}
.grow {
  flex: 1;
}
.small {
  font-size: 12px;
}
.file {
  margin: 10px 0;
}
.fhead {
  margin-bottom: 6px;
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
.out {
  margin: 6px 0 0;
  max-height: 240px;
  padding: 8px 10px;
  font-size: 12px;
  line-height: 1.5;
  white-space: pre-wrap;
  background: #0d1117;
  border: 1px solid var(--line);
  border-radius: 8px;
}
.skipped {
  margin-top: 8px;
  font-size: 13px;
  summary {
    cursor: pointer;
    color: var(--muted);
  }
  ul {
    margin: 8px 0 0;
    padding-left: 18px;
  }
}
.log {
  margin-top: 12px;
  padding: 10px 12px;
  border-radius: 8px;
  background: rgba(255, 255, 255, 0.04);
}
.hint {
  margin-right: auto;
}
@media (max-width: 900px) {
  .stats {
    grid-template-columns: repeat(2, 1fr);
  }
}
</style>
