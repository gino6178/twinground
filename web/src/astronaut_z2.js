// NASA Z-2 suit (NASA 3D Resources, NASA/LaRC/Advanced Concepts Lab) skinned at runtime. The model
// ships as one rigid mesh with the arms held forward; the joints below were measured from its
// vertices (front +Z, left +X, feet at y = 0). Weights come from body regions with smooth blends.
import * as THREE from 'three'

const Z2 = {
  pelvis: [0, 0.86, 0], spine: [0, 1.0, 0], head: [0, 1.62, 0],
  shoulder: [0.27, 1.45, -0.05], elbow: [0.32, 1.33, 0.17], wrist: [0.31, 1.2, 0.42], fingertip: [0.28, 1.1, 0.62],
  hip: [0.12, 0.86, 0], knee: [0.19, 0.47, 0.03], ankle: [0.21, 0.13, 0.025],
}
const smooth = (a, b, x) => { const t = Math.min(1, Math.max(0, (x - a) / (b - a))); return t * t * (3 - 2 * t) }
function segment(p, a, b) {
  const ab = [b[0] - a[0], b[1] - a[1], b[2] - a[2]], ap = [p[0] - a[0], p[1] - a[1], p[2] - a[2]]
  const t = (ap[0] * ab[0] + ap[1] * ab[1] + ap[2] * ab[2]) / (ab[0] ** 2 + ab[1] ** 2 + ab[2] ** 2)
  const c = Math.min(1, Math.max(0, t))
  return { t, d: Math.hypot(ap[0] - ab[0] * c, ap[1] - ab[1] * c, ap[2] - ab[2] * c) }
}

