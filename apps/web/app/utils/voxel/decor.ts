// 사무실 장식: 방 칸막이, 가구, 식물, 출입구.
// 캐릭터 이동 경로(layout.ts 의 NODES/EDGES)와 겹치지 않는 곳에만 배치한다.
// 카메라가 남동쪽에서 내려다보므로 남·동쪽 벽은 유리로, 북·서쪽 벽은 불투명하게 만든다.
import * as THREE from 'three'
import { DEPARTMENTS } from '@pixelboss/shared'
import { ANNEX, CEO, FLOOR, LAYOUT, ROOMS, ZONES, workerDesk, type Vec2 } from './layout'
import { box, boxGeo, mat, textSprite } from './world'

const GLASS = new THREE.MeshLambertMaterial({ color: '#bfe3ff', transparent: true, opacity: 0.3, depthWrite: false })
const FRAME = '#8aa0b4'
const WALL = '#ece6da'
const BOOKS = ['#c0392b', '#2e86c1', '#27ae60', '#f1c40f', '#8e44ad', '#e67e22', '#ecf0f1', '#16a085']
const ledMats = new Map<string, THREE.MeshBasicMaterial>()

const led = (color: string): THREE.MeshBasicMaterial => {
  let m = ledMats.get(color)
  if (!m) ledMats.set(color, (m = new THREE.MeshBasicMaterial({ color })))
  return m
}

const room = (id: string): (typeof ROOMS)[number] => ROOMS.find((r) => r.id === id)!

const put = (root: THREE.Group, o: THREE.Object3D, x: number, z: number, rot = 0, y = 0): void => {
  o.position.set(x, y, z)
  o.rotation.y = rot
  root.add(o)
}

// ───────────────────────── 벽 / 유리 칸막이 ─────────────────────────

interface WallOpts {
  h: number
  glass?: boolean
  color?: string
  /** 문(2칸 폭)이 뚫리는 위치의 중심 좌표 (벽이 따라가는 축 기준) */
  door?: number
}

/** a→b 직선(x축 또는 z축과 평행)을 2칸 단위 세그먼트로 세운다 */
const wall = (root: THREE.Group, a: Vec2, b: Vec2, o: WallOpts): void => {
  const alongX = a.z === b.z
  const lo = alongX ? Math.min(a.x, b.x) : Math.min(a.z, b.z)
  const hi = alongX ? Math.max(a.x, b.x) : Math.max(a.z, b.z)
  const gap: [number, number][] = []
  for (let t = lo; t < hi; t += 2) {
    const len = Math.min(2, hi - t)
    const c = t + len / 2
    if (o.door !== undefined && Math.abs(c - o.door) < 1.01) {
      gap.push([t, t + len])
      continue
    }
    const x = alongX ? c : a.x
    const z = alongX ? a.z : c
    const [w, d] = alongX ? [len, 0.2] : [0.2, len]
    if (o.glass) {
      root.add(box(alongX ? len : 0.3, 0.25, alongX ? 0.3 : len, FRAME, x, 0, z))
      root.add(box(alongX ? len : 0.12, o.h - 0.25, alongX ? 0.12 : len, GLASS, x, 0.25, z, false))
      root.add(box(w, 0.12, d, FRAME, x, o.h - 0.12, z))
    } else {
      root.add(box(w, o.h, d, o.color ?? WALL, x, 0, z))
      root.add(box(alongX ? len : 0.3, 0.2, alongX ? 0.3 : len, '#bdb4a3', x, 0, z))
    }
  }
  // 문 기둥은 실제로 뚫린 구간의 양 끝에 세운다
  if (gap.length) {
    for (const e of [Math.min(...gap.map((g) => g[0])), Math.max(...gap.map((g) => g[1]))]) {
      root.add(box(0.3, o.h, 0.3, FRAME, alongX ? e : a.x, 0, alongX ? a.z : e))
    }
  }
}

const sign = (root: THREE.Group, text: string, x: number, y: number, z: number, bg = 'rgba(30,30,40,0.8)', color = '#fff'): void => {
  const s = textSprite(text, { bg, color, size: 38, scale: 0.7 })
  s.position.set(x, y, z)
  root.add(s)
}

// ───────────────────────── 식물 ─────────────────────────

/** 잎이 방사형으로 퍼지는 화분 식물 (몬스테라·고사리 공통) */
const leafy = (potColor: string, potH: number, leaf: string, n: number, len: number, y: number): THREE.Group => {
  const g = new THREE.Group()
  g.add(box(0.8, potH, 0.8, potColor))
  g.add(box(0.12, y - potH + 0.1, 0.12, '#5a7d3a', 0, potH))
  for (let i = 0; i < n; i++) {
    const arm = new THREE.Group()
    arm.rotation.y = (i / n) * Math.PI * 2
    arm.position.y = y + (i % 3) * 0.3
    const plate = box(len, 0.08, len * 0.6, leaf, len / 2 + 0.1, 0, 0, false)
    plate.rotation.z = 0.35
    arm.add(plate)
    g.add(arm)
  }
  return g
}

const monstera = (): THREE.Group => leafy('#3d4350', 0.8, '#2f8f4e', 6, 0.9, 1.2)
const fern = (): THREE.Group => leafy('#c9b79c', 0.5, '#4aa55a', 8, 0.7, 0.8)

/** 스투키·산세베리아: 뾰족하게 선 잎 */
const snakePlant = (): THREE.Group => {
  const g = new THREE.Group()
  g.add(box(0.8, 0.6, 0.8, '#f2efe9'))
  const leaves: [number, number, number][] = [[0, 0, 1.9], [0.2, 0.1, 1.5], [-0.2, 0.1, 1.6], [0.1, -0.2, 1.3], [-0.1, -0.2, 1.7], [0.25, -0.1, 1.2]]
  leaves.forEach(([x, z, h], i) => g.add(box(0.16, h, 0.16, i % 2 ? '#2f7d4f' : '#3f9b5f', x, 0.6, z, false)))
  return g
}

/** 책상·테이블 위에 올리는 작은 다육식물 */
const succulent = (): THREE.Group => {
  const g = new THREE.Group()
  g.add(box(0.45, 0.3, 0.45, '#f2efe9'))
  for (const [x, z, h] of [[0, 0, 0.45], [0.12, 0.08, 0.3], [-0.12, -0.06, 0.3]] as const) g.add(box(0.14, h, 0.14, '#6fbf8b', x, 0.3, z, false))
  return g
}

// ───────────────────────── 가구 ─────────────────────────

const chair = (color = '#3d3d46'): THREE.Group => {
  const g = new THREE.Group()
  g.add(box(0.7, 0.08, 0.7, '#222'))
  g.add(box(0.14, 0.6, 0.14, '#222', 0, 0.08))
  g.add(box(0.8, 0.14, 0.8, color, 0, 0.65))
  g.add(box(0.8, 0.9, 0.12, color, 0, 0.8, -0.4))
  return g
}

const stool = (color = '#e0a458'): THREE.Group => {
  const g = new THREE.Group()
  g.add(box(0.14, 0.8, 0.14, '#555'))
  g.add(box(0.8, 0.14, 0.8, color, 0, 0.8))
  return g
}

