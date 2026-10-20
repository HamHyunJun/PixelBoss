<script setup lang="ts">
// 프로젝트 관리: 등록된 프로젝트 확인·삭제, 경로 붙여넣기 또는 폴더 탐색으로 추가
const emit = defineEmits<{ close: [] }>()
const { state, listDir, addProject, removeProject } = useHQ()

const path = ref('')
const name = ref('')
const confirmId = ref<string | undefined>()

const locked = computed(() => state.phase !== 'idle')
const registered = computed(() => new Set(state.projects.map((p) => p.path)))
const crumbs = computed(() => {
  const parts = (state.fs?.path ?? '').split('/').filter(Boolean)
  return parts.map((label, i) => ({ label, path: '/' + parts.slice(0, i + 1).join('/') }))
})

const HEALTH: Record<string, { label: string; cls: string }> = {
  clean: { label: '정상', cls: 'ok' },
  changed: { label: '변경 있음', cls: 'info' },
  error: { label: '오류', cls: 'err' },
}

const submit = (): void => {
  if (!path.value.trim() || locked.value) return
  addProject(path.value, name.value)
}

const pick = (p: string): void => {
  path.value = p
}

const askRemove = (id: string): void => {
  if (confirmId.value === id) {
    removeProject(id)
    confirmId.value = undefined
    return
  }
  confirmId.value = id
  setTimeout(() => confirmId.value === id && (confirmId.value = undefined), 3000)
}

onMounted(() => listDir())

// 추가에 성공하면(목록이 늘면) 입력을 비우고 탐색기의 '등록됨' 표시를 갱신
watch(
  () => state.projects.length,
  (n, prev) => {
    if (n > prev) {
      path.value = ''
      name.value = ''
    }
  },
)
</script>

<template>
  <BaseModal title="프로젝트 관리" :subtitle="`등록 ${state.projects.length}개 · 프로젝트가 늘면 책상과 사무실 공간이 함께 커집니다. 지시는 등록된 모든 프로젝트가 대상입니다`" wide @close="emit('close')">
    <p v-if="locked" class="notice" role="status">진행 중인 지시가 끝난 뒤에 프로젝트를 추가·삭제할 수 있습니다.</p>

    <h3>등록된 프로젝트</h3>
    <p v-if="!state.projects.length" class="muted empty">아직 등록된 프로젝트가 없습니다. 아래에서 폴더를 추가하세요.</p>
    <ul v-else class="projects" data-test="project-list">
      <li v-for="p in state.projects" :key="p.id">
        <div class="info">
          <b>{{ p.name }}</b>
          <span class="mono muted path">{{ p.path }}</span>
        </div>
        <span v-if="state.deltas[p.id]" class="health" :class="HEALTH[state.deltas[p.id]!.health]?.cls">{{ HEALTH[state.deltas[p.id]!.health]?.label }}</span>
        <button class="danger" :class="{ armed: confirmId === p.id }" :disabled="locked" :aria-label="`${p.name} 삭제`" @click="askRemove(p.id)">
          {{ confirmId === p.id ? '정말 삭제?' : '삭제' }}
        </button>
      </li>
    </ul>

    <h3>프로젝트 추가</h3>
    <form class="add" @submit.prevent="submit()">
      <label>
        <span>폴더 경로 (붙여넣기)</span>
        <input v-model="path" class="mono" placeholder="/Users/me/work/my-project  또는  ~/work/my-project" spellcheck="false" autocomplete="off" data-test="project-path" />
      </label>
      <label>
        <span>표시 이름 (선택)</span>
        <input v-model="name" placeholder="폴더 이름 사용" autocomplete="off" />
      </label>
      <button class="primary" type="submit" :disabled="!path.trim() || locked || !state.connected" data-test="project-add">추가</button>
    </form>

    <div class="browser">
      <div class="bar">
        <nav class="crumbs" aria-label="현재 폴더">
          <button :disabled="!state.fs" @click="listDir()">🏠</button>
          <template v-for="c in crumbs" :key="c.path">
            <span class="muted" aria-hidden="true">/</span>
            <button @click="listDir(c.path)">{{ c.label }}</button>
          </template>
        </nav>
        <button v-if="state.fs?.parent" title="상위 폴더" @click="listDir(state.fs.parent)">↑ 상위</button>
        <button v-if="state.fs" :disabled="registered.has(state.fs.path)" @click="pick(state.fs.path)">이 폴더 선택</button>
      </div>
      <p v-if="state.fs?.error" class="notice err" role="alert">{{ state.fs.error }}</p>
      <ul v-else class="entries scroll" data-test="fs-list">
        <li v-for="e in state.fs?.entries" :key="e.path">
          <button class="enter" @click="listDir(e.path)">
            <span aria-hidden="true">📁</span>
            <span class="n">{{ e.name }}</span>
            <span v-if="e.isGit" class="tag git">git</span>
            <span v-if="e.hasPackage" class="tag">package.json</span>
          </button>
          <button v-if="registered.has(e.path)" disabled>등록됨</button>
          <button v-else :disabled="!e.isGit" :title="e.isGit ? '이 폴더를 경로 입력란에 넣기' : 'git 저장소(.git)가 있는 폴더만 등록할 수 있습니다'" @click="pick(e.path)">선택</button>
        </li>
        <li v-if="state.fs && !state.fs.entries.length" class="muted empty">하위 폴더가 없습니다</li>
      </ul>
    </div>
  </BaseModal>
