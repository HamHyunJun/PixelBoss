// 복셀 오피스 월드 생성 (바닥, 벽, 부서 구역, 회의실, 게시판, 책상)
import * as THREE from 'three'
import { DEPARTMENTS } from '@voxelhq/shared'
import type { DepartmentId } from '@voxelhq/shared'
import { BOARD, FLOOR, ROOM, ZONES, type DeskSpec } from './layout'

const geoCache = new Map<string, THREE.BoxGeometry>()
const matCache = new Map<string, THREE.MeshLambertMaterial>()

export function boxGeo(w: number, h: number, d: number) {
  const k = `${w}|${h}|${d}`
  let g = geoCache.get(k)
  if (!g) geoCache.set(k, (g = new THREE.BoxGeometry(w, h, d)))
  return g
}

export function mat(color: string | number) {
  const k = String(color)
  let m = matCache.get(k)
  if (!m) matCache.set(k, (m = new THREE.MeshLambertMaterial({ color })))
  return m
}

/** 바닥 기준(y=밑면)으로 상자를 만든다 */
export function box(w: number, h: number, d: number, color: string | number | THREE.Material, x = 0, y = 0, z = 0, shadow = true) {
  const m = new THREE.Mesh(boxGeo(w, h, d), color instanceof THREE.Material ? color : mat(color))
  m.position.set(x, y + h / 2, z)
  m.castShadow = shadow
  m.receiveShadow = true
  return m
}

/** 캔버스 텍스트 스프라이트 (구역 간판, 이름표) */
export function textSprite(text: string, opts: { color?: string; bg?: string; size?: number; scale?: number } = {}) {
  const size = opts.size ?? 48
  const canvas = document.createElement('canvas')
  const ctx = canvas.getContext('2d')!
  const font = `700 ${size}px Pretendard Variable, Pretendard, "WenQuanYi Zen Hei", sans-serif`
  ctx.font = font
  const w = Math.ceil(ctx.measureText(text).width) + size
  canvas.width = w
  canvas.height = Math.ceil(size * 1.6)
  ctx.font = font
  if (opts.bg) {
    ctx.fillStyle = opts.bg
    ctx.beginPath()
    ctx.roundRect(0, 0, canvas.width, canvas.height, size * 0.35)
    ctx.fill()
  }
  ctx.fillStyle = opts.color ?? '#fff'
  ctx.textAlign = 'center'
  ctx.textBaseline = 'middle'
  ctx.fillText(text, canvas.width / 2, canvas.height / 2 + size * 0.05)
  const tex = new THREE.CanvasTexture(canvas)
  tex.colorSpace = THREE.SRGBColorSpace
  tex.minFilter = THREE.LinearFilter
  const sprite = new THREE.Sprite(new THREE.SpriteMaterial({ map: tex, depthWrite: false, transparent: true }))
  const s = (opts.scale ?? 1) / 40
  sprite.scale.set(canvas.width * s, canvas.height * s, 1)
  sprite.renderOrder = 10
  return sprite
}

const tint = (hex: string, toward: string, t: number) => new THREE.Color(hex).lerp(new THREE.Color(toward), t)

function inZone(x: number, z: number): DepartmentId | null {
  for (const [id, zone] of Object.entries(ZONES)) {
    if (Math.abs(x - zone.cx) <= 10 && Math.abs(z - zone.cz) <= 6.5) return id as DepartmentId
  }
  return null
}

export interface DeskHandle {
  group: THREE.Group
  screen: THREE.Mesh<THREE.BoxGeometry, THREE.MeshBasicMaterial>
}

