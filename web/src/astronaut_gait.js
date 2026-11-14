// Procedural locomotion for the astronaut: planted feet with a swing arc, two-bone leg IK on the
// terrain, pelvis bob and sway, counter-rotating torso, arm swing with elbow lag, head stabilisation,
// jump anticipation, landing compression and idle micro-motion. Walking follows measured human
// joint-angle curves (gait_reference.js): the stance knee sets the pelvis height, the swing leg is
// posed from the hip and knee curves and handed back to IK just before heel strike.
import * as THREE from 'three'
import { GAIT_REFERENCE, sampleGait } from './gait_reference.js'

const clamp = (v, a, b) => Math.min(b, Math.max(a, v))
const smooth = t => t * t * (3 - 2 * t)
const DEG = Math.PI / 180
const TOE_OFF = 0.62  // fraction of the reference cycle spent in stance
const TOE = 0.17  // ankle-to-toe lever the foot rolls about (m)
const TOE_ROLL = 1.2  // the most the foot rolls up onto its toes (rad)
const HEEL_RISE = TOE * Math.sin(TOE_ROLL)  // matching ankle rise (m)
const KNEE_HANDOFF = 0.9  // share of the swing after which the knee eases from the curve to IK
const LAND_EARLY = 0.18  // share of the stance by which the foot lands short of the mid-stance aim
// Reference cycle position (0 = heel strike) for a foot in stance (progress 0..1) or swing (0..1).
const stanceU = p => p * TOE_OFF, swingU = p => TOE_OFF + p * (1 - TOE_OFF)
const approach = (obj, axis, value, rate, dt) => { obj.rotation[axis] += (value - obj.rotation[axis]) * Math.min(1, dt * rate) }

