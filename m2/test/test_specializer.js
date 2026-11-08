/**
 * TeaFabric M2 v1.2 — fixed-pipeline specializer JIT contract tests.
 * Verifies: snapshot/key normalization, state baking (fog off => zero fog
 * code), alpha-test discard baking, headlight semantic equivalence with the
 * fallback family, LRU cache behavior, GLSM virtual-state plumbing, ES 3.00
 * hygiene, and no GL calls for virtual caps (they must never reach WebGL).
 * Run: node test/test_specializer.js
 */
'use strict';
const path = require('path');
const { GlStateManager, GL_CONST } = require(path.join(__dirname, '..', 'GlStateManager.js'));
const { Specializer, snapshot, key, specialize, HEADLIGHT_SHADE } = require(path.join(__dirname, '..', 'Specializer.js'));

let pass = 0, fail = 0; const failures = [];
function test(name, fn) {
  try { fn(); pass++; console.log('  PASS ' + name); }
  catch (e) { fail++; failures.push(name + ' -> ' + e.message); console.log('  FAIL ' + name + ' :: ' + e.message); }
}
function eq(a, b, m) { if (JSON.stringify(a) !== JSON.stringify(b)) throw new Error(`${m}: got ${JSON.stringify(a)} want ${JSON.stringify(b)}`); }
function ok(cond, m) { if (!cond) throw new Error(m); }

// headless GL stub: counts GL calls, nothing else
function makeGLStub() {
  return { stats: { calls: [] }, MAX_COMBINED_TEXTURE_IMAGE_UNITS: 8,
    getParameter() { return 8; },
    enable(c) { this.stats.calls.push(['enable', c]); },
    disable(c) { this.stats.calls.push(['disable', c]); } };
}
function freshGSM() { return new GlStateManager(makeGLStub()); }

console.log('== fixed-pipe specializer JIT contract tests ==');

// ---- 1. snapshot/key normalization ---------------------------------------
test('snapshot+key: state-set order is irrelevant (same key)', () => {
  const g = freshGSM();
  g.lightingEnable();
  g.fogEnable(); g.fogf(GL_CONST.FOG_MODE, GL_CONST.FOG_LINEAR); g.fogf(GL_CONST.FOG_START, 20); g.fogf(GL_CONST.FOG_END, 120);
  const k1 = key(snapshot(g, ['Position', 'UV0', 'Color']));
  // rebuild in a different call order
  const g2 = freshGSM();
  g2.fogf(GL_CONST.FOG_END, 120); g2.fogEnable(); g2.lightingEnable(); g2.fogf(GL_CONST.FOG_MODE, GL_CONST.FOG_LINEAR); g2.fogf(GL_CONST.FOG_START, 20);
  const k2 = key(snapshot(g2, ['Color', 'Position', 'UV0'])); // attrib order sorted too
  eq(k1, k2, 'keys must match regardless of GLSM call order / attrib order');
});

test('snapshot+key: different fog mode => different key', () => {
  const a = freshGSM(), b = freshGSM();
  a.fogEnable(); a.fogf(GL_CONST.FOG_MODE, GL_CONST.FOG_LINEAR);
  b.fogEnable(); b.fogf(GL_CONST.FOG_MODE, GL_CONST.FOG_EXP2);
  ok(key(snapshot(a, ['Position'])) !== key(snapshot(b, ['Position'])), 'fog mode must change the key');
});

test('snapshot+key: alpha ref granularity changes the key', () => {
  const a = freshGSM(), b = freshGSM();
  a.alphaTestEnable(); a.alphaFunc(GL_CONST.GREATER, 0.1);
  b.alphaTestEnable(); b.alphaFunc(GL_CONST.GREATER, 0.35);
  ok(key(snapshot(a, ['Position', 'UV0'])) !== key(snapshot(b, ['Position', 'UV0'])), 'ref is baked, must split keys');
});

// ---- 2. state baking -------------------------------------------------------
test('baking: fog OFF emits ZERO fog code (no branch, no fogColor)', () => {
  const g = freshGSM(); // fog untouched => disabled
  const p = specialize(snapshot(g, ['Position', 'UV0', 'Color']));
  ok(!/fog/i.test(p.fs), 'fsh must not mention fog at all when disabled');
  ok(!/vViewPos/.test(p.vs), 'vsh must not compute view pos for fog when disabled');
  ok(/fragColor = outColor;/.test(p.fs), 'straight passthrough expected');
});

