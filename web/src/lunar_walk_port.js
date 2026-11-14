// Stone geometry and stone surface shading adapted from lunar-walk (https://github.com/hh-hang/lunar-walk),
// src/terrain/gravel.js and src/rendering/surface.js, commit 23abfd1.
//
// MIT License. Copyright (c) 2026 屈航
// Permission is hereby granted, free of charge, to any person obtaining a copy of this software and associated
// documentation files (the "Software"), to deal in the Software without restriction, including without limitation
// the rights to use, copy, modify, merge, publish, distribute, sublicense, and/or sell copies of the Software, and
// to permit persons to whom the Software is furnished to do so, subject to the following conditions: The above
// copyright notice and this permission notice shall be included in all copies or substantial portions of the
// Software. THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR IMPLIED, INCLUDING BUT NOT
// LIMITED TO THE WARRANTIES OF MERCHANTABILITY, FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT
// SHALL THE AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER LIABILITY, WHETHER IN AN ACTION
// OF CONTRACT, TORT OR OTHERWISE, ARISING FROM, OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER
// DEALINGS IN THE SOFTWARE.
//
// Changes for TwinGround: the noise function is passed in, the shader hooks chain onto materials that already
// have hooks (sun visibility, shadow cascade), and the level-of-detail dithering of the original is left out.
import * as THREE from 'three'
import { mergeVertices } from 'three/addons/utils/BufferGeometryUtils.js'

// An irregular stone: a noisy icosphere cut by three planes, flattened, with a flat underside.
// noise(x, z, seed) must return values in about 0..1.
export function gravelGeometry(variant, detail, noise) {
  const source = new THREE.IcosahedronGeometry(1, detail)
  const positions = source.getAttribute('position')
  const point = new THREE.Vector3()
  const cuts = [new THREE.Vector3(0.8, 0.48, 0.3).normalize(), new THREE.Vector3(-0.4, 0.65, -0.7).normalize(), new THREE.Vector3(-0.75, -0.2, 0.6).normalize()]
  for (const cut of cuts) cut.applyAxisAngle(THREE.Object3D.DEFAULT_UP, variant * 1.7)
  for (let i = 0; i < positions.count; i++) {
    point.fromBufferAttribute(positions, i)
    let radius = 0.79 + noise(point.x * 2.6 + variant * 7, point.z * 2.6 + point.y, 3201) * 0.28
    radius += (noise(point.x * 9 + point.y * 3 + variant, point.z * 8 - point.y * 2, 3202) - 0.5) * 0.055
    for (let c = 0; c < cuts.length; c++) {
      const facing = point.dot(cuts[c])
      if (facing > 0) radius = Math.min(radius, (0.76 + c * 0.055) / facing)
    }
    point.multiplyScalar(radius)
    point.x += point.y * (variant % 2 ? 0.22 : -0.14)
    point.y = Math.max(-0.32, point.y * (0.58 + variant * 0.045))
    positions.setXYZ(i, point.x, point.y, point.z)
  }
  // Merge the shared vertices before computing normals, so the faces shade smoothly instead of in patches.
  source.deleteAttribute('normal')
  source.deleteAttribute('uv')
  const geometry = mergeVertices(source, 1e-5)
  source.dispose()
  geometry.computeVertexNormals()
  geometry.computeBoundingSphere()
  return geometry
}

const STONE_NOISE = `
  varying vec3 vStoneWorld;
  float stoneHash(vec2 p) {
    vec3 q = fract(vec3(p.xyx) * vec3(0.0973, 0.1137, 0.1379));
    q += dot(q, q.yzx + 17.17);
    return fract((q.x + q.z) * q.y);
  }
  float stoneNoise(vec2 p) {
    vec2 cell = floor(p), t = fract(p);
    t = t * t * (3.0 - 2.0 * t);
    return mix(mix(stoneHash(cell), stoneHash(cell + vec2(1, 0)), t.x), mix(stoneHash(cell + vec2(0, 1)), stoneHash(cell + vec2(1, 1)), t.x), t.y);
  }
`

