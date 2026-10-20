// 오피스 배치도(좌표)와 이동 경로 그래프
// 바닥 x∈[-32,32], z∈[-26,26]. 중앙 회의실, 4개 부서 구역(사분면), 북쪽 벽에 리포트 게시판.
import type { DepartmentId } from '@voxelhq/shared'

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

export const FLOOR = { minX: -32, maxX: 32, minZ: -26, maxZ: 26 }
export const ROOM = { minX: -8, maxX: 8, minZ: -5, maxZ: 5 }
export const BOARD = { x: 0, z: -25.4, width: 14, height: 3.2, y: 2 }

/** 부서 구역 중심 (사분면) */
export const ZONES: Record<DepartmentId, { cx: number; cz: number; sx: number; sz: number }> = {
  qa: { cx: -21, cz: -14, sx: -1, sz: -1 },
  planning: { cx: 21, cz: -14, sx: 1, sz: -1 },
  infra: { cx: -21, cz: 14, sx: -1, sz: 1 },
  docs: { cx: 21, cz: 14, sx: 1, sz: 1 },
}

export const facingTo = (from: Vec2, to: Vec2) => Math.atan2(to.x - from.x, to.z - from.z)

/** 경로 그래프 노드 */
export const NODES: Record<string, Vec2> = {
  'hub:qa': { x: -10.5, z: -14 },
  'hub:planning': { x: 10.5, z: -14 },
  'hub:infra': { x: -10.5, z: 14 },
  'hub:docs': { x: 10.5, z: 14 },
  'cor:nw': { x: -10.5, z: -7.5 },
  'cor:ne': { x: 10.5, z: -7.5 },
  'cor:sw': { x: -10.5, z: 7.5 },
  'cor:se': { x: 10.5, z: 7.5 },
  'door:w': { x: -10.5, z: 0 },
  'door:e': { x: 10.5, z: 0 },
  'in:w': { x: -6.5, z: 0 },
  'in:e': { x: 6.5, z: 0 },
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
  ['door:w', 'in:w'],
  ['door:e', 'in:e'],
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

/** 실무자 책상: 구역마다 2열 × 3석, 가운데 통로(z=cz)를 사이에 두고 마주 보지 않게 바깥쪽을 향함 */
export function workerDesk(dept: DepartmentId, index: number): DeskSpec {
  const z = ZONES[dept]
  const col = index % 3
  const row = Math.floor(index / 3) // 0: 통로 북쪽, 1: 통로 남쪽
  const x = z.cx + (col - 1) * 5.5 + z.sx * 1.5
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

/** 회의실 테이블 좌석 (팀장 4명) */
export function meetingSeat(dept: DepartmentId): Spot {
  const order: DepartmentId[] = ['qa', 'planning', 'infra', 'docs']
  const i = order.indexOf(dept)
  const x = i % 2 === 0 ? -2.6 : 2.6
  const z = i < 2 ? -2.4 : 2.4
  const pos = { x, z }
  return { pos, facing: facingTo(pos, { x, z: 0 }), approach: { x: x < 0 ? -5 : 5, z: z < 0 ? -2.4 : 2.4 }, node: x < 0 ? 'in:w' : 'in:e', sit: false }
}

/** 회의실 대기 위치 (이슈 보고하러 온 실무자) */
export function meetingStandSpot(seq: number): Spot {
  const side = seq % 2 === 0 ? -1 : 1
  const k = Math.floor(seq / 2) % 6
  const pos = { x: side * (5.2 + (k % 3) * 1.0), z: -2 + Math.floor(k / 3) * 4 }
  return { pos, facing: facingTo(pos, { x: 0, z: 0 }), approach: { x: side * 6.5, z: pos.z }, node: side < 0 ? 'in:w' : 'in:e', sit: false }
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
