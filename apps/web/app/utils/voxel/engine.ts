// Three.js 엔진: 렌더러, 아이소메트릭 카메라(피치 제어), 레이캐스팅, 렌더 루프
import * as THREE from 'three'
import { OrbitControls } from 'three/examples/jsm/controls/OrbitControls.js'
import { DEPARTMENTS, leaderId, workerId } from '@pixelboss/shared'
import type { ProjectConfig } from '@pixelboss/shared'
import { Character } from './character'
import { Director, type DirectorInput } from './director'
import decor from './decor'
import { FLOOR, ceoDeskSpot, configureLayout, leaderDesk, workerDesk } from './layout'
import { buildDesk, buildWorld, type DeskHandle, type WorldHandle } from './world'

export type ViewPreset = 'top' | 'iso' | 'side'

/** 프리셋별 극각(polar). 0 = 완전 수직 탑뷰, π/2 = 완전 수평 사이드 뷰 */
export const PRESET_POLAR: Record<ViewPreset, number> = { top: 0.0001, iso: Math.PI / 4, side: Math.PI / 2 }

export class VoxelEngine {
  readonly renderer: THREE.WebGLRenderer
  readonly scene = new THREE.Scene()
  readonly camera: THREE.OrthographicCamera
  readonly controls: OrbitControls
  readonly chars = new Map<string, Character>()
  world: WorldHandle
  private desks = new Map<string, DeskHandle>()
  private director: Director
  private sun!: THREE.DirectionalLight
  private layoutWidth = 0
  /** 수족관 등 매 프레임 갱신되는 장식 */
  private ticks: ((t: number) => void)[] = []
  private raycaster = new THREE.Raycaster()
  private pointer = new THREE.Vector2()
  private timer = new THREE.Timer()
  private frame = 0
  private projectKey = ''
  private tmp = new THREE.Vector3()
  private hovered: Character | null = null
  private polarTween: { from: number; to: number; t: number } | null = null
  private down = { x: 0, y: 0 }
  private resizeObserver: ResizeObserver
  /** 이번 프레임 극각 (UI 표시용) */
  onPolarChange?: (polar: number) => void
  onPick?: (agentId: string) => void
  /** 리포트 게시판 클릭 */
  onPickBoard?: () => void
  /** 마우스가 올라간 캐릭터와 머리 위 화면 좌표(컨테이너 기준 px). 벗어나면 undefined */
  onHover?: (hover?: { agentId: string; x: number; y: number }) => void

