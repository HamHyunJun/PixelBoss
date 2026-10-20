<script setup lang="ts">
// 스케줄: 정해진 요일·시각에 자동으로 지시를 내려 보고서를 받는다 (읽기 전용 제안 보고서라 자리를 비워도 파일이 바뀌지 않는다)
import { DEPARTMENTS } from '@pixelboss/shared'
import type { DepartmentId } from '@pixelboss/shared'

const emit = defineEmits<{ close: [] }>()
const { state, saveSchedule, removeSchedule, runSchedule } = useHQ()

const DAYS = ['일', '월', '화', '수', '목', '금', '토']

const name = ref('')
const time = ref('09:00')
const days = ref<number[]>([1, 2, 3, 4, 5])
const text = ref('')
const dept = ref<DepartmentId | ''>('')
const confirmId = ref<string | undefined>()

const busy = computed(() => state.phase !== 'idle')
const real = computed(() => state.runnerMode === 'claude')
const valid = computed(() => !!text.value.trim() && !!time.value && days.value.length > 0)

const toggleDay = (d: number): void => {
  days.value = days.value.includes(d) ? days.value.filter((x) => x !== d) : [...days.value, d].sort()
}
const setDays = (next: number[]): void => {
  days.value = next
}
const dayLabel = (ds: number[]): string => (ds.length === 7 ? '매일' : ds.join() === '1,2,3,4,5' ? '평일' : ds.map((d) => DAYS[d]).join(' '))
const deptLabel = (ids: DepartmentId[]): string => (ids.length ? ids.map((i) => DEPARTMENTS.find((d) => d.id === i)?.name.split(' ')[0]).join(' · ') : '자동 선택(전체)')
const when = (ms?: number): string => (ms ? new Date(ms).toLocaleString('ko-KR', { month: 'numeric', day: 'numeric', weekday: 'short', hour: '2-digit', minute: '2-digit' }) : '-')

const add = (): void => {
  if (!valid.value) return
  saveSchedule({ name: name.value, time: time.value, days: days.value, text: text.value, departments: dept.value ? [dept.value] : [], enabled: true })
  name.value = ''
  text.value = ''
}
const toggle = (s: (typeof state.schedules)[number]): void => {
  saveSchedule({ ...s, enabled: !s.enabled })
}
const askRemove = (id: string): void => {
  if (confirmId.value === id) {
    removeSchedule(id)
    confirmId.value = undefined
    return
  }
  confirmId.value = id
  setTimeout(() => confirmId.value === id && (confirmId.value = undefined), 3000)
}
</script>

<template>
  <BaseModal title="스케줄" subtitle="정해진 시각에 자동으로 지시를 내려 보고서를 받습니다. 결정은 돌아와서 직접 합니다" wide @close="emit('close')">
    <p class="notice" :class="{ warn: real }" role="status">
      <template v-if="real">현재 <b>실제 Claude Code</b> 모드입니다. 스케줄이 실행될 때마다 토큰을 씁니다. 지시에 <code>강제</code>를 넣지 않으면 변경이 있는 프로젝트만 대상이 됩니다.</template>
      <template v-else>현재 <b>Mock 실행기</b> 모드라 비용은 들지 않지만 간단한 규칙 점검 결과만 나옵니다. 실제 제안을 받으려면 상단 실행기 버튼을 Claude Code 로 바꾸세요.</template>
    </p>
    <p class="notice" role="status">
      <template v-if="state.keepAwake">✔ 스케줄이 켜져 있는 동안 맥의 잠자기를 막고 있습니다. 화면 잠금은 <code>Ctrl+Cmd+Q</code>로 하세요 (전원 버튼은 잠자기라 서버가 멈춥니다). 덮개를 닫으면 소용없습니다.</template>
      <template v-else>켜진 스케줄이 없습니다. 스케줄을 켜면 맥의 잠자기를 막습니다.</template>
    </p>

    <h3>등록된 스케줄</h3>
    <p v-if="!state.schedules.length" class="muted empty">아직 스케줄이 없습니다. 아래에서 추가하세요.</p>
    <ul v-else class="list" data-test="schedule-list">
      <li v-for="s in state.schedules" :key="s.id" :class="{ off: !s.enabled }">
        <label class="sw" :title="s.enabled ? '끄기' : '켜기'">
          <input type="checkbox" :checked="s.enabled" :aria-label="`${s.name} 사용`" @change="toggle(s)" />
          <span />
        </label>
        <div class="info">
          <b>{{ s.name }}</b>
          <span class="meta mono">{{ s.time }} · {{ dayLabel(s.days) }} · {{ deptLabel(s.departments) }}</span>
          <span class="cmd">“{{ s.text }}”</span>
          <span class="muted small">
            <template v-if="s.enabled">다음 실행 {{ when(s.nextRunAt) }}</template>
            <template v-else>꺼짐</template>
            <template v-if="s.lastStatus"> · 최근: {{ s.lastStatus }}</template>
            <template v-if="s.lastRunAt"> ({{ when(s.lastRunAt) }})</template>
          </span>
        </div>
        <button :disabled="busy" title="시각과 상관없이 지금 한 번 실행" @click="runSchedule(s.id)">지금 실행</button>
        <button class="danger" :class="{ armed: confirmId === s.id }" :aria-label="`${s.name} 삭제`" @click="askRemove(s.id)">{{ confirmId === s.id ? '정말 삭제?' : '삭제' }}</button>
      </li>
    </ul>

    <h3>스케줄 추가</h3>
    <form class="add" @submit.prevent="add()">
      <label class="w-time"><span>시각</span><input v-model="time" type="time" required data-test="sch-time" /></label>
      <fieldset class="days">
        <legend>요일</legend>
        <button v-for="(l, d) in DAYS" :key="d" type="button" class="day" :class="{ on: days.includes(d) }" :aria-pressed="days.includes(d)" @click="toggleDay(d)">{{ l }}</button>
        <button type="button" class="link" @click="setDays([1, 2, 3, 4, 5])">평일</button>
        <button type="button" class="link" @click="setDays([0, 1, 2, 3, 4, 5, 6])">매일</button>
      </fieldset>
      <label class="w-dept">
        <span>호출 부서</span>
        <select v-model="dept" data-test="sch-dept">
          <option value="">자동 선택(전체)</option>
          <option v-for="d in DEPARTMENTS" :key="d.id" :value="d.id">{{ d.name }}</option>
        </select>
      </label>
      <label class="w-text"><span>지시 내용</span><input v-model="text" placeholder="예: 이번 주 변경분의 타입 에러와 린트 오류를 점검해 변경안을 보고" maxlength="500" data-test="sch-text" /></label>
      <label class="w-name"><span>이름 (선택)</span><input v-model="name" placeholder="예: 아침 점검" maxlength="40" /></label>
      <button class="primary" type="submit" :disabled="!valid || !state.connected" data-test="sch-add">추가</button>
    </form>
    <p class="muted small hint">
      서버가 꺼져 있거나 잠자기였다가 예정 시각 6시간 안에 깨어나면 한 번 따라잡아 실행합니다. 이전 보고서가 승인 대기 중이면 처리된 뒤 실행합니다.
      보고서가 도착하면 macOS 알림이 뜹니다.
    </p>
  </BaseModal>
