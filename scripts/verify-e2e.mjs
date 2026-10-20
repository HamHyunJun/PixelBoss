#!/usr/bin/env node
// 통합 검증 스크립트 (백엔드 흐름)
// 가상 프로젝트 6개 생성 → 서버 기동 → 정적 필터 확인 → 전체 소집 → PTY 병렬 실행 → 승인/반려 → 결과 확인
// 사용법: pnpm verify            (서버를 직접 띄움, mock 실행기)
//        PIXELBOSS_URL=ws://127.0.0.1:4100/ws pnpm verify   (이미 떠 있는 pnpm dev 서버에 접속)
import { execFileSync, spawn } from 'node:child_process'
import { existsSync, readFileSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const fixtures = join(root, 'fixtures')
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
let failures = 0
const ok = (cond, label) => {
  console.log(`${cond ? '  ✔' : '  ✖'} ${label}`)
  if (!cond) failures++
}

let server
let url = process.env.PIXELBOSS_URL
if (!url) {
  execFileSync(process.execPath, [join(root, 'scripts/make-fixtures.mjs')], { stdio: 'inherit' })
  execFileSync('rm', ['-rf', join(root, '.data')])
  const port = 4199
  url = `ws://127.0.0.1:${port}/ws`
  server = spawn('pnpm', ['--filter', '@pixelboss/server', 'start'], {
    cwd: root,
    env: { ...process.env, PIXELBOSS_PORT: String(port), PIXELBOSS_FAST: '1', PIXELBOSS_MOCK_SPEED: '4', PIXELBOSS_RUNNER: process.env.PIXELBOSS_RUNNER ?? 'mock' },
    stdio: ['ignore', 'pipe', 'inherit'],
    detached: true,
  })
  server.stdout.on('data', (d) => process.env.VERBOSE && process.stdout.write(d))
  for (let i = 0; i < 60; i++) {
    try {
      const r = await fetch(`http://127.0.0.1:${port}/api/health`)
      if (r.ok) break
    } catch {}
    await sleep(250)
  }
}

const ws = new WebSocket(url)
const state = { agents: new Map(), deltas: {}, phase: 'idle', plan: null, approval: null, phases: [], transitions: new Map() }
const waiters = []
ws.onmessage = (ev) => {
  const m = JSON.parse(ev.data)
  if (m.type === 'snapshot') {
    for (const a of m.data.agents) state.agents.set(a.id, a)
    state.deltas = m.data.deltas
    state.phase = m.data.phase
  } else if (m.type === 'agent') {
    state.agents.set(m.agent.id, m.agent)
    const t = state.transitions.get(m.agent.id) ?? []
    if (t.at(-1) !== m.agent.status) t.push(m.agent.status)
    state.transitions.set(m.agent.id, t)
  } else if (m.type === 'delta') state.deltas[m.delta.projectId] = m.delta
  else if (m.type === 'phase') {
    state.phase = m.phase
    state.phases.push(m.phase)
  } else if (m.type === 'plan') state.plan = m.plan
  else if (m.type === 'approval') state.approval = m.approval
  for (const w of [...waiters]) if (w.pred()) (waiters.splice(waiters.indexOf(w), 1), w.resolve())
}
const until = (pred, ms = 60000, label = '') =>
  new Promise((resolve, reject) => {
    if (pred()) return resolve()
    const w = { pred, resolve }
    waiters.push(w)
    setTimeout(() => reject(new Error(`시간 초과: ${label}`)), ms)
  })
const send = (m) => ws.send(JSON.stringify(m))
await new Promise((r) => (ws.onopen = r))

const finish = (code) => {
  ws.close()
  // pnpm → tsx → node 프로세스 트리 전체 종료
  if (server) try { process.kill(-server.pid, 'SIGTERM') } catch {}
  process.exit(code)
}

try {
  console.log('\n[1] 1차 정적 필터 (git status/diff + 검사 명령)')
  await until(() => Object.keys(state.deltas).length === 6, 30000, '초기 스캔')
  const h = (id) => state.deltas[id]?.health
  ok(state.agents.size === 28, `에이전트 28명 (부서 4 × (실무 6 + 팀장 1)) → ${state.agents.size}`)
  ok(h('shop-web') === 'error', `shop-web: error (타입/린트) → ${h('shop-web')}`)
  ok(h('admin-api') === 'error', `admin-api: error (테스트) → ${h('admin-api')}`)
  ok(h('mobile-app') === 'clean', `mobile-app: clean → ${h('mobile-app')}`)
  ok(h('data-pipeline') === 'changed', `data-pipeline: changed → ${h('data-pipeline')}`)
  ok(h('design-system') === 'clean', `design-system: clean → ${h('design-system')}`)
  ok(h('landing-page') === 'error', `landing-page: error (린트) → ${h('landing-page')}`)

  console.log('\n[2] 전체 소집: "버그 픽스 및 접근성 표준 검사 적용"')
  state.phases = []
  send({ type: 'command', text: '버그 픽스 및 접근성 표준 검사 적용' })
  await until(() => state.phase === 'awaiting-approval' || (state.phases.length > 2 && state.phase === 'idle'), 120000, '승인 카드')
  ok(
    JSON.stringify(state.phases) === JSON.stringify(['assembling', 'planning', 'dispatching', 'working', 'reviewing', 'awaiting-approval']),
    `단계 순서: ${state.phases.join(' → ')}`,
  )
  const active = state.plan.tasks.filter((t) => !t.skipped).map((t) => t.projectId)
  const skipped = state.plan.tasks.filter((t) => t.skipped).map((t) => t.projectId)
  ok(state.plan.departments.join() === 'qa', `분해 부서: ${state.plan.departments.join(', ')}`)
  ok(active.sort().join() === 'admin-api,data-pipeline,landing-page,shop-web', `실행 대상: ${active.join(', ')}`)
  ok(skipped.sort().join() === 'design-system,mobile-app', `LLM 호출 0 으로 건너뜀: ${skipped.join(', ')}`)
  for (const p of active) {
    const t = state.transitions.get(`qa:${p}`) ?? []
    ok(t.includes('running') && t.at(-1) === 'done', `qa:${p} PTY 상태 전이: ${t.join(' → ')}`)
  }
  for (const p of skipped) ok(!state.transitions.get(`qa:${p}`)?.includes('running'), `qa:${p} PTY 미실행`)
  const lt = state.transitions.get('qa:leader') ?? []
  ok(lt.includes('running') && lt.at(-1) === 'done', `QA 팀장 집계 상태: ${lt.join(' → ')}`)
  const reports = state.approval.reports
  const changed = reports.filter((r) => r.files.length).map((r) => r.projectId).sort()
  ok(changed.join() === 'admin-api,landing-page,shop-web', `diff 가 있는 리포트: ${changed.join(', ')}`)
  const shop = reports.find((r) => r.projectId === 'shop-web')
  ok(/alt=""/.test(shop?.diff ?? '') && /-\s+console\.log/.test(shop?.diff ?? ''), 'shop-web diff 에 타입·린트·alt 수정 포함')

  // 결정 키(코드 변경=프로젝트 id, 기획 아이디어=아이디어 id) 전부에 같은 값을 보낸다
  const decisionsFor = (approve) =>
    Object.fromEntries([...new Set(state.approval.reports.filter((r) => r.files.length).map((r) => r.projectId)), ...state.approval.reports.flatMap((r) => r.ideas.map((i) => i.id))].map((k) => [k, approve]))

  console.log('\n[3] 승인 → 커밋')
  send({ type: 'approval:decide', commandId: state.approval.commandId, decisions: decisionsFor(true) })
  await until(() => state.approval?.decided === true && state.phase === 'idle', 30000, '승인 처리')
  await sleep(500)
  for (const line of state.approval.decisionLog) console.log(`     ${line}`)
  const lastMsg = execFileSync('git', ['log', '-1', '--format=%s'], { cwd: join(fixtures, 'shop-web') }).toString().trim()
  ok(lastMsg.startsWith('PixelBoss: 버그 픽스'), `shop-web 최신 커밋: "${lastMsg}"`)
  await until(() => h('shop-web') === 'clean' && h('admin-api') === 'clean' && h('landing-page') === 'clean', 20000, '재스캔')
  ok(true, '재스캔 결과 shop-web / admin-api / landing-page 모두 clean')
  ok(h('data-pipeline') === 'changed', '사용자의 기존 미커밋 변경(data-pipeline)은 건드리지 않음')

  console.log('\n[4] 전체 소집: "릴리즈 노트 작성" → 반려 → 복원')
  state.phases = []
  send({ type: 'command', text: '이번 주 커밋 로그로 릴리즈 노트 작성' })
  await until(() => state.phase === 'awaiting-approval', 120000, '승인 카드 2')
  ok(state.plan.departments.join() === 'docs', `분해 부서: ${state.plan.departments.join(', ')}`)
  ok(state.plan.tasks.filter((t) => !t.skipped).length === 6, '문서팀 6명 병렬 실행 (첫 기록이라 전원 대상)')
  ok(existsSync(join(fixtures, 'mobile-app/CHANGELOG.md')), 'mobile-app/CHANGELOG.md 생성됨')
  const cmd2 = state.approval.commandId
  send({ type: 'approval:decide', commandId: cmd2, decisions: decisionsFor(false) })
  await until(() => state.approval?.decided === true && state.phase === 'idle', 30000, '반려 처리')
  ok(!existsSync(join(fixtures, 'mobile-app/CHANGELOG.md')), '반려 후 CHANGELOG.md 제거됨')
  ok(existsSync(join(root, '.data/rejected', cmd2, 'mobile-app/new-files/CHANGELOG.md')), '반려된 결과물은 .data/rejected 에 보관')
  const job = readFileSync(join(fixtures, 'data-pipeline/src/job.ts'), 'utf8')
  ok(job.includes('retries = 3'), '반려 후에도 data-pipeline 의 기존 미커밋 변경 유지')

  console.log('\n[5] 전체 소집: "모든 프로젝트 타입 에러 일괄 해결" (모두 Clean)')
  state.phases = []
  send({ type: 'command', text: '모든 프로젝트 타입 에러 일괄 해결' })
  await until(() => state.phases.includes('dispatching') && state.phase === 'idle', 60000, 'Clean 종료')
  ok(state.plan.tasks.every((t) => t.skipped), `실행 0건 / 건너뜀 ${state.plan.tasks.length}건 → 토큰 소모 0`)
  ok(!state.phases.includes('working'), 'PTY 를 하나도 띄우지 않음')
} catch (e) {
  console.error(`\n✖ ${e.message}`)
  failures++
}

console.log(failures ? `\n검증 실패 ${failures}건` : '\n✅ 백엔드 통합 검증 통과')
finish(failures ? 1 : 0)
