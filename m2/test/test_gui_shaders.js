/**
 * TeaFabric M2 v1.1 — GUI/fixed-pipe fallback shader family contract tests.
 * Verifies: vertex-format attribute order, uniform/sampler contract, GUI-family
 * fog-free rule, converted ES 3.00 hygiene, and the new GUI RenderType presets.
 * Run: node test/test_gui_shaders.js
 */
'use strict';
const fs = require('fs');
const path = require('path');
const { GlStateManager, GL_CONST } = require(path.join(__dirname, '..', 'GlStateManager.js'));
const { RENDER_TYPES, applyRenderType } = require(path.join(__dirname, '..', 'RenderTypeStates.js'));

const MANIFEST = JSON.parse(fs.readFileSync(path.join(__dirname, '..', 'build', 'shaders', 'manifest.json'), 'utf8'));
const byName = {};
for (const p of MANIFEST.programs) byName[p.name] = p;
const progJson = {};
for (const n of Object.keys(byName)) progJson[n] = JSON.parse(fs.readFileSync(path.join(__dirname, '..', 'samples', 'program', n + '.json'), 'utf8'));

let pass = 0, fail = 0; const failures = [];
function test(name, fn) {
  try { fn(); pass++; console.log('  PASS ' + name); }
  catch (e) { fail++; failures.push(name + ' -> ' + e.message); console.log('  FAIL ' + name + ' :: ' + e.message); }
}
function eq(a, b, m) { if (JSON.stringify(a) !== JSON.stringify(b)) throw new Error(`${m}: got ${JSON.stringify(a)} want ${JSON.stringify(b)}`); }
function ok(cond, m) { if (!cond) throw new Error(m); }

console.log('== GUI/fixed-pipe fallback shader contract tests ==');

// ---- vertex-format contract (1.16.5 VertexFormats equivalents) ------------
const FORMAT_CONTRACT = {
  position:                    { attrs: ['Position'],                 samplers: [] },
  position_color:              { attrs: ['Position', 'Color'],        samplers: [] },
  position_tex:                { attrs: ['Position', 'UV0'],          samplers: ['Sampler0'] },
  position_tex_color:          { attrs: ['Position', 'UV0', 'Color'], samplers: ['Sampler0'] },
  position_tex_color_normal:   { attrs: ['Position', 'UV0', 'Color', 'Normal'], samplers: ['Sampler0'] },
  position_tex_lightmap_color: { attrs: ['Position', 'UV0', 'UV2', 'Color'], samplers: ['Sampler0', 'Sampler2'] },
};

test('manifest contains all 8 M2 programs', () => {
  eq(MANIFEST.programs.length, 8, 'program count');
  for (const n of Object.keys(FORMAT_CONTRACT)) ok(byName[n], 'missing program: ' + n);
});

for (const [name, c] of Object.entries(FORMAT_CONTRACT)) {
  test(`contract[${name}]: attribute order + samplers`, () => {
    eq(progJson[name].attributes, c.attrs, 'attributes');
    eq(progJson[name].samplers.map(s => s.name), c.samplers, 'samplers');
    eq(byName[name].attributes, c.attrs, 'manifest attributes');
    eq(byName[name].samplers, c.samplers, 'manifest samplers');
  });
}

test('MVP contract: every program declares ModelViewMat + ProjMat', () => {
  for (const n of Object.keys(byName)) {
    const u = byName[n].uniforms;
    ok(u.includes('ModelViewMat'), n + ' missing ModelViewMat');
    ok(u.includes('ProjMat'), n + ' missing ProjMat');
  }
});

test('GUI family is fog-free; world rendertype_solid keeps fog', () => {
  for (const n of ['position', 'position_color', 'position_tex', 'position_tex_color',
                   'position_tex_color_normal', 'position_tex_lightmap_color']) {
    const fog = byName[n].uniforms.filter(u => u.startsWith('Fog'));
    eq(fog, [], n + ' must be fog-free');
  }
  ok(byName['rendertype_solid'].uniforms.includes('FogStart'), 'rendertype_solid keeps FogStart');
});

test('color-multiply programs carry ColorModulator; position carries current-color Color', () => {
  for (const n of ['position_color', 'position_tex', 'position_tex_color',
                   'position_tex_color_normal', 'position_tex_lightmap_color']) {
    ok(byName[n].uniforms.includes('ColorModulator'), n + ' missing ColorModulator');
  }
  ok(byName['position'].uniforms.includes('Color'), 'position needs Color uniform');
  ok(!byName['position'].uniforms.includes('ColorModulator'), 'position must not have ColorModulator');
});