test('baking: linear fog bakes start/end as numeric literals', () => {
  const g = freshGSM();
  g.fogEnable(); g.fogf(GL_CONST.FOG_MODE, GL_CONST.FOG_LINEAR); g.fogf(GL_CONST.FOG_START, 20); g.fogf(GL_CONST.FOG_END, 120);
  const p = specialize(snapshot(g, ['Position', 'UV0', 'Color']));
  ok(/clamp\(\(120\.000000 - fogDist\) \/ \(120\.000000 - 20\.000000\)/.test(p.fs), 'start/end must be baked literals');
  ok(/mix\(fogColor, outColor\.rgb, fogFactor\)/.test(p.fs), 'fog mix present');
});

test('baking: exp2 fog bakes density, no clamp', () => {
  const g = freshGSM();
  g.fogEnable(); g.fogf(GL_CONST.FOG_MODE, GL_CONST.FOG_EXP2); g.fogf(GL_CONST.FOG_DENSITY, 0.008);
  const p = specialize(snapshot(g, ['Position', 'UV0', 'Color']));
  ok(/exp\(-\(0\.008000 \* fogDist\) \* \(0\.008000 \* fogDist\)\)/.test(p.fs), 'exp2 formula with baked density');
  ok(!/clamp/.test(p.fs), 'exp2 must not clamp');
});

test('baking: alphaTest bakes discard + literal ref', () => {
  const g = freshGSM();
  g.alphaTestEnable(); g.alphaFunc(GL_CONST.GREATER, 0.35);
  const p = specialize(snapshot(g, ['Position', 'UV0']));
  ok(/if \(outColor\.a < 0\.350000\) discard;/.test(p.fs), 'GREATER test failure => a < ref discarded');
});

test('baking: lighting OFF => no normal transform in vsh', () => {
  const g = freshGSM();
  const p = specialize(snapshot(g, ['Position', 'UV0', 'Color', 'Normal']));
  ok(!/vNormal/.test(p.vs), 'lighting off must skip normal pipeline entirely');
});

// ---- 3. semantic equivalence with the fallback family ---------------------
test('equivalence: headlight combo uses the SAME shade formula as position_tex_color_normal', () => {
  const g = freshGSM();
  g.lightingEnable();
  g.lightfv(GL_CONST.LIGHT0, GL_CONST.POSITION, [0, 0, 1, 0]); // headlight in view space
  g.lightfv(GL_CONST.LIGHT0, GL_CONST.DIFFUSE, [0.6, 0.6, 0.6, 1]);
  const p = specialize(snapshot(g, ['Position', 'UV0', 'Color', 'Normal']));
  const norm = s => s.replace(/\s+/g, ' ').trim();
  ok(norm(p.fs).includes(norm('float shade = ' + HEADLIGHT_SHADE + ';')), 'shade formula must match fallback family');
  ok(/mat3\(ModelViewMat\) \* Normal/.test(p.vs), 'view-space normal transform matches');
  ok(/texture\(Sampler0, vUV0\)/.test(p.fs), 'texel fetch matches');
  ok(/outColor = outColor \* ColorModulator;/.test(p.fs), 'ColorModulator contract holds');
});

test('equivalence: UV2 lightmap normalization (texel*16, /256.0)', () => {
  const g = freshGSM();
  const p = specialize(snapshot(g, ['Position', 'UV0', 'UV2', 'Color']));
  ok(/texture\(Sampler2, \(vUV2 \+ 0\.5\) \/ 256\.0\)/.test(p.fs), 'lightmap sheet contract');
});

// ---- 4. LRU cache ----------------------------------------------------------
test('cache: same snapshot twice = 1 miss + 1 hit (no recompile)', () => {
  const s = new Specializer(8);
  const g = freshGSM();
  const snap = snapshot(g, ['Position', 'UV0']);
  s.get(snap); s.get(snap);
  eq(s.stats.misses, 1, 'exactly one compile');
  eq(s.stats.hits, 1, 'second lookup hits');
});

test('cache: LRU evicts the oldest beyond max', () => {
  const s = new Specializer(2);
  const g = freshGSM();
  s.get(snapshot(g, ['Position']));
  s.get(snapshot(g, ['Position', 'UV0']));
  s.get(snapshot(g, ['Position', 'Color']));
  eq(s.stats.evictions, 1, 'cap=2 exceeded once');
  // re-request the FIRST combo => must be a miss again (it was evicted)
  const before = s.stats.misses;
  s.get(snapshot(g, ['Position']));
  eq(s.stats.misses, before + 1, 'evicted entry was recompiled');
});

test('cache: LRU refresh protects hot entries from eviction', () => {
  const s = new Specializer(2);
  const g = freshGSM();
  const hot = snapshot(g, ['Position']);
  s.get(hot);
  s.get(snapshot(g, ['Position', 'UV0']));
  s.get(hot); // refresh => now MRU
  s.get(snapshot(g, ['Position', 'Color'])); // evicts the UV0 combo, not hot
  eq(s.stats.evictions, 1, 'one eviction');
  const before = s.stats.misses;
  s.get(hot);
  eq(s.stats.hits, 2, 'hot entry survived (hit, not recompiled)');
});

// ---- 5. GLSM virtual-state plumbing ---------------------------------------
test('GLSM: virtual caps issue ZERO GL enable/disable calls (pure CPU state)', () => {
  const g = freshGSM();
  g.lightingEnable(); g.fogEnable(); g.alphaTestEnable();
  g.lightingDisable(); g.fogDisable(); g.alphaTestDisable();
  const glCalls = g.gl.stats.calls.filter(c => c[0] === 'enable' || c[0] === 'disable');
  eq(glCalls.length, 0, 'WebGL2 has no LIGHTING/FOG/ALPHA_TEST caps — must never reach GL');
});

test('GLSM: redundant virtual enable counts as dedup skip', () => {
  const g = freshGSM();
  const before = g.stats.skippedByCache;
  g.lightingEnable(); g.lightingEnable(); g.lightingEnable();
  eq(g.stats.skippedByCache - before, 2, '2 redundant enables deduped');
  ok(g.lighting.enabled === true, 'state is on');
});

test('GLSM: fogf/fogfv/lightfv mutate state and lightfv marks dirty', () => {
  const g = freshGSM();
  g.fogf(GL_CONST.FOG_MODE, GL_CONST.FOG_EXP2);
  eq(g.fog.mode, GL_CONST.FOG_EXP2, 'fog mode set');
  g.fogfv(GL_CONST.FOG_COLOR, [0.5, 0.6, 0.7, 1]);
  eq(g.fog.color, [0.5, 0.6, 0.7, 1], 'fog color set');
  const dirtyBefore = g.lighting.dirty;
  g.lightfv(GL_CONST.LIGHT1, GL_CONST.DIFFUSE, [0.2, 0.2, 0.25, 1]);
  ok(g.lighting.dirty === true, 'light change marks lighting dirty');
  eq(g.lighting.lights[1].diffuse, [0.2, 0.2, 0.25, 1], 'light1 diffuse updated');
});

test('GLSM: unsupported pname/light fails fast', () => {
  const g = freshGSM();
  let threw = 0;
  try { g.fogf(0x1234, 1); } catch (e) { threw++; }
  try { g.lightfv(0x4005, GL_CONST.DIFFUSE, [1, 0, 0, 1]); } catch (e) { threw++; } // LIGHT4: not modeled
  eq(threw, 2, 'both calls must throw');
});

// ---- 6. ES 3.00 hygiene on generated sources ------------------------------
test('hygiene: generated programs are ES 3.00 clean', () => {
  const combos = [
    ['Position', 'UV0', 'Color'],
    ['Position', 'UV0', 'Color', 'Normal', 'UV2'],
  ];
  const g = freshGSM();
  g.lightingEnable(); g.fogEnable(); g.fogf(GL_CONST.FOG_MODE, GL_CONST.FOG_LINEAR);
  g.alphaTestEnable(); g.alphaFunc(GL_CONST.GREATER, 0.1);
  for (const attrs of combos) {
    const p = specialize(snapshot(g, attrs));
    for (const src of [p.vs, p.fs]) {
      ok(src.startsWith('#version 300 es'), 'version header');
      ok(!/gl_FragColor|attribute |varying |texture2D|gl_FragData|GL_FOG|GL_LIGHTING/.test(src), 'no legacy tokens in ' + p.name);
    }
    ok(/in vec3 Position;/.test(p.vs), 'Position attribute');
    ok(/uniform mat4 ModelViewMat;/.test(p.vs) && /uniform mat4 ProjMat;/.test(p.vs), 'MVP contract');
    ok(/uniform vec4 ColorModulator;/.test(p.fs), 'ColorModulator contract');
  }
});

// ---- 7. program name stability --------------------------------------------
test('naming: fpjit_<fnv> stable for identical snapshots, distinct otherwise', () => {
  const g1 = freshGSM(), g2 = freshGSM();
  g1.fogEnable(); g1.fogf(GL_CONST.FOG_MODE, GL_CONST.FOG_EXP); g1.fogf(GL_CONST.FOG_DENSITY, 0.01);
  g2.fogEnable(); g2.fogf(GL_CONST.FOG_MODE, GL_CONST.FOG_EXP); g2.fogf(GL_CONST.FOG_DENSITY, 0.01);
  const p1 = specialize(snapshot(g1, ['Position', 'UV0', 'Color']));
  const p2 = specialize(snapshot(g2, ['Position', 'UV0', 'Color']));
  eq(p1.name, p2.name, 'identical combos share a program identity');
  const p3 = specialize(snapshot(g2, ['Position', 'UV0']));
  ok(p1.name !== p3.name, 'different attribs => different identity');
  ok(/^fpjit_[0-9a-f]{8}$/.test(p1.name), 'name format');
});

// ============================================================================
console.log(`\n== RESULT: ${pass} passed, ${fail} failed ==`);
if (fail) { console.log('FAILURES:\n  ' + failures.join('\n  ')); process.exit(1); }
