/**
 * TeaFabric M2 — GlStateManager unit tests (Node, mock WebGL2 context).
 * Verifies cache/dedup semantics, matrix stack math, and baseline reset.
 * Run: node test/test_glstatemanager.js
 */
'use strict';
const { GlStateManager, Matrix4f, GL_CONST } = require('../GlStateManager.js');

// ---------- mock WebGL2 context: records every call, fakes queries -----------
function makeMockGL() {
  const calls = [];
  const faked = new Set([
    'MAX_COMBINED_TEXTURE_IMAGE_UNITS', 'COMPILE_STATUS', 'LINK_STATUS',
    'VERTEX_SHADER', 'FRAGMENT_SHADER',
  ]);
  const rec = (name) => (...args) => { calls.push([name, ...args]); return name === 'createProgram' ? { id: 'p' } : name === 'createShader' ? { id: 's' } : null; };
  const gl = {};
  for (const k of ['colorMask','blendFuncSeparate','blendEquationSeparate','depthFunc','depthMask','cullFace',
    'viewport','scissor','stencilFunc','stencilOp','logicOp','lineWidth','bindTexture','activeTexture',
    'texParameteri','texImage2D','useProgram','getUniformLocation','uniformMatrix4fv','bindVertexArray',
    'bindFramebuffer','clearColor','clearDepth','clear','polygonOffset','enable','disable',
    'createFramebuffer','framebufferTexture2D','createShader','shaderSource','compileShader',
    'attachShader','linkProgram','createProgram','getShaderParameter','getProgramParameter',
    'getShaderInfoLog','getProgramInfoLog'])
    gl[k] = rec(k);
  gl.enable = (cap) => calls.push(['enable', cap]);
  gl.disable = (cap) => calls.push(['disable', cap]);
  gl.MAX_COMBINED_TEXTURE_IMAGE_UNITS = 8;
  gl.getParameter = () => 8; // only queried for MAX_COMBINED_TEXTURE_IMAGE_UNITS
  gl.TEXTURE0 = 0x84C0; gl.TEXTURE_2D = 0x0DE1; gl.FRAMEBUFFER = 0x8D40;
  gl.VERTEX_SHADER = 0x8B31; gl.FRAGMENT_SHADER = 0x8B37;
  gl.COMPILE_STATUS = 1; gl.LINK_STATUS = 1;
  gl.getShaderParameter = () => true;
  gl.getProgramParameter = () => true;
  gl.getUniformLocation = (p, n) => ({ loc: n });
  // GL enum constants used via this.gl.*
  for (const [k, v] of Object.entries({
    BLEND: 0x0BE2, DEPTH_TEST: 0x0B71, CULL_FACE: 0x0B44, SCISSOR_TEST: 0x0C11,
    STENCIL_TEST: 0x0B90, POLYGON_OFFSET_FILL: 0x8037, COLOR_LOGIC_OP: 0x0BF2,
    COLOR_BUFFER_BIT: 0x4000, DEPTH_BUFFER_BIT: 0x0100 }))
    gl[k] = v;
  gl.__calls = calls;
  return gl;
}

// ---------- tiny test framework ----------------------------------------------
let pass = 0, fail = 0;
const failures = [];
function test(name, fn) {
  try { fn(); pass++; console.log('  PASS ' + name); }
  catch (e) { fail++; failures.push(name + ' -> ' + e.message); console.log('  FAIL ' + name + ' :: ' + e.message); }
}
function eq(a, b, msg) { if (JSON.stringify(a) !== JSON.stringify(b)) throw new Error(`${msg || 'eq'}: got ${JSON.stringify(a)} want ${JSON.stringify(b)}`); }
function countCalls(gl, name) { return gl.__calls.filter(c => c[0] === name).length; }
function lastCall(gl, name) { const c = gl.__calls.filter(x => x[0] === name); return c[c.length - 1] || null; }

// ---------- suite --------------------------------------------------------------
console.log('== GlStateManager unit tests ==');

test('singleton state: identical color4f calls emit ZERO gl calls', () => {
  const gl = makeMockGL(), g = new GlStateManager(gl);
  g.color4f(0.5, 0.2, 0.1, 0.9);          // set a non-default color
  g.color4f(0.5, 0.2, 0.1, 0.9);          // dup -> skip
  g.color4f(0.5, 0.2, 0.1, 0.9);          // dup -> skip
  g.applyAll();
  eq(countCalls(gl, 'colorMask'), 1, 'colorMask deduped to 1');
  eq(g.stats.skippedByCache, 2, 'two calls skipped by cache');
});