</template>

<style scoped lang="scss">
h3 {
  margin: 18px 0 8px;
  font-size: 14px;
}
.notice {
  margin: 0 0 10px;
  padding: 8px 12px;
  border-radius: 8px;
  font-size: 13px;
  line-height: 1.55;
  background: rgba(255, 255, 255, 0.05);
  border: 1px solid var(--line);
  &.warn {
    background: rgba(255, 204, 0, 0.1);
    border-color: rgba(255, 204, 0, 0.35);
  }
  code {
    font-family: var(--mono);
    padding: 1px 5px;
    border-radius: 4px;
    background: rgba(255, 255, 255, 0.1);
  }
}
.empty {
  margin: 0;
  padding: 6px 4px;
}
.small {
  font-size: 12px;
}
.list {
  list-style: none;
  margin: 0;
  padding: 0;
  display: grid;
  gap: 8px;
  li {
    display: flex;
    align-items: center;
    gap: 12px;
    padding: 10px 12px;
    border: 1px solid var(--line);
    border-radius: 10px;
    background: rgba(255, 255, 255, 0.03);
    transition: opacity 0.15s;
    &.off {
      opacity: 0.6;
    }
  }
  .info {
    flex: 1;
    min-width: 0;
    display: grid;
    gap: 2px;
  }
  .meta {
    font-size: 12px;
    color: var(--accent);
  }
  .cmd {
    font-size: 13px;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }
}
.sw {
  position: relative;
  width: 40px;
  height: 22px;
  flex: none;
  input {
    position: absolute;
    inset: 0;
    opacity: 0;
    cursor: pointer;
    margin: 0;
    z-index: 1;
  }
  span {
    position: absolute;
    inset: 0;
    border-radius: 999px;
    background: rgba(255, 255, 255, 0.18);
    transition: background 0.2s;
    &::after {
      content: '';
      position: absolute;
      top: 3px;
      left: 3px;
      width: 16px;
      height: 16px;
      border-radius: 50%;
      background: #fff;
      transition: transform 0.2s cubic-bezier(0.3, 1.4, 0.5, 1);
    }
  }
  input:checked + span {
    background: var(--ok);
    &::after {
      transform: translateX(18px);
    }
  }
  input:focus-visible + span {
    outline: 2px solid var(--accent);
    outline-offset: 2px;
  }
}
.danger.armed {
  background: var(--err);
  border-color: var(--err);
  color: #fff;
}
.add {
  display: grid;
  grid-template-columns: 130px 1fr 200px;
  gap: 10px 12px;
  align-items: end;
  label,
  fieldset {
    display: grid;
    gap: 4px;
    font-size: 12px;
    color: var(--muted);
    margin: 0;
    padding: 0;
    border: 0;
    min-width: 0;
  }
  .days {
    display: flex;
    flex-wrap: wrap;
    align-items: center;
    gap: 6px;
    legend {
      float: left;
      width: 100%;
      padding: 0;
      margin-bottom: 4px;
    }
  }
  .w-text {
    grid-column: 1 / 3;
  }
  .w-name {
    grid-column: 3;
  }
  > .primary {
    grid-column: 3;
  }
}
.day {
  width: 34px;
  padding: 6px 0;
  text-align: center;
  border-radius: 8px;
  transition: background 0.15s, border-color 0.15s, transform 0.1s;
  &.on {
    background: rgba(255, 159, 26, 0.2);
    border-color: var(--accent);
    color: var(--text);
    font-weight: 700;
  }
  &:active {
    transform: scale(0.94);
  }
}
.link {
  border: 0;
  background: transparent;
  color: var(--info);
  padding: 2px 6px;
  font-size: 12px;
}
input,
select {
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
select option {
  background: var(--panel-solid);
}
.sw input {
  padding: 0;
  border: 0;
  background: transparent;
}
.hint {
  margin-top: 12px;
  line-height: 1.6;
}
</style>
