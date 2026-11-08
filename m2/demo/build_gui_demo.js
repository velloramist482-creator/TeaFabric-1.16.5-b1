/**
 * Builds a fully self-contained gui_demo_standalone.html: inlines
 * GlStateManager.js + RenderTypeStates.js (IIFE-wrapped) and embeds the
 * CONVERTED ES 3.00 program sources from build/shaders/manifest.json.
 * Run: node demo/build_gui_demo.js
 */
'use strict';
const fs = require('fs');
const path = require('path');
const root = path.join(__dirname, '..');
let html = fs.readFileSync(path.join(__dirname, 'gui_demo.html'), 'utf8');

// 1. inline JS modules (IIFE-wrapped: top-level const must not cross script blocks)
for (const f of ['GlStateManager.js', 'RenderTypeStates.js']) {
  const src = fs.readFileSync(path.join(root, f), 'utf8');
  const tag = `<!--__${f.replace('.js', '').toUpperCase().replace('GLSTATEMANAGER', 'GSM').replace('RENDERTYPESTATES', 'RT')}__-->`;
  if (!html.includes(tag)) throw new Error('tag not found: ' + tag);
  html = html.replace(tag, `<script>\n/* ==== inlined from ${f} (IIFE-wrapped) ==== */\n(function(){\n${src}\n})();\n</script>`);
}

// 2. embed converter OUTPUT (ES 3.00) for every manifest program
const OUT = path.join(root, 'build', 'shaders');
const manifest = JSON.parse(fs.readFileSync(path.join(OUT, 'manifest.json'), 'utf8'));
const payload = {};
for (const p of manifest.programs) {
  payload[p.name] = {
    vs: fs.readFileSync(path.join(OUT, p.vertex), 'utf8'),
    fs: fs.readFileSync(path.join(OUT, p.fragment), 'utf8'),
    attrs: p.attributes,
  };
}
if (!html.includes('/*__PROGRAMS__*/{}')) throw new Error('PROGRAMS placeholder not found');
html = html.replace('/*__PROGRAMS__*/{}', JSON.stringify(payload));

const out = path.join(__dirname, 'gui_demo_standalone.html');
fs.writeFileSync(out, html);
console.log('written: ' + out + ' (' + (html.length / 1024).toFixed(1) + ' KB), programs: ' + Object.keys(payload).join(', '));