const table = (w: number, d: number, h = 1.3, top = '#7a5233', leg = '#4e3420'): THREE.Group => {
  const g = new THREE.Group()
  g.add(box(w, 0.15, d, top, 0, h - 0.15))
  for (const sx of [-1, 1]) for (const sz of [-1, 1]) g.add(box(0.2, h - 0.15, 0.2, leg, sx * (w / 2 - 0.2), 0, sz * (d / 2 - 0.2)))
  return g
}

/** 앞면은 로컬 +z */
const sofa = (w: number, color: string, cushion: string): THREE.Group => {
  const g = new THREE.Group()
  g.add(box(w, 0.6, 1.1, color, 0, 0.15, 0.1))
  g.add(box(w, 1.0, 0.35, color, 0, 0.75, -0.45))
  for (const s of [-1, 1]) g.add(box(0.35, 0.55, 1.1, color, s * (w / 2 - 0.175), 0.75, 0.1))
  g.add(box(w - 0.8, 0.2, 0.85, cushion, 0, 0.75, 0.15))
  return g
}

/** 앞면은 로컬 +z */
const bookshelf = (w: number, h = 2.8): THREE.Group => {
  const g = new THREE.Group()
  g.add(box(w, h, 0.7, '#6b4a2f'))
  const rows = Math.floor(h / 0.9)
  for (let r = 0; r < rows; r++) {
    const y = 0.2 + r * 0.85
    g.add(box(w - 0.2, 0.08, 0.6, '#4a3220', 0, y, 0.05))
    let x = -w / 2 + 0.25
    for (let i = 0; x < w / 2 - 0.3; i++) {
      const bh = 0.45 + ((i * 7 + r * 3) % 4) * 0.08
      g.add(box(0.16, bh, 0.45, BOOKS[(i + r * 3) % BOOKS.length]!, x, y + 0.08, 0.08, false))
      x += 0.22
    }
  }
  return g
}

/** 서버 랙: LED 가 켜진 앞면은 로컬 +z */
const rack = (): THREE.Group => {
  const g = new THREE.Group()
  g.add(box(1.2, 3, 1.1, '#2b2f3a'))
  for (let r = 0; r < 8; r++) {
    g.add(box(1.0, 0.22, 0.05, '#3a4050', 0, 0.2 + r * 0.33, 0.55, false))
    const m = led((r * 3) % 5 === 0 ? '#ffb020' : '#46e06f')
    const dot = new THREE.Mesh(new THREE.BoxGeometry(0.1, 0.08, 0.04), m)
    dot.position.set(0.35, 0.2 + r * 0.33 + 0.11, 0.58)
    g.add(dot)
  }
  return g
}

const fileCabinet = (): THREE.Group => {
  const g = new THREE.Group()
  g.add(box(1.8, 1.5, 0.8, '#9aa5b1'))
  for (let i = 0; i < 3; i++) {
    g.add(box(1.6, 0.04, 0.04, '#6f7a86', 0, 0.35 + i * 0.4, 0.41, false))
    g.add(box(0.5, 0.06, 0.06, '#d5dbe0', 0, 0.5 + i * 0.4 - 0.1, 0.43, false))
  }
  return g
}

const printer = (): THREE.Group => {
  const g = new THREE.Group()
  g.add(box(1.2, 0.5, 0.9, '#d9dde2'))
  g.add(box(0.9, 0.12, 0.6, '#aeb6be', 0, 0.5))
  g.add(box(0.7, 0.05, 0.4, '#fbfaf5', 0.1, 0.62, 0.4, false))
  return g
}

const fridge = (): THREE.Group => {
  const g = new THREE.Group()
  g.add(box(1.6, 3.4, 1.4, '#e3e7ea'))
  g.add(box(1.62, 0.06, 1.42, '#b9c0c6', 0, 2.3))
  g.add(box(0.08, 0.8, 0.08, '#8a8f94', 0.55, 1.2, 0.72, false))
  g.add(box(0.08, 0.5, 0.08, '#8a8f94', 0.55, 2.55, 0.72, false))
  return g
}

const vending = (): THREE.Group => {
  const g = new THREE.Group()
  g.add(box(1.6, 3.2, 1.2, '#d94b4b'))
  g.add(box(1.2, 2.0, 0.05, '#2a3b50', -0.1, 0.9, 0.62, false))
  for (let r = 0; r < 4; r++) for (let c = 0; c < 4; c++) g.add(box(0.2, 0.3, 0.06, BOOKS[(r * 4 + c) % BOOKS.length]!, -0.55 + c * 0.3, 1.0 + r * 0.45, 0.65, false))
  g.add(box(0.25, 0.5, 0.06, '#111', 0.62, 1.3, 0.62, false))
  return g
}

const waterDispenser = (): THREE.Group => {
  const g = new THREE.Group()
  g.add(box(0.8, 1.3, 0.8, '#eef2f5'))
  g.add(box(0.6, 0.9, 0.6, '#7fc8ff', 0, 1.3))
  g.add(box(0.1, 0.1, 0.1, '#e74c3c', -0.15, 0.9, 0.41, false))
  g.add(box(0.1, 0.1, 0.1, '#3498db', 0.15, 0.9, 0.41, false))
  return g
}

const trash = (): THREE.Group => {
  const g = new THREE.Group()
  g.add(box(0.6, 0.8, 0.6, '#7b8794'))
  g.add(box(0.66, 0.08, 0.66, '#59636e', 0, 0.8))
  return g
}

const floorLamp = (): THREE.Group => {
  const g = new THREE.Group()
  g.add(box(0.5, 0.08, 0.5, '#333'))
  g.add(box(0.1, 2.6, 0.1, '#444', 0, 0.08))
  g.add(box(0.7, 0.6, 0.7, '#ffe9a8', 0, 2.5, 0, false))
  return g
}

// ───────────────────────── 방 구성 ─────────────────────────

/** 가림막(스크린) 한 줄: 개구부(통로)를 뺀 구간만 낮은 패널로 세운다. 높이는 허리~어깨 정도라 시야는 트이되 동선과 소음을 나눈다 */
const screens = (root: THREE.Group, a: Vec2, b: Vec2, o: { h: number; color: string; openings?: [number, number][] }): void => {
  const alongX = a.z === b.z
  const lo = alongX ? Math.min(a.x, b.x) : Math.min(a.z, b.z)
  const hi = alongX ? Math.max(a.x, b.x) : Math.max(a.z, b.z)
  const open = [...(o.openings ?? [])].sort((p, q) => p[0] - q[0])
  const pieces: [number, number][] = []
  let cur = lo
  for (const [from, to] of open) {
    if (from > cur) pieces.push([cur, Math.min(from, hi)])
    cur = Math.max(cur, to)
  }
  if (cur < hi) pieces.push([cur, hi])
  for (const [from, to] of pieces) {
    const len = to - from
    if (len <= 0.01) continue
    const mid = (from + to) / 2
    const x = alongX ? mid : a.x
    const z = alongX ? a.z : mid
    root.add(box(alongX ? len : 0.14, o.h, alongX ? 0.14 : len, o.color, x, 0.15, z))
    root.add(box(alongX ? len : 0.22, 0.08, alongX ? 0.22 : len, '#f4f3ef', x, 0.15 + o.h, z, false)) // 상단 마감
    for (const e of [from, to]) root.add(box(0.2, 0.18, 0.2, '#9aa0a8', alongX ? e : a.x, 0, alongX ? a.z : e, false)) // 받침발
  }
}

const mutedHex = (color: string, toward: string, t: number): string => '#' + new THREE.Color(color).lerp(new THREE.Color(toward), t).getHexString()

