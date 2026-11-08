#!/usr/bin/env node
/**
 * TeaFabric M2 v1.2 — REAL WebGL2 verification of SPECIALIZED programs.
 * Generates 4 representative fixed-pipe combos via Specializer.js, compiles
 * and links them in a real headless-Chromium WebGL2 context, renders the
 * full-state combo one frame and reads back pixels (fog+light visible).
 * Cleanup-conscious: closes its tab when done (no renderer leaks).
 * Run: node test/run_specializer_check.js
 */
'use strict';
const fs = require('fs');
const path = require('path');
const { execSync } = require('child_process');

const { GlStateManager, GL_CONST } = require(path.join(__dirname, '..', 'GlStateManager.js'));
const { Specializer, snapshot } = require(path.join(__dirname, '..', 'Specializer.js'));

function ab(args) {
  return execSync('agent-browser ' + args, { encoding: 'utf8', maxBuffer: 32 * 1024 * 1024 }).trim();
}
function makeStub() {
  return { MAX_COMBINED_TEXTURE_IMAGE_UNITS: 8, getParameter: () => 8, enable() {}, disable() {} };
}

// ---- build 4 representative combos ----------------------------------------
function combo1_gui(g) { return snapshot(g, ['Position', 'UV0', 'Color']); }                    // fog off, no lights
function combo2_world(g) {                                                                       // full state
  g.lightingEnable();
  g.lightfv(GL_CONST.LIGHT0, GL_CONST.POSITION, [0.2, 0.8, 0.5, 0]);
  g.lightfv(GL_CONST.LIGHT0, GL_CONST.DIFFUSE, [0.7, 0.7, 0.65, 1]);
  g.fogEnable(); g.fogf(GL_CONST.FOG_MODE, GL_CONST.FOG_LINEAR);
  g.fogf(GL_CONST.FOG_START, 20); g.fogf(GL_CONST.FOG_END, 60);
  g.fogfv(GL_CONST.FOG_COLOR, [0.55, 0.65, 0.8, 1]);
  return snapshot(g, ['Position', 'UV0', 'Color', 'Normal', 'UV2']);
}
function combo3_cutout(g) {                                                                      // exp2 + alpha test
  g.lightingDisable();
  g.fogEnable(); g.fogf(GL_CONST.FOG_MODE, GL_CONST.FOG_EXP2); g.fogf(GL_CONST.FOG_DENSITY, 0.01);
  g.alphaTestEnable(); g.alphaFunc(GL_CONST.GREATER, 0.35);
  return snapshot(g, ['Position', 'UV0', 'Color']);
}
function combo4_headlight(g) {                                                                   // headlight = fallback equiv
  g.fogDisable(); g.alphaTestDisable();
  g.lightingEnable();
  g.lightfv(GL_CONST.LIGHT0, GL_CONST.POSITION, [0, 0, 1, 0]);
  g.lightfv(GL_CONST.LIGHT0, GL_CONST.DIFFUSE, [0.6, 0.6, 0.6, 1]);
  return snapshot(g, ['Position', 'UV0', 'Color', 'Normal']);
}
function combo5_texenv_replace(g) {                                                              // v1.3: GL_REPLACE
  g.lightingDisable(); g.fogDisable(); g.alphaTestDisable();
  g.texEnvi(GL_CONST.TEXTURE_ENV, GL_CONST.TEXTURE_ENV_MODE, GL_CONST.TEXENV_REPLACE);
  return snapshot(g, ['Position', 'UV0', 'Color']);
}
function combo6_texenv_decal(g) {                                                                // v1.3: GL_DECAL
  g.lightingDisable(); g.fogDisable(); g.alphaTestDisable();
  g.texEnvi(GL_CONST.TEXTURE_ENV, GL_CONST.TEXTURE_ENV_MODE, GL_CONST.TEXENV_DECAL);
  return snapshot(g, ['Position', 'UV0', 'Color']);
}

