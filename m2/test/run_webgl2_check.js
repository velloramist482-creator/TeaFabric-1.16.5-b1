#!/usr/bin/env node
/**
 * TeaFabric M2 — full WebGL2 verification runner.
 * Pipeline: generate test page -> open in headless Chromium -> wait -> read
 * JSON result -> print PASS/FAIL report. One command: node test/run_webgl2_check.js
 */
'use strict';
const fs = require('fs');
const path = require('path');
const { execSync } = require('child_process');

function ab(args) {
  return execSync('agent-browser ' + args, { encoding: 'utf8', maxBuffer: 32 * 1024 * 1024 }).trim();
}

// 1. generate page
execSync('node ' + JSON.stringify(path.join(__dirname, 'make_webgl_page.js')), { encoding: 'utf8' });
const pageUrl = 'file://' + path.join(__dirname, '..', 'build', 'shaders', 'webgl_test.html');

// 2. open fresh tab and wait for completion marker
ab('tab new ' + JSON.stringify(pageUrl));
let tries = 0;
while (tries++ < 20) {
  const title = ab('eval "document.title"').split('\n').pop().replace(/"/g, '');
  if (title === 'TF-DONE') break;
  require('sleep') ? null : null;
  execSync('sleep 0.3');
}
// 3. read result
let rawOut = ab('eval "window.__RESULT"');
// normalize shell-escaping artifacts from agent-browser output: \" -> "
rawOut = rawOut.replace(/\\"/g, '"');
const braceStart = rawOut.indexOf('{');
const braceEnd = rawOut.lastIndexOf('}');
if (braceStart < 0 || braceEnd <= braceStart) { console.error('no result captured:\n' + rawOut); process.exit(1); }
const r = JSON.parse(rawOut.slice(braceStart, braceEnd + 1));

console.log('== WebGL2 REAL compile/link verification ==');
console.log('GL: ' + r.webglVersion + ' | GLSL: ' + r.glsl);
let ok = true, pass = 0;
for (const x of r.results) {
  const p = x.vsOk && x.fsOk && x.linkOk; ok &&= p; if (p) pass++;
  console.log((p ? 'PASS' : 'FAIL') + ' ' + x.name + ': vs=' + x.vsOk + ' fs=' + x.fsOk + ' link=' + x.linkOk +
    (x.activeUniforms !== undefined ? ' activeUniforms=' + x.activeUniforms + ' activeAttribs=' + x.activeAttribs : '') +
    (x.log.length ? '\n   ' + x.log.join('\n   ') : ''));
}
console.log(`\n== RESULT: ${pass}/${r.results.length} programs compile+link in real WebGL2 ${ok ? '(ALL GREEN)' : ''} ==`);
// persist machine-readable report for CI
fs.writeFileSync(path.join(__dirname, '..', 'build', 'webgl2_report.json'), JSON.stringify(r, null, 2));
process.exit(ok ? 0 : 1);
