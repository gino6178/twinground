// Drivable NASA Space Exploration Vehicle (NASA 3D Resources). The model is one rigid mesh; the six
// wheel sets are separated at load time from their measured centres so they can roll and steer.
// Driving is kinematic with crab steering, terrain-following suspension and traction ~ mu * g.
import * as THREE from 'three'
import { drivePower } from './terramechanics.js'

const clamp = (v, a, b) => Math.min(b, Math.max(a, v))
// Measured from the model (metres, front +Z, left +X, wheel bottoms at y = 0 after leveling).
let WHEEL_R = 0.383
let AXLES = [{ z: 0.832, steer: 1 }, { z: -0.87, steer: 0 }, { z: -2.57, steer: -1 }]
let TRACK_X = [1.25, 2.05]

// Apollo Lunar Roving Vehicle model with four separate wheel nodes (Wheel_LF, Wheel_RF, Wheel_LR, Wheel_RR). The model is
// turned so that front is +Z, scaled to the real 2.29 m wheelbase and set down on its wheels; the wheel centres then give
// the axle positions and wheel radius used by the driving code. The LRV steered both axles, as modelled here.
export function buildLrvTemplate(gltfScene) {
  const holder = new THREE.Group(); holder.add(gltfScene)
  const find = name => { let hit = null; gltfScene.traverse(o => { if (!hit && o.name === name) hit = o }); if (!hit) throw new Error('rover wheel missing: ' + name); return hit }
  const nodes = { LF: find('Wheel_LF'), RF: find('Wheel_RF'), LR: find('Wheel_LR'), RR: find('Wheel_RR') }
  const centre = o => new THREE.Box3().setFromObject(o).getCenter(new THREE.Vector3())
  holder.updateMatrixWorld(true)
  let c = Object.fromEntries(Object.entries(nodes).map(([k, o]) => [k, centre(o)]))
  const front = c.LF.clone().add(c.RF).multiplyScalar(0.5), rear = c.LR.clone().add(c.RR).multiplyScalar(0.5)
  const forward = front.clone().sub(rear)
  holder.rotation.y = -Math.atan2(forward.x, forward.z)
  holder.scale.setScalar(2.29 / Math.max(1e-6, Math.hypot(forward.x, forward.z)))
  holder.updateMatrixWorld(true)
  let box = new THREE.Box3().setFromObject(holder)
  c = Object.fromEntries(Object.entries(nodes).map(([k, o]) => [k, centre(o)]))
  const midX = (c.LF.x + c.RF.x + c.LR.x + c.RR.x) / 4, midZ = (c.LF.z + c.LR.z + c.RF.z + c.RR.z) / 4
  holder.position.set(-midX, -box.min.y, -midZ)
  holder.updateMatrixWorld(true)
  box = new THREE.Box3().setFromObject(holder)
  c = Object.fromEntries(Object.entries(nodes).map(([k, o]) => [k, centre(o)]))
  // The model's own left/right naming decides which side is +X.
  const sideSign = c.LF.x >= c.RF.x ? 1 : -1
  const zf = (c.LF.z + c.RF.z) / 2, zr = (c.LR.z + c.RR.z) / 2, half = (Math.abs(c.LF.x) + Math.abs(c.RF.x) + Math.abs(c.LR.x) + Math.abs(c.RR.x)) / 4
  WHEEL_R = (c.LF.y + c.RF.y + c.LR.y + c.RR.y) / 4
  AXLES = [{ z: zf, steer: 1 }, { z: (zf + zr) / 2, steer: 0 }, { z: zr, steer: -1 }]
  TRACK_X = [half, half]
  holder.traverse(o => { if (o.isMesh) { o.castShadow = true; o.receiveShadow = true; o.frustumCulled = false } })
  const wheel = (o, left, axle) => ({ object: o, side: left ? sideSign : -sideSign, axle })
  return {
    bodyObject: holder, length: box.max.z - box.min.z, width: box.max.x - box.min.x, height: box.max.y - box.min.y,
    wheels: [wheel(nodes.LF, true, 0), wheel(nodes.RF, false, 0), wheel(nodes.LR, true, 2), wheel(nodes.RR, false, 2)],
    // Open seat: the driver sits on the left, eyes about 1.5 m above the ground.
    eyeOffset: new THREE.Vector3(0.45 * sideSign, 1.55, zf * 0.15), seat: new THREE.Vector3(0.45 * sideSign, 0.32, (zf + zr) / 2 - 0.25),
    dispose() { holder.traverse(o => { if (o.isMesh) { o.geometry.dispose(); (Array.isArray(o.material) ? o.material : [o.material]).forEach(m => { Object.values(m).forEach(v => v?.isTexture && v.dispose()); m.dispose() }) } }) },
  }
}

