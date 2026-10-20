// 오피스 배치도(좌표)와 이동 경로 그래프
// 바닥 z∈[-26,26], x∈[-W,W] (W 는 프로젝트 수에 따라 커진다. 기본 32). 가운데는 복도, 부서 방들, 북쪽 벽에 리포트 게시판과 사장실 별관 문.
import type { DepartmentId } from '@pixelboss/shared'

export interface Vec2 {
  x: number
  z: number
}

export interface Spot {
  /** 서 있거나 앉는 위치 */
  pos: Vec2
  /** 바라보는 방향 (라디안, +z 기준 Y축 회전) */
  facing: number
  /** 통로 쪽 진입점 */
  approach: Vec2
  /** 경로 그래프에서 연결되는 노드 */
  node: string
  sit: boolean
}

/** 부서 구역·중앙 회의실 밖의 추가 공간(바닥 색 구분용). */
export interface RoomSpec {
  id: string
  name: string
  minX: number
  maxX: number
  minZ: number
  maxZ: number
  floor: string
}

/** 이 값들은 configureLayout() 이 프로젝트 수에 맞춰 제자리에서 갱신한다 (다른 모듈은 import 한 객체를 그대로 읽는다) */
export const FLOOR = { minX: -32, maxX: 32, minZ: -26, maxZ: 26 }
/** 사장실 별관: 건물(직사각형) 북쪽 벽 바깥, 리포트 게시판 뒤. 게시판 옆 문으로 드나든다 */
export const ANNEX = { minX: -13, maxX: 13, minZ: -42, maxZ: -26, doorX: 10.6 }
export const BOARD = { x: 0, z: -25.4, width: 14, height: 3.2, y: 2 }
export const ROOMS: RoomSpec[] = []
/** 부서 방 하나에 놓이는 책상 열 수 (통로 양쪽으로 열마다 2석) */
export const LAYOUT = { cols: 3 }

/** 부서 구역 중심 (사분면) */
export const ZONES: Record<DepartmentId, { cx: number; cz: number; sx: number; sz: number }> = {
  qa: { cx: -21, cz: -14, sx: -1, sz: -1 },
  planning: { cx: 21, cz: -14, sx: 1, sz: -1 },
  // 개발팀은 서쪽 가운데 띠(통로 z=0)에 둔다. 기획팀 제안을 받아 구현한다
  dev: { cx: -21, cz: 0, sx: -1, sz: -1 },
  infra: { cx: -21, cz: 14, sx: -1, sz: 1 },
  docs: { cx: 21, cz: 14, sx: 1, sz: 1 },
}

const MIN_COLS = 3
const MEETING_W = 8

