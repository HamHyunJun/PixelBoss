<script setup lang="ts">
// 문서팀 히스토리: 파이프라인마다 남은 진행 기록(PixelBoss 쪽 .data/history)을 목록으로 보고 읽는다
const emit = defineEmits<{ close: [] }>()
const { state, listHistory, readHistory } = useHQ()

const selected = ref<string | undefined>()
const projectName = (id: string): string => state.projects.find((p) => p.id === id)?.name ?? id

const open = (id: string): void => {
  selected.value = id
  readHistory(id)
}

onMounted(() => listHistory())
</script>

<template>
  <BaseModal title="작업 히스토리" subtitle="문서팀이 파이프라인마다 남긴 기록입니다 (PixelBoss 안에만 저장되고 프로젝트 폴더에는 쓰지 않습니다)" wide @close="emit('close')">
    <p v-if="!state.history.length" class="muted empty">아직 기록이 없습니다. 승인한 제안의 개발 파이프라인이 끝나면 여기에 쌓입니다.</p>
    <div v-else class="grid">
      <ul class="list scroll" data-test="history-list">
        <li v-for="h in state.history" :key="h.id">
          <button :class="{ on: selected === h.id }" @click="open(h.id)">
            <b>{{ projectName(h.projectId) }}</b>
            <span class="muted small">{{ h.date }} · {{ h.result }}</span>
            <span class="t">{{ h.title.replace(/ — .*$/, '') }}</span>
          </button>
        </li>
      </ul>
      <div class="doc scroll" data-test="history-doc">
        <MarkdownView v-if="selected && state.historyDoc?.id === selected" :text="state.historyDoc.markdown" />
        <p v-else class="muted empty">왼쪽에서 기록을 선택하세요.</p>
      </div>
    </div>
  </BaseModal>
</template>

<style scoped lang="scss">
.empty {
  padding: 8px 4px;
}
.grid {
  display: grid;
  grid-template-columns: 300px 1fr;
  gap: 16px;
  min-height: 420px;
}
.list {
  list-style: none;
  margin: 0;
  padding: 0;
  display: grid;
  gap: 6px;
  align-content: start;
  max-height: 60vh;
  button {
    width: 100%;
    display: grid;
    gap: 2px;
    text-align: left;
    padding: 8px 10px;
    border-radius: 10px;
    transition: border-color 0.15s, background 0.15s;
    &.on {
      border-color: var(--accent);
      background: rgba(255, 159, 26, 0.1);
    }
  }
  .t {
    font-size: 13px;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }
}
.small {
  font-size: 12px;
}
.doc {
  max-height: 60vh;
}
@media (max-width: 900px) {
  .grid {
    grid-template-columns: 1fr;
  }
}
</style>