/** 부서 구역: 책상 열 사이 큐비클 패널, 서류함, 화이트보드. 소음 나는 복합기는 복사실로 옮겼다 */
const buildZones = (root: THREE.Group, projectCount: number): void => {
  const usedCols = Math.ceil(projectCount / 2)
  for (const d of DEPARTMENTS) {
    const z = ZONES[d.id]
    const fabric = mutedHex(d.color, '#d8dce2', 0.62)
    for (let c = 0; c < usedCols - 1; c++) {
      const bx = (workerDesk(d.id, 2 * c).desk.x + workerDesk(d.id, 2 * c + 2).desk.x) / 2
      for (const row of [0, 1]) {
        const dz = workerDesk(d.id, row).desk.z
        root.add(box(0.14, 1.5, 2.8, mat(fabric), bx, 0.12, dz))
        root.add(box(0.2, 0.08, 2.9, '#f4f3ef', bx, 1.62, dz, false))
      }
    }
    const backZ = z.cz + z.sz * 5.2
    const rot = z.sz < 0 ? 0 : Math.PI
    for (let k = 0; k < LAYOUT.cols; k++) put(root, fileCabinet(), z.cx + (k - (LAYOUT.cols - 1) / 2) * 2.2, backZ, rot)
    put(root, snakePlant(), z.sx * (FLOOR.maxX - 1.8), backZ)
    // 팀 화이트보드: 구역 바깥쪽 끝에서 통로를 향한다
    const wbx = z.sx * (FLOOR.maxX - 0.8)
    put(root, whiteboard(), wbx, z.cz, z.sx < 0 ? Math.PI / 2 : -Math.PI / 2)
  }
}

/** 이동식 화이트보드 (앞면은 로컬 +z) */
const whiteboard = (): THREE.Group => {
  const g = new THREE.Group()
  g.add(box(3, 1.8, 0.1, '#fdfdfd', 0, 1.0, 0))
  g.add(box(3.1, 0.08, 0.14, '#9aa0a8', 0, 0.95, 0))
  g.add(box(0.12, 1.0, 0.12, '#8a9099', -1.2, 0, 0))
  g.add(box(0.12, 1.0, 0.12, '#8a9099', 1.2, 0, 0))
  g.add(box(1.0, 0.07, 0.03, '#2e86c1', -0.5, 2.2, 0.06, false))
  g.add(box(1.5, 0.07, 0.03, '#c0392b', 0.2, 1.8, 0.06, false))
  g.add(box(0.8, 0.07, 0.03, '#27ae60', -0.7, 1.45, 0.06, false))
  return g
}

/** 부서별 오픈 오피스 경계: 유리방 대신 가림막으로 구역을 나누고, 복도 쪽에 통로(개구부)를 둔다. 개발팀은 집중이 필요해 더 높게 */
const buildDeptRooms = (root: THREE.Group): void => {
  for (const d of DEPARTMENTS) {
    const z = ZONES[d.id]
    const [x0, x1] = z.sx < 0 ? [FLOOR.minX, -11] : [11, FLOOR.maxX]
    const [z0, z1] = [z.cz - 6, z.cz + 6]
    const color = mutedHex(d.color, '#d8dce2', 0.55)
    const h = d.id === 'dev' ? 1.9 : 1.3
    // 복도(허브 노드) 쪽 경계: 책상 통로 높이에 4칸 개구부
    screens(root, { x: z.sx * 11, z: z0 }, { x: z.sx * 11, z: z1 }, { h, color, openings: [[z.cz - 2.4, z.cz + 2.4]] })
    // 가로 경계: 구역마다 3칸 통로를 두 곳 낸다 (복도 쪽 모서리 근처와 중간)
    const gaps = (): [number, number][] => ([[13, 16], [25, 28]] as const).map(([from, to]) => (z.sx < 0 ? [-to, -from] : [from, to]) as [number, number])
    const edges = d.id === 'dev' ? [z0, z1] : [z.sz < 0 ? z1 : z0]
    for (const ez of edges) screens(root, { x: x0, z: ez }, { x: x1, z: ez }, { h, color, openings: gaps() })
    // 북쪽 부서의 바깥 경계 중 회의실 사이 틈
    if (z.sz < 0 && d.id !== 'dev') screens(root, { x: z.sx * 14, z: z0 }, { x: z.sx * 11, z: z0 }, { h, color })
    // 안쪽 경계 바닥에 부서 색 띠 (구역 표시)
    root.add(box(0.3, 0.03, z1 - z0, d.color, z.sx * 11.3, 0, z.cz, false))
  }
}

const buildMeetingRooms = (root: THREE.Group): void => {
  for (const r of ROOMS.filter((r) => r.id.startsWith('meeting'))) {
    const cx = (r.minX + r.maxX) / 2
    wall(root, { x: r.minX, z: r.maxZ }, { x: r.maxX, z: r.maxZ }, { h: 3.2, glass: true, door: r.minX + 3 })
    if (r.maxX <= 0) {
      wall(root, { x: r.maxX, z: r.minZ }, { x: r.maxX, z: r.maxZ }, { h: 3.2, glass: true })
    } else {
      // 동쪽: 사장실(solid 벽 보유) 옆 방은 서쪽 벽을, 맨 바깥 방은 동쪽 벽도 세운다
      wall(root, { x: r.minX, z: r.minZ }, { x: r.minX, z: r.maxZ }, { h: 3.2, glass: true })
      if (r.maxX === FLOOR.maxX) wall(root, { x: r.maxX, z: r.minZ }, { x: r.maxX, z: r.maxZ }, { h: 3.2, glass: true })
    }
    put(root, table(4.4, 1.8), cx, -23)
    for (const dx of [-1.4, 0, 1.4]) {
      put(root, chair(), cx + dx, -24.5, 0)
      put(root, chair(), cx + dx, -21.5, Math.PI)
    }
    root.add(box(4, 2, 0.1, '#fdfdfd', cx, 1.1, -25.9))
    root.add(box(4.2, 0.12, 0.14, '#9aa5b1', cx, 1.0, -25.85))
    root.add(box(1.2, 0.08, 0.04, '#2e86c1', cx - 0.8, 2.1, -25.83, false))
    root.add(box(1.8, 0.08, 0.04, '#c0392b', cx + 0.4, 1.7, -25.83, false))
    sign(root, r.name, cx, 3.9, r.maxZ)
  }
}

type Tick = (t: number) => void

const GOLD = '#d4af37'
const WALNUT = '#4a2f1b'
const BURGUNDY = '#6d1f2c'
const WATER = new THREE.MeshLambertMaterial({ color: '#2fb4e8', transparent: true, opacity: 0.5, depthWrite: false })
const BUBBLE = new THREE.MeshLambertMaterial({ color: '#e8fbff', transparent: true, opacity: 0.7, depthWrite: false })

/** 테두리가 있는 러그. 층마다 높이를 달리해 면이 겹쳐 깜빡이지 않게 한다 */
const rug = (root: THREE.Group, x: number, z: number, w: number, d: number, base: string, trim: string): void => {
  root.add(box(w, 0.05, d, trim, x, 0, z, false))
  root.add(box(w - 0.5, 0.06, d - 0.5, base, x, 0, z, false))
  root.add(box(w - 1.1, 0.065, d - 1.1, trim, x, 0, z, false))
  root.add(box(w - 1.3, 0.07, d - 1.3, base, x, 0, z, false))
}

