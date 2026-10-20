#!/usr/bin/env node
// 목(mock) Claude Code 실행기
// 실제 claude CLI 와 같은 자리(PTY 안, 프로젝트 cwd)에서 실행되어 "읽기 → 수정 → 요약" 흐름을 흉내 낸다.
// LLM 을 호출하지 않으므로 토큰 비용 없이 오케스트레이션 전체 흐름을 검증할 수 있다.
import { execFileSync } from 'node:child_process'
import { existsSync, mkdirSync, readFileSync, readdirSync, statSync, writeFileSync } from 'node:fs'
import { dirname, join, relative } from 'node:path'
import { createInterface } from 'node:readline'

const task = JSON.parse(readFileSync(process.env.VOXELHQ_TASK_FILE, 'utf8'))
const cwd = process.cwd()
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
const c = { dim: '\x1b[2m', orange: '\x1b[38;5;214m', green: '\x1b[32m', cyan: '\x1b[36m', red: '\x1b[31m', reset: '\x1b[0m' }
const say = (s = '') => process.stdout.write(s + '\r\n')
const speed = Number(process.env.VOXELHQ_MOCK_SPEED ?? 1)
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

const edits = []
function edit(file, fn, why) {
  const before = existsSync(file) ? readFileSync(file, 'utf8') : ''
  const after = fn(before)
  if (after === before) return
  mkdirSync(dirname(file), { recursive: true })
  writeFileSync(file, after)
  edits.push(`${relative(cwd, file)} — ${why}`)
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

if (dept === 'qa') {
  // 소스 디렉터리(src/)만 수정한다
  const sources = files.filter((f) => relative(cwd, f).startsWith('src/'))
  for (const f of sources.filter((f) => /\.(m?[jt]sx?|vue)$/.test(f))) {
    edit(f, (s) => s.replace(/(:\s*number\s*=\s*)"(\d+)"/g, '$1$2'), '문자열→숫자 타입 에러 수정 (TS2322)')
    edit(f, (s) => s.split('\n').filter((l) => !/^\s*console\.log\(/.test(l)).join('\n'), 'no-console 린트 위반 제거')
    edit(f, (s) => s.replace(/return a - b \/\/ add/g, 'return a + b // add'), 'add() 테스트 실패 원인 수정')
  }
  if (/접근성|a11y|accessib/i.test(text)) {
    for (const f of sources.filter((f) => /\.(html|vue)$/.test(f))) {
      edit(f, (s) => s.replace(/<img(?![^>]*\balt=)([^>]*)>/g, '<img alt=""$1>'), '이미지 대체 텍스트(alt) 추가')
    }
  }
} else if (dept === 'planning') {
  const target = join(cwd, 'docs/IMPROVEMENTS.md')
  edit(
    target,
    (s) =>
      (s || '# 개선안 제안\n') +
      `\n## ${new Date().toISOString().slice(0, 10)} — ${task.command}\n` +
      (task.context.changedFiles.length
        ? task.context.changedFiles.map((f) => `- \`${f}\`: 변경 영역 기준 리팩토링/성능 점검 필요`).join('\n')
        : '- 변경 파일 없음: 구조 개선 포인트만 기록') +
      '\n',
    '개선안 문서 갱신',
  )
} else if (dept === 'infra') {
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
    'engines/CI 스크립트 보강',
  )
} else if (dept === 'docs') {
  let log = ''
  try {
    log = execFileSync('git', ['log', '--oneline', '-n', '10'], { cwd }).toString()
  } catch {}
  edit(
    join(cwd, 'CHANGELOG.md'),
    (s) => (s || '# 변경 이력\n') + `\n## ${new Date().toISOString().slice(0, 10)}\n` + log.trim().split('\n').map((l) => `- ${l}`).join('\n') + '\n',
    '커밋 로그 기반 릴리즈 노트 추가',
  )
}

for (const e of edits) {
  say(`${c.orange}⏺ Update${c.reset}(${e.split(' — ')[0]})`)
  await pause(400)
}

// 입력 대기 연출: VOXELHQ_MOCK_ASK 에 프로젝트 id 를 넣으면 해당 PTY 가 사용자 입력을 기다린다
if (process.env.VOXELHQ_MOCK_ASK && process.env.VOXELHQ_MOCK_ASK.split(',').includes(task.projectId)) {
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

say()
if (edits.length) {
  await typeLine(`${c.green}✔ ${edits.length}건 수정 완료${c.reset}`)
  for (const e of edits) say(`  · ${e}`)
} else {
  await typeLine(`${c.green}✔ 수정할 항목이 없습니다 (이미 정상)${c.reset}`)
}
await pause(300)
process.exit(0)
