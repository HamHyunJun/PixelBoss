#!/usr/bin/env node
// 통합 검증 스크립트 (브라우저 흐름) — `pnpm dev` 가 떠 있는 상태에서 실행
// 전체 소집 명령 → PTY 병렬 스폰 → 3D 캐릭터 상태 동기화 → 모달/터미널 → 승인 카드 → 커밋 까지 실제 화면으로 검증한다.
// 사용법: pnpm fixtures && pnpm dev  (다른 터미널에서)  pnpm verify:ui
import { mkdirSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { chromium } from 'playwright'

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const shots = join(root, 'docs/screenshots')
mkdirSync(shots, { recursive: true })
const URL = process.env.PIXELBOSS_WEB ?? 'http://localhost:3000/'

let failures = 0
const ok = (cond, label) => {
  console.log(`${cond ? '  ✔' : '  ✖'} ${label}`)
  if (!cond) failures++
}

const browser = await chromium.launch({
  executablePath: process.env.PLAYWRIGHT_CHROMIUM ?? undefined,
  args: ['--use-gl=angle', '--use-angle=swiftshader', '--enable-unsafe-swiftshader', '--ignore-gpu-blocklist'],
})
const page = await browser.newPage({ viewport: { width: 1600, height: 950 } })
const errors = []
page.on('pageerror', (e) => errors.push(e.message))
page.on('console', (m) => m.type() === 'error' && !/ERR_TUNNEL|Failed to load resource/.test(m.text()) && errors.push(m.text()))

/** 3D 캐릭터 상태 조회 (VoxelOffice 가 window.__pixelboss 로 엔진을 노출) */
const chars = () =>
  page.evaluate(() => {
    const e = window.__pixelboss
    return [...e.chars.values()].map((c) => ({ id: c.agentId, icon: c.icon, pose: c.pose, x: c.group.position.x, z: c.group.position.z, home: c.home.pos }))
  })
const screenPos = (id) =>
  page.evaluate((agentId) => {
    const e = window.__pixelboss
    const c = e.chars.get(agentId)
    const v = c.group.position.clone()
    v.y = 1.4
    v.project(e.camera)
    const r = e.renderer.domElement.getBoundingClientRect()
    return { x: r.left + ((v.x + 1) / 2) * r.width, y: r.top + ((1 - v.y) / 2) * r.height }
  }, id)
/** 캐릭터를 레이캐스팅 클릭. 걷는 중이면 위치가 바뀌므로 몇 번 재시도 */
const clickAgent = async (id, selector) => {
  for (let i = 0; i < 6; i++) {
    const p = await screenPos(id)
    await page.mouse.click(p.x, p.y)
    if (await page.waitForSelector(selector, { timeout: 1500 }).catch(() => null)) return
  }
  throw new Error(`${id} 클릭 실패`)
}
/** 조건이 참이 될 때까지 폴링 (헤드리스 환경은 프레임이 느릴 수 있음) */
const until = async (fn, timeout = 15000) => {
  const t0 = Date.now()
  while (Date.now() - t0 < timeout) {
    if (await fn()) return true
    await page.waitForTimeout(200)
  }
  return false
}
const pitch = async () => parseInt((await page.locator('[data-test=pitch]').textContent()) ?? '')
const phase = () => page.locator('[data-test=phase] li.active').textContent().catch(() => null)
const waitPhase = async (label, timeout = 60000) => {
  const t0 = Date.now()
  while (Date.now() - t0 < timeout) {
    if ((await phase())?.trim() === label) return true
    await page.waitForTimeout(150)
  }
  return false
}

try {
  console.log('\n[UI-1] 대시보드 로드')
  await page.goto(URL, { waitUntil: 'networkidle' })
  await page.waitForFunction(() => !!window.__pixelboss, null, { timeout: 30000 })
  await page.waitForTimeout(3500)
  const c0 = await chars()
  ok(c0.length === 28, `3D 캐릭터 28명 배치 → ${c0.length}`)
  ok((await page.locator('[data-test=pitch]').textContent())?.trim() === '45°', '기본 시점: 45° 아이소메트릭')
  await page.screenshot({ path: join(shots, '01-office-iso.png') })

  console.log('\n[UI-2] 전체 소집 명령 입력')
  await page.fill('[data-test=command-input]', '버그 픽스 및 접근성 표준 검사 적용')
  await page.click('[data-test=command-submit]')
  ok(await waitPhase('팀장 소집', 10000), '단계: 팀장 소집')
  const met = await until(async () => (await chars()).filter((c) => c.id.endsWith(':leader')).every((l) => Math.abs(l.x) < 8 && Math.abs(l.z) < 5), 8000)
  ok(met, '팀장 4명 모두 중앙 회의실 테이블로 이동')
  await page.screenshot({ path: join(shots, '02-all-hands-meeting.png') })

  ok(await waitPhase('업무 하달', 10000), '단계: 업무 하달')
  ok(await until(async () => Math.abs((await chars()).find((c) => c.id === 'qa:leader').x) > 12, 6000), 'QA 팀장이 부서로 복귀해 실무자에게 이동')
  await page.screenshot({ path: join(shots, '03-dispatch.png') })

  ok(await waitPhase('PTY 실행', 15000), '단계: PTY 실행')
  // 작업 중(톱니바퀴) → 완료(체크) 아이콘을 띄운 실무자를 누적 수집 (짧은 작업은 샘플 사이에 끝날 수 있음)
  const seen = new Map()
  await until(async () => {
    for (const c of await chars()) if (!c.id.endsWith(':leader') && (c.icon === 'working' || c.icon === 'done')) seen.set(c.id, [...new Set([...(seen.get(c.id) ?? []), c.icon])])
    return seen.size >= 4
  }, 10000)
  const working = [...seen.keys()].map((id) => ({ id }))
  ok(working.length === 4 && [...seen.values()].filter((v) => v.includes('working')).length >= 3, `PTY 상태 → 3D 아이콘 동기화: ${[...seen].map(([id, v]) => `${id}(${v.join('→')})`).join(', ')}`)
  await page.screenshot({ path: join(shots, '04-working.png') })
  ok(!working.some((c) => c.id === 'qa:mobile-app' || c.id === 'qa:design-system'), 'Clean 프로젝트 담당자는 작업하지 않음')

  // 작업 중인 실무자 클릭 → xterm 터미널 모달
  await clickAgent('qa:landing-page', '[data-test=terminal] .xterm-rows')
  await page.waitForTimeout(1500)
  const termText = await page.locator('[data-test=terminal] .xterm-rows').innerText()
  ok(/PixelBoss|Claude Code/.test(termText), '실무자 클릭 → PTY 터미널(xterm.js) 실시간 출력 표시')
  await page.screenshot({ path: join(shots, '05-worker-terminal.png') })
  await page.keyboard.press('Escape')

  ok(await waitPhase('승인 대기', 60000), '단계: 승인 대기')
  await page.waitForSelector('[data-test=approval]')
  await page.waitForSelector('[data-test=apply]')
  ok((await chars()).filter((c) => c.icon === 'done').length >= 4, '완료한 실무자 머리 위 녹색 체크')
  ok(await until(() => page.evaluate(() => window.__pixelboss.world.paperCount >= 4), 15000), '완료한 실무자가 게시판에 리포트 서류 부착 (4장 이상)')
  ok(await until(async () => (await chars()).filter((c) => !c.id.endsWith(':leader') && c.icon === 'done').every((c) => c.x === c.home.x && c.z === c.home.z), 15000), '서류 부착 후 자리로 복귀')
  await page.screenshot({ path: join(shots, '06-approval-card.png') })

  // 팀장 클릭 → 부서 통합 브리핑
  await clickAgent('qa:leader', '[data-test=leader-table]')
  const rows = await page.locator('[data-test=leader-table] tbody tr').count()
  ok(rows === 6, `팀장 클릭 → 부서 통합 브리핑 (프로젝트 ${rows}개)`)
  await page.screenshot({ path: join(shots, '07-leader-briefing.png') })
  await page.keyboard.press('Escape')

  console.log('\n[UI-3] 승인 → 커밋')
  await page.click('[data-test=approve-all]')
  await page.click('[data-test=apply]')
  await page.waitForSelector('[data-test=approval] .log', { timeout: 15000 })
  const log = await page.locator('[data-test=approval] .log').innerText()
  ok(/커밋/.test(log), `승인 결과: ${log.split('\n').slice(1).join(' / ')}`)

  console.log('\n[UI-4] 카메라 피치')
  await page.click('text=⬇ 탑뷰')
  ok(await until(async () => (await pitch()) === 90, 5000), '탑뷰 버튼 → 수직 90°')
  await page.screenshot({ path: join(shots, '08-top-view.png') })
  await page.click('text=⬆ 사이드')
  ok(await until(async () => (await pitch()) === 0, 5000), '사이드 버튼 → 수평 0°')
  await page.screenshot({ path: join(shots, '09-side-view.png') })
  // 마우스 드래그: 아래로 끌면 탑뷰 쪽, 위로 끌면 수평 쪽
  await page.click('text=◩ 45° 아이소')
  await until(async () => (await pitch()) === 45, 5000)
  await page.mouse.move(800, 600)
  await page.mouse.down()
  await page.mouse.move(800, 900, { steps: 10 })
  await page.mouse.up()
  await page.waitForTimeout(800)
  const down = await pitch()
  await page.mouse.move(800, 300)
  await page.mouse.down()
  await page.mouse.move(800, 0, { steps: 10 })
  await page.mouse.up()
  await page.waitForTimeout(800)
  const up = await pitch()
  ok(down > 45 && up < 45, `드래그 ↓ → ${down}° (탑뷰 방향), 드래그 ↑ → ${up}° (수평 방향)`)
} catch (e) {
  console.error(`\n✖ ${e.message}`)
  failures++
}

ok(errors.length === 0, `브라우저 콘솔 에러 ${errors.length}건${errors.length ? ': ' + errors.slice(0, 3).join(' | ') : ''}`)
await browser.close()
console.log(failures ? `\nUI 검증 실패 ${failures}건` : `\n✅ UI 통합 검증 통과 (스크린샷: docs/screenshots)`)
process.exit(failures ? 1 : 0)