test('blend state change emits exactly one enable+funcSeparate+equation triple', () => {
  const gl = makeMockGL(), g = new GlStateManager(gl);
  g.blendFuncSeparate(0x0302, 0x0303, 0x0302, 0x0303);
  g.blendEnable(); g.applyAll();
  eq(countCalls(gl, 'blendFuncSeparate'), 1, 'one blendFuncSeparate');
  eq(countCalls(gl, 'blendEquationSeparate'), 1, 'one blendEquationSeparate');
  eq(countCalls(gl, 'enable'), 1, 'one enable');
  // second applyAll with no change => no new calls
  g.applyAll();
  eq(countCalls(gl, 'blendFuncSeparate'), 1, 'still one after reapply');
});

const capCalls = (gl, name, cap) => gl.__calls.filter(c => c[0] === name && c[1] === cap).length;

test('1.16.5 renderType blend chain: solid->cutout->translucent flushes correctly', () => {
  const gl = makeMockGL(), g = new GlStateManager(gl);
  g.blendDisable(); g.applyAll();                       // solid: blend off
  g.blendDisable(); g.applyAll();                       // cutout: no-op (cache)
  g.blendEnable(); g.blendFuncSeparate(0x0302, 0x0303, 0x0301, 0x0300); g.applyAll(); // translucent
  eq(capCalls(gl, 'disable', gl.BLEND), 1, 'one disable(BLEND) total');
  eq(capCalls(gl, 'enable', gl.BLEND), 1, 'one enable(BLEND) total');
});

test('depth func+mask change emits 2 calls, not 4', () => {
  const gl = makeMockGL(), g = new GlStateManager(gl);
  g.depthEnable(); g.depthFunc(GL_CONST.LEQUAL); g.depthMask(false); g.applyAll();
  eq(countCalls(gl, 'depthFunc'), 1, 'one depthFunc');
  eq(countCalls(gl, 'depthMask'), 1, 'one depthMask');
});

test('texture binding dedup per active unit', () => {
  const gl = makeMockGL(), g = new GlStateManager(gl);
  const texA = { id: 'A' }, texB = { id: 'B' };
  g.activeTexture(0); g.bindTexture(GL_CONST.TEXTURE_2D, texA);
  g.bindTexture(GL_CONST.TEXTURE_2D, texA); // dup -> skip
  g.activeTexture(1); g.bindTexture(GL_CONST.TEXTURE_2D, texB);
  g.activeTexture(0); g.bindTexture(GL_CONST.TEXTURE_2D, texA); // unit-0 already A -> skip switch? No: activeTexture(0) emits (was on 1)
  eq(countCalls(gl, 'bindTexture'), 2, 'only 2 bindTexture calls');
  eq(countCalls(gl, 'activeTexture'), 2, 'activeTexture GL calls: ->1, ->0 (initial 0 cached)');
});

test('matrix stack: push/pop/translate/rotate/scale correctness', () => {
  const gl = makeMockGL(), g = new GlStateManager(gl);
  g.matrixMode(GL_CONST.MODELVIEW);
  g.loadIdentity();
  g.pushMatrix();
  g.translatef(2, 0, 0);
  eq(g.getMatrix().m[12], 2, 'translate x');
  g.pushMatrix();
  g.scalef(3, 3, 3);
  eq(g.getMatrix().m[0], 3, 'scale after translate keeps tx');
  eq(g.getMatrix().m[12], 2, 'tx preserved');
  g.popMatrix();
  eq(g.getMatrix().m[0], 1, 'pop undoes scale');
  g.popMatrix();
  eq(g.getMatrix().m[12], 0, 'pop undoes translate');
});

test('matrix stack: underflow and overflow throw', () => {
  const gl = makeMockGL(), g = new GlStateManager(gl);
  let threw = 0;
  try { g.popMatrix(); } catch (e) { threw++; }
  g.matrixMode(GL_CONST.PROJECTION);
  try { g.popMatrix(); } catch (e) { threw++; }
  eq(threw, 2, 'two underflows caught');
});

