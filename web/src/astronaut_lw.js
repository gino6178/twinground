// Astronaut from lunar-walk (https://github.com/hh-hang/lunar-walk): "Tripo Astronaut 2 (Stylized and animated)" by
// Jungle Jim, CC BY 4.0, https://sketchfab.com/3d-models/tripo-astronaut-2-stylized-and-animated-fe594ac4364942e8abad34744e507038
// The model carries its own motion clips (idle, walk, run, jumpStart, jumpLoop, jumpEnd, driving). This module scales
// it to a suited astronaut, blends the clips from the explorer's movement state and slows them in low gravity.
import * as THREE from 'three'

const HEIGHT_M = 1.9
const CLIPS = ['idle', 'walk', 'run', 'jumpLoop', 'driving']
// The clips were authored for Earth gravity; the reference project plays them at 0.6 on the Moon.
const gravityPace = g => Math.min(1, Math.max(0.55, Math.pow(g / 9.81, 0.28)))

export function makeLwAstronaut(gltf, { yaw = 0 } = {}) {
  const model = gltf.scene
  const root = new THREE.Group(), holder = new THREE.Group()
  root.add(holder); holder.add(model)
  model.updateMatrixWorld(true)
  const box = new THREE.Box3().setFromObject(model)
  const scale = HEIGHT_M / Math.max(1e-6, box.max.y - box.min.y)
  holder.scale.setScalar(scale)
  holder.position.set(-(box.min.x + box.max.x) / 2 * scale, -box.min.y * scale, -(box.min.z + box.max.z) / 2 * scale)
  holder.rotation.y = yaw

  const materials = new Set()
  let headBone = null
  model.traverse(o => {
    if (o.isBone && !headBone && /head/i.test(o.name) && !/scaleCompensation/i.test(o.name)) headBone = o
    if (!o.isMesh) return
    o.castShadow = true; o.receiveShadow = true; o.frustumCulled = false
    for (const material of Array.isArray(o.material) ? o.material : [o.material]) {
      if (materials.has(material)) continue
      materials.add(material)
      material.userData.baseColor = material.color.clone()
      // Two-sided suit parts cast from their back faces, which avoids striped self-shadowing under a low Sun.
      if (material.side === THREE.DoubleSide && material.shadowSide === null) material.shadowSide = THREE.BackSide
    }
  })

  // A plain node that follows the head, in metres and without the skeleton's scale, for the headlamp and the camera.
  const head = new THREE.Object3D(); head.position.set(0, HEIGHT_M * 0.9, 0); root.add(head)
  const headlamp = new THREE.SpotLight(0xffffff, 0)
  headlamp.position.set(0, 0.08, 0.18); headlamp.target.position.set(0, -0.6, 4)
  head.add(headlamp, headlamp.target)

  const mixer = new THREE.AnimationMixer(model)
  const actions = {}
  for (const name of CLIPS) {
    const clip = THREE.AnimationClip.findByName(gltf.animations, name)
    if (!clip) continue
    const action = mixer.clipAction(clip)
    action.setEffectiveWeight(name === 'idle' ? 1 : 0); action.play()
    actions[name] = { action, weight: name === 'idle' ? 1 : 0 }
  }
  const world = new THREE.Vector3()
  // Foot plants for footprints and dust: a foot counts as planted when its ankle comes down to standing height.
  const feet = [/_L_Foot_\d+$/, /_R_Foot_\d+$/].map((pattern, i) => {
    let bone = null
    model.traverse(o => { if (!bone && o.isBone && pattern.test(o.name)) bone = o })
    return { bone, side: i ? -1 : 1, down: true }
  })
  let wasGrounded = true

  return {
    model: 'lw', root, head, headlamp, hipHeight: HEIGHT_M * 0.52,
    // state: the explorer's gait state (speed, running, grounded, gravity, walkSpeed, runSpeed)
    // onPlant(side, x, z, landing) is called when a foot comes down.
    animate(state, dt, driving = false, onPlant = null) {
      const speed = state.speed || 0
      const target = driving && actions.driving ? 'driving' : !state.grounded && actions.jumpLoop ? 'jumpLoop' : speed < 0.08 ? 'idle' : state.running && actions.run ? 'run' : 'walk'
      const pace = gravityPace(state.gravity || 9.81)
      const k = Math.min(1, dt * 7)
      for (const [name, entry] of Object.entries(actions)) {
        entry.weight += ((name === target ? 1 : 0) - entry.weight) * k
        entry.action.setEffectiveWeight(entry.weight)
        // Step rate follows ground speed, so the feet do not slide.
        entry.action.timeScale = name === 'walk' ? pace * Math.min(1.5, Math.max(0.6, speed / Math.max(0.1, state.walkSpeed || 1)))
          : name === 'run' ? pace * Math.min(1.4, Math.max(0.7, speed / Math.max(0.1, state.runSpeed || 2))) : pace
      }
      mixer.update(dt)
      if (headBone) { headBone.getWorldPosition(world); root.worldToLocal(world); head.position.copy(world) }
      if (onPlant && !driving) {
        const landing = state.grounded && !wasGrounded
        for (const foot of feet) {
          if (!foot.bone) continue
          foot.bone.getWorldPosition(world)
          const lift = world.y - root.position.y
          const down = foot.down ? lift < 0.24 : lift < 0.19
          if ((down && !foot.down && state.grounded && speed > 0.15) || landing) onPlant(foot.side, world.x, world.z, landing)
          foot.down = down
        }
      }
      wasGrounded = !!state.grounded
    },
    setLamp() {},
    // Regolith clinging to the suit: the fabric colours drift toward the local dust colour.
    setDust(color, amount) {
      const t = Math.min(0.6, amount * 0.7)
      for (const material of materials) if (!material.name?.includes('Visor')) material.color.copy(material.userData.baseColor).lerp(color, t)
    },
    dispose() {
      mixer.stopAllAction()
      model.traverse(o => { if (o.isMesh) o.geometry.dispose() })
      for (const material of materials) { Object.values(material).forEach(v => v?.isTexture && v.dispose()); material.dispose() }
    },
  }
}
