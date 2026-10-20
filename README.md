<img src="docs/logo.svg" alt="PixelBoss 로고" width="96" />

# PixelBoss (AI Virtual Company)

로컬·GitHub 프로젝트 6개를 24시간 관리하는 **복셀 3D 가상 오피스 대시보드**입니다.
사용자가 회의실에 팀장들을 소집해 상위 지시를 내리면, 팀장이 부서 실무진에게 태스크를 나누고
각 실무 에이전트가 백엔드의 독립된 Claude Code PTY 세션으로 실제 프로젝트 코드를 수정합니다.

![오피스 전경](docs/screenshots/01-office-iso.png)

## 빠르게 실행하기

```bash
pnpm install
pnpm fixtures        # 검증용 가상 프로젝트 6개를 ./fixtures 에 생성 (선택)
pnpm dev             # 백엔드(ws://127.0.0.1:4100) + 프론트엔드(http://localhost:3000)
```

기본 실행기는 **mock** 이라 LLM 을 호출하지 않습니다. 실제 Claude Code 로 돌리려면:

```bash
PIXELBOSS_RUNNER=claude pnpm dev   # 또는 config/projects.json 의 runner.mode 를 "claude" 로
```

`claude` CLI 가 설치·로그인되어 있어야 합니다. 각 세션은 `claude -p "<하위 프롬프트>" --permission-mode acceptEdits --output-format stream-json`
으로 해당 프로젝트 디렉터리(cwd)에서 실행되고, 프로젝트에 설정한 검사 명령만 `--allowedTools` 로 추가 허용합니다.

## 내 프로젝트 연결하기

`config/projects.json` 을 `config/projects.local.json` 으로 복사한 뒤(이 파일은 git 에 올라가지 않음) 경로를 바꿉니다.

```jsonc
{
  "runner": { "mode": "claude", "maxParallel": 6, "timeoutSec": 900 },
  "scan": { "intervalSec": 300, "runChecks": true },
  "projects": [
    {
      "id": "shop-web",
      "name": "Shop Web",
      "path": "/Users/me/dev/shop-web",                  // 로컬 절대 경로
      "github": { "owner": "me", "repo": "shop-web" },     // 선택: Octokit 연동
      "checks": { "typecheck": "pnpm tsc --noEmit", "lint": "pnpm eslint .", "test": "pnpm test" }
    }
  ]
}
```

| 환경 변수 | 설명 |
| --- | --- |
| `PIXELBOSS_RUNNER` | `mock` / `claude` 실행기 전환 |
| `PIXELBOSS_CONFIG` | 설정 파일 경로 직접 지정 |
| `PIXELBOSS_PORT`, `PIXELBOSS_HOST` | 백엔드 포트(기본 4100), 바인드 주소(기본 127.0.0.1) |
| `GITHUB_TOKEN` | 열린 이슈 수 조회 (정적 필터 보조 신호) |
| `PIXELBOSS_GITHUB_PR=1` | 승인 시 `pixelboss/<지시ID>` 브랜치 푸시 + PR 생성 |

## 동작 방식

```
사용자 ── 전체 소집 입력 ──▶ 오케스트레이터
                              │ ① 팀장 소집 (3D: 팀장들이 회의실로)
                              │ ② 1차 정적 필터: git status/diff + 타입/린트/테스트 검사
                              │ ③ 규칙 기반 명령 분해 → 부서 × 프로젝트 하위 프롬프트
                              │    신호 없는 프로젝트는 건너뜀 (LLM 호출 0)
                              │ ④ 업무 하달 (3D: 팀장이 실무자에게 걸어가 전달)
                              ▼
                PtyManager ── node-pty × N (프로젝트끼리 병렬, 같은 프로젝트는 부서 순서대로 직렬)
                              │ 상태(대기열/진행 중/입력 대기/완료/오류) → WebSocket → 3D 캐릭터 FSM
                              ▼
                팀장 취합 ── 작업 직전 스냅샷 대비 git diff → 최종 변경 승인 카드
                              ├ 승인: 에이전트가 바꾼 파일만 커밋 (기존 미커밋 변경은 건드리지 않음)
                              └ 반려: 작업 직전 상태로 복원, 패치는 .data/rejected 에 보관
```

### 토큰 절약 원칙
- 명령 분해는 LLM 없이 키워드 규칙과 정적 필터 결과로만 합니다.
- 부서별 신호: QA = 실패한 검사/변경, 기획 = 변경 파일, 인프라 = 빌드·감사 실패나 의존성 파일 변경, 문서 = 마지막 기록 이후 새 커밋.
- 신호가 없는 프로젝트는 "Clean" 으로 남기고 PTY 를 띄우지 않습니다. 강제로 전부 돌리려면 지시에 `강제` 또는 `--all` 을 넣습니다.
- 하위 프롬프트에 변경 파일 목록과 에러 로그 앞부분을 넣어 주므로 Claude 가 저장소를 다시 훑을 필요가 없습니다.
- 주기 스캔은 git 핑거프린트가 바뀐 프로젝트만 검사 명령을 다시 실행합니다.

### 3D 오피스
- 4개 부서 구역(QA·기획·인프라·문서) × 실무자 6명 + 팀장 1명, 중앙 회의실, 북쪽 벽 리포트 게시판.
- 기본 시점은 45° 아이소메트릭. 마우스를 **아래로 끌면 수직 탑뷰**, **위로 끌면 수평 사이드 뷰**, 좌우로 끌면 회전합니다.
- 캐릭터 상태: 평상시 타이핑, 소집 시 팀장 회의실 집결, 하달 시 팀장이 실무자에게 이동,
  작업 중 주황 톱니바퀴, 이슈 시 빨간 느낌표 후 회의실 보고, 완료 시 녹색 체크 후 게시판에 서류 부착.
- 실무자 클릭: 프로젝트 상태·에러 로그·하위 프롬프트·실시간 PTY 터미널(xterm.js, 키 입력 전달 가능).
- 팀장 클릭: 부서 통합 브리핑 대시보드.

## 검증

```bash
pnpm typecheck   # shared / server / web 타입 검사
pnpm verify      # 백엔드 통합 검증: 가상 프로젝트 6개 → 정적 필터 → 소집 → PTY 병렬 → 승인/반려 → Clean 시 토큰 0
pnpm fixtures && pnpm dev   # 다른 터미널에서 ↓
pnpm verify:ui   # 브라우저 통합 검증 (Playwright, 스크린샷은 docs/screenshots)
```

## 구조

```
config/projects.json         대상 프로젝트 템플릿
packages/shared              프론트/백 공용 타입과 WebSocket 프로토콜
apps/server                  Node.js 오케스트레이터
  src/pty-manager.ts         node-pty 다중 세션 관리자 (동시 실행 제한, 입력 대기 감지)
  src/git.ts                 git 델타 감지 + 작업 전후 스냅샷
  src/planner.ts             상위 명령 → 하위 프롬프트 분해
  src/orchestrator.ts        소집 → 분해 → 실행 → 취합 → 승인/반려
  bin/claude-stream.mjs      실제 Claude Code 실행 래퍼 (stream-json → 터미널 출력)
  bin/mock-claude.mjs        LLM 없이 흐름을 검증하는 목 실행기
apps/web                     Nuxt 4 + Three.js 프론트엔드
  app/utils/voxel/           복셀 월드, 캐릭터 FSM, 연출 감독, 카메라
scripts/                     가상 프로젝트 생성, 통합 검증
```