/** 책상 + 모니터 + 의자. 모니터 화면 색으로 작업 상태를 표시한다 */
export function buildDesk(spec: DeskSpec, accent: string, leader = false): DeskHandle {
  const g = new THREE.Group()
  const width = leader ? 3.4 : 3
  g.add(box(width, 0.2, 1.6, leader ? '#6b4a2f' : '#c8a27a', 0, 1.1, 0))
  for (const sx of [-1, 1]) for (const sz of [-1, 1]) g.add(box(0.2, 1.1, 0.2, '#5b4636', sx * (width / 2 - 0.2), 0, sz * 0.6))
  // 모니터 (책상 뒤쪽, 앉은 사람을 향함 = 로컬 +z)
  g.add(box(0.3, 0.4, 0.3, '#333', 0, 1.3, -0.45))
  g.add(box(1.5, 0.95, 0.12, '#222', 0, 1.65, -0.5))
  const screen = new THREE.Mesh(boxGeo(1.32, 0.78, 0.02), new THREE.MeshBasicMaterial({ color: '#2a3a55' }))
  screen.position.set(0, 1.65 + 0.475, -0.43)
  g.add(screen)
  // 키보드, 서류
  g.add(box(0.9, 0.06, 0.3, '#ddd', 0, 1.3, 0.25))
  g.add(box(0.5, 0.05, 0.6, '#f5f1e6', width / 2 - 0.5, 1.3, 0.1))
  if (leader) g.add(box(0.35, 0.5, 0.35, accent, -width / 2 + 0.4, 1.3, -0.2))
  g.position.set(spec.desk.x, 0, spec.desk.z)
  g.rotation.y = spec.rotation

  // 의자 (좌석 위치)
  const chair = new THREE.Group()
  chair.add(box(0.9, 0.15, 0.9, '#3d3d46', 0, 0.75, 0))
  chair.add(box(0.9, 1.0, 0.15, '#3d3d46', 0, 0.9, -0.45)) // 등받이는 바라보는 방향 반대쪽
  chair.add(box(0.15, 0.75, 0.15, '#222', 0, 0, 0))
  chair.position.set(spec.seat.pos.x, 0, spec.seat.pos.z)
  chair.rotation.y = spec.seat.facing
  const root = new THREE.Group()
  root.add(g, chair)
  return { group: root, screen }
}

export interface WorldHandle {
  root: THREE.Group
  board: THREE.Group
  addPaper(color: string): void
  clearPapers(): void
  readonly paperCount: number
}