export function makeZ2Astronaut(gltfScene, { lite = false } = {}) {
  let source
  gltfScene.updateMatrixWorld(true)
  gltfScene.traverse(o => { if (o.isMesh && !source) source = o })
  if (!source) throw Error('Z-2 mesh missing')
  const geometry = source.geometry.clone().applyMatrix4(source.matrixWorld)
  // Phones: the standard material is much cheaper than the physical one the file uses.
  const material = lite ? new THREE.MeshStandardMaterial({ map: source.material.map, bumpMap: source.material.bumpMap, bumpScale: source.material.bumpScale, roughness: source.material.roughness ?? 0.6, metalness: 0 }) : source.material
  // The file keeps its grey bump (height) texture in the normal-map slot with scale 0. three.js still takes the
  // normal's z from that texture's blue channel, which is zero or negative wherever the texture is mid-grey, so the
  // suit showed clusters of black pixels (NaN normals) and inverted shading. Use the texture as the bump map it is.
  const heights = source.material.normalMap
  if (!lite && heights) { material.normalMap = null; material.bumpMap = heights; material.bumpScale = 2 }
  const box = new THREE.Box3().setFromBufferAttribute(geometry.attributes.position)
  geometry.translate(0, -box.min.y, 0)

  // Bones: 0 root, 1 pelvis, 2 spine, 3 head, 4/5 shoulder L/R, 6/7 elbow L/R, 8/9 hip L/R, 10/11 knee L/R,
  // 12/13 wrist L/R, 14/15 ankle L/R (the boots stay flat on the ground instead of tilting with the shins)
  const at = (v, side = 1) => new THREE.Vector3(v[0] * side, v[1], v[2])
  const bones = Array.from({ length: 16 }, () => new THREE.Bone())
  const place = (i, parent, world) => {
    bones[i].userData.world = world
    if (parent >= 0) { bones[parent].add(bones[i]); bones[i].position.copy(world).sub(bones[parent].userData.world) }
    else bones[i].position.copy(world)
  }
  place(0, -1, new THREE.Vector3())
  place(1, 0, at(Z2.pelvis)); place(2, 1, at(Z2.spine)); place(3, 2, at(Z2.head))
  place(4, 2, at(Z2.shoulder, 1)); place(5, 2, at(Z2.shoulder, -1))
  place(6, 4, at(Z2.elbow, 1)); place(7, 5, at(Z2.elbow, -1))
  place(8, 1, at(Z2.hip, 1)); place(9, 1, at(Z2.hip, -1))
  place(10, 8, at(Z2.knee, 1)); place(11, 9, at(Z2.knee, -1))
  place(12, 6, at(Z2.wrist, 1)); place(13, 7, at(Z2.wrist, -1))
  place(14, 10, at(Z2.ankle, 1)); place(15, 11, at(Z2.ankle, -1))

  const pos = geometry.attributes.position, n = pos.count
  const skinIndex = new Uint16Array(n * 4), skinWeight = new Float32Array(n * 4)
  for (let i = 0; i < n; i++) {
    const x = pos.getX(i), y = pos.getY(i), z = pos.getZ(i)
    const side = x >= 0 ? 1 : -1, ax = Math.abs(x), p = [ax, y, z]
    const w = new Map()
    const add = (bone, value) => { if (value > 1e-4) w.set(bone, (w.get(bone) || 0) + value) }
    const up = segment(p, Z2.shoulder, Z2.elbow), fore = segment(p, Z2.elbow, Z2.wrist), hand = segment(p, Z2.wrist, Z2.fingertip)
    const armDist = Math.min(up.d, fore.d, hand.d)
    const torsoCore = ax < 0.2 && z < 0.12
    if (y > 0.98 && armDist < 0.14 && !torsoCore && z > -0.22) {
      // Arms: the shoulder cap blends into the torso, the elbow blends upper and lower arm.
      const shoulderBone = side > 0 ? 4 : 5, elbowBone = side > 0 ? 6 : 7, wristBone = side > 0 ? 12 : 13
      // Position along the shoulder-elbow-wrist chain from the nearest segment (0..3).
      const chain = up.d <= fore.d && up.d <= hand.d ? up.t : fore.d <= hand.d ? 1 + Math.max(0, fore.t) : 2 + Math.max(0, hand.t)
      const intoArm = smooth(-0.1, 0.3, up.t)
      const toFore = smooth(0.82, 1.18, chain), toHand = smooth(1.85, 2.12, chain)
      add(2, 1 - intoArm)
      add(shoulderBone, intoArm * (1 - toFore))
      add(elbowBone, intoArm * toFore * (1 - toHand))
      add(wristBone, intoArm * toHand)
    } else if (y < 0.98) {
      // Legs below the waist belt; the pelvis blends into the thighs around the hip bearings.
      const hipBone = side > 0 ? 8 : 9, other = side > 0 ? 9 : 8, kneeBone = side > 0 ? 10 : 11, ankleBone = side > 0 ? 14 : 15
      const legShare = 1 - smooth(0.72, 0.95, y)
      const lowerShare = smooth(-0.12, 0.12, (Z2.knee[1] - y) / 0.5)
      const sideShare = smooth(0, 0.05, ax)
      const bootShare = 1 - smooth(Z2.ankle[1] - 0.03, Z2.ankle[1] + 0.06, y)
      add(1, 1 - legShare)
      add(hipBone, legShare * (1 - lowerShare) * (0.5 + 0.5 * sideShare))
      add(other, legShare * (1 - lowerShare) * (0.5 - 0.5 * sideShare))
      add(kneeBone, legShare * lowerShare * (1 - bootShare))
      add(ankleBone, legShare * lowerShare * bootShare)
    } else {
      // Torso, pack and helmet move with the spine; the waist blends into the pelvis.
      const toSpine = smooth(0.95, 1.08, y)
      add(2, toSpine); add(1, 1 - toSpine)
    }
    const entries = [...w.entries()].sort((a, b) => b[1] - a[1]).slice(0, 4)
    const total = entries.reduce((s, e) => s + e[1], 0) || 1
    entries.forEach(([bone, value], k) => { skinIndex[i * 4 + k] = bone; skinWeight[i * 4 + k] = value / total })
  }
  geometry.setAttribute('skinIndex', new THREE.Uint16BufferAttribute(skinIndex, 4))
  geometry.setAttribute('skinWeight', new THREE.Float32BufferAttribute(skinWeight, 4))

  // Regolith tint on the boots and lower legs, from the rest-pose height.
  const dust = { color: { value: new THREE.Color(0x8a7f70) }, amount: { value: 0 } }
  material.onBeforeCompile = shader => {
    shader.uniforms.uDust = dust.color; shader.uniforms.uDustAmount = dust.amount
    shader.vertexShader = shader.vertexShader
      .replace('#include <common>', '#include <common>\nvarying float vRestY;')
      .replace('#include <begin_vertex>', '#include <begin_vertex>\nvRestY = position.y;')
    shader.fragmentShader = shader.fragmentShader
      .replace('#include <common>', '#include <common>\nuniform vec3 uDust;\nuniform float uDustAmount;\nvarying float vRestY;')
      .replace('#include <map_fragment>', '#include <map_fragment>\ndiffuseColor.rgb = mix(diffuseColor.rgb, uDust * (0.85 + 0.3 * diffuseColor.g), uDustAmount * (1.0 - smoothstep(0.15, 0.62, vRestY)) * 0.8);')
  }
  material.customProgramCacheKey = () => 'z2-dust'
  material.needsUpdate = true

  const mesh = new THREE.SkinnedMesh(geometry, material)
  mesh.castShadow = true; mesh.receiveShadow = true; mesh.frustumCulled = false
  const root = new THREE.Group(), body = new THREE.Group()
  root.add(body); body.add(mesh); mesh.add(bones[0])
  mesh.updateMatrixWorld(true)
  mesh.bind(new THREE.Skeleton(bones))
  const headlamp = new THREE.SpotLight(0xf3fbff, 0, 60, 0.45, 0.5, 1.6)
  headlamp.position.set(0, 0.28, 0.12); headlamp.target.position.set(0, -0.6, 4)
  bones[3].add(headlamp, headlamp.target)
  const joint = (a, b, c) => ({ joint: bones[a], mid: bones[b], ankle: c === undefined ? null : bones[c] })
  // Lowering the forward-reaching arms leaves the palms facing backward. Roll each hand about its own
  // axis (thumb forward) so the palms face the thighs, as in a relaxed stance. 2.0 rad was measured from
  // the glove's finger curl in the standing pose: the palm then faces straight in (1.3 left it ~40° back).
  const palmIn = side => new THREE.Quaternion().setFromAxisAngle(
    new THREE.Vector3((Z2.fingertip[0] - Z2.wrist[0]) * side, Z2.fingertip[1] - Z2.wrist[1], Z2.fingertip[2] - Z2.wrist[2]).normalize(), -2.0 * side)
  return {
    model: 'z2', hipHeight: Z2.pelvis[1], root, body, pelvis: bones[1], torso: bones[2], head: bones[3],
    legL: joint(8, 10, 14), legR: joint(9, 11, 15), armL: { ...joint(4, 6), wrist: bones[12], palm: palmIn(1) }, armR: { ...joint(5, 7), wrist: bones[13], palm: palmIn(-1) }, headlamp,
    // The model reaches forward; lower the arms toward a relaxed suited stance.
    // The model holds straight arms 60 degrees forward: lower them to hang with a slight elbow bend.
    pose: { armX: 0.9, armZ: 0.06, elbow: -0.25, elbowRun: -0.3 },
    leg: { thigh: 0.397, shin: 0.47, hipX: 0.12, hipY: 0, footX: 0.21 },
    setLamp() {},
    setDust(color, amount) { dust.color.value.copy(color); dust.amount.value = Math.min(0.85, amount) },
    dispose() { geometry.dispose(); Object.values(material).forEach(v => v?.isTexture && v.dispose()); material.dispose() },
  }
}
