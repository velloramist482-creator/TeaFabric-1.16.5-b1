/**
 * TeaFabric M2 — RenderType state-table tests.
 * Run: node test/test_rendertype.js
 */
'use strict';
const path = require('path');
const { GlStateManager, GL_CONST } = require(path.join(__dirname, '..', 'GlStateManager.js'));
const { RENDER_TYPES, applyRenderType } = require(path.join(__dirname, '..', 'RenderTypeStates.js'));

function makeMockGL() {
  const calls = [];
  const gl = { __calls: calls, MAX_COMBINED_TEXTURE_IMAGE_UNITS: 8 };
  for (const k of ['colorMask','blendFuncSeparate','blendEquationSeparate','depthFunc','depthMask','cullFace',
    'viewport','scissor','stencilFunc','stencilOp','logicOp','lineWidth','bindTexture','activeTexture',
    'texParameteri','texImage2D','useProgram','uniformMatrix4fv','bindVertexArray','bindFramebuffer',
    'clearColor','clearDepth','clear','polygonOffset','enable','disable','drawArrays'])
    gl[k] = (...a) => calls.push([k, ...a]);
  gl.getParameter = () => 8;
  gl.BLEND = 0x0BE2; gl.DEPTH_TEST = 0x0B71; gl.CULL_FACE = 0x0B44; gl.POLYGON_OFFSET_FILL = 0x8037;
  return gl;
}
const last = (gl, name) => { const c = gl.__calls.filter(x => x[0] === name); return c[c.length - 1] || null; };

let pass = 0, fail = 0; const failures = [];
function test(name, fn) {
  try { fn(); pass++; console.log('  PASS ' + name); }
  catch (e) { fail++; failures.push(name + ' -> ' + e.message); console.log('  FAIL ' + name + ' :: ' + e.message); }
}
function eq(a, b, m) { if (JSON.stringify(a) !== JSON.stringify(b)) throw new Error(`${m}: got ${JSON.stringify(a)} want ${JSON.stringify(b)}`); }

console.log('== RenderType state-table tests ==');

test('table has 15 render types incl. gui family + v1.3 lightning/water_mask', () => {
  eq(Object.keys(RENDER_TYPES).length, 15, 'count');
});

test('solid: no blend, depth LEQUAL+mask, cull back', () => {
  const gl = makeMockGL(), g = new GlStateManager(gl);
  applyRenderType(g, 'rendertype_solid');
  eq(last(gl, 'enable') === null || gl.__calls.filter(c => c[0]==='enable' && c[1]===gl.BLEND).length, 0, 'blend stays off');
  eq(last(gl, 'depthFunc')[1], GL_CONST.LEQUAL, 'depth func');
  eq(last(gl, 'depthMask')[1], true, 'depth mask true');
  eq(last(gl, 'cullFace')[1], GL_CONST.BACK, 'cull back');
});

test('solid->translucent->solid: blend and depthMask flip back correctly', () => {
  const gl = makeMockGL(), g = new GlStateManager(gl);
  applyRenderType(g, 'rendertype_solid');          // first flush: baseline sync
  const baseline = gl.__calls.filter(c => c[0] === 'disable' && c[1] === gl.BLEND).length;
  applyRenderType(g, 'rendertype_translucent');
  eq(last(gl, 'depthMask')[1], false, 'translucent depthMask false');
  const bf = last(gl, 'blendFuncSeparate');
  eq([bf[1], bf[2]], [GL_CONST.SRC_ALPHA, GL_CONST.ONE_MINUS_SRC_ALPHA], 'translucent blend factors');
  eq(gl.__calls.filter(c => c[0] === 'enable' && c[1] === gl.BLEND).length, 1, 'blend enabled once');
  applyRenderType(g, 'rendertype_solid');
  eq(last(gl, 'depthMask')[1], true, 'back to solid: depthMask true');
  eq(gl.__calls.filter(c => c[0] === 'disable' && c[1] === gl.BLEND).length - baseline, 1, 'one extra disable on flip-back');
});

test('text_see_through: depth ALWAYS', () => {
  const gl = makeMockGL(), g = new GlStateManager(gl);
  applyRenderType(g, 'rendertype_text_see_through');
  eq(last(gl, 'depthFunc')[1], GL_CONST.ALWAYS, 'func ALWAYS');
});

test('lines: polygonOffset(-1,-1) enabled', () => {
  const gl = makeMockGL(), g = new GlStateManager(gl);
  applyRenderType(g, 'rendertype_lines');
  eq(last(gl, 'polygonOffset')[1], -1, 'factor -1');
  eq(last(gl, 'polygonOffset')[2], -1, 'units -1');
  eq(gl.__calls.some(c => c[0] === 'enable' && c[1] === gl.POLYGON_OFFSET_FILL), true, 'polfill enabled');
});

test('unknown render type throws', () => {
  const gl = makeMockGL(), g = new GlStateManager(gl);
  let threw = false;
  try { applyRenderType(g, 'rendertype_magic'); } catch (e) { threw = /unknown render type/.test(e.message); }
  eq(threw, true, 'throws with message');
});

test('full frame chain solid->cutout->text->translucent emits bounded GL calls', () => {
  const gl = makeMockGL(), g = new GlStateManager(gl);
  applyRenderType(g, 'rendertype_solid');
  applyRenderType(g, 'rendertype_cutout');   // identical to solid except shader: expect ~0 state calls
  const n = gl.__calls.length;
  applyRenderType(g, 'rendertype_text');
  applyRenderType(g, 'rendertype_translucent');
  const perSwitch = (gl.__calls.length - n) / 2;
  if (perSwitch > 20) throw new Error('too many calls per switch: ' + perSwitch);
  console.log(`      [info] avg GL calls per rendertype switch: ${perSwitch}`);
});

console.log(`\n== RESULT: ${pass} passed, ${fail} failed ==`);
if (failures.length) { failures.forEach(f => console.log(' - ' + f)); process.exit(1); }
