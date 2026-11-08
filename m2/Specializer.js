/**
 * Specializer.js — TeaFabric M2 v1.2: fixed-pipeline -> GLSL ES 3.00 JIT.
 *
 * Reference-project-aligned route ("their JIT = per GL-state-combination
 * on-demand shader specialization + cache"): the 1.16.5 client drives
 * fixed-function GL (glEnable(GL_LIGHTING), glFogf, glAlphaFunc, glColor...).
 * WebGL2 has no fixed pipeline, so on the FIRST use of each state
 * combination we generate a dedicated minimal GLSL ES 3.00 program with the
 * state BAKED IN as constants (zero runtime branches), compile it once, and
 * cache it (LRU). Subsequent frames reuse the cached program.
 *
 * Contracts (same as the handwritten fallback family in samples/program):
 *   - MVP uniforms everywhere: ModelViewMat + ProjMat
 *   - ColorModulator on all color-multiply programs (setShaderColor equiv.)
 *   - GUI combos are fog-free by construction (fog off => no fog code at all)
 *   - UV2 lightmap: texel*16 on the 256-wide sheet, fsh divides by 256.0
 *   - ES 3.00 hygiene: #version 300 es, in/out, no legacy tokens
 *
 * Zero Mojang assets: all generated source is emitted from our own templates.
 */
'use strict';

const GL_CONST = require('./GlStateManager.js').GL_CONST;

const MAX_CACHE = 64; // LRU cap: 1.16.5 uses ~a dozen real combos in practice

// ---------------------------------------------------------------------------
// snapshot: plain-object capture of the fixed-pipe state that matters for
// shader generation. Everything else (blend/depth/cull) is real GL state.
// ---------------------------------------------------------------------------
function snapshot(gsm, attribs) {
  const L = gsm.lighting, F = gsm.fog, A = gsm.alphaTest;
  return {
    attribs: attribs.slice(), // e.g. ['Position','UV0','Color','Normal','UV2']
    lighting: {
      enabled: L.enabled,
      modelAmbient: L.modelAmbient.slice(),
      lights: L.lights.map(x => ({
        enabled: x.enabled,
        ambient: x.ambient.slice(),
        diffuse: x.diffuse.slice(),
        specular: x.specular.slice(),
        position: x.position.slice(), // w==0 => directional
      })),
    },
    fog: {
      enabled: F.enabled,
      mode: F.enabled ? F.mode : 0,
      density: F.density, start: F.start, end: F.end,
      color: F.color.slice(),
    },
    alphaTest: {
      enabled: A.enabled,
      func: A.enabled ? A.func : 0,
      ref: A.enabled ? A.ref : 0,
    },
    shadeModel: gsm._shadeModel || GL_CONST.SMOOTH,
  };
}

// ---------------------------------------------------------------------------
// key: order-independent normalization -> stable cache identity
// ---------------------------------------------------------------------------
function key(snap) {
  const parts = [];
  parts.push('attr=' + [...snap.attribs].sort().join(','));
  parts.push('shade=' + (snap.shadeModel === GL_CONST.FLAT ? 'flat' : 'smooth'));
  const L = snap.lighting;
  parts.push('light=' + (L.enabled ? 1 : 0));
  if (L.enabled) {
    parts.push('ma=' + L.modelAmbient.map(v => v.toFixed(4)).join(','));
    L.lights.forEach((l, i) => {
      parts.push(`l${i}=${l.enabled ? 1 : 0}|` +
        `a=${l.ambient.map(v => v.toFixed(3)).join(',')};` +
        `d=${l.diffuse.map(v => v.toFixed(3)).join(',')};` +
        `p=${l.position.map(v => v.toFixed(3)).join(',')}`);
    });
  }
  const F = snap.fog;
  parts.push('fog=' + (F.enabled ? { [GL_CONST.FOG_LINEAR]: 'linear', [GL_CONST.FOG_EXP]: 'exp', [GL_CONST.FOG_EXP2]: 'exp2' }[F.mode] || 'linear' : 'off'));
  if (F.enabled) {
    parts.push('fcol=' + F.color.map(v => v.toFixed(4)).join(','));
    if (F.mode === GL_CONST.FOG_LINEAR) parts.push('fs=' + F.start + ',fe=' + F.end);
    else parts.push('fd=' + F.density);
  }
  const A = snap.alphaTest;
  parts.push('alpha=' + (A.enabled ? `${A.func === GL_CONST.GREATER ? 'gt' : A.func === GL_CONST.LEQUAL ? 'le' : 'ge'}@${A.ref}` : 'off'));
  return parts.join(';');
}

