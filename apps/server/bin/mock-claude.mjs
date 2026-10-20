#!/usr/bin/env node
// 목(mock) Claude Code 실행기
// 실제 claude CLI 와 같은 자리(PTY 안, 프로젝트 cwd)에서 실행되어 "읽기 → 수정 → 요약" 흐름을 흉내 낸다.
// LLM 을 호출하지 않으므로 토큰 비용 없이 오케스트레이션 전체 흐름을 검증할 수 있다.
import { execFileSync } from 'node:child_process'
import { existsSync, mkdirSync, readFileSync, readdirSync, statSync, writeFileSync } from 'node:fs'
import { dirname, join, relative } from 'node:path'
import { createInterface } from 'node:readline'

const task = JSON.parse(readFileSync(process.env.PIXELBOSS_TASK_FILE, 'utf8'))
const cwd = process.cwd()
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
const c = { dim: '\x1b[2m', orange: '\x1b[38;5;214m', green: '\x1b[32m', cyan: '\x1b[36m', red: '\x1b[31m', reset: '\x1b[0m' }
const say = (s = '') => process.stdout.write(s + '\r\n')
const speed = Number(process.env.PIXELBOSS_MOCK_SPEED ?? 1)
const pause = (ms) => sleep(ms / speed)

function walk(dir, out = []) {
  for (const name of readdirSync(dir)) {
    if (name === '.git' || name === 'node_modules') continue
    const p = join(dir, name)
    if (statSync(p).isDirectory()) walk(p, out)
    else out.push(p)
  }
  return out
}

// propose(기본): 파일을 건드리지 않고 '하려는 변경'만 한글 제안으로 정리한다 / execute·fix: 승인된 제안(또는 QA 지적)을 실제로 적용한다 (개발팀) / review: QA 검수(읽기 전용)
const mode = task.mode ?? 'propose'
const edits = []
const planned = []
let summary = ''
function edit(file, fn, why, preview = []) {
  const before = existsSync(file) ? readFileSync(file, 'utf8') : ''
  const after = fn(before)
  if (after === before) return
  if (mode === 'execute' || mode === 'fix') {
    mkdirSync(dirname(file), { recursive: true })
    writeFileSync(file, after)
  }
  edits.push(`${relative(cwd, file)} — ${why}`)
  planned.push({ file: relative(cwd, file), why, preview })
}

async function typeLine(s) {
  for (const ch of s) {
    process.stdout.write(ch)
    await pause(6)
  }
  process.stdout.write('\r\n')
}

say(`${c.cyan}╭─ Claude Code (mock) ─────────────────────────────╮${c.reset}`)
say(`${c.cyan}│${c.reset} 프로젝트: ${task.projectName}  부서: ${task.departmentName}`)
say(`${c.cyan}│${c.reset} cwd: ${cwd}`)
say(`${c.cyan}╰──────────────────────────────────────────────────╯${c.reset}`)
say(`${c.dim}> ${task.prompt.split('\n')[0].slice(0, 110)}${c.reset}`)
await pause(500)

const files = walk(cwd).filter((f) => /\.(m?[jt]sx?|vue|html|json|md)$/.test(f))
// 실제 Claude 처럼 필요한 파일만 읽는다: 변경 파일 + 에러 로그에 언급된 파일 우선
const focus = files.filter((f) => task.context.changedFiles.includes(relative(cwd, f)) || task.context.errors.some((e) => e.excerpt.includes(relative(cwd, f))))
for (const f of (focus.length ? focus : files).slice(0, 6)) {
  say(`${c.orange}⏺ Read${c.reset}(${relative(cwd, f)})`)
  await pause(250)
}

const text = task.prompt
const dept = task.department

