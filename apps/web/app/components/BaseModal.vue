<script setup lang="ts">
defineProps<{ title: string; subtitle?: string; wide?: boolean }>()
const emit = defineEmits<{ close: [] }>()
const onKey = (e: KeyboardEvent) => e.key === 'Escape' && emit('close')
onMounted(() => window.addEventListener('keydown', onKey))
onBeforeUnmount(() => window.removeEventListener('keydown', onKey))
</script>

<template>
  <div class="backdrop" @click.self="emit('close')">
    <section class="modal panel" :class="{ wide }" role="dialog" :aria-label="title">
      <header>
        <div>
          <h2>{{ title }}</h2>
          <div v-if="subtitle" class="muted sub">{{ subtitle }}</div>
        </div>
        <slot name="actions" />
        <button class="close" aria-label="닫기" @click="emit('close')">✕</button>
      </header>
      <div class="body scroll">
        <slot />
      </div>
      <footer v-if="$slots.footer" class="foot">
        <slot name="footer" />
      </footer>
    </section>
  </div>
</template>

<style scoped lang="scss">
.backdrop {
  position: fixed;
  inset: 0;
  background: rgba(5, 8, 15, 0.55);
  display: grid;
  place-items: center;
  z-index: 50;
  padding: 24px;
}
.modal {
  width: min(960px, 100%);
  max-height: calc(100vh - 48px);
  display: flex;
  flex-direction: column;
  background: var(--panel-solid);
  &.wide {
    width: min(1440px, 100%);
  }
}
header {
  display: flex;
  align-items: flex-start;
  gap: 12px;
  padding: 16px 18px 12px;
  border-bottom: 1px solid var(--line);
  > div:first-child {
    flex: 1;
  }
  h2 {
    font-size: 18px;
  }
  .sub {
    margin-top: 3px;
    font-size: 12px;
  }
}
.body {
  padding: 16px 18px 18px;
}
.foot {
  display: flex;
  align-items: center;
  justify-content: flex-end;
  gap: 10px;
  padding: 12px 18px;
  border-top: 1px solid var(--line);
}
</style>
