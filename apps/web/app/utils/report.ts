// 승인 보고서용 보조 함수: unified diff 를 파일별로 나누고, 문서(md) 내용을 안전하게 읽기 좋은 블록으로 바꾼다 (v-html 미사용)
export interface FileDiff {
  file: string
  isNew: boolean
  /** 추가된 줄(접두사 '+' 제거). 문서 파일은 이것이 곧 이번에 쓴 내용이다 */
  added: string[]
  insertions: number
  deletions: number
  /** 이 파일의 원본 diff 조각 */
  raw: string
}

export interface MdBlock {
  kind: 'h' | 'li' | 'p'
  level: number
  segs: { text: string; code: boolean }[]
}

const DOC_RE = /\.(md|mdx|markdown|txt)$/i

const parseDiff = (diff: string): FileDiff[] => {
  const sections = diff.split(/^(?=diff --git )/m).filter((s) => s.startsWith('diff --git '))
  return sections.map((raw) => {
    const lines = raw.split('\n')
    const file = lines[0]!.match(/ b\/(.+)$/)?.[1] ?? lines[0]!
    const body = lines.filter((l) => !l.startsWith('+++') && !l.startsWith('---'))
    const added = body.filter((l) => l.startsWith('+')).map((l) => l.slice(1))
    return {
      file,
      isNew: /^new file mode/m.test(raw),
      added,
      insertions: added.length,
      deletions: body.filter((l) => l.startsWith('-')).length,
      raw,
    }
  })
}

const inline = (text: string): MdBlock['segs'] => text.replace(/\*\*/g, '').split('`').map((t, i) => ({ text: t, code: i % 2 === 1 })).filter((s) => s.text)

/** 헤딩(#), 목록(-, *, 1.), 문단만 처리하는 최소 마크다운 변환. 코드 펜스 안쪽은 문단으로 둔다 */
const renderMarkdown = (lines: string[]): MdBlock[] => {
  const blocks: MdBlock[] = []
  for (const line of lines) {
    if (!line.trim() || /^```/.test(line.trim())) continue
    const h = line.match(/^(#{1,6})\s+(.*)$/)
    const li = line.match(/^\s*(?:[-*]|\d+[.)])\s+(.*)$/)
    if (h) blocks.push({ kind: 'h', level: h[1]!.length, segs: inline(h[2]!) })
    else if (li) blocks.push({ kind: 'li', level: 0, segs: inline(li[1]!) })
    else blocks.push({ kind: 'p', level: 0, segs: inline(line.trim()) })
  }
  return blocks
}

const isDoc = (file: string): boolean => DOC_RE.test(file)

/** 에이전트 출력(ANSI 제거본)에서 의미 있는 마지막 줄들만 추린다 */
const tailLines = (output: string, count = 24): string[] =>
  output
    .split('\n')
    .map((l) => l.replace(/\r/g, '').trimEnd())
    .filter((l) => l.trim())
    .slice(-count)

export default { parseDiff, renderMarkdown, isDoc, tailLines }
