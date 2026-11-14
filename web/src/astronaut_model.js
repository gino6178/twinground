// Procedural EVA suit: hard upper torso, life-support backpack, helmet with gold sun visor and
// lights, bearings and bellows at the joints, gloves and lunar-style boots. Faces +Z, feet at y = 0.
import * as THREE from 'three'
import { RoundedBoxGeometry } from 'three/addons/geometries/RoundedBoxGeometry.js'

function weaveCanvas() {
  const c = document.createElement('canvas'); c.width = c.height = 128
  const ctx = c.getContext('2d'), img = ctx.createImageData(128, 128)
  for (let y = 0; y < 128; y++) for (let x = 0; x < 128; x++) {
    const v = 128 + 38 * Math.sin(x * Math.PI / 2) * Math.sin(y * Math.PI / 2) + (Math.random() - 0.5) * 30 + 18 * Math.sin(y * 0.19)
    const i = (y * 128 + x) * 4
    img.data[i] = img.data[i + 1] = img.data[i + 2] = Math.max(0, Math.min(255, v)); img.data[i + 3] = 255
  }
  ctx.putImageData(img, 0, 0)
  return c
}
function patchCanvas() {
  const c = document.createElement('canvas'); c.width = c.height = 128
  const ctx = c.getContext('2d')
  ctx.fillStyle = '#0d2a35'; ctx.beginPath(); ctx.arc(64, 64, 62, 0, Math.PI * 2); ctx.fill()
  ctx.strokeStyle = '#d8c58a'; ctx.lineWidth = 5; ctx.stroke()
  ctx.fillStyle = '#f5f5f5'; ctx.beginPath(); ctx.arc(64, 58, 20, 0, Math.PI * 2); ctx.fill()
  ctx.fillStyle = '#e65a54'; ctx.beginPath(); ctx.arc(80, 50, 7, 0, Math.PI * 2); ctx.fill()
  ctx.fillStyle = '#f2efe4'; ctx.font = '700 15px Manrope, sans-serif'; ctx.textAlign = 'center'
  ctx.fillText('ANALOG ATLAS', 64, 104)
  return c
}

