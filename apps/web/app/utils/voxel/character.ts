// 큐브형 복셀 캐릭터 + 이동/애니메이션 상태 머신
import * as THREE from 'three'
import { box, boxGeo, textSprite } from './world'
import { routeBetween, type Spot, type Vec2 } from './layout'

export type IconKind = 'working' | 'alert' | 'done' | 'waiting' | 'queued' | 'meeting' | null
export type Pose = 'typing' | 'stand' | 'walk' | 'talk' | 'post'

const SKIN = ['#f1c27d', '#e0ac69', '#c68642', '#ffdbac', '#8d5524']
const HAIR = ['#2b1d0e', '#4a3222', '#1c1c1c', '#7a4a1e', '#b5651d']

function basic(color: string) {
  return new THREE.MeshBasicMaterial({ color })
}

/** 머리 위 상태 아이콘 (복셀) */
function buildIcons() {
  const icons: Record<Exclude<IconKind, null>, THREE.Object3D> = {} as never
  // 작업 중: 주황 톱니바퀴
  const gear = new THREE.Group()
  const orange = basic('#ff9f1a')
  gear.add(new THREE.Mesh(boxGeo(0.36, 0.36, 0.14), orange))
  for (let k = 0; k < 8; k++) {
    const a = (k / 8) * Math.PI * 2
    const tooth = new THREE.Mesh(boxGeo(0.16, 0.16, 0.14), orange)
    tooth.position.set(Math.cos(a) * 0.3, Math.sin(a) * 0.3, 0)
    tooth.rotation.z = a
    gear.add(tooth)
  }
  const hole = new THREE.Mesh(boxGeo(0.14, 0.14, 0.16), basic('#7a3d00'))
  gear.add(hole)
  icons.working = gear
  // 이슈: 빨간 느낌표
  const alert = new THREE.Group()
  const red = basic('#ff3b30')
  const bar = new THREE.Mesh(boxGeo(0.18, 0.46, 0.18), red)
  bar.position.y = 0.12
  const dot = new THREE.Mesh(boxGeo(0.18, 0.16, 0.18), red)
  dot.position.y = -0.26
  alert.add(bar, dot)
  icons.alert = alert
  // 완료: 녹색 체크
  const check = new THREE.Group()
  const green = basic('#34c759')
  const s1 = new THREE.Mesh(boxGeo(0.16, 0.3, 0.16), green)
  s1.position.set(-0.13, -0.06, 0)
  s1.rotation.z = Math.PI / 4
  const s2 = new THREE.Mesh(boxGeo(0.16, 0.56, 0.16), green)
  s2.position.set(0.1, 0.04, 0)
  s2.rotation.z = -Math.PI / 5
  check.add(s1, s2)
  icons.done = check
  // 입력 대기 / 대기열 / 회의 중 은 스프라이트
  icons.waiting = textSprite('?', { bg: '#ffcc00', color: '#3a2a00', size: 56, scale: 0.55 })
  icons.queued = textSprite('…', { bg: '#8e8e93', color: '#fff', size: 56, scale: 0.55 })
  icons.meeting = textSprite('💬', { bg: 'rgba(255,255,255,0.9)', size: 52, scale: 0.55 })
  for (const o of Object.values(icons)) o.visible = false
  return icons
}

let seed = 1
const rand = () => ((seed = (seed * 16807) % 2147483647) / 2147483647)

export class Character {
  readonly group = new THREE.Group()
  private body = new THREE.Group()
  private legL = new THREE.Group()
  private legR = new THREE.Group()
  private armL = new THREE.Group()
  private armR = new THREE.Group()
  private head: THREE.Mesh
  private iconSlot = new THREE.Group()
  private icons = buildIcons()
  private materials: THREE.MeshLambertMaterial[] = []

  icon: IconKind = null
  pose: Pose = 'typing'
  spot!: Spot
  /** 기본 자리 (책상) */
  home!: Spot

  private path: Vec2[] = []
  private moveToken = 0
  private arrive: ((ok: boolean) => void) | null = null
  private phaseOffset = rand() * 10
  private speed = 5.5

  constructor(
    readonly agentId: string,
    color: string,
    readonly leader: boolean,
  ) {
    const skin = SKIN[Math.floor(rand() * SKIN.length)]!
    const hair = HAIR[Math.floor(rand() * HAIR.length)]!
    const mk = (w: number, h: number, d: number, c: string, x = 0, y = 0, z = 0) => {
      const m = box(w, h, d, new THREE.MeshLambertMaterial({ color: c }), x, y, z)
      this.materials.push(m.material as THREE.MeshLambertMaterial)
      m.userData.agentId = agentId
      return m
    }
    const scale = leader ? 1.12 : 1
    // 다리 (엉덩이 관절 기준)
    for (const [leg, x] of [
      [this.legL, -0.2],
      [this.legR, 0.2],
    ] as const) {
      leg.position.set(x, 0.75, 0)
      const m = mk(0.32, 0.75, 0.36, leader ? '#2c2c3a' : '#34495e', 0, -0.75, 0)
      leg.add(m)
      this.body.add(leg)
    }
    // 몸통
    this.body.add(mk(0.8, 0.85, 0.48, color, 0, 0.75, 0))
    if (leader) {
      this.body.add(mk(0.16, 0.6, 0.05, '#c0392b', 0, 0.95, 0.25)) // 넥타이
    }
    // 팔 (어깨 관절 기준)
    for (const [arm, x] of [
      [this.armL, -0.52],
      [this.armR, 0.52],
    ] as const) {
      arm.position.set(x, 1.55, 0)
      arm.add(mk(0.24, 0.78, 0.3, color, 0, -0.78, 0))
      arm.add(mk(0.22, 0.16, 0.26, skin, 0, -0.92, 0))
      this.body.add(arm)
    }
    // 머리
    this.head = mk(0.7, 0.7, 0.7, skin, 0, 1.6, 0)
    this.body.add(this.head)
    this.body.add(mk(0.74, 0.18, 0.74, hair, 0, 2.22, 0))
    this.body.add(mk(0.74, 0.3, 0.12, hair, 0, 1.98, -0.32))
    // 눈
    this.body.add(mk(0.1, 0.1, 0.02, '#1b1b1b', -0.16, 1.98, 0.36))
    this.body.add(mk(0.1, 0.1, 0.02, '#1b1b1b', 0.16, 1.98, 0.36))
    if (leader) {
      // 팀장 표식: 금색 헤드셋
      this.body.add(mk(0.82, 0.08, 0.16, '#f5c542', 0, 2.42, 0))
      this.body.add(mk(0.1, 0.3, 0.2, '#f5c542', -0.4, 1.95, 0))
    }
    this.body.scale.setScalar(scale)
    this.group.add(this.body)

    this.iconSlot.position.y = leader ? 3.35 : 3.05
    for (const o of Object.values(this.icons)) this.iconSlot.add(o)
    this.group.add(this.iconSlot)
    this.group.userData.agentId = agentId
  }