/** 북쪽 띠(z -26~-20)의 회의실, 가운데 띠의 서버실·자료실, 중앙의 탕비실, 남쪽의 라운지·복사실·전화 부스·로비·화장실·창고 */
const buildRooms = (w: number): RoomSpec[] => {
  const north = { minZ: -26, maxZ: -20 }
  const rooms: RoomSpec[] = [
    { id: 'meetingC', name: '회의실 C', minX: -24, maxX: -14, ...north, floor: '#c9b896' },
    { id: 'meetingB', name: '회의실 B', minX: -32, maxX: -24, ...north, floor: '#d0c0a0' },
    { id: 'meetingD', name: '회의실 D', minX: 14, maxX: 23, ...north, floor: '#c9b896' },
    { id: 'meetingE', name: '회의실 E', minX: 23, maxX: 32, ...north, floor: '#d0c0a0' },
    { id: 'server', name: '서버실', minX: w - 18, maxX: w - 10, minZ: -4, maxZ: 4, floor: '#aeb6c0' },
    { id: 'library', name: '자료실', minX: w - 8, maxX: w, minZ: -4, maxZ: 4, floor: '#bba98f' },
    // 중앙: 넓은 탕비실·카페 (순환 복도 x=±10.5, z=±7.5 안쪽)
    { id: 'pantry', name: '탕비실 · 카페', minX: -9, maxX: 9, minZ: -6, maxZ: 6, floor: '#d8c2a0' },
    // 남쪽 중앙축: 휴게 라운지 / 복사실 / 전화 부스 / 로비(출입구)
    { id: 'lounge', name: '휴게 라운지', minX: -10, maxX: 0, minZ: 9, maxZ: 19, floor: '#b9aea0' },
    { id: 'copy', name: '복사·인쇄실', minX: 3, maxX: 10, minZ: 9, maxZ: 13.5, floor: '#c9cdd3' },
    { id: 'booths', name: '전화 부스', minX: 3, maxX: 10, minZ: 13.5, maxZ: 19, floor: '#c4c9d1' },
    { id: 'lobby', name: '로비', minX: -10, maxX: 10, minZ: 19, maxZ: 26, floor: '#e6dfd2' },
    // 남쪽 띠: 화장실(남/여)과 창고·사물함
    { id: 'restroom', name: '화장실', minX: -19, maxX: -12, minZ: 21, maxZ: 26, floor: '#dfe5e8' },
    { id: 'storage', name: '창고 · 사물함', minX: 12, maxX: 19, minZ: 21, maxZ: 26, floor: '#cfd2d6' },
  ]
  // 건물이 넓어지면 북쪽 띠의 남는 구간을 회의실로 채운다 (바깥쪽으로 서쪽 → 동쪽 순서)
  const extra = Math.ceil((w - 32) / MEETING_W)
  const width = extra ? (w - 32) / extra : 0
  let letter = 'F'.charCodeAt(0)
  for (const side of [-1, 1]) {
    for (let i = 0; i < extra; i++) {
      const [a, b] = [32 + i * width, 32 + (i + 1) * width].map((x) => side * x).sort((p, q) => p - q) as [number, number]
      rooms.push({ id: `meeting-${side < 0 ? 'w' : 'e'}${i}`, name: `회의실 ${String.fromCharCode(letter++)}`, minX: a, maxX: b, ...north, floor: i % 2 ? '#d0c0a0' : '#c9b896' })
    }
  }
  return rooms
}

/** 프로젝트 수에 맞춰 부서 방 열 수와 건물 너비를 정한다. 6개까지는 기존 크기(W=32), 이후 2개마다 열이 하나씩 늘어난다 */
export const configureLayout = (projectCount: number): void => {
  const cols = Math.max(MIN_COLS, Math.ceil(projectCount / 2))
  const w = 2 * Math.ceil((15.5 + 5.5 * cols) / 2)
  LAYOUT.cols = cols
  FLOOR.minX = -w
  FLOOR.maxX = w
  for (const z of Object.values(ZONES)) z.cx = (z.sx * (11 + w)) / 2
  ROOMS.splice(0, ROOMS.length, ...buildRooms(w))
}
configureLayout(0)

export const facingTo = (from: Vec2, to: Vec2) => Math.atan2(to.x - from.x, to.z - from.z)

/** 경로 그래프 노드 */
export const NODES: Record<string, Vec2> = {
  'hub:qa': { x: -10.5, z: -14 },
  'hub:planning': { x: 10.5, z: -14 },
  'hub:infra': { x: -10.5, z: 14 },
  'hub:docs': { x: 10.5, z: 14 },
  'hub:dev': { x: -10.5, z: 0 },
  // 탕비실·카페 안쪽 통로(싱크 카운터와 아일랜드 사이 z=-3.6)와 휴게 라운지 입구
  pwest: { x: -8, z: -3.6 },
  pmid: { x: 0, z: -3.6 },
  peast: { x: 8, z: -3.6 },
  lw: { x: -8.8, z: 8.8 },
  le: { x: -1.2, z: 8.8 },
  // 사장실 별관: 게시판 옆 문 → 문 안쪽 → 서쪽으로 이어지는 안쪽 통로(z=-29)
  'ceo:door': { x: 10.6, z: -24 },
  'ceo:in': { x: 10.6, z: -29 },
  'ceo:eA': { x: 6.8, z: -29 },
  'ceo:aisle': { x: 0, z: -29 },
  'ceo:wA': { x: -6.4, z: -29 },
  'cor:nw': { x: -10.5, z: -7.5 },
  'cor:ne': { x: 10.5, z: -7.5 },
  'cor:sw': { x: -10.5, z: 7.5 },
  'cor:se': { x: 10.5, z: 7.5 },
  'door:w': { x: -10.5, z: 0 },
  'door:e': { x: 10.5, z: 0 },
  'mid:n': { x: 0, z: -7.5 },
  'mid:s': { x: 0, z: 7.5 },
  board: { x: 0, z: -21 },
}

