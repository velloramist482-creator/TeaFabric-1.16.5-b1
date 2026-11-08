#!/usr/bin/env node
/**
 * TeaFabric M2 — REAL WebGL2 compile/link verification.
 * Uses the agent-browser headless Chromium: creates a WebGL2 context,
 * compiles every converted shader pair from build/shaders, links each
 * program, and reports compile/link status + driver logs.
 * Run: node test/compile_webgl2.js
 */
'use strict';
const fs = require('fs');
const path = require('path');
const { execSync } = require('child_process');

const OUT = path.join(__dirname, '..', 'build', 'shaders');
const manifest = JSON.parse(fs.readFileSync(path.join(OUT, 'manifest.json'), 'utf8'));

// package the shader sources into one JSON payload
const payload = manifest.programs.map(p => ({
  name: p.name,
  vs: fs.readFileSync(path.join(OUT, p.vertex), 'utf8'),
  fs: fs.readFileSync(path.join(OUT, p.fragment), 'utf8'),
}));

const browserCode = `
(async () => {
  const programs = ${JSON.stringify(JSON.stringify(payload))};
  const list = JSON.parse(programs);
  const canvas = document.createElement('canvas');
  canvas.width = 8; canvas.height = 8;
  const gl = canvas.getContext('webgl2', { antialias: false });
  if (!gl) return JSON.stringify({ fatal: 'webgl2 unavailable in this browser' });
  const results = [];
  for (const p of list) {
    const r = { name: p.name, vsOk: false, fsOk: false, linkOk: false, log: [] };
    let prog = null;
    try {
      const mk = (type, src) => {
        const sh = gl.createShader(type);
        gl.shaderSource(sh, src); gl.compileShader(sh);
        const ok = gl.getShaderParameter(sh, gl.COMPILE_STATUS);
        const log = gl.getShaderInfoLog(sh) || '';
        return { ok, log };
      };
      const a = mk(gl.VERTEX_SHADER, p.vs);
      r.vsOk = a.ok; if (a.log.trim()) r.log.push('VS: ' + a.log.trim());
      const b = mk(gl.FRAGMENT_SHADER, p.fs);
      r.fsOk = b.ok; if (b.log.trim()) r.log.push('FS: ' + b.log.trim());
      if (a.ok && b.ok) {
        prog = gl.createProgram();
        // recompile + attach properly
        const vs2 = gl.createShader(gl.VERTEX_SHADER); gl.shaderSource(vs2, p.vs); gl.compileShader(vs2);
        const fs2 = gl.createShader(gl.FRAGMENT_SHADER); gl.shaderSource(fs2, p.fs); gl.compileShader(fs2);
        gl.attachShader(prog, vs2); gl.attachShader(prog, fs2); gl.linkProgram(prog);
        r.linkOk = !!gl.getProgramParameter(prog, gl.LINK_STATUS);
        const llog = gl.getProgramInfoLog(prog) || '';
        if (llog.trim()) r.log.push('LINK: ' + llog.trim());
        if (r.linkOk) {
          // bonus: count active uniforms/attribs as proof of real linkage
          r.activeUniforms = gl.getProgramParameter(prog, gl.ACTIVE_UNIFORMS);
          r.activeAttribs = gl.getProgramParameter(prog, gl.ACTIVE_ATTRIBUTES);
        }
      }
    } catch (e) { r.log.push('EXC: ' + e.message); }
    results.push(r);
  }
  return JSON.stringify({ webglVersion: gl.getParameter(gl.VERSION), glsl: gl.getParameter(gl.SHADING_LANGUAGE_VERSION), results });
})()
`;

const out = execSync(`agent-browser eval ${JSON.stringify(browserCode)}`, { encoding: 'utf8', maxBuffer: 32 * 1024 * 1024 });
// agent-browser prints a ✓ line then the JSON string
const jsonLine = out.split('\n').find(l => l.trim().startsWith('{'));
if (!jsonLine) { console.error('Unexpected agent-browser output:\n' + out); process.exit(1); }
const report = JSON.parse(JSON.parse(jsonLine));

console.log('== WebGL2 REAL compile/link verification ==');
console.log(`GL: ${report.webglVersion} | GLSL: ${report.glsl}`);
let allOk = true;
for (const r of report.results) {
  const ok = r.vsOk && r.fsOk && r.linkOk;
  allOk &&= ok;
  console.log(`${ok ? 'PASS' : 'FAIL'} ${r.name}: vs=${r.vsOk} fs=${r.fsOk} link=${r.linkOk}` +
    (r.activeUniforms !== undefined ? ` activeUniforms=${r.activeUniforms} activeAttribs=${r.activeAttribs}` : '') +
    (r.log.length ? '\n      ' + r.log.join('\n      ') : ''));
}
console.log(`\n== RESULT: ${allOk ? 'ALL PROGRAMS COMPILE AND LINK IN REAL WEBGL2' : 'FAILURES PRESENT'}`);
process.exit(allOk ? 0 : 1);
