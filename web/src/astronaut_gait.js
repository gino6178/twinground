// Procedural locomotion for the astronaut: planted feet with a swing arc, two-bone leg IK on the
// terrain, pelvis bob and sway, counter-rotating torso, arm swing with elbow lag, head stabilisation,
// jump anticipation, landing compression and idle micro-motion.
import * as THREE from 'three'

const clamp = (v, a, b) => Math.min(b, Math.max(a, v))
const smooth = t => t * t * (3 - 2 * t)
const approach = (obj, axis, value, rate, dt) => { obj.rotation[axis] += (value - obj.rotation[axis]) * Math.min(1, dt * rate) }

export function createGait({ onPlant } = {}) {
  const feet = [1, -1].map(side => ({ side, planted: new THREE.Vector3(), from: new THREE.Vector3(), to: new THREE.Vector3(), world: new THREE.Vector3(), swing: false, s: 0, solo: 0, ready: false, pitch: 0 }))
  let phase = 0, time = 0, land = 0, landVel = 0, wasGrounded = true, glance = 0, glanceTarget = 0, nextGlance = 3, breath = 0, lastSpeed = 0, lastFacing = 0
  let width = 1  // stance width: feet come in under the hips while walking
  const arms = [{}, {}]
  const tmp = new THREE.Vector3(), left = new THREE.Vector3(), fwd = new THREE.Vector3()

  function restFoot(a, s, side, out) {
    return out.copy(s.pos).addScaledVector(left, a.leg.footX * side * width).addScaledVector(fwd, 0.02)
  }

  function solveLeg(a, s, foot, pelvisY, sway) {
    const leg = foot.side > 0 ? a.legL : a.legR
    const L = a.leg
    // Foot target in the body frame (root faces +Z, +X is the astronaut's left).
    tmp.copy(foot.world).sub(s.pos)
    const c = Math.cos(-s.facing), sn = Math.sin(-s.facing)
    const lx = tmp.x * c + tmp.z * sn, lz = -tmp.x * sn + tmp.z * c, ly = tmp.y
    const hipX = L.hipX * foot.side + sway, hipY = pelvisY + L.hipY
    const dz = lz, dy = ly - hipY, dx = lx - hipX
    const reach = (L.thigh + L.shin) * 0.995
    const dist = clamp(Math.hypot(dz, dy), 0.12, reach)
    const phi = Math.atan2(dz, -dy)
    const hipBend = Math.acos(clamp((L.thigh ** 2 + dist ** 2 - L.shin ** 2) / (2 * L.thigh * dist), -1, 1))
    const knee = Math.PI - Math.acos(clamp((L.thigh ** 2 + L.shin ** 2 - dist ** 2) / (2 * L.thigh * L.shin), -1, 1))
    leg.joint.rotation.x = -(phi + hipBend)
    leg.mid.rotation.x = knee
    // A little hip roll keeps the foot under the planted point on side slopes and turns.
    leg.joint.rotation.z = clamp((dx - (L.footX - L.hipX) * foot.side) / Math.max(0.3, -dy), -0.25, 0.25)
    // Ankle: cancel the shin's pitch and roll so the sole follows the ground, plus the foot's own roll-off.
    if (leg.ankle) {
      leg.ankle.rotation.x = clamp(-(leg.joint.rotation.x + leg.mid.rotation.x) + foot.pitch, -0.75, 0.95)
      leg.ankle.rotation.z = -leg.joint.rotation.z
    }
  }

  return {
    reset(a, s) {
      fwd.set(Math.sin(s.facing), 0, Math.cos(s.facing)); left.set(Math.cos(s.facing), 0, -Math.sin(s.facing))
      feet.forEach(f => { restFoot(a, s, f.side, f.planted); f.planted.y = s.groundAt(f.planted.x, f.planted.z, s.pos.y); f.world.copy(f.planted); f.swing = false; f.solo = 0; f.ready = true })
      phase = 0; land = 0; landVel = 0; lastFacing = s.facing; arms.forEach(arm => { arm.ready = false })
    },

    update(a, s, dt) {
      time += dt; breath += dt
      const P = a.pose, L = a.leg
      fwd.set(Math.sin(s.facing), 0, Math.cos(s.facing)); left.set(Math.cos(s.facing), 0, -Math.sin(s.facing))
      if (!feet[0].ready) this.reset(a, s)
      const speed = s.speed, lowG = s.gravity < 5
      const moving = s.grounded && speed > 0.06
      // Stride from dynamic similarity: at lower gravity the same speed is a "faster" gait (higher Froude number),
      // so strides lengthen and cadence drops, as in Apollo EVA footage. Capped by leg length.
      const legLength = L.thigh + L.shin
      const equivalent = speed * Math.pow(9.81 / Math.max(0.5, s.gravity), 0.35)
      const stride = clamp(0.5 + 0.55 * equivalent, 0.55, (s.running ? 2.6 : 1.55) * legLength)
      const swingFrac = s.lope ? 0.62 : s.running ? 0.5 : lowG ? 0.44 : 0.4
      width += ((moving ? 0.78 : 1) - width) * Math.min(1, dt * 4)
      const slopePitch = -Math.atan(clamp(s.grade, -0.8, 0.8))
      const offsetR = s.lope ? 0.14 : 0.5
      const stepHeight = (s.running ? 0.16 : 0.1) * (lowG ? 1.4 : 1)

      // Landing: a damped spring compresses the legs after an impact.
      if (s.grounded && !wasGrounded) { landVel -= clamp(s.impact, 0, 6) * 0.09; feet.forEach(f => { f.swing = false; restFoot(a, s, f.side, f.planted); f.planted.y = s.groundAt(f.planted.x, f.planted.z, s.pos.y); onPlant?.(f.side, f.planted.x, f.planted.z, s.facing, true) }) }
      wasGrounded = s.grounded
      landVel += (-120 * land - 18 * landVel) * dt; land += landVel * dt
      land = clamp(land, -0.22, 0.05)

      if (moving) {
        phase = (phase + speed / stride * dt) % 1
        feet.forEach((f, i) => {
          const start = i === 0 ? 0 : offsetR
          const local = ((phase - start) % 1 + 1) % 1
          const inSwing = local < swingFrac
          if (inSwing && !f.swing) {
            f.swing = true; f.from.copy(f.planted)
          }
          if (inSwing) {
            f.s = local / swingFrac
            // Aim where the body will be at mid-stance so the foot lands under the hip.
            const stanceTime = (1 - swingFrac) * stride / Math.max(0.1, speed)
            restFoot(a, s, f.side, f.to).addScaledVector(s.vel, stanceTime * 0.5 + (1 - f.s) * swingFrac * stride / Math.max(0.1, speed) * 0.5)
            f.to.y = s.groundAt(f.to.x, f.to.z, s.pos.y)
            const e = smooth(f.s)
            f.world.lerpVectors(f.from, f.to, e)
            f.world.y += Math.sin(Math.PI * f.s) * stepHeight
            // Toe-off at the start of the swing, toes up for the heel strike at the end.
            f.pitch = slopePitch + 0.45 * (1 - smooth(Math.min(1, f.s / 0.45))) - 0.2 * smooth(clamp((f.s - 0.6) / 0.4, 0, 1))
          } else if (f.swing) {
            f.swing = false; f.planted.copy(f.to); f.world.copy(f.planted)
            onPlant?.(f.side, f.planted.x, f.planted.z, s.facing, false)
          } else f.world.copy(f.planted)
          if (!inSwing) {
            // Stance: flat on the ground, the heel rising just before the next push-off.
            const toSwing = ((start - phase) % 1 + 1) % 1
            f.pitch += (slopePitch + 0.25 * (1 - smooth(Math.min(1, toSwing / 0.12))) - f.pitch) * Math.min(1, dt * 20)
          }
        })
      } else if (s.grounded) {
        // Standing: re-plant a foot that drifted (turning in place or stopping) with a short step.
        feet.forEach((f, i) => {
          restFoot(a, s, f.side, tmp)
          if (!f.swing && f.solo <= 0 && tmp.distanceTo(f.planted) > 0.16 && feet[1 - i].solo <= 0) { f.solo = 0.32; f.from.copy(f.planted) }
          if (f.solo > 0) {
            f.solo -= dt
            const k = 1 - Math.max(0, f.solo) / 0.32
            f.to.copy(tmp); f.to.y = s.groundAt(tmp.x, tmp.z, s.pos.y)
            f.world.lerpVectors(f.from, f.to, smooth(k)); f.world.y += Math.sin(Math.PI * k) * 0.06
            if (f.solo <= 0) { f.planted.copy(f.to); f.world.copy(f.planted); onPlant?.(f.side, f.planted.x, f.planted.z, s.facing, false) }
          } else f.world.copy(f.planted)
          f.swing = false
          f.pitch += (slopePitch - f.pitch) * Math.min(1, dt * 10)
        })
      } else {
        // Airborne: feet tuck under the body.
        const tuck = clamp(0.5 + s.vy / 4, 0, 1)
        feet.forEach(f => {
          restFoot(a, s, f.side, f.world).addScaledVector(fwd, 0.08 * f.side + 0.05)
          f.world.y = s.pos.y + 0.1 + tuck * 0.18 + (f.side > 0 ? 0.05 : 0)
          f.planted.copy(f.world)
          f.pitch += (0.3 - f.pitch) * Math.min(1, dt * 8)
        })
      }

      // Heel rise and toe-off pivot on the toes, not the ankle: lift the ankle by the toe lever.
      if (s.grounded) for (const f of feet) f.world.y += 0.17 * Math.max(0, Math.sin(f.pitch - slopePitch))

      // Pelvis: bob twice per stride, lowered so both feet stay reachable, crouched before jumps.
      const run = clamp(speed / Math.max(0.1, s.runSpeed), 0, 1.3)
      const bob = moving && !s.lope ? -(s.running ? 0.035 : 0.028) * (lowG ? 1.3 : 1) * Math.cos(4 * Math.PI * phase) : 0
      let pelvisY = a.hipHeight + bob + land - s.crouch * 0.2 - (moving ? 0.02 + 0.03 * run : 0)
      for (const f of feet) {
        const dy = f.world.y - s.pos.y, horiz = Math.hypot(f.world.x - s.pos.x, f.world.z - s.pos.z)
        const reach = (L.thigh + L.shin) * 0.985
        pelvisY = Math.min(pelvisY, dy - L.hipY + Math.sqrt(Math.max(0, reach * reach - horiz * horiz)))
      }
      const sway = moving ? 0.028 * Math.sin(2 * Math.PI * phase) * (s.lope ? 0.3 : 1) : 0.012 * Math.sin(time * 0.55)
      a.pelvis.position.y = pelvisY
      a.pelvis.position.x = sway
      feet.forEach(f => solveLeg(a, s, f, pelvisY, sway))

      // Torso: lean into speed and slope, counter-rotate against the hips, breathe.
      const counter = moving ? 0.09 * Math.sin(2 * Math.PI * (phase - 0.15)) * (s.lope ? 0.3 : 1) : 0.02 * Math.sin(time * 0.4)
      approach(a.torso, 'x', run * 0.14 + clamp(s.grade, -0.4, 0.4) * 0.5 + s.crouch * 0.25 + (s.grounded ? 0 : 0.06) - land * 0.6, 8, dt)
      approach(a.torso, 'y', counter, 10, dt)
      approach(a.torso, 'z', moving ? -sway * 1.4 : 0.02 * Math.sin(time * 0.55 + 0.5), 8, dt)
      a.torso.scale.y = 1 + (s.reducedMotion ? 0 : Math.sin(breath * (moving ? 2.6 : 1.5)) * 0.006)

      // Arms: damped pendulums driven by the stride and by body acceleration, so they lag, overshoot
      // and settle after a stop; lower gravity gives a slower, floatier swing.
      if (!arms[0].ready) arms.forEach(arm => { arm.a = P.armX; arm.e = P.elbow; arm.w = -0.12; arm.v = arm.ev = arm.wv = 0; arm.ready = true })
      const k = 22 + 40 * Math.min(1, s.gravity / 9.81), c = 2 * Math.sqrt(k) * 0.42
      const fwdAccel = clamp((speed - lastSpeed) / Math.max(dt, 1e-3), -6, 6); lastSpeed = speed
      let turn = s.facing - lastFacing; turn = Math.atan2(Math.sin(turn), Math.cos(turn)) / Math.max(dt, 1e-3); lastFacing = s.facing
      const swingAmp = moving ? (s.running ? 0.55 : 0.36) * Math.min(1, speed / Math.max(0.1, s.walkSpeed)) * (s.lope ? 0.45 : 1) : 0
      const wave = Math.cos(2 * Math.PI * (phase - 0.4))
      arms.forEach((arm, i) => {
        const side = i === 0 ? 1 : -1, bone = i === 0 ? a.armL : a.armR
        let target = P.armX + side * swingAmp * wave + (moving ? 0 : 0.025 * Math.sin(time * 0.9 + i * 1.7))
        if (!s.grounded) target = P.armX - 0.35
        arm.v += (k * (target - arm.a) - c * arm.v + fwdAccel * 0.35) * dt
        arm.a += arm.v * dt
        bone.joint.rotation.x = arm.a
        // Outward on turns (centrifugal) and in the air; a little wider when loping.
        const outward = P.armZ + (s.grounded ? 0 : 0.3) + (s.lope ? 0.12 : 0) + Math.max(0, -side * clamp(turn, -3, 3) * speed * 0.05)
        approach(bone.joint, 'z', side * outward, 6, dt)
        // The elbow flexes as the arm comes forward and trails the shoulder.
        const eTarget = P.elbow + run * P.elbowRun - Math.max(0, P.armX - arm.a) * 0.7 - (s.grounded ? 0 : 0.25)
        arm.ev += (90 * (eTarget - arm.e) - 13 * arm.ev) * dt; arm.e += arm.ev * dt
        bone.mid.rotation.x = arm.e
        // The hand hangs relaxed and lags the forearm.
        if (bone.wrist) { arm.wv += (120 * (-0.12 - arm.ev * 0.04 - arm.w) - 14 * arm.wv) * dt; arm.w += arm.wv * dt; bone.wrist.rotation.x = arm.w }
      })

      // Head: keep the gaze level, follow the camera, glance around when idle.
      if (!moving && time > nextGlance) { glanceTarget = (Math.random() - 0.5) * 1.1; nextGlance = time + 3 + Math.random() * 5 }
      if (moving) glanceTarget = 0
      glance += (glanceTarget - glance) * Math.min(1, dt * 2)
      approach(a.head, 'y', clamp(s.lookYaw * 0.6 + glance, -0.7, 0.7), 4, dt)
      approach(a.head, 'x', -a.torso.rotation.x * 0.7, 6, dt)
      approach(a.head, 'z', -a.torso.rotation.z * 0.8, 6, dt)
    },
  }
}
