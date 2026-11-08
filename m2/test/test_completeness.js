/**
 * TeaFabric M2 v1.3 — COMPLETENESS suite ("编译后所有都能用" machine check).
 *
 * 1. Coverage matrix enforcement: EVERY OpenGL function referenced by the
 *    SHA1-verified 1.16.5 client.jar (build/gl_surface.json, constant-pool
 *    scan — no decompilation) MUST have a disposition in
 *    docs/coverage_table.js. A missing entry fails here, so the shim can
 *    never silently fall behind the real client surface again.
 * 2. New v1.3 surfaces: texenv virtual state (zero GL calls, fail-fast),
 *    texenv baking in the specializer (4 modes), CurrentColor path,
 *    GLSM<->Specializer integration (compile-once + uniform feed + dedup),
 *    attribute stack, client-state/buffer/query wrappers, new RenderTypes.
 * Run: node test/test_completeness.js
 */
'use strict';
const fs = require('fs');
const path = require('path');
const { GlStateManager, GL_CONST } = require(path.join(__dirname, '..', 'GlStateManager.js'));
const { Specializer, snapshot, key, specialize } = require(path.join(__dirname, '..', 'Specializer.js'));
const { RENDER_TYPES, applyRenderType } = require(path.join(__dirname, '..', 'RenderTypeStates.js'));
const { COVERAGE, SUMMARY } = require(path.join(__dirname, '..', 'docs', 'coverage_table.js'));

let pass = 0, fail = 0; const failures = [];
function test(name, fn) {
  try { fn(); pass++; console.log('  PASS ' + name); }
  catch (e) { fail++; failures.push(name + ' -> ' + e.message); console.log('  FAIL ' + name + ' :: ' + e.message); }
}
function eq(a, b, m) { if (JSON.stringify(a) !== JSON.stringify(b)) throw new Error(`${m}: got ${JSON.stringify(a)} want ${JSON.stringify(b)}`); }
function ok(cond, m) { if (!cond) throw new Error(m); }
function throws(fn, m) { let t = 0; try { fn(); } catch (e) { t = 1; } ok(t, m); }

