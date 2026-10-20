// 이슈 추적기: 에러·진행상 문제를 한곳에 모은다.
// 같은 문제(key)는 하나로 합치고, 다시 정상이 되면 자동으로 '해결됨'으로 바꾼다. 사용자가 '확인함'으로 표시할 수 있다.
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { dirname, resolve } from 'node:path'
import type { IssueInfo } from '@pixelboss/shared'
import { REPO_ROOT } from './config.js'

const FILE = resolve(REPO_ROOT, '.data/issues.json')
const KEEP_RESOLVED = 30

export type IssueInput = Omit<IssueInfo, 'id' | 'at' | 'status'> & { key: string }

export class IssueTracker {
  private issues: IssueInfo[] = []

  constructor(private emit: (issue: IssueInfo) => void) {
    if (existsSync(FILE)) {
      try {
        this.issues = JSON.parse(readFileSync(FILE, 'utf8'))
      } catch {
        /* 손상된 기록은 무시 */
      }
    }
  }

  list(): IssueInfo[] {
    return this.issues
  }

  /**
   * 문제를 올린다. 새로 생겼거나(또는 해결됐다가 다시 생겼으면) true — 이때만 팀장 보고 연출과 알림을 한다.
   * 이미 열려 있거나 확인함으로 표시된 같은 문제는 내용만 갱신한다.
   */
  raise(input: IssueInput): boolean {
    const { key, ...rest } = input
    const cur = this.issues.find((i) => i.id === key)
    if (!cur) {
      const issue: IssueInfo = { ...rest, id: key, at: Date.now(), status: 'open' }
      this.issues.push(issue)
      this.publish(issue)
      return true
    }
    if (cur.status === 'resolved') {
      Object.assign(cur, rest, { at: Date.now(), status: 'open' })
      this.publish(cur)
      return true
    }
    if (cur.detail !== rest.detail || cur.title !== rest.title) {
      Object.assign(cur, { title: rest.title, detail: rest.detail })
      this.publish(cur)
    }
    return false
  }

  resolve(key: string): void {
    const cur = this.issues.find((i) => i.id === key)
    if (cur && cur.status !== 'resolved') {
      cur.status = 'resolved'
      this.publish(cur)
    }
  }

  /** 프로젝트의 check 이슈 중 지금도 실패 중인 것(stillFailing)만 남기고 나머지는 해결 처리 */
  syncChecks(projectId: string, stillFailing: Set<string>): void {
    for (const i of this.issues) if (i.projectId === projectId && i.kind === 'check' && i.status !== 'resolved' && !stillFailing.has(i.id)) this.resolve(i.id)
  }

  resolveProject(projectId: string): void {
    for (const i of this.issues) if (i.projectId === projectId) this.resolve(i.id)
  }

  ack(id: string, acknowledged: boolean): void {
    const cur = this.issues.find((i) => i.id === id)
    if (!cur || cur.status === 'resolved') return
    cur.status = acknowledged ? 'acknowledged' : 'open'
    this.publish(cur)
  }

  private publish(issue: IssueInfo): void {
    this.trim()
    mkdirSync(dirname(FILE), { recursive: true })
    writeFileSync(FILE, JSON.stringify(this.issues, null, 2))
    this.emit(issue)
  }

  private trim(): void {
    const resolved = this.issues.filter((i) => i.status === 'resolved')
    for (const i of resolved.slice(0, Math.max(0, resolved.length - KEEP_RESOLVED))) this.issues.splice(this.issues.indexOf(i), 1)
  }
}
