#!/usr/bin/env node
// 실제 Claude Code CLI 실행 래퍼
// `claude -p --output-format stream-json` 이벤트를 사람이 읽기 좋은 터미널 출력으로 바꿔 PTY(xterm.js)로 흘려보낸다.
import { spawn } from 'node:child_process'
import { readFileSync, writeFileSync } from 'node:fs'
import { createInterface } from 'node:readline'

const task = JSON.parse(readFileSync(process.env.PIXELBOSS_TASK_FILE, 'utf8'))
const bin = process.env.PIXELBOSS_CLAUDE_BIN || 'claude'
const extra = JSON.parse(process.env.PIXELBOSS_CLAUDE_ARGS || '[]')
// 최종 답변은 파일로도 남겨 오케스트레이터가 보고서(한글 본문)로 쓸 수 있게 한다
const resultFile = process.env.PIXELBOSS_RESULT_FILE
let lastText = ''
let usage
const c = { dim: '\x1b[2m', orange: '\x1b[38;5;214m', green: '\x1b[32m', cyan: '\x1b[36m', red: '\x1b[31m', reset: '\x1b[0m' }
const say = (s = '') => process.stdout.write(s.replace(/\n/g, '\r\n') + '\r\n')

say(`${c.cyan}Claude Code 실행: ${task.projectName} / ${task.departmentName}${c.reset}`)
const child = spawn(bin, ['-p', task.prompt, '--output-format', 'stream-json', '--verbose', ...extra], {
  cwd: process.cwd(),
  stdio: ['ignore', 'pipe', 'pipe'],
  env: process.env,
})

function describeTool(name, input = {}) {
  const target = input.file_path || input.path || input.pattern || input.command || input.url || ''
  return `${c.orange}⏺ ${name}${c.reset}(${String(target).slice(0, 120)})`
}

createInterface({ input: child.stdout }).on('line', (line) => {
  let ev
  try {
    ev = JSON.parse(line)
  } catch {
    return say(line)
  }
  if (ev.type === 'system' && ev.subtype === 'init') say(`${c.dim}session ${ev.session_id} · model ${ev.model}${c.reset}`)
  else if (ev.type === 'assistant') {
    for (const block of ev.message?.content ?? []) {
      if (block.type === 'text' && block.text.trim()) {
        lastText = block.text.trim()
        say(lastText)
      }
      else if (block.type === 'tool_use') say(describeTool(block.name, block.input))
    }
  } else if (ev.type === 'user') {
    for (const block of ev.message?.content ?? []) {
      if (block.type === 'tool_result' && block.is_error) say(`${c.red}  ⎿ 도구 오류${c.reset}`)
    }
  } else if (ev.type === 'result') {
    if (typeof ev.result === 'string' && ev.result.trim()) lastText = ev.result.trim()
    usage = { costUsd: ev.total_cost_usd ?? 0, turns: ev.num_turns ?? 0 }
    say()
    const ok = ev.subtype === 'success' && !ev.is_error
    say(`${ok ? c.green + '✔ 완료' : c.red + '✖ 실패'}${c.reset} · ${ev.num_turns ?? '?'}턴 · $${(ev.total_cost_usd ?? 0).toFixed(4)}`)
  }
})
child.stderr.on('data', (d) => process.stdout.write(`${c.red}${d}${c.reset}`))
child.on('close', (code) => {
  if (resultFile && lastText) writeFileSync(resultFile, lastText)
  if (resultFile && usage) writeFileSync(resultFile.replace(/\.txt$/, '.usage.json'), JSON.stringify(usage))
  process.exit(code ?? 1)
})
child.on('error', (e) => {
  say(`${c.red}claude 실행 실패: ${e.message}${c.reset}`)
  process.exit(127)
})