export function createGait({ onPlant } = {}) {
  const feet = [1, -1].map(side => ({ side, planted: new THREE.Vector3(), from: new THREE.Vector3(), to: new THREE.Vector3(), world: new THREE.Vector3(), swing: false, s: 0, solo: 0, soloLen: 0.32, ready: false, pitch: 0, pv: 0, oP: 0, vP: 0, u: 0, fkH: 0, fkK: 0, fkA: 0, lift: false, oH: 0, vH: 0, oK: 0, vK: 0, refHip: 0, refKnee: 0, shownHip: 0, shownKnee: 0, lastHip: 0, lastKnee: 0 }))
  let wasMoving = false, walkMix = 0
  let refW = 0  // how much the walk follows the reference curves (eased in and out between gaits)
  let phase = 0, time = 0, land = 0, landVel = 0, wasGrounded = true, glance = 0, glanceTarget = 0, nextGlance = 3, breath = 0, lastSpeed = 0, lastFacing = 0
  let width = 1  // stance width: feet come in under the hips while walking
  const arms = [{}, {}]
  const tmp = new THREE.Vector3(), left = new THREE.Vector3(), fwd = new THREE.Vector3()

  function restFoot(a, s, side, out) {
    return out.copy(s.pos).addScaledVector(left, a.leg.footX * side * width).addScaledVector(fwd, 0.02)
  }

  function solveLeg(a, s, foot, pelvisY, sway, dt) {
    const leg = foot.side > 0 ? a.legL : a.legR
    const L = a.leg
    // Foot target in the body frame (root faces +Z, +X is the astronaut's left).
    tmp.copy(foot.world).sub(s.pos)
    const c = Math.cos(-s.facing), sn = Math.sin(-s.facing)
    const lx = tmp.x * c + tmp.z * sn, lz = -tmp.x * sn + tmp.z * c, ly = tmp.y
    const hipX = L.hipX * foot.side + sway, hipY = pelvisY + L.hipY
    const dz = lz, dy = ly - hipY, dx = lx - hipX
    const reach = (L.thigh + L.shin) * 0.9998
    const dist = clamp(Math.hypot(dz, dy), 0.12, reach)
    const phi = Math.atan2(dz, -dy)
    const hipBend = Math.acos(clamp((L.thigh ** 2 + dist ** 2 - L.shin ** 2) / (2 * L.thigh * dist), -1, 1))
    const knee = Math.PI - Math.acos(clamp((L.thigh ** 2 + L.shin ** 2 - dist ** 2) / (2 * L.thigh * L.shin), -1, 1))
    leg.joint.rotation.x = -(phi + hipBend)
    leg.mid.rotation.x = knee
    // Swing leg posed from the reference hip and knee angles (forward kinematics).
    const hipRef = -sampleGait(GAIT_REFERENCE.hip, foot.u) * DEG, kneeRef = sampleGait(GAIT_REFERENCE.knee, foot.u) * DEG
    if (foot.fkH > 0 || foot.fkK > 0 || foot.lift) {
      const h = Math.max(dt, 1e-3)
      if (foot.lift) {
        // Lift-off: start from the pose and joint speeds the leg had, as offsets from the curves...
        foot.oH = foot.shownHip - foot.refHip; foot.vH = (foot.shownHip - foot.lastHip - hipRef + foot.refHip) / h
        foot.oK = foot.shownKnee - foot.refKnee; foot.vK = (foot.shownKnee - foot.lastKnee - kneeRef + foot.refKnee) / h
        foot.lift = false
      }
      if (foot.swing) {
        // ...which settle like a critically damped spring, so the leg turns around smoothly onto the curves.
        const w = 7
        foot.vH += (-w * w * foot.oH - 2 * w * foot.vH) * h; foot.oH += foot.vH * h
        foot.vK += (-w * w * foot.oK - 2 * w * foot.vK) * h; foot.oK += foot.vK * h
      }
      const k = knee + (kneeRef + foot.oK - knee) * foot.fkK
      // Where the hip is not on the curve it aims the foot at its target for the knee actually shown (with the IK
      // knee this is exactly the IK hip), so hip and knee never disagree about where the foot goes.
      const aim = -(phi + Math.atan2(L.shin * Math.sin(k), L.thigh + L.shin * Math.cos(k)))
      leg.joint.rotation.x = aim + (hipRef + foot.oH - aim) * foot.fkH
      leg.mid.rotation.x = k
    }
    foot.refHip = hipRef; foot.refKnee = kneeRef
    foot.lastHip = foot.shownHip; foot.lastKnee = foot.shownKnee
    foot.shownHip = leg.joint.rotation.x; foot.shownKnee = leg.mid.rotation.x
    // A little hip roll keeps the foot under the planted point on side slopes and turns.
    leg.joint.rotation.z = clamp((dx - (L.footX - L.hipX) * foot.side) / Math.max(0.3, -dy), -0.25, 0.25)
    // Ankle: cancel the shin's pitch and roll so the sole follows the ground, plus the foot's own roll-off.
    if (leg.ankle) {
      let ankle = -(leg.joint.rotation.x + leg.mid.rotation.x) + foot.pitch
      // Mid-swing the foot hangs with the shin as in the reference (dorsiflexion is negative x here).
      if (foot.fkA > 0) ankle += (-sampleGait(GAIT_REFERENCE.ankle, foot.u) * DEG - ankle) * foot.fkA
      leg.ankle.rotation.x = clamp(ankle, -0.75, 0.95)
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
      // Walking uses the measured curves; running and the low-gravity lope keep the procedural gait.
      refW += ((moving && !s.running && !s.lope ? 1 : 0) - refW) * Math.min(1, dt * 4)

      // Landing: a damped spring compresses the legs after an impact.
      if (s.grounded && !wasGrounded) { landVel -= clamp(s.impact, 0, 6) * 0.09; feet.forEach(f => { f.swing = false; restFoot(a, s, f.side, f.planted); f.planted.y = s.groundAt(f.planted.x, f.planted.z, s.pos.y); onPlant?.(f.side, f.planted.x, f.planted.z, s.facing, true) }) }
      wasGrounded = s.grounded
      landVel += (-120 * land - 18 * landVel) * dt; land += landVel * dt
      land = clamp(land, -0.22, 0.05)

      if (moving && !wasMoving) {
        // Setting off: start the cycle with both feet down and the one further back about to step, rather than
        // resuming wherever the last walk stopped (which could leave a foot already halfway through a step).
        const behindL = (feet[0].planted.x - s.pos.x) * fwd.x + (feet[0].planted.z - s.pos.z) * fwd.z < (feet[1].planted.x - s.pos.x) * fwd.x + (feet[1].planted.z - s.pos.z) * fwd.z
        phase = ((behindL ? 0 : offsetR) - Math.min(0.05, 0.5 - swingFrac - 0.005) + 1) % 1
      }
      wasMoving = moving
      if (moving) {
        phase = (phase + speed / stride * dt) % 1
        feet.forEach((f, i) => {
          const start = i === 0 ? 0 : offsetR
          const local = ((phase - start) % 1 + 1) % 1
          const inSwing = local < swingFrac
          if (inSwing) {
            const p = local / swingFrac
            f.u = swingU(p)
            // Pose from the curves after lift-off, back to IK for the last stretch so the foot lands on target.
            // Lifting off from a leg already on the curves needs no carry-over.
            if (!f.swing) f.lift = true
            // The hip goes back to IK for the last stretch to aim the foot; the knee stays on the curve, which
            // slows into heel strike (the stance pelvis is set so the planted knee continues the same curve), handing
            // over to IK only at the very end so an off-prediction landing (speeding up, rough ground) still lands clean.
            f.fkH = refW * (1 - smooth(clamp((p - 0.72) / 0.28, 0, 1))); f.fkK = refW * (1 - smooth(clamp((p - KNEE_HANDOFF) / (1 - KNEE_HANDOFF), 0, 1)))
            f.fkA = refW * smooth(Math.min(1, p / 0.3)) * (1 - smooth(clamp((p - 0.6) / 0.35, 0, 1)))
          } else {
            const p = (local - swingFrac) / (1 - swingFrac)
            f.u = stanceU(p)
            // Pre-swing: up on the toes, the knee starts to fold as in the curves (the hip stays on IK so the toe stays put).
            f.fkA = 0; f.fkH = 0; f.fkK = refW * smooth(clamp((p - 0.8) / 0.2, 0, 1))
            f.oH = f.vH = f.oK = f.vK = 0
          }
          if (inSwing && !f.swing) {
            f.swing = true; f.from.copy(f.planted); f.toePitch = Math.max(0.45 * (1 - refW), f.pitch - slopePitch)
            f.oP = 0; f.vP = f.pv * refW  // keep the toe-roll's speed going for a moment after lift-off
          }
          if (inSwing) {
            f.s = local / swingFrac
            // Aim where the body will be at mid-stance so the foot lands under the hip. Following the reference,
            // the foot lands a little closer (hip ~22 deg flexed at heel strike) and the trailing heel rises instead,
            // and the target holds still in the world so the foot arrives at rest instead of skidding in.
            const stanceTime = (1 - swingFrac) * stride / Math.max(0.1, speed)
            restFoot(a, s, f.side, f.to).addScaledVector(s.vel, stanceTime * (0.5 - LAND_EARLY * refW) + (1 - f.s) * swingFrac * stride / Math.max(0.1, speed) * (0.5 + 0.5 * refW))
            f.to.y = s.groundAt(f.to.x, f.to.z, s.pos.y)
            const e = smooth(f.s)
            f.world.lerpVectors(f.from, f.to, e)
            f.world.y += Math.sin(Math.PI * f.s) * stepHeight * (1 - refW * smooth(clamp((f.s - 0.55) / 0.45, 0, 1)))  // the posed swing knee gives the clearance
            // Toe-off at the start of the swing, toes up for the heel strike at the end.
            const was = f.pitch
            const hp = Math.min(dt, 0.05); f.vP += (-100 * f.oP - 20 * f.vP) * hp; f.oP += f.vP * hp
            f.pitch = slopePitch + (f.toePitch || 0.45) * (1 - smooth(Math.min(1, f.s / 0.45))) - 0.2 * smooth(clamp((f.s - 0.6) / 0.4, 0, 1)) + f.oP
            f.pv = (f.pitch - was) / Math.max(dt, 1e-3)
          } else if (f.swing) {
            f.swing = false; f.planted.copy(f.to); f.world.copy(f.planted)
            onPlant?.(f.side, f.planted.x, f.planted.z, s.facing, false)
          } else f.world.copy(f.planted)
          if (!inSwing) {
            // Stance: flat on the ground, the heel rising just before the next push-off.
            const toSwing = ((start - phase) % 1 + 1) % 1
            // Critically damped, so the foot lowers flat after heel strike without a kink in its rotation.
            const target = slopePitch + 0.25 * (1 - smooth(Math.min(1, toSwing / 0.12)))
            f.pv += (400 * (target - f.pitch) - 40 * f.pv) * Math.min(dt, 0.05); f.pitch += f.pv * Math.min(dt, 0.05)
          }
        })
      } else if (s.grounded) {
        // Standing: re-plant a foot that drifted (turning in place or stopping) with a short step.
        feet.forEach((f, i) => {
          // Coming to a stop: the curve blends fade out rather than cut, and a foot caught in the air finishes with a
          // short step to its resting spot instead of snapping back to where it last stood.
          const fade = Math.max(0, 1 - dt * 8); f.fkH *= fade; f.fkK *= fade; f.fkA *= fade
          restFoot(a, s, f.side, tmp)
          if (f.swing) { f.solo = 0.12 + 0.2 * (1 - f.s); f.soloLen = f.solo; f.from.copy(f.world) }
          else if (f.solo <= 0 && tmp.distanceTo(f.planted) > 0.16 && feet[1 - i].solo <= 0) { f.solo = f.soloLen = 0.32; f.from.copy(f.planted) }
          if (f.solo > 0) {
            f.solo -= dt
            const k = 1 - Math.max(0, f.solo) / f.soloLen
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
          f.fkH = f.fkK = f.fkA = 0
          restFoot(a, s, f.side, f.world).addScaledVector(fwd, 0.08 * f.side + 0.05)
          f.world.y = s.pos.y + 0.1 + tuck * 0.18 + (f.side > 0 ? 0.05 : 0)
          f.planted.copy(f.world)
          f.pitch += (0.3 - f.pitch) * Math.min(1, dt * 8)
        })
      }

      // Heel rise and toe-off pivot on the toes, not the ankle: lift the ankle by the toe lever.
      // On the reference walk the ankle also swings forward round the toes (TOE = ankle-to-toe lever).
      if (s.grounded) for (const f of feet) {
        const q = Math.max(0, f.pitch - slopePitch)
        f.world.y += TOE * Math.sin(q); f.world.addScaledVector(fwd, TOE * (1 - Math.cos(q)) * refW)
      }

      // Pelvis: bob twice per stride, lowered so both feet stay reachable, crouched before jumps.
      const run = clamp(speed / Math.max(0.1, s.runSpeed), 0, 1.3)
      // Walking offsets ease in and out with the walk instead of switching on the first and last moving frame.
      walkMix += ((moving ? 1 : 0) - walkMix) * Math.min(1, dt * 6)
      const bob = !s.lope ? -(s.running ? 0.035 : 0.028) * (lowG ? 1.3 : 1) * Math.cos(4 * Math.PI * phase) * walkMix : 0
      let pelvisY = a.hipHeight + bob + land - s.crouch * 0.2 - walkMix * (0.02 + 0.03 * run)
      // Foot offsets along the facing direction: the leg IK works in that plane (sideways is taken by hip roll).
      const along = p => (p.x - s.pos.x) * fwd.x + (p.z - s.pos.z) * fwd.z
      if (refW > 0) {
        // The leading stance leg bends as much as the reference knee says, so the pelvis rides up over the
        // planted foot (nearly straight at mid-stance) instead of walking crouched. A foot about to land pulls
        // the pelvis down ahead of heel strike; the trailing foot rolls onto its toes to keep up (heel rise).
        const len = u => { const k = sampleGait(GAIT_REFERENCE.knee, u) * DEG; return Math.sqrt(L.thigh ** 2 + L.shin ** 2 + 2 * L.thigh * L.shin * Math.cos(k)) }
        const limit = (p, u) => { const l = len(u), dz = along(p); return p.y - s.pos.y - L.hipY + Math.sqrt(Math.max(0, l * l - dz * dz)) }
        let lead = null
        for (const f of feet) if (!f.swing && f.solo <= 0 && (!lead || f.u < lead.u)) lead = f
        // The planted leg sets the height (its knee on the curve). A swinging foot needs the pelvis at the height it
        // will land at, judged from where the hip will be at touchdown; when that is higher the planted foot rolls onto
        // its toes to make up the difference (only once it is behind the hip), so the stance knee never over-bends.
        const yLead = lead ? limit(lead.world, lead.u) : a.hipHeight
        const behind = lead ? smooth(clamp(-along(lead.world) / 0.15, 0, 1)) : 0
        let target = yLead
        for (const f of feet) if (f.swing) {
          const dzLand = along(f.to) - speed * (1 - f.s) * swingFrac * stride / Math.max(0.1, speed), l0 = len(0)
          const yLand = f.to.y - s.pos.y - L.hipY + Math.sqrt(Math.max(0, l0 * l0 - dzLand * dzLand))
          target = Math.max(target, yLead + (yLand - yLead) * smooth(Math.min(1, f.s / 0.3)))
        }
        const refY = Math.min(a.hipHeight, yLead + HEEL_RISE * behind, target)
        if (Number.isFinite(refY)) pelvisY += (refY + land - s.crouch * 0.2 - pelvisY) * refW
        for (const f of feet) {
          if (f.swing || f.solo > 0 || (f === lead && along(f.world) > 0)) continue  // heel rise only once the foot is behind the hip
          // Roll the foot up about its toes until the leg, bent as the reference knee says, reaches it.
          const l = len(f.u), hy = s.pos.y + pelvisY + L.hipY, dz0 = along(f.planted)
          const reachAt = q => Math.hypot(dz0 + TOE * (1 - Math.cos(q)), hy - f.planted.y - TOE * Math.sin(q))
          if (reachAt(0) <= l) continue
          let lo = 0, hi = Math.PI / 2
          for (let i = 0; i < 14; i++) { const m = (lo + hi) / 2; if (reachAt(m) > l) lo = m; else hi = m }
          // Soft limit: the roll eases to its highest angle instead of stopping dead.
          const q0 = TOE_ROLL * 0.65, q = (hi < q0 ? hi : q0 + (TOE_ROLL - q0) * (1 - Math.exp(-(hi - q0) / (TOE_ROLL - q0)))) * refW
          if (q > f.pitch - slopePitch) {
            f.world.copy(f.planted).addScaledVector(fwd, TOE * (1 - Math.cos(q)) * refW); f.world.y += TOE * Math.sin(q)
            f.pv = (slopePitch + q - f.pitch) / Math.max(dt, 1e-3); f.pitch = slopePitch + q
          }
        }
      }
      for (const f of feet) {
        // A leg posed from the curves (swing, and the knee in pre-swing) need not hold the pelvis down; the hold
        // fades with that blend so the pelvis never jumps when it lets go.
        const free = f.swing ? refW : refW * f.fkK
        if (free >= 1) continue
        // On the curves: straighter legs, measured in the IK's plane. Otherwise the original, more cautious reach.
        const horiz = Math.hypot(f.world.x - s.pos.x, f.world.z - s.pos.z)
        const dy = f.world.y - s.pos.y, dz = horiz + (Math.abs(along(f.world)) - horiz) * refW
        const reach = (L.thigh + L.shin) * (0.985 + 0.0147 * refW)  // 0.9997: the reference knee straightens to ~3 deg
        const held = Math.min(pelvisY, dy - L.hipY + Math.sqrt(Math.max(0, reach * reach - dz * dz)))
        pelvisY += (held - pelvisY) * (1 - free)
      }
      const sway = walkMix * 0.028 * Math.sin(2 * Math.PI * phase) * (s.lope ? 0.3 : 1) + (1 - walkMix) * 0.012 * Math.sin(time * 0.55)
      a.pelvis.position.y = pelvisY
      a.pelvis.position.x = sway
      feet.forEach(f => solveLeg(a, s, f, pelvisY, sway, dt))

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
        if (bone.wrist) {
          arm.wv += (120 * (-0.12 - arm.ev * 0.04 - arm.w) - 14 * arm.wv) * dt; arm.w += arm.wv * dt
          bone.wrist.rotation.set(arm.w, 0, 0)
          // Models whose hands need rolling to face the body: the swing lag stays in the arm's plane.
          if (bone.palm) bone.wrist.quaternion.multiply(bone.palm)
        }
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