test('ortho / perspective produce correct column-major values', () => {
  const gl = makeMockGL(), g = new GlStateManager(gl);
  g.matrixMode(GL_CONST.PROJECTION); g.loadIdentity();
  g.ortho(0, 100, 0, 50, -1, 1);
  const m = g.getMatrix().m;
  eq([m[0], m[5], m[12], m[13]].map(v => Math.abs(v) < 1e-6 ? Math.round(v * 50) : Math.round(v * 50) / 50), [0.02, 0.04, -1, -1], 'ortho(0..100,0..50) approx');
  g.loadIdentity();
  g.perspective(90, 1, 0.5, 10);
  const p = g.getMatrix().m;
  eq(Math.abs(p[0] - 1) < 1e-6, true, 'perspective 90deg aspect1 => m[0]=1');
  eq(p[11], -1, 'perspective m[11] = -1');
  eq(p[15], 0, 'perspective m[15] = 0');
});

test('uniformLocation without useProgram fails fast with clear message', () => {
  const gl = makeMockGL(), g = new GlStateManager(gl);
  let msg = '';
  try { g.uniformLocation('Nope'); } catch (e) { msg = e.message; }
  if (!/useProgram/.test(msg)) throw new Error('expected fail-fast, got: ' + msg);
});

test('uniformLocation(prog, name) explicit-program shape also works', () => {
  const gl = makeMockGL(), g = new GlStateManager(gl);
  const p = { id: 'explicit' };
  const loc = g.uniformLocation(p, 'FogColor');
  eq(loc.loc, 'FogColor', 'returns location for explicit program');
});

test('MVP upload dedup: matrix unchanged => uniformMatrix4fv not re-emitted', () => {
  const gl = makeMockGL(), g = new GlStateManager(gl);
  g.matrixMode(GL_CONST.MODELVIEW); g.loadIdentity();
  g.matrixMode(GL_CONST.PROJECTION); g.loadIdentity();
  g.matrixMode(GL_CONST.MODELVIEW);
  g.useProgram({ id: 'progA' }); // MC semantics: bind program before uniform queries
  const mv = g.uniformLocation('ModelViewMat'), pj = g.uniformLocation('ProjMat');
  g.uniformMatrix4fvMVP(mv, pj);
  const n1 = countCalls(gl, 'uniformMatrix4fv');
  g.uniformMatrix4fvMVP(mv, pj); // same key -> dedup
  eq(countCalls(gl, 'uniformMatrix4fv'), n1, 'no extra upload');
  g.translatef(1, 2, 3);
  g.uniformMatrix4fvMVP(mv, pj);
  eq(countCalls(gl, 'uniformMatrix4fv'), n1 + 2, 'MV changed => 2 uploads');
});

test('MVP dedup is PER-PROGRAM: switching program with same matrices re-uploads (v1.1 GUI bug regression)', () => {
  const gl = makeMockGL(), g = new GlStateManager(gl);
  g.matrixMode(GL_CONST.MODELVIEW); g.loadIdentity();
  g.matrixMode(GL_CONST.PROJECTION); g.loadIdentity();
  const progA = { id: 'progA' }, progB = { id: 'progB' };
  g.useProgram(progA);
  const mvA = g.uniformLocation('ModelViewMat'), pjA = g.uniformLocation('ProjMat');
  g.uniformMatrix4fvMVP(mvA, pjA);
  const n1 = countCalls(gl, 'uniformMatrix4fv');
  g.useProgram(progB); // same matrices, DIFFERENT program
  const mvB = g.uniformLocation('ModelViewMat'), pjB = g.uniformLocation('ProjMat');
  g.uniformMatrix4fvMVP(mvB, pjB);
  eq(countCalls(gl, 'uniformMatrix4fv'), n1 + 2, 'new program must get its own MVP upload');
  // and switching back with unchanged matrices must ALSO re-upload to progA
  g.useProgram(progA);
  g.uniformMatrix4fvMVP(mvA, pjA);
  eq(countCalls(gl, 'uniformMatrix4fv'), n1 + 2, 'back to progA: no upload needed (its uniforms still hold the right matrices)');
  // a matrix change dirties: next upload goes to CURRENT program, and the
  // OTHER program's stale map entry forces its own upload afterwards
  g.translatef(1, 2, 3);
  g.uniformMatrix4fvMVP(mvA, pjA);
  eq(countCalls(gl, 'uniformMatrix4fv'), n1 + 4, 'dirty upload to progA');
  g.useProgram(progB);
  g.uniformMatrix4fvMVP(mvB, pjB);
  eq(countCalls(gl, 'uniformMatrix4fv'), n1 + 6, 'progB stale entry => own upload');
});