const EDGES: [string, string][] = [
  ['hub:qa', 'cor:nw'],
  ['cor:nw', 'door:w'],
  ['door:w', 'cor:sw'],
  ['cor:sw', 'hub:infra'],
  ['hub:planning', 'cor:ne'],
  ['cor:ne', 'door:e'],
  ['door:e', 'cor:se'],
  ['cor:se', 'hub:docs'],
  ['cor:nw', 'mid:n'],
  ['mid:n', 'cor:ne'],
  ['cor:sw', 'mid:s'],
  ['mid:s', 'cor:se'],
  ['hub:dev', 'door:w'],
  ['door:w', 'pwest'],
  ['pwest', 'pmid'],
  ['pmid', 'peast'],
  ['peast', 'door:e'],
  ['cor:sw', 'lw'],
  ['mid:s', 'le'],
  ['ceo:door', 'board'],
  ['ceo:door', 'hub:planning'],
  ['ceo:door', 'cor:ne'],
  ['ceo:door', 'mid:n'],
  ['ceo:door', 'ceo:in'],
  ['ceo:in', 'ceo:eA'],
  ['ceo:eA', 'ceo:aisle'],
  ['ceo:aisle', 'ceo:wA'],
  ['mid:n', 'board'],
  ['hub:qa', 'board'],
  ['hub:planning', 'board'],
]

const ADJ = new Map<string, string[]>()
for (const [a, b] of EDGES) {
  ADJ.set(a, [...(ADJ.get(a) ?? []), b])
  ADJ.set(b, [...(ADJ.get(b) ?? []), a])
}

const dist = (a: Vec2, b: Vec2) => Math.hypot(a.x - b.x, a.z - b.z)

/** 노드 간 최단 경로 (다익스트라, 노드 수가 적어 단순 구현) */
export function routeNodes(from: string, to: string): string[] {
  const d = new Map<string, number>([[from, 0]])
  const prev = new Map<string, string>()
  const todo = new Set(Object.keys(NODES))
  while (todo.size) {
    let u = ''
    let best = Infinity
    for (const n of todo) if ((d.get(n) ?? Infinity) < best) ((best = d.get(n)!), (u = n))
    if (!u || u === to) break
    todo.delete(u)
    for (const v of ADJ.get(u) ?? []) {
      const alt = best + dist(NODES[u]!, NODES[v]!)
      if (alt < (d.get(v) ?? Infinity)) (d.set(v, alt), prev.set(v, u))
    }
  }
  const path = [to]
  while (path[0] !== from && prev.has(path[0]!)) path.unshift(prev.get(path[0]!)!)
  return path[0] === from ? path : [from, to]
}

/** spot → spot 이동 웨이포인트 */
export function routeBetween(a: Spot, b: Spot): Vec2[] {
  if (a.node === b.node && a.node.startsWith('hub:')) return [a.approach, b.approach, b.pos]
  const nodes = routeNodes(a.node, b.node).map((n) => NODES[n]!)
  return [a.approach, ...nodes, b.approach, b.pos]
}

// ───────────────────────── 좌석 계산 ─────────────────────────

export interface DeskSpec {
  /** 책상 중심 */
  desk: Vec2
  /** 책상 회전 (모니터가 바라보는 방향의 반대 = 앉은 사람 쪽) */
  rotation: number
  seat: Spot
}

/** 실무자 책상: 복도 쪽 열부터 바깥으로 채우고, 열마다 통로(z=cz) 북쪽/남쪽에 1석씩 둔다. 프로젝트가 늘면 열이 늘어난다 */
export function workerDesk(dept: DepartmentId, index: number): DeskSpec {
  const z = ZONES[dept]
  const col = Math.floor(index / 2)
  const row = index % 2 // 0: 통로 북쪽, 1: 통로 남쪽
  const x = z.sx * (17 + col * 5.5)
  const deskZ = z.cz + (row === 0 ? -3.2 : 3.2)
  const seatZ = z.cz + (row === 0 ? -1.6 : 1.6)
  const pos = { x, z: seatZ }
  const deskPos = { x, z: deskZ }
  return {
    desk: deskPos,
    rotation: facingTo(deskPos, pos),
    seat: { pos, facing: facingTo(pos, deskPos), approach: { x, z: z.cz }, node: `hub:${dept}`, sit: true },
  }
}