</template>

<style scoped lang="scss">
h3 {
  margin: 18px 0 8px;
  font-size: 14px;
  &:first-of-type {
    margin-top: 0;
  }
}
.notice {
  margin: 0 0 12px;
  padding: 8px 12px;
  border-radius: 8px;
  background: rgba(255, 204, 0, 0.1);
  border: 1px solid rgba(255, 204, 0, 0.35);
  font-size: 13px;
  &.err {
    background: rgba(255, 69, 58, 0.1);
    border-color: rgba(255, 69, 58, 0.4);
  }
}
.empty {
  margin: 0;
  padding: 8px 4px;
}
.projects {
  list-style: none;
  margin: 0;
  padding: 0;
  display: grid;
  gap: 6px;
  li {
    display: flex;
    align-items: center;
    gap: 12px;
    padding: 8px 12px;
    border: 1px solid var(--line);
    border-radius: 8px;
    background: rgba(255, 255, 255, 0.03);
  }
  .info {
    flex: 1;
    min-width: 0;
    display: grid;
    gap: 2px;
  }
  .path {
    font-size: 12px;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }
}
.health {
  font-size: 12px;
  padding: 2px 8px;
  border-radius: 999px;
  border: 1px solid currentColor;
  &.ok {
    color: var(--ok);
  }
  &.info {
    color: var(--info);
  }
  &.err {
    color: var(--err);
  }
}
.danger.armed {
  background: var(--err);
  border-color: var(--err);
  color: #fff;
}
.add {
  display: grid;
  grid-template-columns: 1fr 200px auto;
  gap: 10px;
  align-items: end;
  label {
    display: grid;
    gap: 4px;
    font-size: 12px;
    color: var(--muted);
  }
}
input {
  font: inherit;
  color: var(--text);
  background: rgba(0, 0, 0, 0.25);
  border: 1px solid var(--line);
  border-radius: 8px;
  padding: 8px 10px;
  transition: border-color 0.15s, box-shadow 0.15s;
  &:focus-visible {
    outline: none;
    border-color: var(--accent);
    box-shadow: 0 0 0 3px rgba(255, 159, 26, 0.2);
  }
}
button:active:not(:disabled) {
  transform: scale(0.97);
}
button:focus-visible {
  outline: 2px solid var(--accent);
  outline-offset: 2px;
}
.browser {
  margin-top: 14px;
  border: 1px solid var(--line);
  border-radius: 10px;
  overflow: hidden;
}
.bar {
  display: flex;
  align-items: center;
  gap: 8px;
  padding: 8px 10px;
  background: rgba(255, 255, 255, 0.04);
  border-bottom: 1px solid var(--line);
}
.crumbs {
  flex: 1;
  min-width: 0;
  display: flex;
  align-items: center;
  flex-wrap: wrap;
  gap: 2px;
  button {
    padding: 2px 6px;
    border-color: transparent;
    background: transparent;
    font-size: 13px;
  }
}
.entries {
  list-style: none;
  margin: 0;
  padding: 4px;
  max-height: 260px;
  li {
    display: flex;
    align-items: center;
    gap: 8px;
    padding: 2px 4px;
  }
  .enter {
    flex: 1;
    display: flex;
    align-items: center;
    gap: 8px;
    text-align: left;
    border-color: transparent;
    background: transparent;
    min-width: 0;
    &:hover:not(:disabled) {
      background: rgba(255, 255, 255, 0.07);
    }
  }
  .n {
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }
}
.tag {
  font-size: 11px;
  padding: 1px 6px;
  border-radius: 6px;
  background: rgba(255, 255, 255, 0.08);
  color: var(--muted);
  &.git {
    background: rgba(52, 199, 89, 0.15);
    color: var(--ok);
  }
}
@media (prefers-reduced-motion: reduce) {
  button:active:not(:disabled) {
    transform: none;
  }
}
</style>