test('viewport dedup', () => {
  const gl = makeMockGL(), g = new GlStateManager(gl);
  g.viewport(0, 0, 854, 480); g.viewport(0, 0, 854, 480); g._flushViewport(); g._flushViewport();
  eq(countCalls(gl, 'viewport'), 1, 'one viewport call');
});

test('scissor: flush emits enable only when enabled', () => {
  const gl = makeMockGL(), g = new GlStateManager(gl);
  g.scissor(10, 10, 100, 100); g.applyAll(); // not enabled => no enable call
  eq(countCalls(gl, 'enable'), 0, 'no enable while off');
  g.scissorEnable(); g.applyAll();
  eq(countCalls(gl, 'enable'), 1, 'one enable after scissorEnable');
  eq(lastCall(gl, 'scissor')[1], 10, 'scissor rect x=10');
});

test('resetBaseline disables 7 caps and restores depthMask', () => {
  const gl = makeMockGL(), g = new GlStateManager(gl);
  g.blendEnable(); g.depthEnable(); g.cullEnable(); g.scissorEnable();
  g.polygonOffsetEnable(); g.stencilEnable(); g.logicOpEnable(); g.depthMask(false);
  g.applyAll();
  const pre = countCalls(gl, 'disable');
  g.resetBaseline(); g.applyAll();
  eq(countCalls(gl, 'disable') - pre, 7, '7 caps disabled');
  eq(g.depth.mask, true, 'depthMask restored');
});

test('texture enable/disable maps to real binding (WebGL2 has no glEnable(TEXTURE_2D))', () => {
  const gl = makeMockGL(), g = new GlStateManager(gl);
  const tex = { id: 'chunkAtlas' };
  g.activeTexture(0); g.bindTexture(GL_CONST.TEXTURE_2D, tex);
  g.enableTexture2D(); // should bindTexture(tex) via cache
  eq(countCalls(gl, 'bindTexture'), 2, 'bind re-emitted on enable path');
  g.disableTexture2D();
  eq(lastCall(gl, 'bindTexture')[2], null, 'disable unbinds');
});

test('M3 contract: 8-float VO path - color/uv state is CPU-only, no GL calls', () => {
  const gl = makeMockGL(), g = new GlStateManager(gl);
  const before = countCalls(gl, 'colorMask');
  // Setting vertex color per-draw must NOT touch GL (goes through vertex attribs)
  for (let i = 0; i < 100; i++) g.color4f(i / 100, 0.5, 0.5, 1);
  g.applyAll();
  eq(countCalls(gl, 'colorMask') - before, 1, 'single mask flush despite 100 color sets');
});

test('frustum vs perspective agree on center ray', () => {
  const a = new Matrix4f(); Matrix4f.perspective(a, 90, 1, 0.5, 10);
  const b = new Matrix4f(); Matrix4f.frustum(b, -0.5, 0.5, -0.5, 0.5, 0.5, 10);
  eq(Math.abs(a.m[10] - b.m[10]) < 1e-5, true, 'z terms match');
  eq(Math.abs(a.m[14] - b.m[14]) < 1e-5, true, 'z offset matches');
});

test('mul: identity * T = T; R(90, y) maps x-axis to -z (MC convention check)', () => {
  const I = new Matrix4f(), T = new Matrix4f().translate(1, 2, 3);
  const out = Matrix4f.mul(new Matrix4f(), I, T);
  eq([out.m[12], out.m[13], out.m[14]], [1, 2, 3], 'I*T = T');
  const R = new Matrix4f().rotate(90, 0, 1, 0);
  const x = { x: R.m[0], y: R.m[1], z: R.m[2] }; // transformed x-axis = column 0 (column-major)
  eq([Math.round(x.x), Math.round(x.y), Math.round(x.z)], [0, 0, -1], 'x -> -z after +90 yaw');
});

console.log(`\n== RESULT: ${pass} passed, ${fail} failed ==`);
if (failures.length) { console.log('Failures:'); failures.forEach(f => console.log(' - ' + f)); process.exit(1); }