/** 사장 의자: 높은 등받이와 팔걸이 (앞면은 로컬 +z) */
const executiveChair = (color: string): THREE.Group => {
  const g = new THREE.Group()
  g.add(box(0.14, 0.7, 0.14, '#222'))
  g.add(box(0.9, 0.1, 0.9, '#222'))
  g.add(box(1.0, 0.22, 1.0, color, 0, 0.7))
  g.add(box(1.0, 1.7, 0.2, color, 0, 0.9, -0.5))
  g.add(box(1.1, 0.2, 0.22, GOLD, 0, 2.6, -0.5))
  for (const s of [-1, 1]) g.add(box(0.14, 0.4, 0.8, color, s * 0.55, 0.92, 0))
  return g
}

/**
 * 벽면 수족관: 물·모래·산호·해초(흔들림)·열대어(헤엄침)·기포. 움직임은 ticks 에 등록해 엔진이 매 프레임 호출한다.
 * x0~x1 는 수조 가로 범위, 뒷면은 북쪽 벽(z=-26)에 붙는다.
 */
const aquarium = (root: THREE.Group, ticks: Tick[], x0: number, x1: number, zc: number): void => {
  const w = x1 - x0
  const cx = (x0 + x1) / 2
  const top = 3.55
  // 받침장 + 금색 장식
  root.add(box(w + 0.4, 0.9, 1.5, '#2b1d14', cx, 0, zc + 0.05))
  root.add(box(w + 0.5, 0.1, 1.6, GOLD, cx, 0.9, zc + 0.05))
  for (let i = 0; i < 5; i++) root.add(box(0.05, 0.6, 0.04, GOLD, x0 + 0.8 + (i * (w - 1.6)) / 4, 0.15, zc + 0.82, false))
  // 모래·물·테두리·조명
  root.add(box(w, 0.25, 1.1, '#efe2b0', cx, 1.0, zc, false))
  root.add(box(w, top - 1.25, 1.1, WATER, cx, 1.25, zc, false))
  root.add(box(w + 0.3, 0.16, 1.3, '#15181d', cx, top, zc))
  root.add(box(w, 0.05, 0.8, led('#d6f7ff'), cx, top - 0.02, zc, false))
  for (const x of [x0 - 0.1, x1 + 0.1, cx]) root.add(box(0.14, top - 1.0, 0.14, '#15181d', x, 1.0, zc + 0.6))
  // 바위·산호·보물상자
  for (const [dx, s, c] of [[-8.3, 1, '#7d8590'], [-4.2, 0.8, '#5f6670'], [-1.2, 1.2, '#7d8590'], [3.6, 0.7, '#5f6670'], [7.8, 1.1, '#7d8590']] as const) {
    root.add(box(0.9 * s, 0.6 * s, 0.7 * s, c, cx + dx, 1.25, zc - 0.1, false))
  }
  for (const [dx, c] of [[-7, '#ff6f91'], [-6.2, '#ffb347'], [-3, '#9b5de5'], [-0.4, '#ff6f91'], [2, '#ffc75f'], [5.5, '#ff6f91'], [6.3, '#9b5de5']] as const) {
    root.add(box(0.3, 0.5, 0.3, c, cx + dx, 1.25, zc + 0.15, false))
    root.add(box(0.18, 0.4, 0.18, c, cx + dx + 0.18, 1.25, zc + 0.1, false))
    root.add(box(0.14, 0.7, 0.14, c, cx + dx - 0.12, 1.25, zc + 0.2, false))
  }
  root.add(box(0.7, 0.4, 0.45, '#6b4a2f', cx + 1.8, 1.25, zc + 0.1, false))
  root.add(box(0.74, 0.1, 0.5, GOLD, cx + 1.8, 1.65, zc + 0.1, false))
  root.add(box(0.7, 0.4, 0.45, '#6b4a2f', cx - 5.4, 1.25, zc + 0.1, false))
  root.add(box(0.74, 0.1, 0.5, GOLD, cx - 5.4, 1.65, zc + 0.1, false))
  // 해초: 밑동을 축으로 좌우로 흔들린다
  const weeds = Math.round(w / 1.4)
  for (let i = 0; i < weeds; i++) {
    const g = new THREE.Group()
    const bx = x0 + 1 + (i * (w - 2)) / (weeds - 1)
    g.position.set(bx, 1.25, zc - 0.25 + (i % 3) * 0.25)
    const h = 0.9 + (i % 3) * 0.35
    g.add(box(0.1, h, 0.1, i % 2 ? '#2f9e5b' : '#3fbf6f', 0, 0, 0, false))
    g.add(box(0.08, h * 0.7, 0.08, '#2f9e5b', 0.1, 0, 0.05, false))
    root.add(g)
    ticks.push((t) => (g.rotation.z = Math.sin(t * 1.3 + i) * 0.13))
  }
  // 열대어: 좌우로 헤엄치며 방향 전환 시 몸을 뒤집는다
  const palette = ['#ff7a45', '#ffd166', '#4cc9f0', '#f72585', '#b5179e', '#80ed99', '#ff9f1c', '#4895ef', '#ffffff']
  const colors = Array.from({ length: Math.round(w / 1.5) }, (_, i) => palette[i % palette.length]!)
  colors.forEach((color, i) => {
    const s = 0.75 + (i % 4) * 0.2
    const g = new THREE.Group()
    g.add(box(0.5 * s, 0.3 * s, 0.2 * s, color, 0, 0, 0, false))
    g.add(box(0.07 * s, 0.32 * s, 0.22 * s, '#ffffff', 0.03 * s, 0, 0, false))
    g.add(box(0.14 * s, 0.14 * s, 0.1 * s, color, -0.02 * s, 0.3 * s, 0, false))
    g.add(box(0.06 * s, 0.06 * s, 0.24 * s, '#111', 0.18 * s, 0.17 * s, 0, false))
    const tail = new THREE.Group()
    tail.position.set(-0.25 * s, 0.15 * s, 0)
    tail.add(box(0.24 * s, 0.34 * s, 0.06 * s, color, -0.12 * s, -0.17 * s, 0, false))
    g.add(tail)
    root.add(g)
    const speed = 0.35 + (i % 5) * 0.09
    const phase = i * 1.9
    const amp = w / 2 - 1.3
    const baseY = 1.7 + (i % 5) * 0.34
    const z = zc - 0.25 + (i % 3) * 0.28
    ticks.push((t) => {
      const a = t * speed + phase
      g.position.set(cx + Math.sin(a) * amp, baseY + Math.sin(t * 1.7 + phase) * 0.12, z)
      g.rotation.y = Math.cos(a) >= 0 ? 0 : Math.PI
      tail.rotation.y = Math.sin(t * 9 + phase) * 0.6
    })
  })
  // 기포
  for (let i = 0; i < Math.round(w / 2.4); i++) {
    const b = box(0.09, 0.09, 0.09, BUBBLE, 0, 0, 0, false)
    b.position.z = zc + 0.1 + (i % 3) * 0.12
    root.add(b)
    const bx = x0 + 1.5 + (i * (w - 3)) / Math.max(1, Math.round(w / 2.4) - 1)
    ticks.push((t) => {
      const p = (t * 0.3 + i * 0.37) % 1
      b.position.set(bx + Math.sin(t * 3 + i) * 0.06, 1.35 + p * 2.05, b.position.z)
    })
  }
}