function fnv1a(str) {
  let h = 0x811c9dc5;
  for (let i = 0; i < str.length; i++) { h ^= str.charCodeAt(i); h = (h * 0x01000193) >>> 0; }
  return h.toString(16).padStart(8, '0');
}

// ---------------------------------------------------------------------------
// specialize: emit dedicated GLSL ES 3.00 with state baked in (no branches)
// ---------------------------------------------------------------------------
const HEADLIGHT_SHADE = '0.4 + 0.6 * max(dot(normalize(vNormal), vec3(0.0, 0.0, 1.0)), 0.0)';

function specialize(snap) {
  const has = a => snap.attribs.includes(a);
  const hasUV0 = has('UV0'), hasColor = has('Color'), hasNormal = has('Normal'), hasUV2 = has('UV2');
  const hasTex = hasUV0; // Sampler0 rides UV0 in every combo that samples
  const K = GL_CONST;

  // ---- vertex shader ------------------------------------------------------
  const vs = [];
  vs.push('#version 300 es');
  vs.push('precision mediump float;');
  vs.push('in vec3 Position;');
  if (hasUV0) vs.push('in vec2 UV0;');
  if (hasColor) vs.push('in vec4 Color;');
  if (hasNormal) vs.push('in vec3 Normal;');
  if (hasUV2) vs.push('in vec2 UV2;');
  vs.push('uniform mat4 ModelViewMat;');
  vs.push('uniform mat4 ProjMat;');
  if (hasUV0) vs.push('out vec2 vUV0;');
  if (hasColor) vs.push('out vec4 vColor;');
  if (hasUV2) vs.push('out vec2 vUV2;');
  if (hasNormal && snap.lighting.enabled) vs.push('out vec3 vNormal;');
  if (snap.fog.enabled) vs.push('out vec3 vViewPos;');
  vs.push('void main() {');
  vs.push('  vec4 viewPos = ModelViewMat * vec4(Position, 1.0);');
  vs.push('  gl_Position = ProjMat * viewPos;');
  if (hasUV0) vs.push('  vUV0 = UV0;');
  if (hasColor) vs.push('  vColor = Color;');
  if (hasUV2) vs.push('  vUV2 = UV2;');
  if (hasNormal && snap.lighting.enabled) vs.push('  vNormal = mat3(ModelViewMat) * Normal;');
  if (snap.fog.enabled) vs.push('  vViewPos = viewPos.xyz;');
  vs.push('}');

  // ---- fragment shader ----------------------------------------------------
  const fs = [];
  fs.push('#version 300 es');
  fs.push('precision mediump float;');
  if (hasTex) fs.push('uniform sampler2D Sampler0;');
  if (hasUV2) fs.push('uniform sampler2D Sampler2;');
  fs.push('uniform vec4 ColorModulator;');
  if (hasUV0) fs.push('in vec2 vUV0;');
  if (hasColor) fs.push('in vec4 vColor;');
  if (hasUV2) fs.push('in vec2 vUV2;');
  const lightOn = snap.lighting.enabled && hasNormal;
  if (lightOn) fs.push('in vec3 vNormal;');
  if (snap.fog.enabled) fs.push('in vec3 vViewPos;');
  fs.push('out vec4 fragColor;');
  fs.push('void main() {');
  fs.push('  vec4 outColor = vec4(1.0);');
  if (hasTex) fs.push('  outColor = texture(Sampler0, vUV0);');
  if (lightOn) {
    // baked directional diffuse (w==0 positions) + model ambient, headlight term
    // included so a single light at +Z reproduces the fallback family formula.
    const L0 = snap.lighting.lights[0];
    const ambient = snap.lighting.modelAmbient;
    fs.push('  vec3 n = normalize(vNormal);');
    fs.push(`  float shade = ${HEADLIGHT_SHADE};`);
    const diff = L0.diffuse, pos = L0.position;
    fs.push(`  vec3 ldir = normalize(vec3(${pos.slice(0, 3).map(v => v.toFixed(6)).join(', ')}));`);
    fs.push(`  float ndl = max(dot(n, ldir), 0.0);`);
    fs.push(`  shade = shade * (1.0 - ${diff[0].toFixed(3)}) + ndl * ${diff[0].toFixed(3)} * 1.0;`);
    fs.push(`  vec3 lightCol = vec3(${ambient[0].toFixed(4)}, ${ambient[1].toFixed(4)}, ${ambient[2].toFixed(4)}) + vec3(${diff[0].toFixed(3)}, ${diff[1].toFixed(3)}, ${diff[2].toFixed(3)});`);
    fs.push('  outColor.rgb = outColor.rgb * mix(vec3(1.0), lightCol, shade);');
  }
  if (hasColor) fs.push('  outColor = outColor * vColor;');
  if (hasUV2) fs.push('  outColor = outColor * texture(Sampler2, (vUV2 + 0.5) / 256.0);');
  fs.push('  outColor = outColor * ColorModulator;');
  if (snap.alphaTest.enabled) {
    const op = snap.alphaTest.func === K.GREATER ? '<' : snap.alphaTest.func === K.LEQUAL ? '>' : '>='; // discard when test FAILS
    fs.push(`  if (outColor.a ${op} ${snap.alphaTest.ref.toFixed(6)}) discard;`);
  }
  if (snap.fog.enabled) {
    const F = snap.fog;
    fs.push('  float fogDist = length(vViewPos);');
    if (F.mode === K.FOG_LINEAR) {
      fs.push(`  float fogFactor = clamp((${F.end.toFixed(6)} - fogDist) / (${F.end.toFixed(6)} - ${F.start.toFixed(6)}), 0.0, 1.0);`);
    } else if (F.mode === K.FOG_EXP) {
      fs.push(`  float fogFactor = exp(-${F.density.toFixed(6)} * fogDist);`);
    } else { // EXP2
      fs.push(`  float fogFactor = exp(-(${F.density.toFixed(6)} * fogDist) * (${F.density.toFixed(6)} * fogDist));`);
    }
    fs.push(`  vec3 fogColor = vec3(${F.color.slice(0, 3).map(v => v.toFixed(6)).join(', ')});`);
    fs.push('  fragColor = vec4(mix(fogColor, outColor.rgb, fogFactor), outColor.a);');
  } else {
    fs.push('  fragColor = outColor;');
  }
  fs.push('}');

  return { name: 'fpjit_' + fnv1a(key(snap)), vs: vs.join('\n') + '\n', fs: fs.join('\n') + '\n' };
}

