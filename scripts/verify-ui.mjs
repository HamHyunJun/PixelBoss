#!/usr/bin/env node
// 통합 검증 스크립트 (브라우저 흐름) — `pnpm dev` 가 떠 있는 상태에서 실행
// 지시 → 부서별 제안 보고서 → 제안 승인 → 개발 파이프라인(구현·QA) → 최종 반영 → 히스토리 까지 실제 화면으로 검증하고 스크린샷을 남긴다.
// 반영·스케줄 추가로 fixtures 와 .data 가 바뀌므로 `pnpm fixtures` 로 만든 가상 프로젝트 + 깨끗한 .data 에서 mock 실행기로 돌릴 것.
// 사용법: pnpm fixtures && pnpm dev  (다른 터미널에서)  pnpm verify:ui   (프론트 주소가 다르면 PIXELBOSS_WEB)
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

/** 스크린샷에 로컬 절대 경로가 남지 않도록 화면 텍스트의 저장소 경로를 ~/dev/ 로 바꾼다 */
const maskPaths = (repo) =>
  page.evaluate((r) => {
    const w = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT)
    for (let n; (n = w.nextNode()); ) n.nodeValue = n.nodeValue.split(`${r}/`).join('~/dev/')
  }, repo)
const shot = async (name, clip) => {
  await maskPaths(root)
  await page.screenshot({ path: join(shots, `${name}.png`), clip })
}

/** 3D 캐릭터 상태 조회 (VoxelOffice 가 window.__pixelboss 로 엔진을 노출) */
const chars = () =>
  page.evaluate(() => [...window.__pixelboss.chars.values()].map((c) => ({ id: c.agentId, icon: c.icon })))
