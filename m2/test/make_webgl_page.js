#!/usr/bin/env node
/**
 * TeaFabric M2 — REAL WebGL2 compile/link verification (file:// HTML runner).
 * Generates a test page that compiles every converted shader pair in the
 * headless browser's WebGL2 context, then reads back JSON results.
 * Run: node test/compile_webgl2.js
 */
'use strict';
const fs = require('fs');
const path = require('path');

const OUT = path.join(__dirname, '..', 'build', 'shaders');
const manifest = JSON.parse(fs.readFileSync(path.join(OUT, 'manifest.json'), 'utf8'));
const payload = manifest.programs.map(p => ({
  name: p.name,
  vs: fs.readFileSync(path.join(OUT, p.vertex), 'utf8'),
  fs: fs.readFileSync(path.join(OUT, p.fragment), 'utf8'),
}));

const html = `<!doctype html><meta charset="utf-8"><title>TF-WebGL2-TEST</title>
<script>
const programs = ${JSON.stringify(payload)};
window.addEventListener('load', () => {
  const canvas = document.createElement('canvas');
  canvas.width = 8; canvas.height = 8;
  const gl = canvas.getContext('webgl2', { antialias: false });
  if (!gl) { window.__RESULT = JSON.stringify({ fatal: 'webgl2 unavailable' }); document.title = 'TF-DONE'; return; }
  const results = [];
  for (const p of programs) {
    const r = { name: p.name, vsOk: false, fsOk: false, linkOk: false, log: [] };
    try {
      const mk = (type, src) => {
        const sh = gl.createShader(type);
        gl.shaderSource(sh, src); gl.compileShader(sh);
        const ok = !!gl.getShaderParameter(sh, gl.COMPILE_STATUS);
        const log = (gl.getShaderInfoLog(sh) || '').trim();
        return { ok, log };
      };
      const a = mk(gl.VERTEX_SHADER, p.vs);
      r.vsOk = a.ok; if (a.log) r.log.push('VS: ' + a.log);
      const b = mk(gl.FRAGMENT_SHADER, p.fs);
      r.fsOk = b.ok; if (b.log) r.log.push('FS: ' + b.log);
      if (a.ok && b.ok) {
        const prog = gl.createProgram();
        const vs2 = gl.createShader(gl.VERTEX_SHADER); gl.shaderSource(vs2, p.vs); gl.compileShader(vs2);
        const fs2 = gl.createShader(gl.FRAGMENT_SHADER); gl.shaderSource(fs2, p.fs); gl.compileShader(fs2);
        gl.attachShader(prog, vs2); gl.attachShader(prog, fs2); gl.linkProgram(prog);
        r.linkOk = !!gl.getProgramParameter(prog, gl.LINK_STATUS);
        const llog = (gl.getProgramInfoLog(prog) || '').trim();
        if (llog) r.log.push('LINK: ' + llog);
        if (r.linkOk) {
          r.activeUniforms = gl.getProgramParameter(prog, gl.ACTIVE_UNIFORMS);
          r.activeAttribs = gl.getProgramParameter(prog, gl.ACTIVE_ATTRIBUTES);
        }
      }
    } catch (e) { r.log.push('EXC: ' + e.message); }
    results.push(r);
  }
  window.__RESULT = JSON.stringify({ webglVersion: gl.getParameter(gl.VERSION), glsl: gl.getParameter(gl.SHADING_LANGUAGE_VERSION), results });
  document.title = 'TF-DONE';
});
<\/script>`;

const htmlPath = path.join(OUT, 'webgl_test.html');
fs.writeFileSync(htmlPath, html);
console.log('test page written: ' + htmlPath);
console.log('Next: agent-browser open file://' + htmlPath + '  then read window.__RESULT');
module.exports = { htmlPath };