const g = new GlStateManager(makeStub());
const combos = [combo1_gui(g), combo2_world(g), combo3_cutout(g), combo4_headlight(g), combo5_texenv_replace(g), combo6_texenv_decal(g)];
const specs = combos.map(s => {
  const p = require(path.join(__dirname, '..', 'Specializer.js')).specialize(s);
  return { name: p.name, key: s, vs: p.vs, fs: p.fs };
});

// ---- one-frame render probe on combo2 (world): tri + pixel readback --------
const renderProbe = `
  // full-state program: full-screen triangle, light-tilted normal, mid-fog distance
  const vs = document.getElementById('probe_vs').textContent;
  const fs = document.getElementById('probe_fs').textContent;
  function sh(type, src) { const s = gl.createShader(type); gl.shaderSource(s, src); gl.compileShader(s);
    if (!gl.getShaderParameter(s, gl.COMPILE_STATUS)) throw new Error(gl.getShaderInfoLog(s)); return s; }
  const prog = gl.createProgram();
  gl.attachShader(prog, sh(gl.VERTEX_SHADER, vs));
  gl.attachShader(prog, sh(gl.FRAGMENT_SHADER, fs));
  gl.linkProgram(prog);
  if (!gl.getProgramParameter(prog, gl.LINK_STATUS)) throw new Error(gl.getProgramInfoLog(prog));
  gl.useProgram(prog);
  // bind 1x1 white textures to unit 0 (Sampler0) and unit 2 (Sampler2)
  const white = new Uint8Array([255, 255, 255, 255]);
  for (const unit of [0, 2]) {
    const tex = gl.createTexture();
    gl.activeTexture(gl.TEXTURE0 + unit);
    gl.bindTexture(gl.TEXTURE_2D, tex);
    gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, 1, 1, 0, gl.RGBA, gl.UNSIGNED_BYTE, white);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.NEAREST);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.NEAREST);
  }
  // interleaved: Position(3) Normal(3) UV0(2) Color(4) UV2(2) = 14 floats/vertex
  const stride = 14 * 4;
  const verts = new Float32Array([
    //    pos(x,y,z)      nor       uv0   color(r,g,b,a)   uv2
    -40, -40, 0,   0, 0, 1,   0, 0,   1, 1, 1, 1,   0, 0,
     40, -40, 0,   0, 0, 1,   1, 0,   1, 1, 1, 1,   255, 255,
      0,  40, 0,   0, 0, 1,  0.5, 1,  1, 1, 1, 1,   128, 128,
  ]);
  const vao = gl.createVertexArray(); gl.bindVertexArray(vao);
  const buf = gl.createBuffer(); gl.bindBuffer(gl.ARRAY_BUFFER, buf);
  gl.bufferData(gl.ARRAY_BUFFER, verts, gl.STATIC_DRAW);
  const loc = n => gl.getAttribLocation(prog, n);
  const set = (n, size, off) => { const i = loc(n); if (i >= 0) { gl.enableVertexAttribArray(i); gl.vertexAttribPointer(i, size, gl.FLOAT, false, stride, off); } };
  set('Position', 3, 0);
  set('Normal', 3, 12);
  set('UV0', 2, 24);
  set('Color', 4, 32);
  set('UV2', 2, 48);
  // standard perspective: fov 90, aspect 1, near 10, far 100; tri at z=-40 (mid-fog)
  const mv = new Float32Array([1,0,0,0, 0,1,0,0, 0,0,1,0, 0,0,-40,1]);
  const fn = 1 / Math.tan(Math.PI / 4); // fov/2 = 45deg => f=1
  const pj = new Float32Array([
    fn,0,0,0,  0,fn,0,0,
    0,0,(fn+10)/(10-100),-1,  0,0,(2*fn*10*10)/(10-100),0,
  ]);
  gl.uniformMatrix4fv(gl.getUniformLocation(prog, 'ModelViewMat'), false, mv);
  gl.uniformMatrix4fv(gl.getUniformLocation(prog, 'ProjMat'), false, pj);
  gl.uniform1i(gl.getUniformLocation(prog, 'Sampler0'), 0);
  gl.uniform1i(gl.getUniformLocation(prog, 'Sampler2'), 2);
  gl.uniform4f(gl.getUniformLocation(prog, 'ColorModulator'), 1, 1, 1, 1);
  gl.clearColor(0, 0, 0, 1); gl.clear(gl.COLOR_BUFFER_BIT | gl.DEPTH_BUFFER_BIT);
  gl.viewport(0, 0, 64, 64);
  gl.drawArrays(gl.TRIANGLES, 0, 3);
  const px = new Uint8Array(64 * 64 * 4);
  gl.readPixels(0, 0, 64, 64, gl.RGBA, gl.UNSIGNED_BYTE, px);
  let nonBlack = 0;
  for (let i = 0; i < px.length; i += 4) if (px[i] + px[i+1] + px[i+2] > 0) nonBlack++;
  const center = ((32 * 64) + 32) * 4;
  return { nonBlackRatio: nonBlack / (64 * 64),
           center: [px[center], px[center + 1], px[center + 2]] };
`;