/** 팀장 책상: 구역 안쪽(회의실 쪽) 끝, 팀원들을 바라봄 */
export function leaderDesk(dept: DepartmentId): DeskSpec {
  const z = ZONES[dept]
  const deskPos = { x: z.sx * 13.2, z: z.cz - z.sz * 3.2 }
  const pos = { x: z.sx * 11.6, z: deskPos.z }
  return {
    desk: deskPos,
    rotation: facingTo(deskPos, pos),
    seat: { pos, facing: facingTo(pos, deskPos), approach: { x: z.sx * 11.6, z: z.cz }, node: `hub:${dept}`, sit: true },
  }
}

/** 사장실 별관 배치 기준점 (decor.ts 와 같은 값을 쓴다). 회의 테이블은 수족관 앞, 집무 책상은 서쪽 책장 앞 */
export const CEO = {
  table: { x: 0, z: -37, length: 8.4, depth: 2.4 },
  desk: { x: -10, z: -33 },
}

/** 사장 책상 자리: 책상 서쪽(책장 앞)에 동쪽을 보고 앉는다. 남쪽 통로로 빠져나온다 */
export function ceoDeskSpot(): Spot {
  const pos = { x: CEO.desk.x - 1.7, z: CEO.desk.z }
  return { pos, facing: Math.PI / 2, approach: { x: pos.x, z: -29 }, node: 'ceo:wA', sit: true }
}

/** 팀장이 대표에게 보고하러 가는 자리: 사장 책상 앞(손님 의자 옆)에서 서쪽의 사장을 보고 선다 */
export function ceoReportSpot(): Spot {
  const pos = { x: -6.9, z: CEO.desk.z }
  return { pos, facing: -Math.PI / 2, approach: { x: pos.x, z: -29 }, node: 'ceo:wA', sit: false }
}

/** 사장의 회의 테이블 상석(서쪽 머리 자리) */
export function ceoMeetingSpot(): Spot {
  const pos = { x: CEO.table.x - CEO.table.length / 2 - 0.9, z: CEO.table.z }
  return { pos, facing: Math.PI / 2, approach: { x: -6.4, z: CEO.table.z }, node: 'ceo:wA', sit: true }
}

/**
 * 전체 소집 위치: 사장실 회의 테이블 주위(서서 면담). 남쪽 3명·북쪽 2명.
 * 남쪽은 안쪽 통로에서 곧바로 내려오고, 북쪽은 서쪽 끝을 돌아 수족관 앞 통로로 접근해 테이블을 가로지르지 않는다.
 */
export function meetingSeat(dept: DepartmentId): Spot {
  const t = CEO.table
  const slots: Record<DepartmentId, { x: number; north: boolean }> = {
    qa: { x: t.x - 2.6, north: false },
    planning: { x: t.x, north: false },
    dev: { x: t.x + 2.6, north: false },
    infra: { x: t.x - 1.3, north: true },
    docs: { x: t.x + 1.3, north: true },
  }
  const { x, north } = slots[dept]
  const pos = { x, z: t.z + (north ? -1.6 : 1.6) }
  return north
    ? { pos, facing: facingTo(pos, t), approach: { x: -6.4, z: pos.z }, node: 'ceo:wA', sit: false }
    : { pos, facing: facingTo(pos, t), approach: { x, z: -29 }, node: 'ceo:aisle', sit: false }
}

/** 게시판 앞 위치 */
export function boardSpot(seq: number): Spot {
  const x = -5 + (seq % 6) * 2
  const pos = { x, z: -23.6 }
  return { pos, facing: Math.PI, approach: { x, z: -21 }, node: 'board', sit: false }
}

/** 실무자 옆에 서는 위치 (팀장이 업무 전달할 때) */
export function besideSpot(seat: Spot, dept: DepartmentId): Spot {
  const pos = { x: seat.pos.x - ZONES[dept].sx * 1.2, z: seat.approach.z }
  return { pos, facing: facingTo(pos, seat.pos), approach: seat.approach, node: seat.node, sit: false }
}