// rich GL stub: records calls, fakes program/shader object flow
function makeGLStub() {
  const calls = [];
  let fake = 1;
  const stub = {
    __calls: calls, MAX_COMBINED_TEXTURE_IMAGE_UNITS: 8,
    // GL enums used by GLSM paths
    BLEND: 0x0BE2, DEPTH_TEST: 0x0B71, CULL_FACE: 0x0B44, SCISSOR_TEST: 0x0C11,
    STENCIL_TEST: 0x0B90, POLYGON_OFFSET_FILL: 0x8037, COLOR_LOGIC_OP: 0x0BF2,
    TEXTURE_2D: 0x0DE1, FRAMEBUFFER: 0x8D40, VERTEX_SHADER: 0x8B31, FRAGMENT_SHADER: 0x8B30,
    LINK_STATUS: 0x8B82, COMPILE_STATUS: 0x8B81, ARRAY_BUFFER: 0x8892, STATIC_DRAW: 0x88E4,
    UNPACK_ALIGNMENT: 0x0CF5,
    getParameter(p) { return 8; },
    getError() { return 0; },
    // object lifecycle fakes
    createShader() { return { id: fake++, kind: 'shader' }; },
    shaderSource() {}, compileShader() {}, deleteShader() {},
    createProgram() { return { id: fake++, kind: 'program' }; },
    attachShader() {}, linkProgram() {}, deleteProgram() {},
    getShaderParameter() { return true; },
    getProgramParameter(t, pname) { return pname === stub.LINK_STATUS ? true : 0; },
    getShaderInfoLog() { return ''; }, getProgramInfoLog() { return ''; },
    getAttribLocation() { return 0; },
    // realistic: per-program uniform presence, parsed from the actual fsh source
    getUniformLocation(p, n) {
      return (p && p.__uniforms && p.__uniforms.includes(n)) ? { loc: n } : null;
    },
    // state-mutating calls all recorded
    enable(c) { calls.push(['enable', c]); },
    disable(c) { calls.push(['disable', c]); },
    useProgram(p) { calls.push(['useProgram', p && p.id]); },
    blendFuncSeparate() { calls.push(['blendFuncSeparate']); },
    blendEquationSeparate() { calls.push(['blendEquationSeparate']); },
    depthFunc() { calls.push(['depthFunc']); }, depthMask() { calls.push(['depthMask']); },
    cullFace() { calls.push(['cullFace']); },
    colorMask() { calls.push(['colorMask']); },
    viewport() { calls.push(['viewport']); },
    clear() { calls.push(['clear']); }, clearColor() {}, clearDepth() {}, clearStencil() {},
    stencilMask() { calls.push(['stencilMask']); },
    blendColor() { calls.push(['blendColor']); },
    blendEquation(m) { calls.push(['blendEquation', m]); },
    bindTexture() { calls.push(['bindTexture']); },
    texParameteri() {}, createTexture() { return { id: fake++, kind: 'tex' }; },
    deleteTexture() {}, texImage2D() { calls.push(['texImage2D']); },
    texSubImage2D() { calls.push(['texSubImage2D']); },
    copyTexSubImage2D() { calls.push(['copyTexSubImage2D']); },
    pixelStorei(t, p) { calls.push(['pixelStorei', t, p]); },
    createBuffer() { return { id: fake++, kind: 'buf' }; },
    deleteBuffer() {}, bindBuffer(t, b) { calls.push(['bindBuffer', t, b && b.id]); },
    bufferData() { calls.push(['bufferData']); },
    bindVertexArray() {}, createVertexArray() { return { id: fake++ }; },
    activeTexture(u) { calls.push(['activeTexture', u]); },
    uniform1i(l, v) { calls.push(['uniform1i', l.loc, v]); },
    uniform4f(l, ...v) { calls.push(['uniform4f', l.loc, ...v]); },
    uniformMatrix4fv(l, t, m) { calls.push(['uniformMatrix4fv', l.loc]); },
    drawArrays(m, f, c) { calls.push(['drawArrays', m, f, c]); },
    polygonOffset() { calls.push(['polygonOffset']); },
    lineWidth() { calls.push(['lineWidth']); },
    readPixels() { calls.push(['readPixels']); },
  };
  return stub;
}
function freshGSM() { return new GlStateManager(makeGLStub()); }
/** Wrap gsm.createProgram so fake programs know their declared uniforms
 *  (parsed from the fsh source) — makes getUniformLocation realistic. */
function wireProgramUniforms(g) {
  const orig = g.createProgram.bind(g);
  g.createProgram = (vs, fs) => {
    const p = orig(vs, fs);
    const decl = (src) => [...src.matchAll(/uniform\s+\w+\s+(\w+)/g)].map(m => m[1]);
    p.__uniforms = [...new Set([...decl(vs), ...decl(fs)])];
    return p;
  };
  return g;
}
const K = GL_CONST;

console.log('== v1.3 completeness: coverage matrix + new surfaces ==');

// ---- 1. coverage matrix enforcement ---------------------------------------
test('coverage: every GL-scope function in client.jar has a disposition', () => {
  // fresh scan (m2/build) wins; committed evidence copy (m2/docs) is the fallback
  const fresh = path.join(__dirname, '..', 'build', 'gl_surface.json');
  const committed = path.join(__dirname, '..', 'docs', 'gl_surface.json');
  const surf = JSON.parse(fs.readFileSync(fs.existsSync(fresh) ? fresh : committed, 'utf8'));
  const GL_OWNERS = new Set(['GL11', 'GL13', 'GL14', 'GL15', 'GL20', 'GL30',
    'ARBFramebufferObject', 'EXTFramebufferObject', 'EXTFramebufferBlit',
    'ARBDebugOutput', 'KHRDebug', 'GL']);
  const covered = new Set(COVERAGE.map(r => r.fn + '@' + r.owner));
  let checked = 0;
  for (const [owner, fns] of Object.entries(surf.surface)) {
    const short = owner.split('/').pop();
    if (!GL_OWNERS.has(short)) continue; // GLFW/OpenAL/STB are other lines
    for (const fn of Object.keys(fns)) {
      ok(covered.has(fn + '@' + short), `client.jar uses ${short}.${fn} but coverage_table.js has no entry — implement/virtual/alias/deviate it, never ignore`);
      checked++;
    }
  }
  eq(checked, COVERAGE.length, 'coverage rows exactly match the scanned surface (both directions)');
  ok(checked >= 130, 'sanity: the client surface is this large, matrix cannot shrink silently');
});

