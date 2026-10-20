// Octokit 연동 (선택). GITHUB_TOKEN 이 없으면 모든 함수가 조용히 건너뛴다.
import { Octokit } from 'octokit'
import type { ProjectConfig } from '@pixelboss/shared'

let client: Octokit | null | undefined

function octokit(): Octokit | null {
  if (client === undefined) client = process.env.GITHUB_TOKEN ? new Octokit({ auth: process.env.GITHUB_TOKEN }) : null
  return client
}

/** 열린 이슈 수 (PR 제외). 정적 필터 보조 신호로만 쓴다. */
export async function countOpenIssues(p: ProjectConfig): Promise<number | undefined> {
  const gh = octokit()
  if (!gh || !p.github) return undefined
  try {
    const { data } = await gh.rest.search.issuesAndPullRequests({
      q: `repo:${p.github.owner}/${p.github.repo} is:issue is:open`,
      per_page: 1,
    })
    return data.total_count
  } catch {
    return undefined
  }
}

/** 승인된 변경을 브랜치로 푸시한 뒤 PR 생성 (PIXELBOSS_GITHUB_PR=1 일 때만) */
export async function openPullRequest(p: ProjectConfig, branch: string, title: string, body: string): Promise<string | undefined> {
  const gh = octokit()
  if (!gh || !p.github || process.env.PIXELBOSS_GITHUB_PR !== '1') return undefined
  const { data } = await gh.rest.pulls.create({
    owner: p.github.owner,
    repo: p.github.repo,
    head: branch,
    base: p.github.baseBranch ?? 'main',
    title,
    body,
  })
  return data.html_url
}
