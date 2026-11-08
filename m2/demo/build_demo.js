#!/usr/bin/env node
/**
 * Builds a fully self-contained demo_standalone.html (inlines GlStateManager.js
 * and RenderTypeStates.js) so the demo runs even under strict file:// policies.
 * Run: node demo/build_demo.js
 */
'use strict';
const fs = require('fs');
const path = require('path');
const root = path.join(__dirname, '..');
let html = fs.readFileSync(path.join(__dirname, 'demo.html'), 'utf8');
for (const f of ['GlStateManager.js', 'RenderTypeStates.js']) {
  const src = fs.readFileSync(path.join(root, f), 'utf8');
  const tag = `<script src="../${f}"></script>`;
  if (!html.includes(tag)) throw new Error('tag not found: ' + tag);
  // inline wrapped in IIFE: top-level const/let must not collide across
  // script blocks (redeclaration is a load-time SyntaxError in browsers)
  html = html.replace(tag, `<script>\n/* ==== inlined from ${f} (IIFE-wrapped) ==== */\n(function(){\n${src}\n})();\n</script>`);
}
const out = path.join(__dirname, 'demo_standalone.html');
fs.writeFileSync(out, html);
console.log('written: ' + out + ' (' + (html.length / 1024).toFixed(1) + ' KB)');