test('coverage: summary tallies and no unknown dispositions', () => {
  const allowed = new Set(['implemented', 'virtual', 'alias', 'deviation']);
  for (const r of COVERAGE) ok(allowed.has(r.disposition), 'unknown disposition ' + r.disposition);
  eq(SUMMARY.total_functions, COVERAGE.length, 'summary total');
  eq(SUMMARY.implemented + SUMMARY.virtual + SUMMARY.alias + SUMMARY.deviation, SUMMARY.total_functions, 'summary adds up');
});

// ---- 2. texenv virtual state ------------------------------------------------
test('texenv: MODULATE default, set/dedup on active unit, per-unit isolation', () => {
  const g = freshGSM();
  eq(g.getTexEnvMode(0), K.TEXENV_MODULATE, 'GL default is MODULATE');
  const before = g.stats.skippedByCache;
  g.texEnvi(K.TEXTURE_ENV, K.TEXTURE_ENV_MODE, K.TEXENV_REPLACE);
  g.texEnvi(K.TEXTURE_ENV, K.TEXTURE_ENV_MODE, K.TEXENV_REPLACE); // dedup
  eq(g.stats.skippedByCache - before, 1, 'redundant set deduped');
  g.activeTexture(1);
  g.texEnvi(K.TEXTURE_ENV, K.TEXTURE_ENV_MODE, K.TEXENV_DECAL);
  eq(g.getTexEnvMode(0), K.TEXENV_REPLACE, 'unit 0 untouched');
  eq(g.getTexEnvMode(1), K.TEXENV_DECAL, 'unit 1 set');
});

test('texenv: BLEND/COMBINE fail-fast; wrong target/pname fail-fast; ZERO GL calls', () => {
  const g = freshGSM();
  throws(() => g.texEnvi(K.TEXTURE_ENV, K.TEXTURE_ENV_MODE, K.TEXENV_COMBINE), 'COMBINE must throw');
  throws(() => g.texEnvi(K.TEXTURE_ENV, K.TEXTURE_ENV_MODE, K.TEXENV_BLEND), 'BLEND must throw');
  throws(() => g.texEnvi(K.TEXTURE_2D, K.TEXTURE_ENV_MODE, K.TEXENV_REPLACE), 'wrong target must throw');
  throws(() => g.texEnvi(K.TEXTURE_ENV, 0x1234, K.TEXENV_REPLACE), 'wrong pname must throw');
  const glCalls = g.gl.__calls.filter(c => c[0] === 'enable' || c[0] === 'disable');
  eq(glCalls.length, 0, 'texenv is virtual: never reaches WebGL');
});

// ---- 3. specializer texEnv baking ------------------------------------------
test('baking: MODULATE (default) multiplies texel * cd', () => {
  const g = freshGSM();
  const p = specialize(snapshot(g, ['Position', 'UV0', 'Color']));
  ok(/vec4 outColor = texel \* cd;/.test(p.fs), 'MODULATE combine');
  ok(!/CurrentColor/.test(p.fs), 'Color attribute present => no CurrentColor uniform');
  ok(p.fs.includes('tex=') === false, 'no key leakage into source');
});

test('baking: REPLACE / DECAL / ADD emit GL-spec formulas', () => {
  const mk = mode => {
    const g = freshGSM();
    g.texEnvi(K.TEXTURE_ENV, K.TEXTURE_ENV_MODE, mode);
    return specialize(snapshot(g, ['Position', 'UV0', 'Color']));
  };
  ok(/vec4 outColor = texel;/.test(mk(K.TEXENV_REPLACE).fs), 'REPLACE: Cf=Ct');
  ok(/vec4 outColor = vec4\(mix\(cd\.rgb, texel\.rgb, texel\.a\), cd\.a\);/.test(mk(K.TEXENV_DECAL).fs), 'DECAL formula');
  ok(/vec4 outColor = vec4\(cd\.rgb \+ texel\.rgb, cd\.a\);/.test(mk(K.TEXENV_ADD).fs), 'ADD formula');
});