function trackCanvas() {
  const c = document.createElement('canvas'); c.width = 64; c.height = 128
  const ctx = c.getContext('2d')
  ctx.fillStyle = '#fff'; ctx.fillRect(6, 0, 52, 128)
  ctx.globalCompositeOperation = 'destination-out'
  for (let y = 0; y < 128; y += 12) { ctx.fillRect(6, y, 52, 4) }
  ctx.globalCompositeOperation = 'source-over'; ctx.fillStyle = 'rgba(255,255,255,0.6)'
  for (let y = 6; y < 128; y += 12) { ctx.fillRect(14, y, 36, 3) }
  return c
}

export function buildRoverTemplate(gltfScene) {
  let source
  gltfScene.updateMatrixWorld(true)
  gltfScene.traverse(o => { if (o.isMesh && !source) source = o })
  const geometry = source.geometry.clone().applyMatrix4(source.matrixWorld)
  const box = new THREE.Box3().setFromBufferAttribute(geometry.attributes.position)
  geometry.translate(0, -box.min.y, 0)
  geometry.computeBoundingSphere()
  const pos = geometry.attributes.position, index = geometry.index.array
  // Vertex -> wheel set (side * 10 + axle) or -1.
  const owner = new Int16Array(pos.count).fill(-1)
  for (let i = 0; i < pos.count; i++) {
    const x = pos.getX(i), y = pos.getY(i), z = pos.getZ(i), ax = Math.abs(x)
    if (ax < TRACK_X[0] - 0.01 || ax > TRACK_X[1] + 0.03 || y > 2 * WHEEL_R + 0.03) continue
    for (let k = 0; k < AXLES.length; k++) {
      if (Math.hypot(y - WHEEL_R, z - AXLES[k].z) <= WHEEL_R + 0.02) { owner[i] = (x > 0 ? 0 : 10) + k; break }
    }
  }
  const bodyIdx = [], wheelIdx = new Map()
  for (let t = 0; t < index.length; t += 3) {
    const a = index[t], b = index[t + 1], c = index[t + 2], o = owner[a]
    if (o >= 0 && owner[b] === o && owner[c] === o) { if (!wheelIdx.has(o)) wheelIdx.set(o, []); wheelIdx.get(o).push(a, b, c) }
    else bodyIdx.push(a, b, c)
  }
  const share = idx => { const g = new THREE.BufferGeometry(); for (const [k, v] of Object.entries(geometry.attributes)) g.setAttribute(k, v); g.setIndex(idx); g.boundingSphere = geometry.boundingSphere; return g }
  return {
    material: source.material, body: share(bodyIdx), length: box.max.z - box.min.z, width: box.max.x - box.min.x, height: box.max.y - box.min.y,
    wheels: [...wheelIdx.entries()].map(([o, idx]) => ({ geometry: share(idx), side: o >= 10 ? -1 : 1, axle: o % 10 })),
    dispose() { geometry.dispose(); this.body.dispose(); this.wheels.forEach(w => w.geometry.dispose()); this.material.dispose() },
  }
}