  constructor(
    private container: HTMLElement,
    projects: ProjectConfig[],
  ) {
    this.renderer = new THREE.WebGLRenderer({ antialias: true, preserveDrawingBuffer: true })
    this.renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2))
    this.renderer.shadowMap.enabled = true
    this.renderer.shadowMap.type = THREE.PCFShadowMap
    this.renderer.outputColorSpace = THREE.SRGBColorSpace
    container.appendChild(this.renderer.domElement)

    this.scene.background = new THREE.Color('#1d2230')
    // 아이소메트릭 느낌을 위해 직교 카메라 사용
    this.camera = new THREE.OrthographicCamera(-1, 1, 1, -1, -500, 1000)
    this.camera.zoom = 0.95
    this.controls = new OrbitControls(this.camera, this.renderer.domElement)
    this.controls.target.set(0, 0, -9)
    // 마우스를 아래로 끌면 극각이 줄어 탑뷰, 위로 끌면 극각이 커져 수평 사이드 뷰가 된다
    this.controls.minPolarAngle = PRESET_POLAR.top
    this.controls.maxPolarAngle = PRESET_POLAR.side
    this.controls.enableDamping = true
    this.controls.dampingFactor = 0.12
    this.controls.rotateSpeed = 0.7
    this.controls.minZoom = 0.1
    this.controls.maxZoom = 4
    this.controls.screenSpacePanning = false
    this.controls.mouseButtons = { LEFT: THREE.MOUSE.ROTATE, MIDDLE: THREE.MOUSE.DOLLY, RIGHT: THREE.MOUSE.PAN }
    // 기본 시점: 위에서 45도로 내려다보는 아이소메트릭 사선 뷰
    const r = 120
    const polar = PRESET_POLAR.iso
    const azimuth = Math.PI / 4
    this.camera.position.set(r * Math.sin(polar) * Math.sin(azimuth), r * Math.cos(polar), r * Math.sin(polar) * Math.cos(azimuth) - 9)
    this.controls.update()
    this.controls.addEventListener('change', () => this.onPolarChange?.(this.controls.getPolarAngle()))

    // 조명
    this.scene.add(new THREE.HemisphereLight('#ffffff', '#5a5a70', 1.4))
    const sun = (this.sun = new THREE.DirectionalLight('#fff4e0', 2.2))
    sun.position.set(30, 60, 25)
    sun.castShadow = true
    sun.shadow.mapSize.set(2048, 2048)
    sun.shadow.bias = -0.0005
    this.scene.add(sun)

    // 월드 + 책상 + 캐릭터
    const world = (this.world = buildWorld())
    this.scene.add(world.root)
    for (const dept of DEPARTMENTS) {
      const lspec = leaderDesk(dept.id)
      const ldesk = buildDesk(lspec, dept.color, true)
      this.scene.add(ldesk.group)
      this.desks.set(leaderId(dept.id), ldesk)
      const leader = new Character(leaderId(dept.id), dept.color, true)
      leader.home = lspec.seat
      leader.placeAt(lspec.seat)
      this.chars.set(leader.agentId, leader)
      this.scene.add(leader.group)
    }
    // 사장: 사장실 책상에서 일하고, 전체 소집 때는 회의 테이블 상석에서 팀장들과 면담한다
    const ceo = new Character('ceo', '#1c2038', true, true)
    ceo.home = ceoDeskSpot()
    ceo.placeAt(ceo.home)
    this.chars.set('ceo', ceo)
    this.scene.add(ceo.group)
    this.buildWorkers(projects)
    this.director = new Director(this.chars, this.desks, this.world)

    // 입력: 드래그와 클릭 구분 (5px 이상 움직이면 카메라 회전으로 간주)
    const el = this.renderer.domElement
    el.addEventListener('pointerdown', (e) => (this.down = { x: e.clientX, y: e.clientY }))
    el.addEventListener('pointerup', (e) => {
      if (Math.hypot(e.clientX - this.down.x, e.clientY - this.down.y) > 5) return
      const c = this.pick(e)
      if (c) this.onPick?.(c.agentId)
      else if (this.overBoard(e)) this.onPickBoard?.()
    })
    el.addEventListener('pointermove', (e) => {
      if (e.buttons) return
      const c = this.pick(e)
      if (c !== this.hovered) {
        this.hovered?.setHighlight(false)
        c?.setHighlight(true)
        this.hovered = c
        if (!c) this.onHover?.(undefined)
      }
      el.style.cursor = c || this.overBoard(e) ? 'pointer' : 'grab'
    })
    el.addEventListener('pointerleave', () => {
      this.hovered?.setHighlight(false)
      this.hovered = null
      this.onHover?.(undefined)
    })

    this.resizeObserver = new ResizeObserver(() => this.resize())
    this.resizeObserver.observe(container)
    this.resize()
    this.loop()
  }

  /** 실무자 책상·캐릭터를 프로젝트 목록에 맞춰 다시 만든다 (좌석이 프로젝트 순서로 정해지므로 통째로 교체) */
  setProjects(projects: ProjectConfig[]) {
    const key = projects.map((p) => p.id).join('|')
    if (key === this.projectKey) return
    configureLayout(projects.length)
    this.rebuildOffice(projects.length) // 칸막이·서류함 수와 건물 너비가 프로젝트 수를 따른다
    for (const [id, c] of this.chars) {
      if (c.leader) continue
      this.scene.remove(c.group, this.desks.get(id)!.group)
      this.chars.delete(id)
      this.desks.delete(id)
      if (this.hovered === c) {
        this.hovered = null
        this.onHover?.(undefined)
      }
    }
    this.buildWorkers(projects)
  }

  /** 바닥·벽·가구를 현재 레이아웃(FLOOR/ROOMS)으로 만들고 조명 범위·카메라 배율을 맞춘다 */
  private buildOffice(projectCount: number) {
    this.world = buildWorld()
    this.ticks = decor.buildDecor(this.world.root, projectCount)
    this.scene.add(this.world.root)
    const reach = FLOOR.maxX + 14
    Object.assign(this.sun.shadow.camera, { left: -reach, right: reach, top: reach, bottom: -reach, near: 1, far: 200 })
    this.sun.shadow.camera.updateProjectionMatrix()
    if (FLOOR.maxX !== this.layoutWidth) {
      // 건물과 사장실 별관이 한 화면에 들어오도록 기본 배율을 정한다 (W=32 에서 0.83)
      this.layoutWidth = FLOOR.maxX
      this.camera.zoom = (0.95 * 58) / (FLOOR.maxX + 34)
      this.camera.updateProjectionMatrix()
    }
  }

  /** 월드를 통째로 다시 만든다. 게시판의 리포트 서류는 복원한다 */
  private rebuildOffice(projectCount: number) {
    const colors = [...this.world.paperColors]
    this.scene.remove(this.world.root)
    this.world.root.traverse((o) => {
      if (o instanceof THREE.Sprite) {
        o.material.map?.dispose()
        o.material.dispose()
      } else if (o instanceof THREE.InstancedMesh) {
        o.dispose()
        ;(o.material as THREE.Material).dispose()
      }
    })
    this.buildOffice(projectCount)
    this.director.setWorld(this.world)
    for (const c of colors) this.world.addPaper(c)
  }

  private buildWorkers(projects: ProjectConfig[]) {
    this.projectKey = projects.map((p) => p.id).join('|')
    for (const dept of DEPARTMENTS) {
      projects.forEach((p, i) => {
        const spec = workerDesk(dept.id, i)
        const desk = buildDesk(spec, dept.color)
        this.scene.add(desk.group)
        const id = workerId(dept.id, p.id)
        this.desks.set(id, desk)
        const c = new Character(id, dept.color, false)
        c.home = spec.seat
        c.placeAt(spec.seat)
        this.chars.set(id, c)
        this.scene.add(c.group)
      })
    }
  }

  /** 레이캐스팅으로 클릭한 캐릭터 찾기 */
  pick(e: PointerEvent): Character | null {
    const rect = this.renderer.domElement.getBoundingClientRect()
    this.pointer.set(((e.clientX - rect.left) / rect.width) * 2 - 1, -((e.clientY - rect.top) / rect.height) * 2 + 1)
    this.raycaster.setFromCamera(this.pointer, this.camera)
    const hits = this.raycaster.intersectObjects([...this.chars.values()].map((c) => c.group), true)
    for (const h of hits) {
      const id = h.object.userData.agentId as string | undefined
      if (id) return this.chars.get(id) ?? null
    }
    return null
  }

  /** 포인터가 리포트 게시판 위에 있는지 */
  private overBoard(e: PointerEvent): boolean {
    const rect = this.renderer.domElement.getBoundingClientRect()
    this.pointer.set(((e.clientX - rect.left) / rect.width) * 2 - 1, -((e.clientY - rect.top) / rect.height) * 2 + 1)
    this.raycaster.setFromCamera(this.pointer, this.camera)
    return this.raycaster.intersectObject(this.world.board, true).length > 0
  }

  /** 카메라 피치를 프리셋으로 부드럽게 전환 */
  setView(preset: ViewPreset) {
    this.polarTween = { from: this.controls.getPolarAngle(), to: PRESET_POLAR[preset], t: 0 }
  }

  private applyPolar(polar: number) {
    const offset = this.camera.position.clone().sub(this.controls.target)
    const sph = new THREE.Spherical().setFromVector3(offset)
    sph.phi = THREE.MathUtils.clamp(polar, PRESET_POLAR.top, PRESET_POLAR.side)
    offset.setFromSpherical(sph)
    this.camera.position.copy(this.controls.target).add(offset)
    this.camera.lookAt(this.controls.target)
    this.onPolarChange?.(sph.phi)
  }

  sync(input: DirectorInput) {
    this.director.sync(input)
  }

  /** 호버 중인 캐릭터 머리 위의 화면 좌표를 알린다 (카메라·캐릭터가 움직여도 따라가도록 매 프레임) */
  private reportHover(c: Character) {
    const v = c.group.getWorldPosition(this.tmp)
    v.y += c.leader ? 3.9 : 3.6
    v.project(this.camera)
    const x = Math.round(((v.x + 1) / 2) * this.container.clientWidth)
    const y = Math.round(((1 - v.y) / 2) * this.container.clientHeight)
    this.onHover?.({ agentId: c.agentId, x, y })
  }

  private resize() {
    const w = this.container.clientWidth
    const h = this.container.clientHeight
    if (!w || !h) return
    const aspect = w / h
    const view = 34 // 화면 세로에 보이는 월드 크기의 절반
    this.camera.left = -view * aspect
    this.camera.right = view * aspect
    this.camera.top = view
    this.camera.bottom = -view
    this.camera.updateProjectionMatrix()
    this.renderer.setSize(w, h)
  }

  private loop = () => {
    this.frame = requestAnimationFrame(this.loop)
    this.timer.update()
    // 프레임이 끊겨도 이동·연출 속도가 실시간을 따라가도록 넉넉하게 제한
    const dt = Math.min(this.timer.getDelta(), 0.25)
    const t = this.timer.getElapsed()
    if (this.polarTween) {
      const tw = this.polarTween
      tw.t = Math.min(1, tw.t + dt * 2.2)
      const k = 1 - Math.pow(1 - tw.t, 3)
      this.applyPolar(tw.from + (tw.to - tw.from) * k)
      if (tw.t >= 1) this.polarTween = null
    }
    this.controls.update()
    for (const c of this.chars.values()) c.update(dt, t)
    for (const tick of this.ticks) tick(t)
    this.director.tick(dt)
    if (this.hovered) this.reportHover(this.hovered)
    this.renderer.render(this.scene, this.camera)
  }

  dispose() {
    cancelAnimationFrame(this.frame)
    this.resizeObserver.disconnect()
    this.controls.dispose()
    this.renderer.dispose()
    this.renderer.domElement.remove()
  }
}