// ---- v1.3 INTEGRATED probe: the compiled-client-shaped draw path ------------
// Everything below goes through GlStateManager (state machine) -> Specializer
// JIT -> drawArrays — exactly the path the TeaVM-compiled client drives. No
// raw gl.* calls except vertex setup (which the client also does via GL20).
const integratedProbe = `
  const K = window.GL_CONST;
  const g = new window.GlStateManager(gl);
  g.attachSpecializer(new window.Specializer(64));
  // white 1x1 texture on unit 0 (the lightmap-free, texture-only combo)
  const white = new Uint8Array([255, 255, 255, 255]);
  const tex = gl.createTexture();
  gl.activeTexture(gl.TEXTURE0);
  gl.bindTexture(gl.TEXTURE_2D, tex);
  gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, 1, 1, 0, gl.RGBA, gl.UNSIGNED_BYTE, white);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.NEAREST);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.NEAREST);
  g.enableTexture2D();
  // client state: matrices via the CPU stacks (fed to the JIT program on bind)
  g.matrixMode(K.MODELVIEW); g.loadIdentity();
  g.matrixMode(K.PROJECTION); g.loadIdentity();
  // full-screen triangle in clip space: Position(3)+UV0(2), no Color attribute
  // => the fixed-pipe glColor path (CurrentColor uniform) is exercised
  const verts = new Float32Array([
    -1, -1, 0.5,   0, 0,
     3, -1, 0.5,   0, 0,
    -1,  3, 0.5,   0, 0,
  ]);
  const vao = gl.createVertexArray(); gl.bindVertexArray(vao);
  const buf = g.genBuffer(); g.bindBuffer(K.ARRAY_BUFFER, buf);
  g.bufferData(K.ARRAY_BUFFER, verts, 0x88E4);
  const readCenter = () => {
    const px = new Uint8Array(64 * 64 * 4);
    gl.readPixels(0, 0, 64, 64, gl.RGBA, gl.UNSIGNED_BYTE, px);
    let nonBlack = 0;
    for (let i = 0; i < px.length; i += 4) if (px[i] + px[i+1] + px[i+2] > 0) nonBlack++;
    const c = ((32 * 64) + 32) * 4;
    return { nonBlackRatio: nonBlack / (64 * 64), center: [px[c], px[c+1], px[c+2]] };
  };
  const wire = (prog) => {
    const set = (n, size, off) => { const i = gl.getAttribLocation(prog, n);
      if (i >= 0) { gl.enableVertexAttribArray(i); gl.vertexAttribPointer(i, size, gl.FLOAT, false, 20, off); } };
    set('Position', 3, 0); set('UV0', 2, 12);
  };
  gl.clearColor(0, 0, 0, 1); gl.clear(gl.COLOR_BUFFER_BIT);
  g.viewport(0, 0, 64, 64);
  // phase A — MODULATE (default texenv): center = texel * glColor
  g.color4f(1.0, 0.25, 0.5, 1.0);
  const pA = g.useSpecializedProgram(['Position', 'UV0']);
  wire(pA);
  g.drawArrays(gl.TRIANGLES, 0, 3);
  const modulate = readCenter();
  // phase B — flip texenv to REPLACE: NEW baked program, center = texel only
  g.texEnvi(K.TEXTURE_ENV, K.TEXTURE_ENV_MODE, K.TEXENV_REPLACE);
  const pB = g.useSpecializedProgram(['Position', 'UV0']);
  wire(pB);
  g.drawArrays(gl.TRIANGLES, 0, 3);
  const replace = readCenter();
  // phase C — IDEMPOTENT rebind + redraw: everything must dedup; the frame is
  // unchanged and the only new GL call is the draw itself
  const callsBeforeC = g.stats.glCalls, skipsBeforeC = g.stats.skippedByCache;
  g.useSpecializedProgram(['Position', 'UV0']);
  g.drawArrays(gl.TRIANGLES, 0, 3);
  const replaceAgain = readCenter();
  return {
    programsUsed: 2, distinctPrograms: pA !== pB,
    glCalls: g.stats.glCalls, dedupSkips: g.stats.skippedByCache,
    phaseC_glCalls: g.stats.glCalls - callsBeforeC,
    phaseC_dedups: g.stats.skippedByCache - skipsBeforeC,
    frameStable: replaceAgain.center[0] === replace.center[0] && replaceAgain.center[1] === replace.center[1] && replaceAgain.center[2] === replace.center[2],
    modulate, replace,
  };
`;

