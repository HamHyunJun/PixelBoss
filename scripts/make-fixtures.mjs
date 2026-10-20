#!/usr/bin/env node
// 통합 검증용 가상 프로젝트 6개를 ./fixtures 아래에 git 저장소로 생성한다.
// 각 프로젝트는 일부러 서로 다른 상태(타입 에러, 테스트 실패, 미커밋 변경, Clean 등)를 갖는다.
import { execFileSync } from 'node:child_process'
import { mkdirSync, rmSync, writeFileSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = resolve(dirname(fileURLToPath(import.meta.url)), '../fixtures')
rmSync(root, { recursive: true, force: true })

// 가상 정적 검사기: 실제 tsc/eslint 대신 같은 형식의 에러 로그를 낸다
const CHECK = `// 가상 정적 검사기 (tsc / eslint / test / build 흉내)
import { readFileSync, readdirSync, statSync, existsSync } from 'node:fs'
import { join } from 'node:path'
const walk = (d, o = []) => { if (!existsSync(d)) return o; for (const n of readdirSync(d)) { const p = join(d, n); statSync(p).isDirectory() ? walk(p, o) : o.push(p) } return o }
const files = walk('src').filter((f) => /\\.(m?[jt]sx?|vue|html)$/.test(f))
const kind = process.argv[2]
const errors = []
for (const f of files) {
  readFileSync(f, 'utf8').split('\\n').forEach((line, i) => {
    if (kind === 'types' && /:\\s*number\\s*=\\s*"/.test(line)) errors.push(\`\${f}(\${i + 1}): error TS2322: Type 'string' is not assignable to type 'number'.\`)
    if (kind === 'lint' && /^\\s*console\\.log\\(/.test(line)) errors.push(\`\${f}:\${i + 1}  error  Unexpected console statement  no-console\`)
  })
}
if (kind === 'test' && existsSync('src/math.js') && /return a - b/.test(readFileSync('src/math.js', 'utf8'))) errors.push('FAIL src/math.test.js › add(1, 2) expected 3, received -1')
if (kind === 'build') { try { JSON.parse(readFileSync('package.json', 'utf8')) } catch (e) { errors.push('error: package.json 파싱 실패 ' + e.message) } }
if (errors.length) { console.error(errors.join('\\n')); console.error(\`✖ \${errors.length} problem(s)\`); process.exit(1) }
console.log('✔ ' + kind + ' ok')
`

const projects = {
  'shop-web': {
    'src/cart.ts': 'export function total(items: { price: number }[]) {\n  const base: number = "0"\n  console.log("calc total")\n  return items.reduce((s, i) => s + i.price, base)\n}\n',
    'src/index.html': '<main>\n  <img src="logo.png">\n  <h1>Shop</h1>\n</main>\n',
  },
  'admin-api': {
    'src/math.js': 'export function add(a, b) {\n  return a - b // add\n}\n',
    'src/server.ts': 'export const port: number = 8080\n',
  },
  'mobile-app': {
    'src/App.vue': '<template>\n  <img src="hero.png" alt="hero">\n</template>\n',
    'src/store.ts': 'export const state = { count: 0 }\n',
  },
  'data-pipeline': {
    'src/job.ts': 'export async function run() {\n  return "ok"\n}\n',
  },
  'design-system': {
    'src/Button.vue': '<template>\n  <button class="btn"><slot /></button>\n</template>\n',
    'src/tokens.ts': 'export const spacing: number = 8\n',
  },
  'landing-page': {
    'src/main.js': 'export function init() {\n  console.log("landing ready")\n  return true\n}\n',
    'src/index.html': '<section>\n  <img src="banner.png">\n</section>\n',
  },
}

const sh = (cwd, ...args) => execFileSync('git', args, { cwd, stdio: 'pipe' }).toString()

for (const [name, files] of Object.entries(projects)) {
  const dir = join(root, name)
  mkdirSync(dir, { recursive: true })
  writeFileSync(join(dir, 'check.mjs'), CHECK)
  writeFileSync(join(dir, 'package.json'), JSON.stringify({ name, version: '1.0.0', type: 'module', private: true }, null, 2) + '\n')
  writeFileSync(join(dir, 'README.md'), `# ${name}\n\nPixelBoss 통합 검증용 가상 프로젝트\n`)
  for (const [f, body] of Object.entries(files)) {
    mkdirSync(dirname(join(dir, f)), { recursive: true })
    writeFileSync(join(dir, f), body)
  }
  sh(dir, 'init', '-q', '-b', 'main')
  sh(dir, '-c', 'user.name=Fixture', '-c', 'user.email=fixture@localhost', 'add', '-A')
  sh(dir, '-c', 'user.name=Fixture', '-c', 'user.email=fixture@localhost', 'commit', '-q', '-m', 'chore: 초기 커밋')
}

// data-pipeline 에는 커밋되지 않은 변경을 남긴다 (기획팀 검토 대상)
writeFileSync(join(root, 'data-pipeline/src/job.ts'), 'export async function run(retries = 3) {\n  for (let i = 0; i < retries; i++) {\n    // TODO: 재시도 로직\n  }\n  return "ok"\n}\n')

console.log(`가상 프로젝트 6개 생성 완료: ${root}`)
console.log('  shop-web      : 타입 에러 + 린트 에러 + alt 누락 이미지')
console.log('  admin-api     : 테스트 실패')
console.log('  mobile-app    : Clean')
console.log('  data-pipeline : 미커밋 변경')
console.log('  design-system : Clean')
console.log('  landing-page  : 린트 에러 + alt 누락 이미지')