/**
 * 사장실 별관(건물 북쪽 벽 바깥, 리포트 게시판 뒤): 게시판 옆 금색 문 → 입구 → 수족관 앞 회의 테이블(전체 소집 면담)
 * 서쪽 책장 앞 집무 책상, 동쪽 소파 라운지. 남쪽·동쪽은 유리라서 카메라(남동쪽)에서 내부가 보인다.
 */
const buildCeoOffice = (root: THREE.Group, ticks: Tick[]): void => {
  const A = ANNEX
  const t = CEO.table
  const d = CEO.desk
  const cz = (A.minZ + A.maxZ) / 2
  const DARK = '#2d2220'

  // 바닥: 크림색 대리석 체크
  const nx = (A.maxX - A.minX) / 2
  const nz = (A.maxZ - A.minZ) / 2
  const floor = new THREE.InstancedMesh(boxGeo(1.94, 0.3, 1.94), new THREE.MeshLambertMaterial(), nx * nz)
  const m4 = new THREE.Matrix4()
  let n = 0
  for (let ix = 0; ix < nx; ix++) {
    for (let iz = 0; iz < nz; iz++) {
      m4.makeTranslation(A.minX + 1 + ix * 2, -0.15, A.minZ + 1 + iz * 2)
      floor.setMatrixAt(n, m4)
      floor.setColorAt(n++, new THREE.Color((ix + iz) % 2 ? '#cbbfa8' : '#d9cfba'))
    }
  }
  floor.receiveShadow = true
  root.add(floor)

  // 벽: 서쪽·북쪽은 짙은 원목 패널 + 금색 띠, 동쪽은 유리, 남쪽(건물 북벽)은 게시판 뒤만 벽이고 나머지는 유리
  wall(root, { x: A.minX, z: A.minZ }, { x: A.minX, z: A.maxZ }, { h: 4.2, color: DARK })
  wall(root, { x: A.minX, z: A.minZ }, { x: A.maxX, z: A.minZ }, { h: 4.2, color: DARK })
  wall(root, { x: A.maxX, z: A.minZ }, { x: A.maxX, z: A.maxZ }, { h: 4.2, glass: true })
  for (const y of [0.5, 3.4]) {
    root.add(box(0.14, 0.12, A.maxZ - A.minZ, GOLD, A.minX + 0.12, y, cz, false))
    root.add(box(A.maxX - A.minX, 0.12, 0.14, GOLD, 0, y, A.minZ + 0.12, false))
  }
  root.add(box(15.2, 4, 1, '#ece6da', 0, 0, A.maxZ - 0.5))
  wall(root, { x: A.minX, z: A.maxZ }, { x: -7.6, z: A.maxZ }, { h: 4, glass: true })
  wall(root, { x: 7.6, z: A.maxZ }, { x: A.maxX, z: A.maxZ }, { h: 4, glass: true, door: A.doorX })

  // 금색 문틀과 활짝 열린 문짝, 간판
  root.add(box(2.6, 0.45, 0.5, GOLD, A.doorX, 3.45, A.maxZ))
  for (const [x, dir] of [[A.doorX - 1, 1], [A.doorX + 1, -1]] as const) {
    const leaf = new THREE.Group()
    leaf.position.set(x, 0, A.maxZ)
    leaf.rotation.y = dir * 1.25
    leaf.add(box(1.0 * dir, 3.2, 0.1, '#3b2a22', 0.5 * dir, 0, 0))
    leaf.add(box(0.7 * dir, 0.1, 0.12, GOLD, 0.5 * dir, 1.5, 0, false))
    root.add(leaf)
  }
  sign(root, '사장실', A.doorX, 4.7, A.maxZ, GOLD, '#2a1c00')

  // 수족관: 뒷벽(북쪽) 전체 폭
  aquarium(root, ticks, -11.5, 11.5, A.minZ + 0.65)

  // 회의 테이블: 호두나무 + 금색 테두리, 붉은 러너와 꽃병. 상석은 서쪽 머리
  rug(root, t.x, t.z, t.length + 3, t.depth + 3.4, BURGUNDY, GOLD)
  put(root, table(t.length, t.depth, 1.3, WALNUT, '#2e1c10'), t.x, t.z)
  for (const s of [-1, 1]) root.add(box(t.length, 0.04, 0.08, GOLD, t.x, 1.3, t.z + s * (t.depth / 2 - 0.05), false))
  root.add(box(t.length - 1.4, 0.03, 0.6, BURGUNDY, t.x, 1.3, t.z, false))
  root.add(box(0.3, 0.55, 0.3, '#e8e4dc', t.x, 1.33, t.z, false))
  for (const [dx, dz, c] of [[0, 0, '#e63946'], [0.1, 0.06, '#ff8fab'], [-0.1, -0.05, '#ffffff'], [0.02, -0.1, '#ffd166']] as const) root.add(box(0.17, 0.17, 0.17, c, t.x + dx, 1.88 + (dz > 0 ? 0.05 : 0), t.z + dz, false))
  for (const dx of [-2.6, 0, 2.6]) root.add(box(0.5, 0.03, 0.34, '#fbfaf5', t.x + dx, 1.3, t.z + 0.6, false))
  for (const dx of [-1.3, 1.3]) root.add(box(0.5, 0.03, 0.34, '#fbfaf5', t.x + dx, 1.3, t.z - 0.6, false))
  put(root, executiveChair(BURGUNDY), t.x - t.length / 2 - 0.9, t.z, Math.PI / 2)

  // 집무 영역(서쪽): 책장 5개를 벽에 붙이고, 그 앞에 임원 책상·사장 의자·손님 의자
  for (const z of [-31, -33.4, -35.8, -38.2, -40.6]) {
    put(root, bookshelf(2.4, 3.4), A.minX + 0.35, z, Math.PI / 2)
    root.add(box(0.3, 0.3, 0.3, GOLD, A.minX + 0.5, 3.4, z + 0.5, false))
    root.add(box(0.22, 0.42, 0.22, '#e8e4dc', A.minX + 0.5, 3.4, z - 0.4, false))
  }
  rug(root, d.x + 0.5, d.z, 6.4, 6.2, '#1f2a4a', GOLD)
  put(root, table(1.8, 4.2, 1.4, '#3b2416', '#24160d'), d.x, d.z)
  root.add(box(1.9, 0.06, 4.3, GOLD, d.x, 1.18, d.z, false))
  root.add(box(0.1, 0.9, 1.5, '#111', d.x - 0.4, 1.4, d.z - 0.5))
  root.add(box(0.02, 0.7, 1.3, '#2a4a7a', d.x - 0.46, 1.5, d.z - 0.5, false))
  root.add(box(0.3, 0.04, 0.9, '#ddd', d.x - 0.1, 1.4, d.z - 0.5, false))
  root.add(box(0.25, 0.12, 0.8, GOLD, d.x + 0.6, 1.4, d.z + 0.6, false))
  root.add(box(0.45, 0.06, 0.45, GOLD, d.x, 1.4, d.z - 1.6, false))
  root.add(box(0.4, 0.4, 0.4, '#2b6cb0', d.x, 1.46, d.z - 1.6, false))
  root.add(box(0.1, 0.5, 0.1, GOLD, d.x - 0.2, 1.4, d.z + 1.5, false))
  root.add(box(0.5, 0.2, 0.4, '#ffe9a8', d.x - 0.2, 1.9, d.z + 1.5, false))
  put(root, executiveChair('#7b1e2b'), d.x - 1.7, d.z, Math.PI / 2)
  for (const dz of [-1.5, 1.5]) put(root, chair('#2f3a52'), d.x + 2.0, d.z + dz, -Math.PI / 2)

  // 라운지(동쪽): 소파 두 개와 안락의자, 낮은 테이블, 플로어 램프
  rug(root, 9.6, -36, 7.2, 6.6, '#1d4a3a', GOLD)
  put(root, sofa(3.6, '#3b2f2f', '#55423f'), 12.0, -36, -Math.PI / 2)
  put(root, sofa(3.6, '#3b2f2f', '#55423f'), 9.4, -39.1, 0)
  put(root, sofa(1.8, '#3b2f2f', '#55423f'), 7.2, -35.6, Math.PI / 2)
  put(root, table(1.8, 1.0, 0.7, '#1d1d22', GOLD), 9.8, -36)
  root.add(box(0.5, 0.05, 0.3, '#f5f1e6', 9.6, 0.7, -36, false))
  root.add(box(0.3, 0.3, 0.3, GOLD, 10.2, 0.7, -36, false))
  put(root, floorLamp(), 12.3, -32.2)
  put(root, monstera(), 12.3, -28.0)
  // 입구 콘솔
  put(root, table(2.0, 0.7, 1.1, '#2b1a10', GOLD), 7.4, -26.9)
  root.add(box(0.3, 0.5, 0.3, '#e8e4dc', 7.4, 1.13, -26.9, false))
  root.add(box(0.2, 0.2, 0.2, '#ff8fab', 7.4, 1.63, -26.9, false))

  // 따뜻한 조명
  for (const [x, z, power] of [[0, -35, 9], [9, -35, 5], [-9, -35, 5]] as const) {
    const lamp = new THREE.PointLight('#ffd9a0', power, 22, 1.4)
    lamp.position.set(x, 3.4, z)
    root.add(lamp)
  }
}

