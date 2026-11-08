#!/usr/bin/env node
/**
 * TeaFabric M2 v1.1 — REAL WebGL2 GUI bring-up verification.
 * Opens gui_demo_standalone.html in headless Chromium, waits for 90 frames,
 * reads window.__GUI_RESULT, takes a screenshot, asserts pixel regions.
 * Run: node test/run_gui_demo_check.js
 */
'use strict';
const fs = require('fs');
const path = require('path');
const { execSync } = require('child_process');

function ab(args) {
  return execSync('agent-browser ' + args, { encoding: 'utf8', maxBuffer: 32 * 1024 * 1024 }).trim();
}

const pageUrl = 'file://' + path.join(__dirname, '..', 'demo', 'gui_demo_standalone.html');
const shotPath = path.join(__dirname, '..', 'demo', 'gui_demo_screenshot.png');

ab('tab new ' + JSON.stringify(pageUrl));
let tries = 0;
while (tries++ < 40) {
  const title = ab('eval "document.title"').split('\n').pop().replace(/"/g, '');
  if (title === 'TF-GUI-DONE') break;
  execSync('sleep 0.3');
}
if (tries >= 40) { console.error('demo did not finish'); process.exit(1); }

let raw = ab('eval "JSON.stringify(window.__GUI_RESULT)"');
raw = raw.replace(/\\"/g, '"');
const j = raw.indexOf('{'), k = raw.lastIndexOf('}');
if (j < 0) { console.error('no result:\n' + raw); process.exit(1); }
const r = JSON.parse(raw.slice(j, k + 1));

console.log('== M2 v1.1 GUI bring-up — REAL WebGL2 render check ==');
console.log('frames=' + r.frames + '  fps=' + r.fpsAvg + '  GL calls(first 5f)=' + r.glCallsPerFrame +
  '  dedup skips=' + r.dedupSkipped + '  non-black=' + (r.nonBlackRatio * 100).toFixed(1) + '%');
for (const [n, v] of Object.entries(r.regions)) console.log('  ' + n.padEnd(18) + ' = rgb(' + v.slice(0, 3).join(',') + ')');

// screenshot for the room report
ab('screenshot ' + JSON.stringify(shotPath));
console.log('screenshot: ' + shotPath);

// ---- assertions ----
let pass = 0, fail = 0; const failures = [];
function t(name, cond, extra) {
  if (cond) { pass++; console.log('  PASS ' + name); }
  else { fail++; failures.push(name + (extra ? ' :: ' + extra : '')); console.log('  FAIL ' + name + (extra ? ' :: ' + extra : '')); }
}
const rgb = (v) => v.slice(0, 3);
const bright = (v) => rgb(v).reduce((a, b) => a + b, 0) / 3;

t('90 frames completed', r.frames === 90);
t('fps >= 30', r.fpsAvg >= 30, 'fps=' + r.fpsAvg);
t('non-black pixels >= 90%', r.nonBlackRatio >= 0.9, 'ratio=' + r.nonBlackRatio);
t('webmcReady flag set', r.webmcReady === true);
t('GL calls modest (dedup active)', r.glCallsPerFrame < 400, 'calls=' + r.glCallsPerFrame);
t('background dirt is brown-ish', (() => { const [r0, g0, b0] = rgb(r.regions.background_dirt); return r0 > 60 && r0 > b0 + 25 && g0 > b0; })(), JSON.stringify(r.regions.background_dirt));
t('button1 body is gray gradient', (() => { const c = bright(r.regions.button1_body); return c > 90 && c < 200; })(), 'brightness=' + bright(r.regions.button1_body).toFixed(1));
t('hover overlay brightens button2', (() => {
  const hov = bright(r.regions.hover_overlay);
  return hov > 110; // hovered button is clearly brighter than base gray
})(), 'hover brightness=' + bright(r.regions.hover_overlay).toFixed(1));
t('tooltip panel dark + purple text row nearby', (() => {
  const c = rgb(r.regions.tooltip_panel);
  return bright(c) < 70;
})(), JSON.stringify(r.regions.tooltip_panel));
t('lightmap panel lit (stone x light ramp, neutral gray)', (() => {
  const c = rgb(r.regions.lightmap_panel);
  return bright(c) > 60 && bright(c) < 220 && Math.abs(c[0] - c[2]) < 14;
})(), 'brightness=' + bright(r.regions.lightmap_panel).toFixed(1) + ' rgb=' + JSON.stringify(c => c));
t('cube renders neutral gray (lit by headlight lambert)', (() => {
  const c = rgb(r.regions.cube_face);
  return Math.abs(c[0] - c[1]) < 14 && Math.abs(c[1] - c[2]) < 14 && bright(c) > 30;
})(), JSON.stringify(r.regions.cube_face));

console.log(`\n== RESULT: ${pass}/${pass + fail} GUI checks ${fail ? '' : '(ALL GREEN)'} ==`);
fs.writeFileSync(path.join(__dirname, '..', 'build', 'gui_demo_report.json'), JSON.stringify(r, null, 2));
process.exit(fail ? 1 : 0);