// ---------------------------------------------------------------------------
// program cache: LRU + hit/miss/eviction stats
// ---------------------------------------------------------------------------
class Specializer {
  constructor(maxEntries = MAX_CACHE) {
    this.max = maxEntries;
    this.cache = new Map(); // key -> {name, vs, fs, key}
    this.stats = { hits: 0, misses: 0, evictions: 0 };
  }
  get(snap) {
    const k = key(snap);
    if (this.cache.has(k)) {
      const v = this.cache.get(k);
      this.cache.delete(k); this.cache.set(k, v); // MRU
      this.stats.hits++;
      return v;
    }
    this.stats.misses++;
    const prog = specialize(snap);
    prog.key = k;
    if (this.cache.size >= this.max) {
      const oldest = this.cache.keys().next().value;
      this.cache.delete(oldest);
      this.stats.evictions++;
    }
    this.cache.set(k, prog);
    return prog;
  }
  /** Convenience: snapshot from a GlStateManager + vertex format, then get(). */
  getProgram(gsm, attribs) { return this.get(snapshot(gsm, attribs)); }
}

if (typeof module !== 'undefined') module.exports = { Specializer, snapshot, key, specialize, HEADLIGHT_SHADE, MAX_CACHE };
if (typeof window !== 'undefined') window.Specializer = Specializer;