// ---- sources embedded for the INTEGRATED probe (real GLSM + JIT in-page) ---
const glsmSrc = fs.readFileSync(path.join(__dirname, '..', 'GlStateManager.js'), 'utf8');
const specSrc = fs.readFileSync(path.join(__dirname, '..', 'Specializer.js'), 'utf8');

const html = `<!doctype html><meta charset="utf-8"><title>TF-SPEC-TEST</title>
<canvas id="c" width="64" height="64" style="display:none"></canvas>
<script>(() => {
${glsmSrc}
})();</scr${''}ipt>
<script>(() => {
${specSrc}
})();</scr${''}ipt>
${specs.map((s, i) => '<script type="x-shader" id="vs' + i + '">' + s.vs + '</scr' + 'ipt>').join('\n')}
${specs.map((s, i) => '<script type="x-shader" id="fs' + i + '">' + s.fs + '</scr' + 'ipt>').join('\n')}
<script id="probe_vs" type="x-shader">${specs[1].vs}</script>
<script id="probe_fs" type="x-shader">${specs[1].fs}</script>
<script>
window.__SPEC_RESULT = (() => {
  const canvas = document.getElementById('c');
  const gl = canvas.getContext('webgl2', { preserveDrawingBuffer: true });
  const out = { webglVersion: gl.getParameter(gl.VERSION), glsl: gl.getParameter(gl.SHADING_LANGUAGE_VERSION), programs: [], probe: null, error: null };
  try {
    for (let i = 0; i < ${specs.length}; i++) {
      const vsSrc = document.getElementById('vs' + i).textContent;
      const fsSrc = document.getElementById('fs' + i).textContent;
      try {
        function sh(type, src) { const s = gl.createShader(type); gl.shaderSource(s, src); gl.compileShader(s);
          if (!gl.getShaderParameter(s, gl.COMPILE_STATUS)) throw new Error('shader ' + i + ': ' + gl.getShaderInfoLog(s)); return s; }
        const p = gl.createProgram();
        gl.attachShader(p, sh(gl.VERTEX_SHADER, vsSrc));
        gl.attachShader(p, sh(gl.FRAGMENT_SHADER, fsSrc));
        gl.linkProgram(p);
        out.programs.push({ name: 'combo' + i, link: !!gl.getProgramParameter(p, gl.LINK_STATUS) });
      } catch (e2) {
        out.programs.push({ name: 'combo' + i, link: false, error: String(e2.message || e2) });
      }
    }
    out.probe = (() => { ${renderProbe.replace("const gl = canvas.getContext('webgl2', { preserveDrawingBuffer: true });", "/* reused gl */")} })();
    out.integrated = (() => { ${integratedProbe} })();
  } catch (e) { out.error = String(e && e.message || e); }
  document.title = 'TF-SPEC-DONE';
  return out;
})();
</script>`;