const buildServerRoom = (root: THREE.Group): void => {
  const r = room('server')
  const x0 = r.minX
  wall(root, { x: r.minX, z: r.minZ }, { x: r.minX, z: r.maxZ }, { h: 3.2, glass: true, door: 1 })
  wall(root, { x: r.minX, z: r.minZ }, { x: r.maxX, z: r.minZ }, { h: 3.2, glass: true })
  wall(root, { x: r.minX, z: r.maxZ }, { x: r.maxX, z: r.maxZ }, { h: 3.2, glass: true })
  wall(root, { x: r.maxX, z: r.minZ }, { x: r.maxX, z: r.maxZ }, { h: 3.2, glass: true })
  for (const z of [-3, -1, 1, 3]) put(root, rack(), x0 + 7, z, -Math.PI / 2)
  for (const z of [-3, -1, 3]) put(root, rack(), x0 + 2.4, z, Math.PI / 2)
  root.add(box(7, 0.04, 1.2, '#4b5563', x0 + 4.5, 0, 0, false))
  sign(root, '서버실', x0 + 4, 3.9, r.maxZ)
}

const buildLibrary = (root: THREE.Group): void => {
  const r = room('library')
  const x0 = r.minX
  wall(root, { x: r.minX, z: r.minZ }, { x: r.minX, z: r.maxZ }, { h: 3.2, glass: true, door: 1 })
  wall(root, { x: r.minX, z: r.minZ }, { x: r.maxX, z: r.minZ }, { h: 3.2, glass: true })
  wall(root, { x: r.minX, z: r.maxZ }, { x: r.maxX, z: r.maxZ }, { h: 3.2, glass: true })
  wall(root, { x: r.maxX, z: r.minZ }, { x: r.maxX, z: r.maxZ }, { h: 3.2, glass: true })
  for (const dx of [2, 4.4, 6.8]) put(root, bookshelf(2.2), x0 + dx, -3.3, 0)
  put(root, table(3.2, 1.6), x0 + 4, 0.6)
  for (const dx of [-0.8, 0.8]) {
    put(root, chair('#8b5e3c'), x0 + 4 + dx, -1.0, 0)
    put(root, chair('#8b5e3c'), x0 + 4 + dx, 2.2, Math.PI)
  }
  put(root, floorLamp(), x0 + 7, 3)
  put(root, fern(), x0 + 0.9, 3.1)
  sign(root, '자료실', x0 + 4, 3.9, r.minZ)
}

// ───────────────────────── 공용 공간: 탕비실·카페 / 휴게 라운지 / 복사실 / 전화 부스 / 로비 / 화장실·창고 ─────────────────────────

const counterTop = '#c9a27a'

/** 주방 카운터: 흰 하부장 + 원목 상판 (앞면은 로컬 +z) */
const counter = (w: number, d = 1.3): THREE.Group => {
  const g = new THREE.Group()
  g.add(box(w, 1.4, d, '#f1eee8'))
  g.add(box(w + 0.1, 0.12, d + 0.1, counterTop, 0, 1.4))
  for (let x = -w / 2 + 0.9; x < w / 2 - 0.4; x += 1.8) g.add(box(0.5, 0.05, 0.04, '#9aa0a8', x, 0.9, d / 2 + 0.02, false))
  return g
}

const copier = (): THREE.Group => {
  const g = new THREE.Group()
  g.add(box(1.7, 1.5, 1.0, '#d7dbe0'))
  g.add(box(1.7, 0.12, 1.0, '#aeb6be', 0, 1.5))
  g.add(box(0.9, 0.06, 0.5, '#fbfaf5', -0.3, 1.62, 0, false))
  g.add(box(0.5, 0.3, 0.05, '#1f3a5f', 0.5, 1.15, 0.52, false))
  return g
}

const phoneBooth = (accent: string): THREE.Group => {
  const g = new THREE.Group()
  g.add(box(2.2, 0.12, 2.2, '#d4d8de'))
  g.add(box(2.2, 3.0, 0.1, accent, 0, 0.12, -1.05)) // 뒷벽(불투명)
  for (const s of [-1, 1]) {
    g.add(box(0.08, 3.0, 2.2, GLASS, s * 1.06, 0.12, 0, false))
    g.add(box(0.12, 3.0, 0.12, '#444a52', s * 1.06, 0.12, 1.05))
  }
  g.add(box(2.3, 0.1, 0.12, '#444a52', 0, 3.1, 1.05)) // 앞쪽 상인방(지붕은 열어 두어 위에서 안이 보인다)
  g.add(box(1.4, 0.08, 0.6, '#efe9dd', 0, 1.15, -0.7))
  g.add(box(0.5, 0.5, 0.5, '#444a52', 0, 0.12, 0.2))
  g.add(box(0.5, 0.1, 0.5, accent, 0, 0.62, 0.2))
  g.add(box(0.5, 0.05, 0.4, led('#ffe9a8'), 0, 2.95, -0.2, false))
  return g
}

const beanbag = (color: string): THREE.Group => {
  const g = new THREE.Group()
  g.add(box(1.0, 0.55, 1.0, color))
  g.add(box(0.8, 0.3, 0.8, color, 0, 0.55))
  return g
}