// Mineral and fracture tone in the albedo plus chipped relief in the normal, sampled in world space from three
// directions so that vertical faces get detail too. Both fade out before they would alias.
export function withStoneDetail(material, kind) {
  const gravel = kind === 'gravel'
  const mineralF = gravel ? '85.0' : '9.0', mineralY = gravel ? '31.0' : '3.0', fractureF = gravel ? '24.0' : '3.1', fractureZ = gravel ? '19.0' : '2.0'
  const chipF = gravel ? '180.0' : '18.0'
  const previous = material.onBeforeCompile, previousKey = material.customProgramCacheKey
  material.onBeforeCompile = (shader, renderer) => {
    previous?.call(material, shader, renderer)
    shader.vertexShader = shader.vertexShader
      .replace('#include <common>', '#include <common>\nvarying vec3 vStoneWorld;')
      .replace('#include <project_vertex>', `#include <project_vertex>
        vec4 stoneWorldPosition = vec4(transformed, 1.0);
        #ifdef USE_INSTANCING
          stoneWorldPosition = instanceMatrix * stoneWorldPosition;
        #endif
        vStoneWorld = (modelMatrix * stoneWorldPosition).xyz;`)
    shader.fragmentShader = shader.fragmentShader
      .replace('#include <common>', `#include <common>\n${STONE_NOISE}`)
      .replace('#include <color_fragment>', `#include <color_fragment>
        float mineral = stoneNoise(vStoneWorld.xz * ${mineralF} + vStoneWorld.y * ${mineralY});
        float fracture = stoneNoise(vStoneWorld.xy * ${fractureF} + vStoneWorld.z * ${fractureZ});
        float stoneFootprint = max(length(dFdx(vStoneWorld)), length(dFdy(vStoneWorld)));
        mineral = mix(0.5, mineral, 1.0 - smoothstep(0.5, 1.5, stoneFootprint * ${mineralF}));
        fracture = mix(0.5, fracture, 1.0 - smoothstep(0.5, 1.5, stoneFootprint * ${fractureF}));
        diffuseColor.rgb *= 0.71 + mineral * 0.39 + fracture * 0.22;`)
      .replace('#include <normal_fragment_maps>', `#include <normal_fragment_maps>
        vec3 stoneNormal = inverseTransformDirection(normal, viewMatrix);
        vec3 weights = abs(stoneNormal);
        weights /= max(dot(weights, vec3(1.0)), 0.0001);
        vec3 sampleAt = vStoneWorld * ${chipF};
        float chip = dot(vec3(stoneNoise(sampleAt.yz), stoneNoise(sampleAt.xz), stoneNoise(sampleAt.xy)), weights);
        vec3 chipSlope;
        chipSlope.x = chip - dot(vec3(stoneNoise(sampleAt.yz), stoneNoise(sampleAt.xz + vec2(0.25, 0.0)), stoneNoise(sampleAt.xy + vec2(0.25, 0.0))), weights);
        chipSlope.y = chip - dot(vec3(stoneNoise(sampleAt.yz + vec2(0.25, 0.0)), stoneNoise(sampleAt.xz), stoneNoise(sampleAt.xy + vec2(0.0, 0.25))), weights);
        chipSlope.z = chip - dot(vec3(stoneNoise(sampleAt.yz + vec2(0.0, 0.25)), stoneNoise(sampleAt.xz + vec2(0.0, 0.25)), stoneNoise(sampleAt.xy)), weights);
        chipSlope -= stoneNormal * dot(stoneNormal, chipSlope);
        float chipFade = 1.0 - smoothstep(12.0, 75.0, length(vViewPosition));
        chipFade *= 1.0 - smoothstep(0.5, 1.5, max(length(dFdx(vStoneWorld)), length(dFdy(vStoneWorld))) * ${chipF});
        normal = normalize(mat3(viewMatrix) * normalize(stoneNormal + chipSlope * 0.4 * chipFade));`)
  }
  material.customProgramCacheKey = () => (previousKey ? previousKey.call(material) : '') + '|stone-' + kind
  material.needsUpdate = true
  return material
}