export function makeAstronaut() {
  const weave = new THREE.CanvasTexture(weaveCanvas())
  weave.wrapS = weave.wrapT = THREE.RepeatWrapping; weave.repeat.set(5, 5); weave.colorSpace = THREE.NoColorSpace
  const fabric = new THREE.MeshStandardMaterial({ color: 0xeeece4, roughness: 0.9, bumpMap: weave, bumpScale: 0.8 })
  const dusty = new THREE.MeshStandardMaterial({ color: 0xeeece4, roughness: 0.95, bumpMap: weave, bumpScale: 1 })
  const shell = new THREE.MeshStandardMaterial({ color: 0xf3f2ee, roughness: 0.42, metalness: 0.02 })
  const metal = new THREE.MeshStandardMaterial({ color: 0xbfc4c9, roughness: 0.25, metalness: 0.95 })
  const dark = new THREE.MeshStandardMaterial({ color: 0x2b2f33, roughness: 0.55, metalness: 0.35 })
  const rubber = new THREE.MeshStandardMaterial({ color: 0x1c1d1f, roughness: 0.95 })
  const glove = new THREE.MeshStandardMaterial({ color: 0xd9d6cc, roughness: 0.75, bumpMap: weave, bumpScale: 0.5 })
  const red = new THREE.MeshStandardMaterial({ color: 0xb3262e, roughness: 0.7 })
  const blue = new THREE.MeshStandardMaterial({ color: 0x2f5fa8, roughness: 0.55 })
  const visor = new THREE.MeshPhysicalMaterial({ color: 0xd8a33a, metalness: 1, roughness: 0.05, clearcoat: 1, clearcoatRoughness: 0.03, envMapIntensity: 2 })
  const lens = new THREE.MeshStandardMaterial({ color: 0xfaf7ea, emissive: 0xfff4d8, emissiveIntensity: 0 })
  const led = new THREE.MeshStandardMaterial({ color: 0xececec, emissive: 0xe6e6e6, emissiveIntensity: 2 })
  const patchTex = new THREE.CanvasTexture(patchCanvas()); patchTex.colorSpace = THREE.SRGBColorSpace
  const patch = new THREE.MeshStandardMaterial({ map: patchTex, roughness: 0.8 })
  const textures = [weave, patchTex]
  const materials = [fabric, dusty, shell, metal, dark, rubber, glove, red, blue, visor, lens, led, patch]

  const mesh = (geometry, material, x = 0, y = 0, z = 0) => {
    const m = new THREE.Mesh(geometry, material); m.position.set(x, y, z); m.castShadow = true; m.receiveShadow = true; return m
  }
  const ring = (radius, tube, material, y = 0) => { const m = mesh(new THREE.TorusGeometry(radius, tube, 8, 28), material, 0, y, 0); m.rotation.x = Math.PI / 2; return m }
  const lathe = (points, material, sz = 1) => { const g = new THREE.LatheGeometry(points.map(([r, y]) => new THREE.Vector2(r, y)), 32); g.scale(1, 1, sz); return mesh(g, material) }

  const root = new THREE.Group()
  const body = new THREE.Group(); root.add(body)
  const HIP = 0.99
  const pelvis = new THREE.Group(); pelvis.position.y = HIP; body.add(pelvis)
  pelvis.add(lathe([[0, -0.16], [0.17, -0.14], [0.21, -0.04], [0.215, 0.08], [0.2, 0.13], [0, 0.13]], fabric, 0.82))
  pelvis.add(ring(0.2, 0.022, metal, 0.12))

  const torso = new THREE.Group(); torso.position.y = 0.13; pelvis.add(torso)
  // Hard upper torso
  torso.add(lathe([[0, 0], [0.19, 0.0], [0.25, 0.08], [0.285, 0.26], [0.28, 0.44], [0.23, 0.56], [0.15, 0.62], [0, 0.625]], shell, 0.78))
  torso.add(ring(0.155, 0.02, metal, 0.63))
  // Display and control module with knobs and a dim status screen
  const dcm = mesh(new RoundedBoxGeometry(0.32, 0.16, 0.12, 3, 0.025), dark, 0, 0.36, 0.24); torso.add(dcm)
  ;[-0.1, -0.03, 0.04].forEach((x, i) => { const k = mesh(new THREE.CylinderGeometry(0.018, 0.018, 0.03, 12), i === 1 ? red : metal, x, 0.39, 0.31); k.rotation.x = Math.PI / 2; torso.add(k) })
  torso.add(mesh(new THREE.BoxGeometry(0.07, 0.04, 0.005), led, 0.1, 0.38, 0.302))
  // Umbilical hoses from the chest module back to the pack
  ;[[0.15, blue], [-0.15, red]].forEach(([x, m]) => {
    const curve = new THREE.CatmullRomCurve3([new THREE.Vector3(x, 0.32, 0.27), new THREE.Vector3(x * 1.9, 0.24, 0.12), new THREE.Vector3(x * 2.05, 0.3, -0.12), new THREE.Vector3(x * 1.4, 0.36, -0.22)])
    torso.add(mesh(new THREE.TubeGeometry(curve, 18, 0.018, 8, false), m))
  })
  // Portable life support system and secondary oxygen pack
  const pack = new THREE.Group(); pack.position.set(0, 0.33, -0.34); torso.add(pack)
  pack.add(mesh(new RoundedBoxGeometry(0.54, 0.7, 0.26, 4, 0.05), shell))
  pack.add(mesh(new RoundedBoxGeometry(0.48, 0.15, 0.22, 3, 0.04), shell, 0, -0.43, 0.01))
  pack.add(mesh(new THREE.BoxGeometry(0.4, 0.02, 0.01), dark, 0, 0.12, -0.131))
  pack.add(mesh(new THREE.BoxGeometry(0.4, 0.02, 0.01), dark, 0, -0.05, -0.131))
  const antenna = mesh(new THREE.CylinderGeometry(0.006, 0.006, 0.3, 6), metal, 0.2, 0.48, -0.05); pack.add(antenna)
  pack.add(mesh(new THREE.SphereGeometry(0.012, 8, 6), red, 0.2, 0.63, -0.05))
  ;[-0.2, 0.2].forEach(x => { const h = mesh(new THREE.TorusGeometry(0.05, 0.01, 6, 14, Math.PI), metal, x, 0.36, -0.13); h.rotation.y = Math.PI / 2; pack.add(h) })
  // Helmet
  const head = new THREE.Group(); head.position.y = 0.76; torso.add(head)
  const helmetGeometry = new THREE.SphereGeometry(0.2, 40, 28); helmetGeometry.scale(1, 1.06, 1.06)
  head.add(mesh(helmetGeometry, shell))
  const visorGeometry = new THREE.SphereGeometry(0.212, 40, 28, Math.PI * 0.08, Math.PI * 0.84, Math.PI * 0.2, Math.PI * 0.45); visorGeometry.scale(1, 1.06, 1.06)
  const visorMesh = mesh(visorGeometry, visor); head.add(visorMesh)
  const lights = []
  ;[0.17, -0.17].forEach(x => {
    const housing = mesh(new THREE.CylinderGeometry(0.032, 0.036, 0.09, 16), shell, x, 0.1, 0.05); housing.rotation.x = Math.PI / 2; head.add(housing)
    const glass = mesh(new THREE.CircleGeometry(0.028, 16), lens, x, 0.1, 0.096); head.add(glass); lights.push(glass)
  })
  head.add(mesh(new RoundedBoxGeometry(0.06, 0.05, 0.08, 2, 0.01), dark, 0.2, -0.02, 0.02))

  const limb = (side, isArm) => {
    const joint = new THREE.Group()
    const upperLen = isArm ? 0.29 : 0.42, lowerLen = isArm ? 0.27 : 0.42, r = isArm ? 0.078 : 0.105
    if (isArm) joint.add(mesh(new THREE.SphereGeometry(0.105, 18, 14), shell, 0, 0.01, 0))
    joint.add(ring(r * 1.05, 0.016, metal, -0.06))
    joint.add(mesh(new THREE.CapsuleGeometry(r, upperLen - r * 1.4, 6, 16), fabric, 0, -upperLen / 2, 0))
    if (side < 0) joint.add(mesh(new THREE.CylinderGeometry(r * 1.07, r * 1.07, 0.06, 18), red, 0, -upperLen * 0.38, 0))
    const mid = new THREE.Group(); mid.position.y = -upperLen; joint.add(mid)
    // Bellows at the elbow and knee
    for (let i = -1; i <= 1; i++) mid.add(ring(r * 1.02, 0.014, isArm ? fabric : dusty, i * 0.03))
    const lowerMaterial = isArm ? fabric : dusty
    mid.add(mesh(new THREE.CapsuleGeometry(r * 0.95, lowerLen - r * 1.3, 6, 16), lowerMaterial, 0, -lowerLen / 2, 0))
    let end
    if (isArm) {
      mid.add(ring(r * 0.95, 0.018, metal, -lowerLen + 0.03))
      end = new THREE.Group(); end.position.set(0, -lowerLen - 0.03, 0)
      end.add(mesh(new THREE.CylinderGeometry(0.075, 0.06, 0.07, 14), glove, 0, 0.0, 0))
      end.add(mesh(new RoundedBoxGeometry(0.1, 0.11, 0.05, 2, 0.02), glove, 0, -0.08, 0.005))
      for (let f = 0; f < 4; f++) { const finger = mesh(new THREE.CapsuleGeometry(0.012, 0.05, 4, 8), glove, -0.034 + f * 0.023, -0.16, 0.012); finger.rotation.x = 0.35; end.add(finger) }
      const thumb = mesh(new THREE.CapsuleGeometry(0.013, 0.04, 4, 8), glove, side * -0.055, -0.1, 0.03); thumb.rotation.z = side * 0.6; end.add(thumb)
    } else {
      end = new THREE.Group(); end.position.set(0, -lowerLen - 0.035, 0.045)
      end.add(mesh(new RoundedBoxGeometry(0.17, 0.14, 0.31, 3, 0.05), dusty))
      end.add(mesh(new RoundedBoxGeometry(0.18, 0.045, 0.33, 2, 0.015), rubber, 0, -0.07, 0))
      end.add(mesh(new THREE.CylinderGeometry(0.1, 0.11, 0.08, 18), dusty, 0, 0.08, -0.04))
    }
    mid.add(end)
    return { joint, mid, wrist: isArm ? end : null }
  }
  const legL = limb(1, false), legR = limb(-1, false)
  legL.joint.position.set(0.12, -0.02, 0); legR.joint.position.set(-0.12, -0.02, 0)
  pelvis.add(legL.joint, legR.joint)
  const armL = limb(1, true), armR = limb(-1, true)
  armL.joint.position.set(0.34, 0.47, 0); armR.joint.position.set(-0.34, 0.47, 0)
  torso.add(armL.joint, armR.joint)
  const patchMesh = mesh(new THREE.CircleGeometry(0.05, 24), patch, 0.083, -0.09, 0.0)
  patchMesh.rotation.y = Math.PI / 2; armL.joint.add(patchMesh)

  const headlamp = new THREE.SpotLight(0xf3fbff, 0, 60, 0.45, 0.5, 1.6)
  headlamp.position.set(0, 0.1, 0.12)
  headlamp.target.position.set(0, -0.8, 4)
  head.add(headlamp, headlamp.target)

  const clean = new THREE.Color(0xeeece4)
  return {
    model: 'procedural', pose: { armX: 0.08, armZ: 0.22, elbow: -0.45, elbowRun: -0.35 },
    leg: { thigh: 0.42, shin: 0.5475, hipX: 0.12, hipY: -0.02, footX: 0.12 },
    hipHeight: HIP, root, body, pelvis, torso, head, legL, legR, armL, armR, headlamp, visor: visorMesh,
    setLamp(on) { lights.forEach(l => { l.material.emissiveIntensity = on ? 6 : 0 }) },
    // Regolith accumulates on boots and lower legs with distance walked.
    setDust(color, amount) { dusty.color.copy(clean).lerp(color, Math.min(0.85, amount)) },
    dispose() { materials.forEach(m => m.dispose()); textures.forEach(t => t.dispose()); root.traverse(o => o.geometry?.dispose()) },
  }
}