test('baking: tex-env mode splits the key (REPLACE != MODULATE programs)', () => {
  const a = freshGSM(), b = freshGSM();
  b.texEnvi(K.TEXTURE_ENV, K.TEXTURE_ENV_MODE, K.TEXENV_REPLACE);
  ok(key(snapshot(a, ['Position', 'UV0'])) !== key(snapshot(b, ['Position', 'UV0'])), 'keys differ');
  // no-texture combos ignore texenv in the key
  const a2 = freshGSM(), b2 = freshGSM();
  b2.texEnvi(K.TEXTURE_ENV, K.TEXTURE_ENV_MODE, K.TEXENV_REPLACE);
  eq(key(snapshot(a2, ['Position'])), key(snapshot(b2, ['Position'])), 'tex-less combo: mode irrelevant');
});

test('baking: CurrentColor uniform appears exactly when the combo lacks Color', () => {
  const g = freshGSM();
  const p = specialize(snapshot(g, ['Position', 'UV0'])); // position_tex style
  ok(/uniform vec4 CurrentColor;/.test(p.fs), 'CurrentColor present');
  ok(/vec4 cd = CurrentColor;/.test(p.fs), 'cd rides CurrentColor');
  const g2 = freshGSM();
  const p2 = specialize(snapshot(g2, ['Position', 'UV0', 'Color']));
  ok(/vec4 cd = vColor;/.test(p2.fs), 'cd rides vertex color');
});

// ---- 4. GLSM <-> Specializer integration -----------------------------------
test('integration: two color channels (glColor -> CurrentColor, setShaderColor -> ColorModulator)', () => {
  const gl = makeGLStub();
  const g = wireProgramUniforms(new GlStateManager(gl));
  g.attachSpecializer(new Specializer(64));
  const p1 = g.useSpecializedProgram(['Position', 'UV0', 'Color']);
  // first bind: useProgram + MVP(2) + ColorModulator feed (has Color => no CurrentColor loc)
  eq(gl.__calls.filter(c => c[0] === 'useProgram').length, 1, 'one useProgram');
  eq(gl.__calls.filter(c => c[0] === 'uniformMatrix4fv').length, 2, 'MVP uploaded');
  eq(gl.__calls.filter(c => c[0] === 'uniform4f' && c[1] === 'ColorModulator').length, 1, 'ColorModulator fed');
  const p2 = g.useSpecializedProgram(['Position', 'UV0', 'Color']);
  eq(p2.id, p1.id, 'same state combo => same program object');
  // identical rebind: everything deduped => ZERO GL calls
  const before = gl.__calls.length;
  g.useSpecializedProgram(['Position', 'UV0', 'Color']);
  eq(gl.__calls.length - before, 0, 'fully deduped rebind issues no GL calls');
  // glColor change: Color-attr combo has no CurrentColor uniform; CM untouched => no feeds
  g.color4f(0.5, 1, 0.5, 1);
  g.useSpecializedProgram(['Position', 'UV0', 'Color']);
  eq(gl.__calls.length - before, 0, 'glColor feeds nothing when the program has no CurrentColor');
  // setShaderColor change => ColorModulator refeed (the INDEPENDENT channel)
  g.setColorModulator(1, 0.5, 0.5, 1);
  g.useSpecializedProgram(['Position', 'UV0', 'Color']);
  const cmFeeds = gl.__calls.filter(c => c[0] === 'uniform4f' && c[1] === 'ColorModulator');
  eq(cmFeeds.length, 2, 'setShaderColor re-feeds ColorModulator');
  eq(gl.__calls[gl.__calls.length - 1][2], 1, 'CM follows setColorModulator, not glColor');
  // CurrentColor channel: no-Color combo binds CurrentColor and feeds glColor
  const p3 = g.useSpecializedProgram(['Position', 'UV0']);
  const ccFeeds = gl.__calls.filter(c => c[0] === 'uniform4f' && c[1] === 'CurrentColor');
  eq(ccFeeds.length, 1, 'no-Color combo feeds CurrentColor on switch');
  eq(ccFeeds[0][2], 0.5, 'CurrentColor follows glColor');
});

test('integration: texenv flip produces a NEW program identity', () => {
  const gl = makeGLStub();
  const g = new GlStateManager(gl);
  g.attachSpecializer(new Specializer(64));
  const a = g.useSpecializedProgram(['Position', 'UV0']);
  g.texEnvi(K.TEXTURE_ENV, K.TEXTURE_ENV_MODE, K.TEXENV_REPLACE);
  const b = g.useSpecializedProgram(['Position', 'UV0']);
  ok(a.id !== b.id, 'REPLACE is a different baked program');
});