  /** 즉시 배치 */
  placeAt(spot: Spot) {
    this.spot = spot
    this.path = []
    this.group.position.set(spot.pos.x, 0, spot.pos.z)
    this.group.rotation.y = spot.facing
    this.pose = spot.sit ? 'typing' : 'stand'
  }

  setIcon(kind: IconKind) {
    if (this.icon === kind) return
    this.icon = kind
    for (const [k, o] of Object.entries(this.icons)) o.visible = k === kind
  }

  setHighlight(on: boolean) {
    for (const m of this.materials) m.emissive.setHex(on ? 0x333333 : 0x000000)
  }

  get busy() {
    return this.path.length > 0
  }

  /** 지정한 자리로 걸어간다. 다른 이동 지시가 오면 false 로 끝난다. */
  goTo(spot: Spot): Promise<boolean> {
    this.arrive?.(false)
    const token = ++this.moveToken
    const from = this.spot
    this.path = routeBetween(from, spot)
    this.spot = spot
    this.pose = 'walk'
    return new Promise((resolve) => {
      this.arrive = (ok) => {
        if (token === this.moveToken) this.arrive = null
        resolve(ok)
      }
    })
  }

  goHome() {
    return this.goTo(this.home)
  }

  isAt(spot: Spot) {
    return this.spot === spot && !this.busy
  }

  update(dt: number, t: number) {
    // 이동
    if (this.path.length) {
      const target = this.path[0]!
      const p = this.group.position
      const dx = target.x - p.x
      const dz = target.z - p.z
      const d = Math.hypot(dx, dz)
      const step = this.speed * dt
      if (d <= step) {
        p.x = target.x
        p.z = target.z
        this.path.shift()
      } else {
        p.x += (dx / d) * step
        p.z += (dz / d) * step
        const want = Math.atan2(dx, dz)
        this.group.rotation.y = lerpAngle(this.group.rotation.y, want, Math.min(1, dt * 12))
      }
      if (!this.path.length) {
        this.pose = this.spot.sit ? 'typing' : 'stand'
        this.arrive?.(true)
      }
    } else {
      this.group.rotation.y = lerpAngle(this.group.rotation.y, this.spot?.facing ?? 0, Math.min(1, dt * 8))
    }

    // 포즈 애니메이션
    const tt = t + this.phaseOffset
    let legSwing = 0
    let armL = 0
    let armR = 0
    let bodyY = 0
    let headTilt = 0
    switch (this.pose) {
      case 'walk': {
        const s = Math.sin(tt * 10)
        legSwing = s * 0.6
        armL = -s * 0.6
        armR = s * 0.6
        bodyY = Math.abs(Math.cos(tt * 10)) * 0.08
        break
      }
      case 'typing': {
        // 앉아서 모니터를 보며 타이핑
        bodyY = 0.12
        armL = -1.2 + Math.sin(tt * 18) * 0.12
        armR = -1.2 + Math.sin(tt * 18 + 1.7) * 0.12
        headTilt = Math.sin(tt * 1.3) * 0.05
        break
      }
      case 'talk':
        armR = -1.6 + Math.sin(tt * 6) * 0.35
        headTilt = Math.sin(tt * 3) * 0.08
        break
      case 'post':
        armR = -2.6 + Math.sin(tt * 8) * 0.15
        armL = -2.4
        break
      default:
        headTilt = Math.sin(tt * 0.8) * 0.04
    }
    const sitting = this.pose === 'typing'
    this.legL.rotation.x = sitting ? -Math.PI / 2 : legSwing
    this.legR.rotation.x = sitting ? -Math.PI / 2 : -legSwing
    this.armL.rotation.x = armL
    this.armR.rotation.x = armR
    this.body.position.y = bodyY
    this.head.rotation.x = headTilt

    // 아이콘 회전/부유
    this.iconSlot.position.y = (this.leader ? 3.35 : 3.05) + Math.sin(t * 3 + this.phaseOffset) * 0.08
    if (this.icon === 'working') {
      this.icons.working.rotation.z -= dt * 4
      this.iconSlot.rotation.y += dt * 1.5
    } else if (this.icon === 'done' || this.icon === 'alert') {
      this.iconSlot.rotation.y += dt * 2
    } else this.iconSlot.rotation.y = 0
  }
}

function lerpAngle(a: number, b: number, t: number) {
  let d = ((b - a + Math.PI) % (Math.PI * 2)) - Math.PI
  if (d < -Math.PI) d += Math.PI * 2
  return a + d * t
}