// ---- write page ------------------------------------------------------------
const OUT = path.join(__dirname, '..', 'build');
fs.mkdirSync(OUT, { recursive: true });
const pagePath = path.join(OUT, 'specializer_test.html');
fs.writeFileSync(pagePath, html);
console.log('page written: ' + pagePath);

// ---- CDP tab hygiene: close any previous specializer tabs, open fresh ------
const http = require('http');
const pageUrl = 'file://' + pagePath;
function cdpJson(pathName) {
  return new Promise((resolve, reject) => {
    // locate the DevToolsActivePort of the agent-browser chrome instance
    const roots = fs.readdirSync('/tmp').filter(d => d.startsWith('agent-browser-chrome-'));
    let port = null;
    for (const r of roots) {
      const p = path.join('/tmp', r, 'DevToolsActivePort');
      if (fs.existsSync(p)) { port = fs.readFileSync(p, 'utf8').split('\n')[0].trim(); break; }
    }
    if (!port) return reject(new Error('no DevToolsActivePort'));
    http.get({ host: '127.0.0.1', port, path: pathName }, res => {
      let b = ''; res.on('data', c => b += c); res.on('end', () => resolve(JSON.parse(b)));
    }).on('error', reject);
  });
}
function cdpClose(targetId) {
  return cdpJson('/json').then(targets => {
    const t = targets.find(x => x.id === targetId);
    if (!t) return;
    return new Promise((resolve, reject) => {
      const ws = new WebSocket(t.webSocketDebuggerUrl);
      ws.onopen = () => ws.send(JSON.stringify({ id: 1, method: 'Target.closeTarget', params: { targetId } }));
      ws.onclose = () => resolve(); ws.onerror = () => resolve();
      setTimeout(() => { try { ws.close(); } catch (e) {} resolve(); }, 1500);
    });
  });
}

async function cdpTabCycle(pageUrl) {
  // close stale tabs of this page, then open a fresh one via CDP
  const targets = await cdpJson('/json');
  for (const t of targets) {
    if (t.type === 'page' && t.url.includes('specializer_test.html')) await cdpClose(t.id);
  }
  // find any quickroom tab to avoid disturbing; open new tab via /json/new
  const opened = await new Promise((resolve, reject) => {
    const roots = fs.readdirSync('/tmp').filter(d => d.startsWith('agent-browser-chrome-'));
    let port = null;
    for (const r of roots) {
      const p = path.join('/tmp', r, 'DevToolsActivePort');
      if (fs.existsSync(p)) { port = fs.readFileSync(p, 'utf8').split('\n')[0].trim(); break; }
    }
    const req = http.request({ host: '127.0.0.1', port, path: '/json/new?' + encodeURIComponent(pageUrl), method: 'PUT' }, res => {
      let b = ''; res.on('data', c => b += c); res.on('end', () => resolve(JSON.parse(b)));
    });
    req.on('error', reject); req.end();
  });
  return opened.id;
}

function cdpEval(targetId, expr) {
  return cdpJson('/json').then(targets => {
    const t = targets.find(x => x.id === targetId);
    if (!t) throw new Error('target gone');
    return new Promise((resolve, reject) => {
      const ws = new WebSocket(t.webSocketDebuggerUrl);
      ws.onopen = () => ws.send(JSON.stringify({
        id: 1, method: 'Runtime.evaluate',
        params: { expression: expr, returnByValue: true, awaitPromise: true, timeout: 15000 },
      }));
      ws.onmessage = ev => {
        const msg = JSON.parse(ev.data);
        if (msg.id === 1) {
          ws.close();
          if (msg.result && msg.result.exceptionDetails) {
            reject(new Error(msg.result.exceptionDetails.exception && msg.result.exceptionDetails.exception.description || 'eval exception'));
          } else resolve(msg.result.result.value);
        }
      };
      ws.onerror = () => reject(new Error('ws error'));
      setTimeout(() => { try { ws.close(); } catch (e) {} reject(new Error('eval timeout')); }, 20000);
    });
  });
}