// ───────────────────────── 휴식 장소 (탕비실·카페, 휴게 라운지) ─────────────────────────

export type BreakKind = 'coffee' | 'fridge' | 'water' | 'vending' | 'stool' | 'dining' | 'sofa' | 'armchair'

export interface BreakSpot extends Spot {
  id: string
  kind: BreakKind
  /** 도착 뒤 취하는 동작: use=기계 조작, drink=서서 마시기, sit=앉아서 쉬기 */
  pose: 'use' | 'drink' | 'sit'
}

const brk = (id: string, kind: BreakKind, pos: Vec2, faceTo: Vec2, approach: Vec2, node: string, pose: BreakSpot['pose']): BreakSpot => ({
  id,
  kind,
  pos,
  facing: facingTo(pos, faceTo),
  approach,
  node,
  sit: pose === 'sit',
  pose,
})

/** decor.ts 의 탕비실·라운지 가구 배치와 같은 좌표를 쓴다. 접근 지점은 가구를 가로지르지 않는 통로 위에 둔다 */
export const BREAK_SPOTS: BreakSpot[] = [
  // 탕비실: 커피머신·냉장고·정수기·자판기 앞에 서서
  brk('coffee-1', 'coffee', { x: 0.6, z: -4.1 }, { x: 0.6, z: -5.3 }, { x: 0.6, z: -3.6 }, 'pmid', 'use'),
  brk('coffee-2', 'coffee', { x: 1.8, z: -4.1 }, { x: 1.8, z: -5.3 }, { x: 1.8, z: -3.6 }, 'pmid', 'use'),
  brk('fridge', 'fridge', { x: -7.3, z: -4.0 }, { x: -7.3, z: -5.1 }, { x: -7.3, z: -3.6 }, 'pwest', 'use'),
  brk('water', 'water', { x: 4.2, z: -4.1 }, { x: 4.2, z: -5.0 }, { x: 4.2, z: -3.6 }, 'peast', 'drink'),
  brk('vending', 'vending', { x: 6.6, z: -4.1 }, { x: 6.6, z: -5.0 }, { x: 6.6, z: -3.6 }, 'peast', 'use'),
  // 아일랜드 스툴과 식탁 의자에 앉아서 (양쪽 바깥 가장자리만: 다른 좌석을 가로지르지 않도록)
  brk('stool-w', 'stool', { x: -2.5, z: -0.6 }, { x: -2.5, z: -2 }, { x: -4, z: -0.6 }, 'pwest', 'sit'),
  brk('stool-e', 'stool', { x: 2.5, z: -0.6 }, { x: 2.5, z: -2 }, { x: 4, z: -0.6 }, 'peast', 'sit'),
  brk('dine-w1', 'dining', { x: -6.85, z: 1.9 }, { x: -5.6, z: 1.9 }, { x: -8, z: 1.9 }, 'pwest', 'sit'),
  brk('dine-w2', 'dining', { x: -6.85, z: 4.7 }, { x: -5.6, z: 4.7 }, { x: -8, z: 4.7 }, 'pwest', 'sit'),
  brk('dine-e1', 'dining', { x: 6.85, z: 1.9 }, { x: 5.6, z: 1.9 }, { x: 8, z: 1.9 }, 'peast', 'sit'),
  brk('dine-e2', 'dining', { x: 6.85, z: 4.7 }, { x: 5.6, z: 4.7 }, { x: 8, z: 4.7 }, 'peast', 'sit'),
  // 휴게 라운지: TV 를 보며 소파·안락의자에 앉아서
  brk('sofa-w', 'sofa', { x: -6.5, z: 14.25 }, { x: -6.5, z: 9.8 }, { x: -6.5, z: 11 }, 'lw', 'sit'),
  brk('sofa-e', 'sofa', { x: -3.5, z: 14.25 }, { x: -3.5, z: 9.8 }, { x: -3.5, z: 11 }, 'le', 'sit'),
  brk('chair-w', 'armchair', { x: -8.8, z: 12.6 }, { x: -5, z: 12.6 }, { x: -8.8, z: 10.9 }, 'lw', 'sit'),
  brk('chair-e', 'armchair', { x: -1.4, z: 12.6 }, { x: -5, z: 12.6 }, { x: -1.4, z: 10.9 }, 'le', 'sit'),
]