const pingPong = (): THREE.Group => {
  const g = new THREE.Group()
  g.add(box(2.8, 0.1, 1.5, '#2d6a4f', 0, 1.0))
  g.add(box(0.05, 0.3, 1.5, '#f4f3ef', 0, 1.1))
  g.add(box(2.8, 0.03, 0.05, '#f4f3ef', 0, 1.1, 0, false))
  for (const x of [-1.2, 1.2]) for (const z of [-0.6, 0.6]) g.add(box(0.12, 1.0, 0.12, '#444a52', x, 0, z))
  return g
}

const tvOn = (w: number): THREE.Group => {
  const g = new THREE.Group()
  g.add(box(w, w * 0.56, 0.1, '#111'))
  g.add(box(w - 0.15, w * 0.56 - 0.15, 0.02, led('#27456b'), 0, 0.07, 0.06, false))
  return g
}

/** 중앙의 넓은 탕비실·카페: 냉장고·주방 카운터·커피 스테이션, 아일랜드(스툴), 4인 식탁 6개, 자판기·정수기·분리수거 */
const buildPantry = (root: THREE.Group): void => {
  const r = room('pantry')
  root.add(box(r.maxX - r.minX - 0.4, 1.1, 0.1, '#e9f0f2', 0, 1.5, r.minZ + 0.05, false)) // 타일 백스플래시
  // 북쪽 벽면 주방: 냉장고 둘, 카운터(싱크·전자레인지·커피머신), 상부장
  for (const x of [-8.2, -6.4]) put(root, fridge(), x, r.minZ + 0.9)
  put(root, counter(8.2), -1.1, r.minZ + 0.75)
  root.add(box(1.0, 0.06, 0.7, '#aab4be', -3.8, 1.55, r.minZ + 0.75, false)) // 싱크
  root.add(box(0.1, 0.45, 0.1, '#aab4be', -3.8, 1.55, r.minZ + 0.45, false)) // 수전
  for (const x of [-2.3, -1.2]) root.add(box(0.9, 0.5, 0.6, '#d9dde2', x, 1.52, r.minZ + 0.75)) // 전자레인지
  for (const x of [0.6, 1.8]) {
    root.add(box(0.7, 0.9, 0.6, '#2b2b33', x, 1.52, r.minZ + 0.75)) // 에스프레소 머신
    root.add(box(0.12, 0.12, 0.05, '#e74c3c', x + 0.15, 2.1, r.minZ + 1.07, false))
  }
  root.add(box(5.2, 1.0, 0.7, '#f0ece4', -2.6, 2.7, r.minZ + 0.4)) // 상부장
  root.add(box(2.8, 0.08, 0.5, '#dcd9d2', 1.8, 2.7, r.minZ + 0.35, false)) // 컵 선반
  for (let i = 0; i < 5; i++) root.add(box(0.2, 0.22, 0.2, ['#e76f51', '#f4a261', '#e9c46a', '#2a9d8f', '#8ecae6'][i]!, 0.7 + i * 0.5, 2.78, r.minZ + 0.35, false))
  // 동쪽 끝: 정수기·자판기 둘·분리수거
  put(root, waterDispenser(), 4.2, r.minZ + 0.9)
  for (const x of [5.8, 7.4]) put(root, vending(), x, r.minZ + 0.9)
  for (const [x, c] of [[3.0, '#2a9d8f'], [3.7, '#e9c46a'], [4.4, '#8d99ae']] as const) root.add(box(0.5, 0.8, 0.5, c, x, 0, r.minZ + 3.0))
  // 아일랜드와 스툴
  root.add(box(6.4, 1.4, 1.4, '#f1eee8', 0, 0, -1.9))
  root.add(box(6.6, 0.12, 1.6, counterTop, 0, 1.4, -1.9))
  root.add(box(0.5, 0.25, 0.5, '#e76f51', -1.5, 1.52, -1.9, false)) // 과일 바구니
  for (let i = 0; i < 6; i++) put(root, stool('#3f444c'), -2.5 + i, -0.6)
  // 식탁: 4인 식탁 6개 (2줄)
  for (const z of [1.9, 4.7]) {
    for (const x of [-5.6, 0, 5.6]) {
      put(root, table(1.8, 1.8, 1.25, '#efe7d6', '#9a8a6e'), x, z)
      put(root, chair('#e8e2d5'), x, z - 1.25, 0)
      put(root, chair('#e8e2d5'), x, z + 1.25, Math.PI)
      put(root, chair('#e8e2d5'), x - 1.25, z, Math.PI / 2)
      put(root, chair('#e8e2d5'), x + 1.25, z, -Math.PI / 2)
    }
  }
  // 낮은 화단으로 가장자리를 두른다
  for (const x of [-8.7, 8.7]) {
    root.add(box(0.5, 0.5, 4.4, '#6b5a45', x, 0, 3.4))
    root.add(box(0.4, 0.4, 4.2, '#3f9b4b', x, 0.5, 3.4, false))
  }
  sign(root, r.name, 0, 4, r.minZ)
}

/** 휴게 라운지: 미디어 월(TV)과 소파 구역, 탁구대, 빈백, 독서 코너 */
const buildLounge = (root: THREE.Group): void => {
  const r = room('lounge')
  rug(root, -5, 14, 8.8, 7.8, '#8da398', '#d8cbb0')
  // 미디어 월
  root.add(box(4.4, 0.8, 0.7, '#3b2f26', -5, 0, r.minZ + 0.7))
  put(root, tvOn(3.4), -5, r.minZ + 0.75, 0, 1.3)
  // 소파 구역 (TV 를 바라봄)
  put(root, sofa(5.0, '#7b8794', '#a7b0bb'), -5, 14.4, Math.PI)
  put(root, sofa(1.8, '#6f7c89', '#a7b0bb'), -8.8, 12.6, Math.PI / 2)
  put(root, sofa(1.8, '#6f7c89', '#a7b0bb'), -1.4, 12.6, -Math.PI / 2)
  put(root, table(2.2, 1.2, 0.7, '#d9c9b0', '#8a7a5a'), -5, 12.5)
  root.add(box(0.5, 0.05, 0.3, '#f5f1e6', -5.4, 0.7, 12.5, false))
  // 놀이 코너
  put(root, pingPong(), -6.6, 17.6)
  for (const [x, z, c] of [[-2.6, 17.8, '#e76f51'], [-1.4, 16.5, '#f4a261'], [-3.4, 16.4, '#2a9d8f']] as const) put(root, beanbag(c), x, z)
  // 독서 코너와 조명·식물
  put(root, bookshelf(2.4, 1.6), -9.6, 16.4, Math.PI / 2)
  put(root, floorLamp(), -1.0, 10.2)
  put(root, monstera(), -9.3, 10.1)
  sign(root, r.name, -5, 4, r.minZ)
}

/** 복사·인쇄실: 소음이 나는 복합기를 모아 둔 별도 방 (집중 구역과 거리를 두고 벽으로 소음을 막는다) */
const buildCopyRoom = (root: THREE.Group): void => {
  const r = room('copy')
  wall(root, { x: r.minX, z: r.minZ }, { x: r.maxX, z: r.minZ }, { h: 3.2, color: '#f4f1ea', door: 6 })
  wall(root, { x: r.maxX, z: r.minZ }, { x: r.maxX, z: r.maxZ }, { h: 3.2, color: '#f4f1ea' })
  wall(root, { x: r.minX, z: r.maxZ }, { x: r.maxX, z: r.maxZ }, { h: 3.2, glass: true })
  wall(root, { x: r.minX, z: r.minZ }, { x: r.minX, z: r.maxZ }, { h: 3.2, glass: true })
  for (const x of [5.2, 7.8]) put(root, copier(), x, r.minZ + 1.0)
  put(root, table(2.2, 1.0, 1.2, '#f1eee8', '#9aa0a8'), 6.4, 11.8)
  for (let i = 0; i < 3; i++) root.add(box(0.7, 0.25 + i * 0.05, 0.9, '#fbfaf5', 5.8 + i * 0.7, 1.2, 11.8, false))
  put(root, bookshelf(2.2, 2.2), r.maxX - 0.5, 12.0, -Math.PI / 2)
  put(root, trash(), 3.9, 12.8)
  sign(root, r.name, 6.5, 3.9, r.minZ)
}