export function buildWorld(): WorldHandle {
  const root = new THREE.Group()

  // 바닥 타일 (InstancedMesh, 구역별 카펫 색)
  const tile = 2
  const nx = (FLOOR.maxX - FLOOR.minX) / tile
  const nz = (FLOOR.maxZ - FLOOR.minZ) / tile
  const floor = new THREE.InstancedMesh(boxGeo(tile - 0.06, 0.3, tile - 0.06), new THREE.MeshLambertMaterial(), nx * nz)
  const m4 = new THREE.Matrix4()
  let i = 0
  for (let ix = 0; ix < nx; ix++) {
    for (let iz = 0; iz < nz; iz++) {
      const x = FLOOR.minX + tile / 2 + ix * tile
      const z = FLOOR.minZ + tile / 2 + iz * tile
      m4.makeTranslation(x, -0.15, z)
      floor.setMatrixAt(i, m4)
      const zone = inZone(x, z)
      const inRoom = x > ROOM.minX && x < ROOM.maxX && z > ROOM.minZ && z < ROOM.maxZ
      const checker = (ix + iz) % 2 === 0 ? 0 : 0.04
      let c: THREE.Color
      if (inRoom) c = tint('#b98b5e', '#000', checker)
      else if (zone) c = tint(DEPARTMENTS.find((d) => d.id === zone)!.color, '#f4f1ea', 0.72 + checker)
      else c = tint('#d9d6cf', '#000', checker)
      floor.setColorAt(i++, c)
    }
  }
  floor.receiveShadow = true
  root.add(floor)

  // 북쪽·서쪽 벽 (반대편은 시야 확보를 위해 비움)
  for (let x = FLOOR.minX; x < FLOOR.maxX; x += 2) {
    root.add(box(2, 4, 1, (x / 2) % 2 === 0 ? '#ece6da' : '#e3dccd', x + 1, 0, FLOOR.minZ - 0.5))
  }
  for (let z = FLOOR.minZ; z < FLOOR.maxZ; z += 2) {
    root.add(box(1, 4, 2, (z / 2) % 2 === 0 ? '#ece6da' : '#e3dccd', FLOOR.minX - 0.5, 0, z + 1))
  }
  // 창문
  for (const x of [-26, -18, 18, 26]) root.add(box(4, 1.6, 0.1, '#9fd3f5', x, 1.6, FLOOR.minZ + 0.02, false))

  // 회의실: 유리 파티션 (출입구는 동·서쪽 가운데)
  const glass = new THREE.MeshLambertMaterial({ color: '#bfe3ff', transparent: true, opacity: 0.35 })
  const frame = '#8aa0b4'
  for (let x = ROOM.minX; x < ROOM.maxX; x += 2) {
    for (const z of [ROOM.minZ, ROOM.maxZ]) {
      root.add(box(2, 1.8, 0.15, glass, x + 1, 0.2, z, false))
      root.add(box(2, 0.2, 0.3, frame, x + 1, 0, z))
    }
  }
  for (let z = ROOM.minZ; z < ROOM.maxZ; z += 2) {
    if (z + 1 > -1.6 && z + 1 < 1.6) continue // 출입구
    for (const x of [ROOM.minX, ROOM.maxX]) {
      root.add(box(0.15, 1.8, 2, glass, x, 0.2, z + 1, false))
      root.add(box(0.3, 0.2, 2, frame, x, 0, z + 1))
    }
  }
  // 대형 회의 테이블
  root.add(box(9, 0.3, 2.8, '#7a5233', 0, 1.0, 0))
  for (const sx of [-1, 1]) for (const sz of [-1, 1]) root.add(box(0.3, 1.0, 0.3, '#4e3420', sx * 4.1, 0, sz * 1.1))
  root.add(box(1.2, 0.5, 0.8, '#2b2b33', 0, 1.3, 0)) // 중앙 프로젝터
  const roomSign = textSprite('중앙 회의실 · 전체 소집', { bg: 'rgba(30,30,40,0.75)', size: 40, scale: 0.8 })
  roomSign.position.set(0, 4.2, ROOM.minZ)
  root.add(roomSign)
  // 화분
  for (const [x, z] of [
    [-7.2, -4.2],
    [7.2, 4.2],
    [-30, 24],
    [30, -24],
  ] as const) {
    root.add(box(0.8, 0.8, 0.8, '#a0522d', x, 0, z))
    root.add(box(1.0, 1.0, 1.0, '#3f9b4b', x, 0.8, z))
    root.add(box(0.6, 0.6, 0.6, '#52b45f', x, 1.8, z))
  }

  // 부서 간판
  for (const d of DEPARTMENTS) {
    const z = ZONES[d.id]
    const sign = textSprite(d.name, { bg: d.color, size: 44, scale: 0.85 })
    sign.position.set(z.cx, 5.2, z.cz - z.sz * 7.2)
    root.add(sign)
  }

  // 리포트 게시판 (북쪽 벽)
  const board = new THREE.Group()
  board.add(box(BOARD.width + 0.6, BOARD.height + 0.6, 0.3, '#6b4a2f', 0, -0.3, 0))
  board.add(box(BOARD.width, BOARD.height, 0.32, '#c79a63', 0, 0, 0.02))
  board.position.set(BOARD.x, BOARD.y, BOARD.z)
  const boardSign = textSprite('📋 리포트 게시판', { bg: 'rgba(30,30,40,0.8)', size: 40, scale: 0.8 })
  boardSign.position.set(0, BOARD.height + 0.9, 0.3)
  board.add(boardSign)
  root.add(board)

  const papers: THREE.Mesh[] = []
  return {
    root,
    board,
    addPaper(color: string) {
      const n = papers.length
      const cols = 12
      const p = box(0.9, 1.1, 0.05, '#fbfaf5', -BOARD.width / 2 + 0.8 + (n % cols) * 1.1, 0.3 + (1 - (Math.floor(n / cols) % 2)) * 1.4, 0.2, false)
      p.add(box(0.9, 0.18, 0.06, color, 0, 0.92 - 0.55 - 0.18, 0, false))
      p.rotation.z = (Math.random() - 0.5) * 0.15
      papers.push(p)
      board.add(p)
    },
    clearPapers() {
      for (const p of papers.splice(0)) board.remove(p)
    },
    get paperCount() {
      return papers.length
    },
  }
}