/** 캐릭터를 레이캐스팅 클릭. 걷는 중이면 위치가 바뀌므로 몇 번 재시도 */
const clickAgent = async (id, selector) => {
  for (let i = 0; i < 8; i++) {
    const p = await page.evaluate((agentId) => {
      const e = window.__pixelboss
      const v = e.chars.get(agentId).group.position.clone()
      v.y = 1.4
      v.project(e.camera)
      const r = e.renderer.domElement.getBoundingClientRect()
      return { x: r.left + ((v.x + 1) / 2) * r.width, y: r.top + ((1 - v.y) / 2) * r.height }
    }, id)
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
const waitPhase = (label, timeout = 60000) => until(async () => (await phase())?.trim() === label, timeout)
const closeModal = async () => {
  await page.keyboard.press('Escape')
  await page.waitForTimeout(400)
}
const boardText = () => page.locator('[data-test=pipeline-board]').textContent().catch(() => '')

try {
  console.log('\n[UI-1] 대시보드 로드')
  await page.goto(URL, { waitUntil: 'networkidle' })
  await page.waitForFunction(() => !!window.__pixelboss, null, { timeout: 30000 })
  await page.waitForTimeout(3500)
  const c0 = await chars()
  const leaders = c0.filter((c) => c.id.endsWith(':leader')).length
  ok(leaders === 5 && c0.length === 5 * 7 + 1, `5개 부서 × (팀장 1 + 담당자 6) + 대표 1 = 36명 배치 → ${c0.length}명 (팀장 ${leaders})`)
  ok((await pitch()) === 45, '기본 시점: 45° 아이소메트릭')
  await shot('01-office-iso')

  console.log('\n[UI-2] 지시 → 부서별 제안 보고서')
  await page.fill('[data-test=command-input]', '강제 각 프로젝트 별로 개선사항, 추가 아이디어 보고해')
  await page.click('[data-test=command-submit]')
  ok(await waitPhase('팀장 소집', 10000), '단계: 팀장 소집')
  ok(await waitPhase('승인 대기', 120000), '단계: 승인 대기 (제안 보고 완료)')
  await page.waitForSelector('[data-test=approval]')
  await page.waitForTimeout(1500)
  const ideas = await page.locator('[data-test=report-idea]').count()
  ok(ideas > 0, `보고서에 제안 ${ideas}건 (코드는 아직 수정되지 않음)`)
  await shot('06-report-proposals')

  console.log('\n[UI-3] 제안 승인 → 개발 파이프라인')
  await page.click('[data-test=approve-all]')
  await page.click('[data-test=apply]')
  await page.waitForSelector('[data-test=pipeline-board]', { timeout: 20000 })
  await page.waitForTimeout(600)
  await shot('04-working')
  ok(await until(async () => (await chars()).some((c) => !c.id.endsWith(':leader') && c.icon === 'working'), 15000), '개발팀 담당자 머리 위 작업 중 아이콘')
  ok(await until(async () => /결정 대기/.test(await boardText()), 90000), '파이프라인: 구현 → QA 통과 → 최종 반영 결정 대기')
  await page.waitForTimeout(3000)
  await closeModal() // 결정 대기가 되면 자동으로 열리는 파이프라인 모달
  await closeModal()
  await shot('07-pipeline-board')

  console.log('\n[UI-4] 최종 반영 (병합) → 문서팀 히스토리')
  await page.locator('[data-pipeline]').filter({ hasText: '결정 대기' }).first().click()
  await page.waitForSelector('[data-test=pipeline-detail]')
  await page.locator('[data-test=pipeline-final]').scrollIntoViewIfNeeded()
  await page.waitForTimeout(400)
  ok(/diff|\+1/.test((await page.locator('[data-test=pipeline-final]').textContent()) ?? ''), '최종 결정 카드에 변경 diff 표시')
  await shot('09-pipeline-final')
  // 병합은 되돌리기 어려워 한 번 더 눌러 확인하는 버튼
  await page.click('[data-test=pipeline-merge]')
  await page.waitForTimeout(300)
  await page.click('[data-test=pipeline-merge]')
  ok(await until(async () => /반영됨/.test((await page.locator('[data-test=pipeline-state]').textContent().catch(() => '')) ?? ''), 15000), '병합 후 상태: 반영됨')
  await closeModal()
  await page.click('[data-test=open-history]')
  await page.waitForSelector('[data-test=history-list] button')
  await page.locator('[data-test=history-list] button').first().click()
  await page.waitForTimeout(800)
  ok(((await page.locator('[data-test=history-doc]').textContent()) ?? '').includes('진행 기록'), '문서팀 히스토리에 진행 기록 저장')
  await shot('14-history')
  await closeModal()

  console.log('\n[UI-5] 팀장·실무자·이슈·스케줄·프로젝트 모달')
  await clickAgent('dev:leader', '[data-test=leader-table]')
  const rows = await page.locator('[data-test=leader-table] tbody tr').count()
  ok(rows === 6, `팀장 클릭 → 부서 통합 브리핑 (프로젝트 ${rows}개)`)
  await page.waitForTimeout(400)
  await shot('10-leader-briefing')
  await closeModal()

  await page.click('[data-test=open-issues]')
  await page.waitForTimeout(700)
  ok((await page.locator('text=이슈 보고').count()) > 0, '🚨 이슈 보고 모달')
  await shot('11-issues')
  await closeModal()

  await page.click('[data-test=open-schedules]')
  // 스케줄은 설정 파일에 저장되어 이전 실행분이 남아 있을 수 있으므로 증가량으로 확인한다
  const schBefore = await page.locator('[data-test=schedule-list] > *').count()
  await page.fill('[data-test=sch-time]', '09:00')
  await page.fill('[data-test=sch-text]', '각 프로젝트의 타입 에러와 린트 오류를 점검해 변경안을 보고')
  await page.click('button:has-text("평일")')
  await page.click('[data-test=sch-add]')
  ok(await until(async () => (await page.locator('[data-test=schedule-list] > *').count()) === schBefore + 1, 5000), '스케줄 추가 (평일 09:00)')
  await shot('12-schedule')
  await closeModal()

  await page.click('[data-test=open-projects]')
  await page.waitForSelector('[data-test=project-list]')
  ok((await page.locator('[data-test=project-list] > *').count()) === 6, '프로젝트 관리: 등록된 6개 표시')
  // 폴더 탐색기는 홈 디렉터리 목록이 보이므로 스크린샷에서 잘라낸다
  await shot('13-projects', { x: 80, y: 20, width: 1440, height: 540 })
  await closeModal()

  // 모달·토스트가 모두 사라진 뒤 실무자 터미널
  await page.waitForTimeout(5000)
  await clickAgent('qa:shop-web', '[data-test=terminal] .xterm-rows')
  await page.waitForTimeout(1200)
  const termText = await page.locator('[data-test=terminal] .xterm-rows').innerText()
  ok(/PixelBoss|Claude Code/.test(termText), '실무자 클릭 → PTY 터미널(xterm.js) 출력 표시')
  await shot('05-worker-terminal')
  await closeModal()

  console.log('\n[UI-6] 카메라 피치')
  await page.click('text=⬇ 탑뷰')
  ok(await until(async () => (await pitch()) === 90, 5000), '탑뷰 버튼 → 수직 90°')
  await page.waitForTimeout(1500)
  await shot('15-top-view')
  await page.click('text=⬆ 사이드')
  ok(await until(async () => (await pitch()) === 0, 5000), '사이드 버튼 → 수평 0°')
  await page.waitForTimeout(1500)
  await shot('16-side-view')
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
