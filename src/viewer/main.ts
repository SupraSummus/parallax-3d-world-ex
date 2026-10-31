/**
 * Reference viewer: renders a World as an ordinary triangle mesh with
 * three.js, to check what the scene looks like independently of the slice
 * renderer. Opened from the app with ?seed=&world=&camera=x,y,z&fov=&distance=.
 */
import * as THREE from 'three'
import { OrbitControls } from 'three/examples/jsm/controls/OrbitControls.js'
import { World, WORLD_TYPES, type Vec3, type WorldType } from '@/lib/world'
import { DEFAULT_FOV, DEFAULT_RENDER_DISTANCE, FOG_PER_RENDER_DISTANCE, focalLength } from '@/lib/renderer'
import { SKY_HORIZON, SKY_TOP } from '@/lib/compositor'
import { buildVoxelMesh } from './mesh'

const params = new URLSearchParams(location.search)
const seed = Number(params.get('seed') ?? 1)
const fov = Number(params.get('fov') ?? DEFAULT_FOV)
const renderDistance = Number(params.get('distance') ?? DEFAULT_RENDER_DISTANCE)
const worldParam = params.get('world')
const worldType: WorldType = WORLD_TYPES.find(t => t.value === worldParam)?.value ?? 'forest'

const started = performance.now()
const world = new World(seed, worldType)
const mesh = buildVoxelMesh(world)
const buildTime = performance.now() - started

const [cx, cy, cz] = (params.get('camera') ?? '').split(',').map(Number)
const parallaxCamera: Vec3 = Number.isFinite(cx) && Number.isFinite(cy) && Number.isFinite(cz)
  ? { x: cx, y: cy, z: cz }
  : world.spawn

const geometry = new THREE.BufferGeometry()
geometry.setAttribute('position', new THREE.BufferAttribute(mesh.positions, 3))
geometry.setAttribute('color', new THREE.BufferAttribute(mesh.colors, 3, true))
geometry.setIndex(new THREE.BufferAttribute(mesh.indices, 1))

const scene = new THREE.Scene()
scene.add(new THREE.Mesh(geometry, new THREE.MeshBasicMaterial({ vertexColors: true })))
// Linear stand-in for the slice renderer's exponential fog.
const fog = new THREE.Fog(SKY_HORIZON, 0, renderDistance * FOG_PER_RENDER_DISTANCE * 2.5)
scene.fog = fog

const renderer = new THREE.WebGLRenderer({ antialias: true, alpha: true })
renderer.setPixelRatio(window.devicePixelRatio)
renderer.outputColorSpace = THREE.LinearSRGBColorSpace // colours are already sRGB, like the 2D canvas
document.body.append(renderer.domElement)
document.body.style.background = `linear-gradient(${SKY_TOP}, ${SKY_HORIZON} 50%)`

const camera = new THREE.PerspectiveCamera(60, 1, 0.1, 2000)
const controls = new OrbitControls(camera, renderer.domElement)
// Draw only when something changes: the mesh can have millions of faces.
const draw = () => { renderer.render(scene, camera) }
controls.addEventListener('change', draw)

/** World +z maps to three.js -z (see mesh.ts). */
function toParallaxView() {
  camera.position.set(parallaxCamera.x, parallaxCamera.y, -parallaxCamera.z)
  // OrbitControls looks at its target; put it straight ahead.
  controls.target.set(parallaxCamera.x, parallaxCamera.y, -parallaxCamera.z - 10)
  controls.update()
  draw()
}

function resize() {
  const { innerWidth: w, innerHeight: h } = window
  renderer.setSize(w, h)
  camera.aspect = w / h
  // Same perspective as the slice renderer (three.js takes the vertical field of view).
  camera.fov = THREE.MathUtils.radToDeg(2 * Math.atan(h / 2 / focalLength(fov, w, h)))
  camera.updateProjectionMatrix()
  draw()
}

const info = document.getElementById('info')
if (info) {
  info.textContent =
    `${worldType} · seed ${String(seed)} · ${world.voxels.length.toLocaleString()} voxels · ` +
    `${mesh.faceCount.toLocaleString()} faces · built in ${buildTime.toFixed(0)} ms`
}
document.getElementById('reset')?.addEventListener('click', toParallaxView)
document.getElementById('fog')?.addEventListener('change', e => {
  scene.fog = (e.target as HTMLInputElement).checked ? fog : null
  draw()
})
window.addEventListener('resize', resize)

resize()
toParallaxView()