/** 전화 부스 3개: 통화·화상회의용 1인 유리 부스 (주 동선에서 떨어진 곳) */
const buildPhoneBooths = (root: THREE.Group): void => {
  const r = room('booths')
  const colors = ['#c9a27a', '#7fa6b8', '#9bb59b']
  ;[4.4, 6.9, 9.4].forEach((x, i) => put(root, phoneBooth(colors[i]!), x, 16.2))
  sign(root, '전화 부스', 6.9, 3.9, r.minZ + 0.5)
}

/** 로비: 안내 데스크와 로고 월, 대기 소파, 코트 랙. 출입문은 남쪽 파사드 가운데 */
const buildLobby = (root: THREE.Group): void => {
  const r = room('lobby')
  // 안내 데스크 + 목재 슬랫 로고 월
  root.add(box(6.4, 3.2, 0.3, '#a97c50', -5.2, 0, r.minZ + 0.4))
  for (let x = -8.2; x < -2.2; x += 0.5) root.add(box(0.08, 3.0, 0.34, '#8a6338', x, 0.1, r.minZ + 0.45, false))
  sign(root, 'PixelBoss', -5.2, 4.2, r.minZ + 0.4, '#3b6cff')
  root.add(box(5.4, 1.2, 1.3, '#f1eee8', -5.2, 0, 22.2))
  root.add(box(5.6, 0.12, 1.5, counterTop, -5.2, 1.2, 22.2))
  root.add(box(1.0, 0.6, 0.08, '#222', -6.2, 1.35, 21.8))
  root.add(box(0.5, 0.05, 0.3, '#c9a227', -3.6, 1.32, 22.6, false))
  put(root, chair('#2f3a52'), -5.2, 20.9, 0)
  // 대기 공간
  rug(root, 6, 22.6, 6.2, 4.2, '#8f9bb0', '#d8cbb0')
  put(root, sofa(3.4, '#6b7280', '#9ca3af'), 8.6, 22.6, -Math.PI / 2)
  put(root, sofa(2.4, '#6b7280', '#9ca3af'), 5.6, 20.4, 0)
  put(root, table(1.4, 1.8, 0.7, '#d9c9b0', '#8a7a5a'), 6.2, 22.6)
  // 코트 랙과 출입 매트, 화분
  for (const dz of [-0.4, 0.4]) root.add(box(0.1, 2.6, 0.1, '#444a52', 9.4, 0, 24.4 + dz))
  root.add(box(0.12, 0.08, 1.0, '#444a52', 9.4, 2.4, 24.4))
  root.add(box(3, 0.06, 1.4, '#3a4256', 0, 0, 25.0, false))
  put(root, monstera(), -9.2, 25.0)
  put(root, snakePlant(), 9.2, 19.8)
}

/** 화장실(남/여)과 창고·사물함: 닫힌 방, 복도 쪽(북쪽) 벽에 문 */
const buildServiceRooms = (root: THREE.Group): void => {
  const rest = room('restroom')
  const store = room('storage')
  const solid = { h: 3.2, color: '#f4f1ea' }
  const mid = (rest.minX + rest.maxX) / 2
  wall(root, { x: rest.minX, z: rest.minZ }, { x: mid, z: rest.minZ }, { ...solid, door: rest.minX + 1 })
  wall(root, { x: mid, z: rest.minZ }, { x: rest.maxX, z: rest.minZ }, { ...solid, door: rest.maxX - 1.25 })
  wall(root, { x: rest.minX, z: rest.minZ }, { x: rest.minX, z: rest.maxZ }, solid)
  wall(root, { x: rest.maxX, z: rest.minZ }, { x: rest.maxX, z: rest.maxZ }, solid)
  wall(root, { x: mid, z: rest.minZ }, { x: mid, z: rest.maxZ }, solid)
  sign(root, '남자', rest.minX + 1, 3.9, rest.minZ, '#3b6cff')
  sign(root, '여자', rest.maxX - 1.25, 3.9, rest.minZ, '#e0527a')
  wall(root, { x: store.minX, z: store.minZ }, { x: store.maxX, z: store.minZ }, { ...solid, door: store.minX + 1 })
  wall(root, { x: store.minX, z: store.minZ }, { x: store.minX, z: store.maxZ }, solid)
  wall(root, { x: store.maxX, z: store.minZ }, { x: store.maxX, z: store.maxZ }, solid)
  sign(root, '창고 · 사물함', store.minX + 1, 3.9, store.minZ, '#5a6472')
}

/** 건물 외벽: 동쪽과 남쪽은 통유리 파사드 (남쪽 가운데는 출입문 개구부). 카메라가 남동쪽이라 내부가 그대로 보인다 */
const buildFacade = (root: THREE.Group): void => {
  const g = { h: 3.4, glass: true }
  wall(root, { x: FLOOR.maxX, z: -20 }, { x: FLOOR.maxX, z: -4 }, g)
  wall(root, { x: FLOOR.maxX, z: 4 }, { x: FLOOR.maxX, z: FLOOR.maxZ }, g)
  wall(root, { x: FLOOR.minX, z: FLOOR.maxZ }, { x: FLOOR.maxX, z: FLOOR.maxZ }, { ...g, door: 0 })
  root.add(box(5.2, 0.5, 0.5, '#3a4256', 0, 3.1, FLOOR.maxZ))
  sign(root, 'PixelBoss', 0, 4.6, FLOOR.maxZ, '#3b6cff')
}

/** 서쪽 벽 창문 (북쪽 벽 중앙은 게시판과 사장실 별관 문이 차지한다) */
const buildWallArt = (root: THREE.Group): void => {
  const wx = FLOOR.minX
  for (const z of [-14, 0, 14]) {
    root.add(box(0.2, 0.15, 4.4, '#fff', wx + 0.1, 1.4, z))
    root.add(box(0.1, 1.8, 4, '#9fd3f5', wx + 0.05, 1.55, z, false))
    root.add(box(0.14, 1.8, 0.12, '#fff', wx + 0.07, 1.55, z, false))
  }
}

const buildCommonPlants = (root: THREE.Group): void => {
}

const buildDecor = (root: THREE.Group, projectCount: number): Tick[] => {
  const ticks: Tick[] = []
  buildZones(root, projectCount)
  buildDeptRooms(root)
  buildMeetingRooms(root)
  buildCeoOffice(root, ticks)
  buildServerRoom(root)
  buildLibrary(root)
  buildPantry(root)
  buildLounge(root)
  buildCopyRoom(root)
  buildPhoneBooths(root)
  buildLobby(root)
  buildServiceRooms(root)
  buildFacade(root)
  buildWallArt(root)
  buildCommonPlants(root)
  return ticks
}

export default { buildDecor }
