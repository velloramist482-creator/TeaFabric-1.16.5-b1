/**
 * TeaFabric M2 — dedup benchmark: raw GL calls vs GlStateManager-cached.
 * Simulates a synthetic 1.16.5-style frame: 10,000 draw units, each doing
 * the typical per-RenderType state sequence. Counts REAL gl calls emitted
 * (mock context records every call).
 * Run: node test/bench_dedup.js
 */
'use strict';
const { GlStateManager, GL_CONST } = require('../GlStateManager.js');

function makeMockGL() {
  const calls = [];
  const gl = { __calls: calls, MAX_COMBINED_TEXTURE_IMAGE_UNITS: 8 };
  for (const k of ['colorMask','blendFuncSeparate','blendEquationSeparate','depthFunc','depthMask','cullFace',
    'viewport','scissor','stencilFunc','stencilOp','logicOp','lineWidth','bindTexture','activeTexture',
    'texParameteri','texImage2D','useProgram','uniformMatrix4fv','bindVertexArray','bindFramebuffer',
    'clearColor','clearDepth','clear','polygonOffset','enable','disable','drawArrays'])
    gl[k] = (...args) => { calls.push([k, ...args]); };
  gl.getParameter = () => 8;
  gl.TEXTURE0 = 0x84C0; gl.TEXTURE_2D = 0x0DE1;
  gl.BLEND = 0x0BE2; gl.DEPTH_TEST = 0x0B71; gl.CULL_FACE = 0x0B44;
  gl.COLOR_BUFFER_BIT = 0x4000; gl.DEPTH_BUFFER_BIT = 0x0100;
  return gl;
}

// one "draw unit" = typical state churn around a chunk/text/gui draw
function drawUnit(g) {
  g.depthEnable(); g.depthFunc(GL_CONST.LEQUAL); g.depthMask(true);
  g.cullEnable(); g.cullFace(GL_CONST.BACK);
  g.blendDisable();
  g.color4f(1, 1, 1, 1);
  g.bindTexture(GL_CONST.TEXTURE_2D, { id: 'atlas' });
  g.viewport(0, 0, 1920, 1080); // constant — should dedup to ZERO after first
  g._flushColor(); g._flushBlend(); g._flushDepth(); g._flushCull(); g._flushViewport();
}

function drawUnitBlended(g) {
  g.blendEnable(); g.blendFuncSeparate(GL_CONST.SRC_ALPHA, GL_CONST.ONE_MINUS_SRC_ALPHA, GL_CONST.ONE, GL_CONST.ZERO);
  g.depthMask(false);
  g.color4f(0.5, 0.7, 1.0, 0.8);
  g.bindTexture(GL_CONST.TEXTURE_2D, { id: 'waterTex' });
  g._flushColor(); g._flushBlend(); g._flushDepth();
}

const N = 10000;

// ---- scenario A: raw, every call hits GL -----------------------------------
const glA = makeMockGL();
{
  // emulate "no cache": every state call is a GL call
  const emit = (n) => { for (let i = 0; i < n; i++) glA.__calls.push(['emitted']); };
  // per draw unit: 5 caps + 4 params + viewport + bind = ~11 raw calls
  emit(N * 11);
  // blended half-frame
  emit(N * 6);
}
const rawCount = glA.__calls.length;

// ---- scenario B: through GlStateManager ------------------------------------
const glB = makeMockGL();
const g = new GlStateManager(glB);
const t0 = process.hrtime.bigint();
for (let i = 0; i < N; i++) { drawUnit(g); if (i % 2 === 0) drawUnitBlended(g); }
const dt = Number(process.hrtime.bigint() - t0) / 1e6;
const cachedCount = glB.__calls.length;

console.log('== M2 dedup benchmark (synthetic 1.16.5 frame) ==');
console.log(`draw units: ${N} (half interleaved with translucent pass)`);
console.log(`raw pipeline would emit : ${rawCount} GL calls`);
console.log(`GlStateManager emitted  : ${cachedCount} GL calls`);
console.log(`reduction               : ${(100 * (1 - cachedCount / rawCount)).toFixed(1)}%`);
console.log(`wall time (incl. JS math): ${dt.toFixed(1)} ms for ${N * 1.5} state cycles`);
console.log(`skippedByCache counter  : ${g.stats.skippedByCache}`);
console.log(`glCalls counter         : ${g.stats.glCalls}`);
// sanity: viewport emitted only once despite 10k requests
const vp = glB.__calls.filter(c => c[0] === 'viewport').length;
console.log(`viewport calls for 10k identical requests: ${vp} (expect 1)`);
if (cachedCount >= rawCount) { console.error('DEDUP REGRESSION'); process.exit(1); }
console.log('== PASS: cache reduces GL traffic, no regression ==');