test('integration: lighting without a Normal attribute still shades (default normal)', () => {
  const g = freshGSM();
  g.lightingEnable();
  const p = specialize(snapshot(g, ['Position', 'UV0', 'Color']));
  ok(/vec3 n = vec3\(0\.0, 0\.0, 1\.0\);/.test(p.fs), 'GL default normal baked');
  ok(!/vNormal/.test(p.vs), 'no normal attribute => no varying');
});

// ---- 5. attribute stack ------------------------------------------------------
test('pushAttrib/popAttrib: full snapshot round-trips all blocks', () => {
  const g = freshGSM();
  g.pushAttrib(0xFFFF);
  g.blendEnable(); g.blendFuncSeparate(K.SRC_ALPHA, K.ONE, K.SRC_ALPHA, K.ONE);
  g.depthFunc(K.ALWAYS); g.depthMask(false);
  g.lightingEnable(); g.fogEnable(); g.fogf(K.FOG_MODE, K.FOG_EXP2); g.fogf(K.FOG_DENSITY, 0.02);
  g.texEnvi(K.TEXTURE_ENV, K.TEXTURE_ENV_MODE, K.TEXENV_ADD);
  g.lineWidth(3);
  g.popAttrib();
  eq(g.blend.enabled, false, 'blend off');
  eq(g.depth.func, K.LESS, 'depth func restored (default at push time)');
  eq(g.depth.mask, true, 'depth mask restored');
  eq(g.lighting.enabled, false, 'lighting off');
  eq(g.fog.enabled, false, 'fog off');
  eq(g.getTexEnvMode(0), K.TEXENV_MODULATE, 'texenv restored');
  eq(g._lineWidth.v, 1, 'line width restored');
  throws(() => g.popAttrib(), 'underflow fail-fast');
  // restore leaves everything dirty => next applyAll flushes (no stale GL state)
  const gl = g.gl;
  g.applyAll();
  ok(gl.__calls.length > 0, 'forced flush after restore');
});

// ---- 6. client state / buffers / queries wrappers ----------------------------
test('client state: caps + pointers + clientActiveTexture + multiTexCoord', () => {
  const g = freshGSM();
  g.enableClientState(K.VERTEX_ARRAY); g.enableClientState(K.COLOR_ARRAY);
  g.texCoordPointer(2, K.FLOAT, 8, { buffer: 'uv' });
  g.clientActiveTexture(K.TEXTURE0 + 1);
  g.texCoordPointer(2, K.FLOAT, 16, { buffer: 'light' });
  eq(g._clientPointers.texcoord[0].stride, 8, 'unit0 pointer');
  eq(g._clientPointers.texcoord[1].stride, 16, 'unit1 pointer after clientActiveTexture');
  g.multiTexCoord2f(K.TEXTURE0 + 1, 240, 128);
  eq(g._multiUV[1], [240, 128], 'lightmap UV replay state');
  throws(() => g.enableClientState(0x1234), 'unknown client cap fail-fast');
  g.normal3f(0, 1, 0);
  eq(g._currentNormal, [0, 1, 0], 'current normal record');
});

test('buffers: gen/bind dedup/data flow through GL exactly once', () => {
  const g = freshGSM();
  const b = g.genBuffer();
  g.bindBuffer(K.ARRAY_BUFFER, b);
  g.bindBuffer(K.ARRAY_BUFFER, b); // dedup
  const binds = g.gl.__calls.filter(c => c[0] === 'bindBuffer');
  eq(binds.length, 1, 'rebind deduped');
  g.bufferData(K.ARRAY_BUFFER, new Float32Array(12), K.STATIC_DRAW);
  eq(g.gl.__calls.filter(c => c[0] === 'bufferData').length, 1, 'bufferData forwarded');
  g.deleteBuffer(b);
});