(async () => {
  const tabId = await cdpTabCycle(pageUrl);
  console.log('tab opened: ' + tabId.slice(0, 8));
  // wait for completion marker
  let tries = 0, done = false;
  while (tries++ < 40 && !done) {
    await new Promise(r2 => setTimeout(r2, 300));
    try {
      const targets = await cdpJson('/json');
      const mine = targets.find(t => t.id === tabId);
      if (mine && mine.title === 'TF-SPEC-DONE') done = true;
    } catch (e) { /* transient */ }
  }
  if (!done) console.error('WARN: TF-SPEC-DONE not observed in time, reading anyway');
  // read the result BEFORE closing the tab
  let r;
  try {
    r = await cdpEval(tabId, 'window.__SPEC_RESULT');
  } catch (e) {
    console.error('eval failed: ' + e.message);
    await cdpClose(tabId);
    process.exit(1);
  }
  await cdpClose(tabId); // hygiene: no renderer leak

  console.log('== Specializer REAL WebGL2 verification ==');
  console.log('GL: ' + r.webglVersion + ' | GLSL: ' + r.glsl);
  let pass = 0, fail = 0;
  function test(name, cond, extra) {
    if (cond) { pass++; console.log('  PASS ' + name + (extra ? ' (' + extra + ')' : '')); }
    else { fail++; console.log('  FAIL ' + name + (extra ? ' (' + extra + ')' : '')); }
  }
  test('no fatal error', !r.error, r.error || '');
  (r.programs || []).forEach(p => test('compile+link ' + p.name, p.link));
  test('probe: one-frame render non-black', r.probe && r.probe.nonBlackRatio > 0.25,
       r.probe ? (100 * r.probe.nonBlackRatio).toFixed(1) + '%' : 'no probe');
  test('probe: fog tint visible (blue channel dominant over red)', r.probe && r.probe.center[2] >= r.probe.center[0],
       r.probe ? 'rgb=' + r.probe.center.join(',') : '');
  test('probe: center pixel lit but fogged (not pure white)', r.probe && r.probe.center[0] > 40 && r.probe.center[0] < 240,
       r.probe ? 'r=' + r.probe.center[0] : '');

  // ---- v1.3 integrated path assertions --------------------------------------
  const I = r.integrated;
  test('integrated: GLSM->JIT path rendered', I && I.modulate && I.modulate.nonBlackRatio > 0.9,
       I && I.modulate ? (100 * I.modulate.nonBlackRatio).toFixed(1) + '%' : 'no result');
  test('integrated: MODULATE = texel * glColor (CurrentColor path)',
       I && I.modulate && Math.abs(I.modulate.center[0] - 255) <= 2 && Math.abs(I.modulate.center[1] - 64) <= 2 && Math.abs(I.modulate.center[2] - 128) <= 2,
       I && I.modulate ? 'rgb=' + I.modulate.center.join(',') + ' want 255,64,128' : '');
  test('integrated: texenv REPLACE flip -> new program, texel bypasses glColor',
       I && I.replace && I.distinctPrograms && Math.abs(I.replace.center[0] - 255) <= 2 && Math.abs(I.replace.center[1] - 255) <= 2 && Math.abs(I.replace.center[2] - 255) <= 2,
       I && I.replace ? 'rgb=' + I.replace.center.join(',') + ' want 255,255,255' : '');
  test('integrated: state dedup alive on the client-shaped path',
       I && I.phaseC_dedups > 0 && I.phaseC_glCalls === 1 && I.frameStable,
       I ? 'C-phase: glCalls=' + I.phaseC_glCalls + ' (want 1: just the draw), dedups=' + I.phaseC_dedups + ', frame stable=' + I.frameStable : '');

  console.log(`\n== RESULT: ${pass} passed, ${fail} failed ==`);
  process.exit(fail ? 1 : 0);
})().catch(e => { console.error('FATAL: ' + e.message); process.exit(1); });