test('converted ES 3.00 hygiene: version line, no legacy tokens, no fixed-pipe builtins', () => {
  const legacy = [/attribute\s/, /varying\s/, /texture2D\s*\(/, /gl_FragColor/, /gl_TexCoord/, /gl_MultiTexCoord/, /gl_Vertex\b/, /#version 150/];
  for (const n of Object.keys(byName)) {
    for (const f of [byName[n].vertex, byName[n].fragment]) {
      const src = fs.readFileSync(path.join(__dirname, '..', 'build', 'shaders', f), 'utf8');
      ok(src.startsWith('#version 300 es'), f + ' must start with #version 300 es');
      for (const re of legacy) ok(!re.test(src), f + ' contains legacy token ' + re);
    }
  }
});

test('lightmap UV2 contract: fsh normalizes texel coords by 256-sheet (v1.0 rule)', () => {
  const fsh = fs.readFileSync(path.join(__dirname, '..', 'build', 'shaders', byName['position_tex_lightmap_color'].fragment), 'utf8');
  ok(/256\.0/.test(fsh), 'lightmap sample must divide uv2 by 256.0');
});

test('normal-shading term: vNormal normalized in vsh, headlight dot in fsh (own math)', () => {
  const vsh = fs.readFileSync(path.join(__dirname, '..', 'build', 'shaders', byName['position_tex_color_normal'].vertex), 'utf8');
  const fsh = fs.readFileSync(path.join(__dirname, '..', 'build', 'shaders', byName['position_tex_color_normal'].fragment), 'utf8');
  ok(/normalize/.test(vsh), 'vsh normalizes normal');
  ok(/dot\s*\(/.test(fsh), 'fsh uses dot() headlight lambert');
  ok(/lightmap/i.test(path.join(__dirname) + '') === false, 'sanity');
  ok(!/Fog/.test(fsh), 'normal variant is fog-free');
});

// ---- GUI RenderType presets ----------------------------------------------
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

test('gui_overlay: blend on, depth LEQUAL + no write', () => {
  const gl = makeMockGL(), g = new GlStateManager(gl);
  applyRenderType(g, 'gui');
  applyRenderType(g, 'gui_overlay');
  const bf = last(gl, 'blendFuncSeparate');
  eq([bf[1], bf[2]], [GL_CONST.SRC_ALPHA, GL_CONST.ONE_MINUS_SRC_ALPHA], 'overlay blend factors');
  eq(last(gl, 'depthMask')[1], false, 'overlay depthMask false');
  eq(last(gl, 'depthFunc')[1], GL_CONST.LEQUAL, 'overlay depth func');
});

test('gui_text_hover: depth ALWAYS, no write, blend on', () => {
  const gl = makeMockGL(), g = new GlStateManager(gl);
  applyRenderType(g, 'gui_text_hover');
  eq(last(gl, 'depthFunc')[1], GL_CONST.ALWAYS, 'hover depth func');
  eq(last(gl, 'depthMask')[1], false, 'hover depthMask false');
  eq(last(gl, 'blendFuncSeparate')[1], GL_CONST.SRC_ALPHA, 'hover blend on');
});

test('gui -> gui -> gui dedup: zero extra GL state calls after baseline', () => {
  const gl = makeMockGL(), g = new GlStateManager(gl);
  applyRenderType(g, 'gui');
  const n0 = gl.__calls.length;
  applyRenderType(g, 'gui');
  applyRenderType(g, 'gui');
  eq(gl.__calls.length - n0, 0, 'no state churn for repeated gui');
});

test('gui -> gui_overlay -> gui: exactly 1 blend enable + 1 blend disable extra', () => {
  const gl = makeMockGL(), g = new GlStateManager(gl);
  applyRenderType(g, 'gui');
  const en0 = gl.__calls.filter(c => c[0] === 'enable' && c[1] === gl.BLEND).length;
  const dis0 = gl.__calls.filter(c => c[0] === 'disable' && c[1] === gl.BLEND).length;
  applyRenderType(g, 'gui_overlay');
  eq(gl.__calls.filter(c => c[0] === 'enable' && c[1] === gl.BLEND).length - en0, 1, 'one enable');
  applyRenderType(g, 'gui');
  eq(gl.__calls.filter(c => c[0] === 'disable' && c[1] === gl.BLEND).length - dis0, 1, 'one disable');
});

test('unknown GUI preset fails fast', () => {
  const gl = makeMockGL(), g = new GlStateManager(gl);
  let threw = false;
  try { applyRenderType(g, 'gui_tooltip_shadow'); } catch (e) { threw = true; }
  ok(threw, 'must throw on unknown preset');
});

test('GUI bring-up ortho: GL_PROJECTION ortho flips Y so v=0 is screen top (MC GUI convention)', () => {
  const gl = makeMockGL(), g = new GlStateManager(gl);
  g.matrixMode(GL_CONST.PROJECTION);
  g.loadIdentity();
  g.ortho(0, 1920, 1080, 0, -1, 1); // MC GUI: top-left origin, Y down
  const m = g.getMatrix(GL_CONST.PROJECTION).m;
  // ortho(t=0,b=1080) => m[5] = 2/(t-b) is negative when b>t (Y-down) => [5] < 0
  ok(m[5] < 0, 'Y-down ortho => m[5] negative, got ' + m[5]);
  ok(m[0] > 0, 'X scale positive');
});

console.log(`\n== RESULT: ${pass} passed, ${fail} failed ==`);
if (fail) { console.log(failures.map(f => '  ! ' + f).join('\n')); process.exit(1); }