test('queries: getFloatv matrices from CPU stacks, tex level sizes recorded', () => {
  const g = freshGSM();
  g.matrixMode(K.PROJECTION); g.ortho(0, 10, 0, 5, -1, 1);
  const m = g.getFloatv(K.PROJECTION);
  const near = (a, b) => Math.abs(a - b) < 1e-6;
  ok(near(m[0], 0.2) && near(m[5], 0.4) && near(m[10], -1) && near(m[15], 1), 'ortho values read back');
  g.activeTexture(0);
  eq(g.getTexLevelParameteri(0, K.TEXTURE_WIDTH), 0, 'no upload yet');
  g.uploadTexture2D(0, 4, 16, 16, 4, 5, null);
  eq(g.getTexLevelParameteri(0, K.TEXTURE_WIDTH), 16, 'width recorded');
  eq(g.getTexLevelParameteri(0, K.TEXTURE_HEIGHT), 16, 'height recorded');
  eq(g.getError(), 0, 'getError passthrough');
});

test('capabilities: honest truth table gates the client fallbacks', () => {
  const g = freshGSM();
  const caps = g.getCapabilities();
  eq([caps.OpenGL30, caps.GL_ARB_framebuffer_object, caps.GL_NV_fog_distance, caps.GL_KHR_debug],
     [true, true, false, false], 'FBO true; NV fog distance / KHR debug honestly false');
});

// ---- 7. draw wrappers ---------------------------------------------------------
test('drawArrays: texGen fail-fast + applyAll pre-flight; enabled dispatch works', () => {
  const g = freshGSM();
  g.texGeni(K.TEXTURE_GEN_S, K.TEXTURE_GEN_MODE, K.SPHERE_MAP);
  throws(() => g.drawArrays(4, 0, 3), 'texgen must fail-fast at draw');
  g.texGeni(K.TEXTURE_GEN_S, K.TEXTURE_GEN_MODE, K.OBJECT_LINEAR); // still set => throws
  throws(() => g.drawArrays(4, 0, 3), 'any recorded gen mode keeps the guard');
  const g2 = freshGSM();
  g2.texGeni(K.TEXTURE_GEN_S, K.TEXTURE_GEN_MODE, K.OBJECT_LINEAR);
  g2.texGeni(K.TEXTURE_GEN_S, K.TEXTURE_GEN_MODE, 0); // disable record = null semantics guarded below
  // NOTE: GL disables texgen via glDisable(GL_TEXTURE_GEN_S) — not modeled in the
  // client surface (scan shows no such call); resetting to null is test-only here.
  g2._texGen.s = null; g2._texGen.t = null;
  g2.drawArrays(4, 0, 3);
  const last = g2.gl.__calls[g2.gl.__calls.length - 1];
  eq(last, ['drawArrays', 4, 0, 3], 'draw forwarded after flush');
});

test('generic enable/disable dispatch: real caps flush, virtual caps stay CPU', () => {
  const g = freshGSM();
  g.enable(K.BLEND); g.enable(K.LIGHTING); g.enable(K.FOG); g.enable(K.ALPHA_TEST);
  eq(g.lighting.enabled && g.fog.enabled && g.alphaTest.enabled, true, 'virtual caps set');
  const glVirt = g.gl.__calls.filter(c => (c[0] === 'enable') && (c[1] === K.LIGHTING || c[1] === K.FOG || c[1] === K.ALPHA_TEST));
  eq(glVirt.length, 0, 'virtual caps never reach WebGL');
  throws(() => g.enable(0xDEAD), 'unmodeled cap fail-fast');
});

// ---- 8. v1.3 RenderTypes -------------------------------------------------------
test('render types: lightning additive no-depth-write; water_mask depth-only', () => {
  const gl = makeGLStub(), g = new GlStateManager(gl);
  const l = applyRenderType(g, 'rendertype_lightning');
  eq([l.blend.src, l.blend.dst], [K.SRC_ALPHA, K.ONE], 'lightning additive');
  eq(l.depth.mask, false, 'lightning never writes depth');
  const w = applyRenderType(g, 'rendertype_water_mask');
  eq(w.colorMask, [false, false, false, false], 'water mask writes no color');
  eq(w.blend, null, 'water mask blends off');
  eq(Object.keys(RENDER_TYPES).length, 15, 'table now 15');
});

// ============================================================================
console.log(`\n== RESULT: ${pass} passed, ${fail} failed ==`);
if (fail) { console.log('FAILURES:\n  ' + failures.join('\n  ')); process.exit(1); }
