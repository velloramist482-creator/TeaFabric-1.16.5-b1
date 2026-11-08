/**
 * TeaFabric M2 — converter output assertions (Node).
 * Run: node test/test_converter.js   (after running tools/convert_core_shaders.js)
 */
'use strict';
const fs = require('fs');
const path = require('path');
const { convertGLSL, inlineImports, ConvertError } = require('../tools/convert_core_shaders.js');

const OUT = path.join(__dirname, '..', 'build', 'shaders');
let pass = 0, fail = 0;
const failures = [];
function test(name, fn) {
  try { fn(); pass++; console.log('  PASS ' + name); }
  catch (e) { fail++; failures.push(name + ' -> ' + e.message); console.log('  FAIL ' + name + ' :: ' + e.message); }
}
function eq(a, b, msg) { if (JSON.stringify(a) !== JSON.stringify(b)) throw new Error(`${msg}: got ${JSON.stringify(a)} want ${JSON.stringify(b)}`); }

console.log('== Converter assertion tests ==');

const programs = JSON.parse(fs.readFileSync(path.join(OUT, 'manifest.json'), 'utf8')).programs;
eq(programs.length, 8, '8 programs in manifest (3 world/text + 5 GUI/fixed-pipe v1.1)');

for (const p of programs) {
  const vs = fs.readFileSync(path.join(OUT, p.vertex), 'utf8');
  const fsr = fs.readFileSync(path.join(OUT, p.fragment), 'utf8');
  const label = p.name;

  test(`[${label}] vertex: starts with #version 300 es`, () => {
    if (!/^#version 300 es/.test(vs)) throw new Error('missing/bad version line: ' + vs.split('\n')[0]);
  });
  test(`[${label}] fragment: starts with #version 300 es`, () => {
    if (!/^#version 300 es/.test(fsr)) throw new Error('missing/bad version line: ' + fsr.split('\n')[0]);
  });
  test(`[${label}] no legacy tokens (attribute/varying/texture2D/gl_FragColor)`, () => {
    const bad = [/^(\s*)attribute\s/m, /^(\s*)varying\s/m, /\btexture2D\b/, /\bgl_FragColor\b/];
    bad.forEach((re, i) => { if (re.test(vs) || re.test(fsr)) throw new Error('residue #' + i); });
  });
  test(`[${label}] #moj_import fully inlined`, () => {
    if (/#moj_import/.test(vs) || /#moj_import/.test(fsr)) throw new Error('unexpanded #moj_import remains');
  });
  test(`[${label}] fragment has explicit precision`, () => {
    if (!/^precision highp float;/m.test(fsr)) throw new Error('no precision in fragment');
  });
  test(`[${label}] fragment out declared before first use`, () => {
    const decl = fsr.indexOf('out vec4 m2_fragColor');
    if (decl < 0) throw new Error('no named out declared');
    const use = fsr.indexOf('m2_fragColor', decl + 20);
    if (use < 0) throw new Error('out never used (suspicious)');
  });
  test(`[${label}] manifest attributes contain NO varying names`, () => {
    const varyingNames = [...fsr.matchAll(/^in\s+(\w+)\s*;/gm)].map(m => m[1]);
    const leaked = p.attributes.filter(a => varyingNames.includes(a) && !/^(Position|Color|UV0|UV1|UV2|Normal)$/.test(a));
    eq(leaked, [], 'no leaked varyings');
  });
  test(`[${label}] gl_Position present in vertex`, () => {
    if (!/gl_Position\s*=/.test(vs)) throw new Error('vertex does not write gl_Position');
  });
}

// ---- fail-fast unit checks on the transformer itself ------------------------
const shims = path.join(__dirname, '..', 'tools', 'inline_shims');
test('fixed-pipe builtin triggers ConvertError (fail fast)', () => {
  try {
    convertGLSL('void main(){ gl_TexCoord[0] = vec4(0); }\n', { isVertex: true, name: 'bad.vsh', searchDirs: [shims] });
    throw new Error('should have thrown');
  } catch (e) {
    if (!(e instanceof ConvertError)) throw new Error('wrong error type: ' + e.message);
    if (!/gl_TexCoord/.test(e.message)) throw new Error('error does not name the builtin');
  }
});
test('duplicate #moj_import is inlined once (include-guard semantics)', () => {
  const src = '#version 150\n#moj_import <fog.glsl>\n#moj_import <fog.glsl>\nvoid main(){}\n';
  const out = inlineImports(src, [shims], 'dup.vsh');
  const begins = out.match(/begin inline <fog\.glsl>/g).length;
  const expands = out.split('minecraft_apply_fog(').length - 1;
  const skips = out.match(/skip duplicate import <fog\.glsl>/g).length;
  eq(begins, 1, 'one expansion block');
  eq(expands, 1, 'function body expanded exactly once');
  eq(skips, 1, 'second import becomes skip comment');
});
test('missing import target -> ConvertError with path', () => {
  try {
    inlineImports('#moj_import <nope.glsl>\n', [shims], 'x.vsh');
    throw new Error('should have thrown');
  } catch (e) {
    if (!(e instanceof ConvertError)) throw new Error('wrong error type');
    if (!/nope\.glsl/.test(e.message)) throw new Error('missing path in message');
  }
});
test('texture2DLod / texture2DProj family mapped', () => {
  const src = '#version 150\nuniform sampler2D S;\nvoid main(){ vec4 a=texture2DLod(S,vec2(0),0.0); vec4 b=texture2DProj(S,vec4(1.0)); }\n';
  const out = convertGLSL(src, { isVertex: false, name: 't.fsh', searchDirs: [shims] });
  if (/\btexture2DLod\b|\btexture2DProj\b|\btexture2D\b/.test(out)) throw new Error('family not fully renamed');
  if (!/\btextureLod\(/.test(out) || !/\btextureProj\(/.test(out)) throw new Error('textureLod/Proj missing');
});

console.log(`\n== RESULT: ${pass} passed, ${fail} failed ==`);
if (failures.length) { console.log('Failures:'); failures.forEach(f => console.log(' - ' + f)); process.exit(1); }