const qaEdits = () => {
  // 소스 디렉터리(src/)만 대상으로 한다
  const sources = files.filter((f) => relative(cwd, f).startsWith('src/'))
  for (const f of sources.filter((f) => /\.(m?[jt]sx?|vue)$/.test(f))) {
    edit(f, (s) => s.replace(/(:\s*number\s*=\s*)"(\d+)"/g, '$1$2'), '문자열을 숫자로 고쳐 타입 에러(TS2322)를 해결')
    edit(f, (s) => s.split('\n').filter((l) => !/^\s*console\.log\(/.test(l)).join('\n'), '디버그용 console.log 를 지워 no-console 린트 위반을 해결')
    edit(f, (s) => s.replace(/return a - b \/\/ add/g, 'return a + b // add'), 'add() 의 뺄셈 오류를 덧셈으로 고쳐 테스트 실패를 해결')
  }
  if (/접근성|a11y|accessib/i.test(text)) {
    for (const f of sources.filter((f) => /\.(html|vue)$/.test(f))) {
      edit(f, (s) => s.replace(/<img(?![^>]*\balt=)([^>]*)>/g, '<img alt=""$1>'), '이미지에 대체 텍스트(alt)를 추가')
    }
  }
}
const infraEdits = () =>
  edit(
    join(cwd, 'package.json'),
    (s) => {
      try {
        const pkg = JSON.parse(s || '{}')
        pkg.engines ??= { node: '>=20' }
        pkg.scripts ??= {}
        pkg.scripts.ci ??= 'node check.mjs types && node check.mjs lint'
        return JSON.stringify(pkg, null, 2) + '\n'
      } catch {
        return s
      }
    },
    'package.json 에 engines(node >=20)와 ci 스크립트를 추가',
  )
const docsEdits = () => {
  let log = ''
  try {
    log = execFileSync('git', ['log', '--oneline', '-n', '10'], { cwd }).toString()
  } catch {}
  const lines = log.trim().split('\n').filter(Boolean).map((l) => `- ${l}`)
  edit(
    join(cwd, 'CHANGELOG.md'),
    (s) => (s || '# 변경 이력\n') + `\n## ${new Date().toISOString().slice(0, 10)}\n` + lines.join('\n') + '\n',
    '최근 커밋 로그로 CHANGELOG.md 에 릴리즈 노트를 추가',
    lines.slice(0, 6),
  )
}

const NOTE_REVIEW = 'Mock 실행기: 실제 AI 검수가 아니라 간단한 규칙 점검입니다.'
const NOTE = 'Mock 실행기: 실제 AI 분석이 아니라 간단한 규칙 점검입니다. 실제 계획은 상단의 실행기 버튼으로 Claude Code 를 켜고 다시 지시하면 받을 수 있습니다.'

if (mode === 'review') {
  // QA 검수: 작업 폴더(개발 전용 브랜치)에서 규칙으로 문제를 찾아 한글로 보고하고 판정을 남긴다
  const issues = []
  for (const f of files.filter((f) => /\.(m?[jt]sx?|vue)$/.test(f) && relative(cwd, f).startsWith('src/'))) {
    const lines = readFileSync(f, 'utf8').split('\n')
    lines.forEach((l, i) => {
      if (/^\s*console\.log\(/.test(l)) issues.push(`### 문제 ${issues.length + 1}. 디버그용 console.log 가 남아 있음\n- 위치: \`${relative(cwd, f)}:${i + 1}\`\n- 문제: 린트(no-console) 위반이며 운영 빌드에 디버그 출력이 남습니다.\n- 수정 방법: 해당 줄을 제거하세요.`)
    })
  }
  summary =
    `${NOTE_REVIEW}\n\n` + (issues.length ? issues.join('\n\n') + '\n\n판정: 수정 필요' : '승인된 제안대로 구현됐고 눈에 띄는 문제를 찾지 못했습니다.\n\n판정: 통과')
} else if (mode === 'execute' || mode === 'fix') {
  // 개발팀 구현·수정: 승인된 제안(또는 QA 지적) 내용에 해당하는 변경만 적용한다
  if (/로그|타입|린트|alt|접근성|테스트|console/i.test(text)) qaEdits()
  if (/engines|ci 스크립트|package\.json|빌드/i.test(text)) infraEdits()
  if (/CHANGELOG|릴리즈|변경 이력/i.test(text)) docsEdits()
} else if (dept === 'planning') {
  // 기획팀: 구조 개선 포인트를 한글 아이디어로 정리 (파일은 건드리지 않음)
  const src = files.filter((f) => /\.(m?[jt]sx?|vue)$/.test(f))
  const logs = src.filter((f) => /console\.log\(/.test(readFileSync(f, 'utf8')))
  const big = src.filter((f) => readFileSync(f, 'utf8').split('\n').length > 300)
  const todo = src.filter((f) => /TODO|FIXME/.test(readFileSync(f, 'utf8')))
  const ideas = []
  if (big.length) ideas.push(`### 제안 ${ideas.length + 1}. 큰 파일 분리 (우선순위: 중)\n- 근거: ${big.slice(0, 3).map((f) => relative(cwd, f)).join(', ')} 가 300줄을 넘습니다.\n- 제안: 책임 단위로 나누면 변경 영향 범위가 줄어듭니다.`)
  if (logs.length) ideas.push(`### 제안 ${ideas.length + 1}. 디버그 로그 정리 (우선순위: 하)\n- 근거: ${logs.slice(0, 3).map((f) => relative(cwd, f)).join(', ')} 에 console.log 가 남아 있습니다.\n- 제안: 제거하거나 로거로 교체하세요.`)
  if (todo.length) ideas.push(`### 제안 ${ideas.length + 1}. 미처리 TODO/FIXME 정리 (우선순위: 하)\n- 근거: ${todo.slice(0, 3).map((f) => relative(cwd, f)).join(', ')}\n- 제안: 이슈로 옮기거나 처리하세요.`)
  summary = `${NOTE}\n\n` + (ideas.length ? ideas.join('\n\n') : '특별한 개선 포인트를 찾지 못했습니다.')
} else {
  // QA·개발·인프라·문서: 어떤 파일을 어떻게 바꿀지 한글 변경안으로만 보고한다 (실제 수정은 승인 뒤 개발팀이 한다)
  if (dept === 'qa' || dept === 'dev') qaEdits()
  else if (dept === 'infra') infraEdits()
  else if (dept === 'docs') docsEdits()
  summary =
    `${NOTE}\n\n` +
    (planned.length
      ? planned
          .map((p, i) => `### 제안 ${i + 1}. ${p.why}\n- 대상 파일: \`${p.file}\`\n- 변경 내용: ${p.why}합니다.` + (p.preview.length ? `\n- 추가될 내용:\n${p.preview.map((l) => `  ${l}`).join('\n')}` : ''))
          .join('\n\n')
      : '변경할 항목을 찾지 못했습니다.')
}

for (const e of edits) {
  say(`${c.orange}⏺ ${mode === 'execute' || mode === 'fix' ? 'Update' : 'Plan'}${c.reset}(${e.split(' — ')[0]})`)
  await pause(400)
}

// 입력 대기 연출: PIXELBOSS_MOCK_ASK 에 프로젝트 id 를 넣으면 해당 PTY 가 사용자 입력을 기다린다
if (process.env.PIXELBOSS_MOCK_ASK && process.env.PIXELBOSS_MOCK_ASK.split(',').includes(task.projectId)) {
  process.stdout.write(`${c.orange}?${c.reset} 변경 사항을 확정할까요? (y/n) `)
  const rl = createInterface({ input: process.stdin })
  const answer = await new Promise((r) => rl.once('line', r))
  rl.close()
  say()
  if (!/^y/i.test(answer)) {
    say(`${c.red}사용자가 취소했습니다.${c.reset}`)
    process.exit(2)
  }
}

if (!summary) summary = edits.length ? `${edits.length}건 수정했습니다.\n` + edits.map((e) => `- ${e}`).join('\n') : '수정할 항목이 없습니다 (이미 정상).'
if (process.env.PIXELBOSS_RESULT_FILE) writeFileSync(process.env.PIXELBOSS_RESULT_FILE, summary)

say()
if (mode === 'review') {
  await typeLine(`${c.green}✔ QA 검수 보고를 작성했습니다 (파일은 수정하지 않았습니다)${c.reset}`)
} else if (mode === 'propose') {
  await typeLine(`${c.green}✔ 변경안을 한글로 정리했습니다 (파일은 수정하지 않았습니다)${c.reset}`)
} else if (edits.length) {
  await typeLine(`${c.green}✔ ${edits.length}건 수정 완료${c.reset}`)
  for (const e of edits) say(`  · ${e}`)
} else {
  await typeLine(`${c.green}✔ 수정할 항목이 없습니다 (이미 정상)${c.reset}`)
}
await pause(300)
process.exit(0)