export function createVehicle(template, scene) {
  const group = new THREE.Group()
  const chassis = new THREE.Group(); group.add(chassis)
  const body = template.bodyObject || new THREE.Mesh(template.body, template.material)
  if (!template.bodyObject) { body.castShadow = true; body.receiveShadow = true; body.frustumCulled = false }
  chassis.add(body)
  group.updateMatrixWorld(true)
  const wheels = template.wheels.map(w => {
    const steer = new THREE.Group(), spin = new THREE.Group()
    const cx = (TRACK_X[0] + TRACK_X[1]) / 2 * w.side, cz = AXLES[w.axle].z
    steer.position.set(cx, WHEEL_R, cz); steer.add(spin)
    chassis.add(steer)
    if (w.object) { steer.updateMatrixWorld(true); spin.attach(w.object) }
    else {
      const mesh = new THREE.Mesh(w.geometry, template.material)
      mesh.position.set(-cx, -WHEEL_R, -cz); mesh.castShadow = true; mesh.receiveShadow = true; mesh.frustumCulled = false
      spin.add(mesh)
    }
    return { steer, spin, side: w.side, axle: w.axle, local: new THREE.Vector3(cx, 0, cz) }
  })
  scene.add(group)

  const trackTexture = new THREE.CanvasTexture(trackCanvas())
  const trackMaterial = new THREE.MeshStandardMaterial({ color: 0x222222, alphaMap: trackTexture, transparent: true, opacity: 0.5, depthWrite: false, roughness: 1 })
  const TRACKS = 1200
  const tracks = new THREE.InstancedMesh(new THREE.PlaneGeometry(0.42, 0.36).rotateX(-Math.PI / 2), trackMaterial, TRACKS)
  tracks.count = 0; tracks.frustumCulled = false; tracks.receiveShadow = true
  scene.add(tracks)
  let trackCursor = 0, trackDistance = 0

  const state = { x: 0, z: 0, y: 0, yaw: 0, speed: 0, steer: 0, pitch: 0, roll: 0, spin: 0, lift: 0, liftVel: 0 }
  const wheelbase = AXLES[0].z - AXLES[2].z, track = (TRACK_X[0] + TRACK_X[1])
  const m = new THREE.Matrix4(), q = new THREE.Quaternion(), e = new THREE.Euler(0, 0, 0, 'YXZ'), v = new THREE.Vector3(), one = new THREE.Vector3(1, 1, 1)

  function worldOf(local, out) {
    const c = Math.cos(state.yaw), s = Math.sin(state.yaw)
    return out.set(state.x + local.x * c + local.z * s, 0, state.z - local.x * s + local.z * c)
  }
  function contacts(ground) {
    let front = 0, rear = 0, leftSum = 0, rightSum = 0, nf = 0, nr = 0, nl = 0, nr2 = 0, ok = true
    for (const w of wheels) {
      worldOf(w.local, v)
      const h = ground(v.x, v.z)
      if (!Number.isFinite(h)) { ok = false; continue }
      if (w.axle === 0) { front += h; nf++ } else if (w.axle === 2) { rear += h; nr++ }
      if (w.side > 0) { leftSum += h; nl++ } else { rightSum += h; nr2++ }
    }
    if (!ok || !nf || !nr || !nl || !nr2) return null
    return { front: front / nf, rear: rear / nr, left: leftSum / nl, right: rightSum / nr2 }
  }

  function settle(ground) {
    const c = contacts(ground)
    if (!c) return false
    state.pitch = Math.atan2(c.front - c.rear, wheelbase)
    state.roll = Math.atan2(c.right - c.left, track)
    state.y = (c.front + c.rear + c.left + c.right) / 4
    return true
  }

  return {
    group, state, eyeOffset: template.eyeOffset || new THREE.Vector3(0, 3.1, 2.4), seat: template.seat || null, length: template.length,
    // A fresh placement starts level: if the ground under the wheels is not known yet (a mesh still streaming), the
    // tilt from the previous world must not carry over.
    place(x, z, yaw, ground) { Object.assign(state, { x, z, yaw, speed: 0, steer: 0, pitch: 0, roll: 0, liftVel: 0, slip: 0 }); if (!settle(ground)) { const h = ground(x, z); if (Number.isFinite(h)) state.y = h } this.sync() },
    // Inputs: throttle -1..1, steer -1..1 (positive = left), brake 0/1.
    update(dt, input, ground, { gravity, speedMult = 1, colliders = [], half = Infinity, onDust, onBlocked, terra = null }) {
      const maxSpeed = 3.0 * speedMult, accel = Math.min(0.9, 0.5 * gravity) * (speedMult > 1 ? 15 : 1)
      const target = input.throttle * maxSpeed
      const brake = input.brake ? 3 * accel : 0
      const dv = target - state.speed
      state.speed += clamp(dv, -(accel + brake) * dt, (accel) * dt)
      if (input.brake) state.speed -= Math.sign(state.speed) * Math.min(Math.abs(state.speed), brake * dt)
      state.steer += (input.steer * 0.42 - state.steer) * Math.min(1, dt * 3)
      // Crab steering: front and rear axles turn opposite ways, halving the turning radius.
      const yawRate = state.speed * Math.tan(state.steer) / (wheelbase / 2)
      const prev = { x: state.x, z: state.z, yaw: state.yaw }
      state.yaw += yawRate * dt
      // B6: the wheels turn at state.speed; the ground passes at (1 - slip) of it
      const groundSpeed = state.speed * (1 - (state.slip || 0))
      state.x += Math.sin(state.yaw) * groundSpeed * dt
      state.z += Math.cos(state.yaw) * groundSpeed * dt
      let blocked = Math.abs(state.x) > half - 4 || Math.abs(state.z) > half - 4
      for (const r of colliders) if (!blocked && Math.hypot(state.x - r.x, state.z - r.z) < r.r + 2.2 && r.r > 0.6) blocked = true
      const c = blocked ? null : contacts(ground)
      // B6: soil thrust limit (slip) and a stability limit, from terramechanics.js; without it the old 0.5 rad rule
      const tm = c && terra ? drivePower(terra, Math.sin(Math.atan2(c.front - c.rear, wheelbase)) * Math.sign(state.speed || 1), state.speed) : null
      // Too steep to climb or no ground under a wheel: stop where we were.
      if (!c || (tm ? tm.blocked && Math.abs(state.speed) > 0.01 : Math.atan2(c.front - c.rear, wheelbase) * Math.sign(state.speed || 1) > 0.5)) {
        Object.assign(state, prev); state.speed = 0; state.slip = 0; onBlocked?.(c ? (tm?.reason === 'traction' ? 'slip' : 'steep') : blocked ? 'blocked' : 'no-ground')
        settle(ground)
      } else {
        const pitch = Math.atan2(c.front - c.rear, wheelbase), roll = Math.atan2(c.right - c.left, track)
        state.pitch += (pitch - state.pitch) * Math.min(1, dt * 8)
        state.roll += (roll - state.roll) * Math.min(1, dt * 8)
        // Suspension: a spring follows the contact height.
        const y = (c.front + c.rear + c.left + c.right) / 4
        state.liftVel += ((y - state.y) * 60 - state.liftVel * 11) * dt
        state.y += state.liftVel * dt
        if (Math.abs(y - state.y) > 1) { state.y = y; state.liftVel = 0 }
        state.slip = tm && !tm.blocked ? tm.slip : 0
      }
      state.powerW = terra ? (tm && !tm.blocked && Math.abs(state.speed) > 0.01 ? tm.power : terra.rover.hotelW) : 0
      const moved = Math.abs(state.speed) * dt
      state.spin += state.speed * dt / WHEEL_R
      trackDistance += moved
      if (trackDistance > 0.34 && Math.abs(state.speed) > 0.05) {
        trackDistance = 0
        for (const w of wheels) {
          if (w.axle !== 2) continue
          worldOf(w.local, v)
          const h = ground(v.x, v.z)
          if (!Number.isFinite(h)) continue
          e.set(0, state.yaw, 0); q.setFromEuler(e)
          m.compose(v.set(v.x, h + 0.03, v.z), q, one)
          tracks.setMatrixAt(trackCursor % TRACKS, m); trackCursor++
          // rooster tails: the rear wheels throw regolith backwards (clean arcs in vacuum)
          if (Math.abs(state.speed) > 0.6 && Math.random() < 0.6) onDust?.(v.x, v.z, Math.abs(state.speed), -Math.sin(state.yaw) * Math.sign(state.speed), -Math.cos(state.yaw) * Math.sign(state.speed))
        }
        tracks.count = Math.min(trackCursor, TRACKS); tracks.instanceMatrix.needsUpdate = true
      }
      this.sync()
    },
    sync() {
      group.position.set(state.x, state.y, state.z)
      e.set(-state.pitch, state.yaw, -state.roll, 'YXZ')
      group.rotation.copy(e)
      for (const w of wheels) {
        w.spin.rotation.x = state.spin
        w.steer.rotation.y = AXLES[w.axle].steer * state.steer
      }
    },
    clearTracks() { tracks.count = 0; trackCursor = 0; tracks.instanceMatrix.needsUpdate = true },
    setVisible(value) { group.visible = value; tracks.visible = value },
    dispose() { scene.remove(group); scene.remove(tracks); tracks.geometry.dispose(); trackMaterial.dispose(); trackTexture.dispose() },
  }
}
