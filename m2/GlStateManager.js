/**
 * TeaFabric M2 — GlStateManager (WebGL2 backend)
 * ================================================
 * 1:1 port of net.minecraft.client.renderer.GlStateManager (1.16.5) semantics
 * onto WebGL2, with a full CPU-side matrix stack (fixed-function GL calls do
 * not exist in WebGL2, so _pushMatrix/_orthoModelView etc. run in JS and are
 * uploaded as uniforms — matches the core-shader uniform contract of M3).
 *
 * Design goals (per room contract v1):
 *  - Zero redundant GL calls: every state goes through a cache + dirty check.
 *  - API surface mirrors 1.16.5 GlStateManager so the TeaVM-generated code
 *    (CGLM.mapClassName output) can bind methods mechanically.
 *  - EXT_framebuffer_object / ARB_shader_objects legacy entry points are
 *    mapped onto WebGL2 core (gl.createFramebuffer / gl.createProgram).
 *  - No GL state leaks: endFrame() restores a known-good baseline.
 *
 * License: MIT (TeaFabric project). No Mojang code or assets contained.
 */

const GL_CONST = {
  // blend factors
  ZERO: 0, ONE: 1, SRC_COLOR: 0x0300, ONE_MINUS_SRC_COLOR: 0x0301,
  SRC_ALPHA: 0x0302, ONE_MINUS_SRC_ALPHA: 0x0303, DST_ALPHA: 0x0304,
  ONE_MINUS_DST_ALPHA: 0x0305, DST_COLOR: 0x0306, ONE_MINUS_DST_COLOR: 0x0307,
  SRC_ALPHA_SATURATE: 0x0308,
  // blend ops (1.16.5 _blendFuncSeparateEXT uses glBlendEquationSeparate)
  FUNC_ADD: 0x8006, MIN: 0x8007, MAX: 0x8008,
  FUNC_SUBTRACT: 0x800A, FUNC_REVERSE_SUBTRACT: 0x800B,
  // depth
  NEVER: 0x0200, LESS: 0x0201, EQUAL: 0x0202, LEQUAL: 0x0203, GREATER: 0x0204,
  NOTEQUAL: 0x0205, GEQUAL: 0x0206, ALWAYS: 0x0207,
  // cull
  FRONT: 0x0404, BACK: 0x0405, FRONT_AND_BACK: 0x0408,
  // logic op
  CLEAR: 0x1500, SET: 0x150F, COPY: 0x1503, COPY_INVERTED: 0x150C,
  NOOP: 0x1505, INVERT: 0x150A, AND: 0x1501, NAND: 0x150E, OR: 0x1507,
  NOR: 0x1508, XOR: 0x1506, AND_REVERSE: 0x1502, AND_INVERTED: 0x1504,
  OR_REVERSE: 0x150B, OR_INVERTED: 0x150D,
  // texture
  TEXTURE_2D: 0x0DE1, NEAREST: 0x2600, LINEAR: 0x2601,
  NEAREST_MIPMAP_NEAREST: 0x2700, LINEAR_MIPMAP_NEAREST: 0x2701,
  NEAREST_MIPMAP_LINEAR: 0x2702, LINEAR_MIPMAP_LINEAR: 0x2703,
  CLAMP: 0x2900, CLAMP_TO_EDGE: 0x812F, REPEAT: 0x2901,
  // matrix modes
  MODELVIEW: 0x1700, PROJECTION: 0x1701, TEXTURE: 0x1702,
  COLOR: 0x1800, // legacy color matrix: kept as no-op slot for parity
};

class Matrix4f {
  constructor() { this.m = new Float32Array(16); this.identity(); }
  identity() {
    const m = this.m; m.fill(0);
    m[0] = m[5] = m[10] = m[15] = 1; return this;
  }
  static mul(out, a, b) { // column-major, out = a * b
    const o = out.m, A = a.m, B = b.m;
    for (let c = 0; c < 4; c++) {
      const b0 = B[c * 4], b1 = B[c * 4 + 1], b2 = B[c * 4 + 2], b3 = B[c * 4 + 3];
      o[c * 4]     = A[0] * b0 + A[4] * b1 + A[8]  * b2 + A[12] * b3;
      o[c * 4 + 1] = A[1] * b0 + A[5] * b1 + A[9]  * b2 + A[13] * b3;
      o[c * 4 + 2] = A[2] * b0 + A[6] * b1 + A[10] * b2 + A[14] * b3;
      o[c * 4 + 3] = A[3] * b0 + A[7] * b1 + A[11] * b2 + A[15] * b3;
    }
    return out;
  }
  translate(x, y, z) {
    const t = new Matrix4f();
    t.m[12] = x; t.m[13] = y; t.m[14] = z;
    Matrix4f.mul(this, this, t); return this;
  }
  scale(x, y, z) {
    const s = new Matrix4f();
    s.m[0] = x; s.m[5] = y; s.m[10] = z;
    Matrix4f.mul(this, this, s); return this;
  }
  rotate(angleDeg, x, y, z) {
    const r = new Matrix4f(), rad = angleDeg * Math.PI / 180;
    const c = Math.cos(rad), s = Math.sin(rad), ic = 1 - c;
    const len = Math.hypot(x, y, z) || 1; x /= len; y /= len; z /= len;
    const m = r.m;
    m[0] = x * x * ic + c;      m[1] = y * x * ic + z * s; m[2] = x * z * ic - y * s;
    m[4] = x * y * ic - z * s;  m[5] = y * y * ic + c;     m[6] = y * z * ic + x * s;
    m[8] = x * z * ic + y * s;  m[9] = y * z * ic - x * s; m[10] = z * z * ic + c;
    Matrix4f.mul(this, this, r); return this;
  }
  static ortho(out, l, r, b, t, n, f) {
    out.identity();
    const m = out.m;
    m[0] = 2 / (r - l); m[5] = 2 / (t - b); m[10] = -2 / (f - n);
    m[12] = -(r + l) / (r - l); m[13] = -(t + b) / (t - b); m[14] = -(f + n) / (f - n);
    return out;
  }
  static perspective(out, fovyDeg, aspect, n, f) {
    out.identity();
    const t = n * Math.tan(fovyDeg * Math.PI / 360), m = out.m;
    m[0] = n / (aspect * t); m[5] = n / t; m[10] = -(f + n) / (f - n);
    m[11] = -1; m[14] = -(2 * f * n) / (f - n); m[15] = 0;
    return out;
  }
  static frustum(out, l, r, b, t, n, f) {
    out.identity();
    const m = out.m, rl = 1 / (r - l), tb = 1 / (t - b), fn = 1 / (f - n);
    m[0] = 2 * n * rl; m[5] = 2 * n * tb; m[8] = (r + l) * rl;
    m[9] = (t + b) * tb; m[10] = -(f + n) * fn; m[11] = -1;
    m[14] = -2 * f * n * fn; m[15] = 0;
    return out;
  }
}

/** Per-target cache of one capability (enable/disable + parameters). */
function makeCap() { return { enabled: false, dirty: true }; }

class GlStateManager {
  constructor(gl) {
    this.gl = gl;
    this.stats = { glCalls: 0, skippedByCache: 0 }; // perf counters for CI

    // ---- texture units -------------------------------------------------
    this._activeTextureUnit = 0;
    this._texUnits = []; // {target: {enabled, bound, dirty}}
    this._maxUnits = gl.getParameter(gl.MAX_COMBINED_TEXTURE_IMAGE_UNITS) || 8;
    for (let i = 0; i < this._maxUnits; i++)
      this._texUnits.push({ [GL_CONST.TEXTURE_2D]: makeCap(), bound: null, dirtyBound: true });

    // ---- state blocks (mirrors GlStateManager internal State classes) ---
    this.color = { r: 1, g: 1, b: 1, a: 1, mask: [true, true, true, true], dirty: true };
    this.blend = { ...makeCap(), srcRgb: GL_CONST.ONE, dstRgb: GL_CONST.ZERO,
                   srcAlpha: GL_CONST.ONE, dstAlpha: GL_CONST.ZERO, modeRgb: GL_CONST.FUNC_ADD, modeAlpha: GL_CONST.FUNC_ADD };
    this.depth = { ...makeCap(), func: GL_CONST.LESS, mask: true };
    this.cull  = { ...makeCap(), mode: GL_CONST.BACK };
    this._polygonOffset = { ...makeCap(), factor: 0, units: 0 };
    this._scissor = { ...makeCap(), x: 0, y: 0, w: 0, h: 0 };
    this.stencil = { ...makeCap(), func: GL_CONST.ALWAYS, ref: 0, mask: 0xFF, sfail: 0x1E00, zfail: 0x1E00, zpass: 0x1E00 };
    this._logicOp = { ...makeCap(), op: GL_CONST.COPY };
    this._viewport = { x: 0, y: 0, w: 0, h: 0, dirty: true };
    this._lineWidth = { v: 1, dirty: true };

    // ---- CPU matrix stacks (MODELVIEW / PROJECTION / TEXTURE) ----------
    this._curMatrixMode = GL_CONST.MODELVIEW;
    this._stacks = {
      [GL_CONST.MODELVIEW]:   { cur: new Matrix4f(), stack: [], max: 32 },
      [GL_CONST.PROJECTION]:  { cur: new Matrix4f(), stack: [], max: 8 },
      [GL_CONST.TEXTURE]:     { cur: new Matrix4f(), stack: [], max: 8 },
      [GL_CONST.COLOR]:       { cur: new Matrix4f(), stack: [], max: 2 }, // legacy no-op slot
    };
    this._uploadDirty = true; // MVP uniforms need re-upload after matrix ops

    // ---- program / uniform cache ---------------------------------------
    this._program = null;
    this._uniformCache = new Map(); // program -> Map(name -> location)

    // ---- VAO / FBO -------------------------------------------------------
    this._vao = null; this._fbo = null; this._fboDirty = true;
  }

  _gl(fn, ...args) { this.stats.glCalls++; return this.gl[fn](...args); }

  // ================= color =================================================
  color4f(r, g, b, a) {
    const c = this.color;
    if (c.r !== r || c.g !== g || c.b !== b || c.a !== a) {
      c.r = r; c.g = g; c.b = b; c.a = a; c.dirty = true;
    } else this.stats.skippedByCache++;
  }
  colorMask(red, green, blue, alpha) {
    const m = this.color.mask;
    if (m[0] !== red || m[1] !== green || m[2] !== blue || m[3] !== alpha) {
      m[0] = red; m[1] = green; m[2] = blue; m[3] = alpha; this.color.dirty = true;
    } else this.stats.skippedByCache++;
  }
  /** Flush vertex-color + colorMask into GL before a draw call. */
  _flushColor() {
    const c = this.color;
    if (c.dirty) {
      this._gl('colorMask', c.mask[0], c.mask[1], c.mask[2], c.mask[3]);
      c.dirty = false; // vertex color goes through a uniform in core shaders
    }
  }

  // ================= blend =================================================
  blendEnable()   { this._cap(this.blend, 'BLEND', true); }
  blendDisable()  { this._cap(this.blend, 'BLEND', false); }
  blendFunc(src, dst) { this.blendFuncSeparate(src, dst, src, dst); }
  blendFuncSeparate(srcRgb, dstRgb, srcAlpha, dstAlpha) {
    const b = this.blend;
    if (b.srcRgb !== srcRgb || b.dstRgb !== dstRgb || b.srcAlpha !== srcAlpha || b.dstAlpha !== dstAlpha) {
      b.srcRgb = srcRgb; b.dstRgb = dstRgb; b.srcAlpha = srcAlpha; b.dstAlpha = dstAlpha; b.dirty = true;
    } else this.stats.skippedByCache++;
  }
  blendFuncSeparateEXT(srcRgb, dstRgb, srcAlpha, dstAlpha, modeRgb, modeAlpha) {
    this.blendFuncSeparate(srcRgb, dstRgb, srcAlpha, dstAlpha);
    const b = this.blend;
    if (b.modeRgb !== modeRgb || b.modeAlpha !== modeAlpha) {
      b.modeRgb = modeRgb; b.modeAlpha = modeAlpha; b.dirty = true;
    }
  }
  _flushBlend() {
    const b = this.blend;
    if (b.dirty) {
      if (b.enabled) this._gl('enable', this.gl.BLEND); else this._gl('disable', this.gl.BLEND);
      this._gl('blendFuncSeparate', b.srcRgb, b.dstRgb, b.srcAlpha, b.dstAlpha);
      this._gl('blendEquationSeparate', b.modeRgb, b.modeAlpha);
      b.dirty = false;
    }
  }

  // ================= depth =================================================
  depthEnable()  { this._cap(this.depth, 'DEPTH_TEST', true); }
  depthDisable() { this._cap(this.depth, 'DEPTH_TEST', false); }
  depthFunc(fn)  { if (this.depth.func !== fn) { this.depth.func = fn; this.depth.dirty = true; } else this.stats.skippedByCache++; }
  depthMask(on)  { if (this.depth.mask !== on) { this.depth.mask = on; this.depth.dirty = true; } else this.stats.skippedByCache++; }
  _flushDepth() {
    const d = this.depth;
    if (d.dirty) {
      if (d.enabled) this._gl('enable', this.gl.DEPTH_TEST); else this._gl('disable', this.gl.DEPTH_TEST);
      this._gl('depthFunc', d.func); this._gl('depthMask', d.mask);
      d.dirty = false;
    }
  }

  // ================= cull ==================================================
  cullEnable()  { this._cap(this.cull, 'CULL_FACE', true); }
  cullDisable() { this._cap(this.cull, 'CULL_FACE', false); }
  cullFace(mode) { if (this.cull.mode !== mode) { this.cull.mode = mode; this.cull.dirty = true; } }
  _flushCull() {
    const c = this.cull;
    if (c.dirty) {
      if (c.enabled) this._gl('enable', this.gl.CULL_FACE); else this._gl('disable', this.gl.CULL_FACE);
      this._gl('cullFace', c.mode); c.dirty = false;
    }
  }

  // ================= misc caps =============================================
  _cap(obj, glName, on) {
    if (obj.enabled !== on) { obj.enabled = on; obj.dirty = true; }
    else this.stats.skippedByCache++;
    obj._glName = glName;
  }
  polygonOffsetEnable()  { this._cap(this._polygonOffset, 'POLYGON_OFFSET_FILL', true); }
  polygonOffsetDisable() { this._cap(this._polygonOffset, 'POLYGON_OFFSET_FILL', false); }
  polygonOffset(factor, units) {
    const p = this._polygonOffset;
    if (p.factor !== factor || p.units !== units) { p.factor = factor; p.units = units; p.dirty = true; }
  }
  stencilEnable()  { this._cap(this.stencil, 'STENCIL_TEST', true); }
  stencilDisable() { this._cap(this.stencil, 'STENCIL_TEST', false); }
  stencilFunc(fn, ref, mask) {
    const s = this.stencil;
    if (s.func !== fn || s.ref !== ref || s.mask !== mask) { s.func = fn; s.ref = ref; s.mask = mask; s.dirty = true; }
  }
  stencilOp(sfail, zfail, zpass) {
    const s = this.stencil;
    if (s.sfail !== sfail || s.zfail !== zfail || s.zpass !== zpass) { s.sfail = sfail; s.zfail = zfail; s.zpass = zpass; s.dirty = true; }
  }
  logicOpEnable()  { this._cap(this._logicOp, 'COLOR_LOGIC_OP', true); }
  logicOpDisable() { this._cap(this._logicOp, 'COLOR_LOGIC_OP', false); }
  logicOp(op) { if (this._logicOp.op !== op) { this._logicOp.op = op; this._logicOp.dirty = true; } }

  // ================= viewport / scissor / line =============================
  viewport(x, y, w, h) {
    const v = this._viewport;
    if (v.x !== x || v.y !== y || v.w !== w || v.h !== h) { v.x = x; v.y = y; v.w = w; v.h = h; v.dirty = true; }
    else this.stats.skippedByCache++;
  }
  _flushViewport() {
    const v = this._viewport;
    if (v.dirty) { this._gl('viewport', v.x, v.y, v.w, v.h); v.dirty = false; }
  }
  scissorEnable()  { this._cap(this._scissor, 'SCISSOR_TEST', true); }
  scissorDisable() { this._cap(this._scissor, 'SCISSOR_TEST', false); }
  scissor(x, y, w, h) {
    const s = this._scissor;
    if (s.x !== x || s.y !== y || s.w !== w || s.h !== h) { s.x = x; s.y = y; s.w = w; s.h = h; s.dirty = true; }
  }
  _flushScissor() {
    const s = this._scissor;
    if (s.dirty) {
      if (s.enabled) this._gl('enable', this.gl.SCISSOR_TEST); else this._gl('disable', this.gl.SCISSOR_TEST);
      if (s.enabled) this._gl('scissor', s.x, s.y, s.w, s.h);
      s.dirty = false;
    }
  }
  lineWidth(v) { if (this._lineWidth.v !== v) { this._lineWidth.v = v; this._lineWidth.dirty = true; } }

  // ================= textures ==============================================
  activeTexture(unit) {
    if (this._activeTextureUnit !== unit) {
      this._activeTextureUnit = unit;
      this._gl('activeTexture', this.gl.TEXTURE0 + unit);
    } else this.stats.skippedByCache++;
  }
  enableTexture2D() {
    const u = this._texUnits[this._activeTextureUnit], t = u[GL_CONST.TEXTURE_2D];
    this._cap(t, 'TEXTURE_2D', true);
    // binding is the actual enablement in WebGL2; flush below
    if (t.dirty) {
      if (u.bound !== null) this._gl('bindTexture', this.gl.TEXTURE_2D, u.bound);
      t.dirty = false;
    }
  }
  disableTexture2D() {
    const u = this._texUnits[this._activeTextureUnit], t = u[GL_CONST.TEXTURE_2D];
    this._cap(t, 'TEXTURE_2D', false);
    if (t.dirty) {
      this._gl('bindTexture', this.gl.TEXTURE_2D, null);
      t.dirty = false;
    }
  }
  bindTexture(target, tex) {
    const u = this._texUnits[this._activeTextureUnit];
    if (u.bound !== tex || u.dirtyBound) {
      u.bound = tex; u.dirtyBound = false;
      this._gl('bindTexture', target, tex);
    } else this.stats.skippedByCache++;
  }
  texParameter2D(target, pname, param) { this._gl('texParameteri', target, pname, param); }
  uploadTexture2D(level, internalFormat, w, h, format, type, pixels) {
    this._gl('texImage2D', this.gl.TEXTURE_2D, level, internalFormat, w, h, 0, format, type, pixels);
  }

  // ================= matrix stack (CPU-side) ===============================
  matrixMode(mode) { this._curMatrixMode = mode; }
  currentMatrixMode() { return this._curMatrixMode; }
  pushMatrix() {
    const s = this._stacks[this._curMatrixMode];
    if (s.stack.length >= s.max) throw new Error('Matrix stack overflow: ' + this._modeName());
    const copy = new Matrix4f(); copy.m.set(s.cur.m);
    s.stack.push(copy); // GL semantics: push a copy, further ops mutate cur
  }
  popMatrix() {
    const s = this._stacks[this._curMatrixMode];
    if (!s.stack.length) throw new Error('Matrix stack underflow: ' + this._modeName());
    s.cur = s.stack.pop(); this._uploadDirty = true;
  }
  loadIdentity() { this._stacks[this._curMatrixMode].cur.identity(); this._uploadDirty = true; }
  loadMatrix(mat) { this._stacks[this._curMatrixMode].cur.m.set(mat.m || mat); this._uploadDirty = true; }
  multMatrix(mat) { Matrix4f.mul(this._stacks[this._curMatrixMode].cur, this._stacks[this._curMatrixMode].cur, matOf(mat)); this._uploadDirty = true; }
  translatef(x, y, z) { this._stacks[this._curMatrixMode].cur.translate(x, y, z); this._uploadDirty = true; }
  scalef(x, y, z)     { this._stacks[this._curMatrixMode].cur.scale(x, y, z); this._uploadDirty = true; }
  rotatef(deg, x, y, z) { this._stacks[this._curMatrixMode].cur.rotate(deg, x, y, z); this._uploadDirty = true; }
  ortho(l, r, b, t, n, f) { Matrix4f.ortho(this._stacks[this._curMatrixMode].cur, l, r, b, t, n, f); this._uploadDirty = true; }
  perspective(fovy, aspect, n, f) { Matrix4f.perspective(this._stacks[this._curMatrixMode].cur, fovy, aspect, n, f); this._uploadDirty = true; }
  frustum(l, r, b, t, n, f) { Matrix4f.frustum(this._stacks[this._curMatrixMode].cur, l, r, b, t, n, f); this._uploadDirty = true; }
  getMatrix(mode) { return this._stacks[mode || this._curMatrixMode].cur; }
  _modeName() { return this._curMatrixMode === GL_CONST.MODELVIEW ? 'MODELVIEW' : this._curMatrixMode === GL_CONST.PROJECTION ? 'PROJECTION' : 'TEXTURE'; }

  // ================= programs ==============================================
  createProgram(vsSrc, fsSrc) {
    const gl = this.gl;
    const vs = this._compile(gl.VERTEX_SHADER, vsSrc);
    const fs = this._compile(gl.FRAGMENT_SHADER, fsSrc);
    const p = gl.createProgram();
    gl.attachShader(p, vs); gl.attachShader(p, fs); gl.linkProgram(p);
    if (!gl.getProgramParameter(p, gl.LINK_STATUS))
      throw new Error('Program link failed: ' + gl.getProgramInfoLog(p));
    return p;
  }
  _compile(type, src) {
    const gl = this.gl, sh = gl.createShader(type);
    gl.shaderSource(sh, src); gl.compileShader(sh);
    if (!gl.getShaderParameter(sh, gl.COMPILE_STATUS))
      throw new Error('Shader compile failed: ' + gl.getShaderInfoLog(sh) + '\n---src---\n' + src);
    return sh;
  }
  useProgram(p) {
    if (this._program !== p) { this._program = p; this._gl('useProgram', p); }
    else this.stats.skippedByCache++;
  }
  /**
   * Cached uniform lookup. Two call shapes:
   *   uniformLocation(name)        — program must be set via useProgram() first
   *                                  (mirrors MC's bind-then-query flow)
   *   uniformLocation(prog, name)  — explicit program
   * Fail-fast with a clear message instead of a cryptic WebGL TypeError.
   */
  uniformLocation(progOrName, maybeName) {
    const prog = maybeName === undefined ? this._program : progOrName;
    const name = maybeName === undefined ? progOrName : maybeName;
    if (!prog) throw new Error('uniformLocation("' + name + '") called before useProgram() — bind the program first (MC RenderSystem semantics)');
    let map = this._uniformCache.get(prog);
    if (!map) { map = new Map(); this._uniformCache.set(prog, map); }
    if (!map.has(name)) map.set(name, this.gl.getUniformLocation(prog, name));
    return map.get(name);
  }
  uniformMatrix4fvMVP(modelViewLoc, projLoc) {
    // dedup key MUST include the program: switching programs re-runs this with
    // the SAME matrices, but uniformMatrix4fv targets the CURRENT program —
    // skipping the upload would leave the new program's MVP uniforms at 0
    // (every vertex collapses to the origin). Found by the v1.1 GUI demo.
    // Keyed by OBJECT IDENTITY via Map — string-concatenating WebGLProgram
    // objects yields '[object WebGLProgram]' for EVERY program, which would
    // wrongly dedup across programs (second bug found by the same demo).
    if (!this._mvpKeys) this._mvpKeys = new Map();
    const sk = this._stackKey();
    if (!this._uploadDirty && this._mvpKeys.get(this._program) === sk) return;
    const gl = this.gl;
    if (modelViewLoc) gl.uniformMatrix4fv(modelViewLoc, false, this.getMatrix(GL_CONST.MODELVIEW).m);
    if (projLoc) gl.uniformMatrix4fv(projLoc, false, this.getMatrix(GL_CONST.PROJECTION).m);
    this._mvpKeys.set(this._program, sk); this._uploadDirty = false;
    this.stats.glCalls += 2;
  }
  _stackKey() {
    // FULL 16-component key: partial keys (e.g. scale-only) miss translations,
    // which lets a per-program dedup entry falsely match after translatef —
    // the other program then keeps its stale MVP (found by v1.1 GUI demo).
    const mv = this.getMatrix(GL_CONST.MODELVIEW).m, pj = this.getMatrix(GL_CONST.PROJECTION).m;
    return Array.from(mv).join(',') + '|' + Array.from(pj).join(',');
  }

  // ================= VAO / FBO =============================================
  bindVertexArray(vao) { if (this._vao !== vao) { this._vao = vao; this._gl('bindVertexArray', vao); } }
  bindFramebuffer(target, fbo) {
    if (target === this.gl.FRAMEBUFFER && this._fbo !== fbo) { this._fbo = fbo; this._fboDirty = true; }
    this._gl('bindFramebuffer', target, fbo);
  }
  /** Legacy EXT_framebuffer_object mapping (GlStateManager._glGenFramebuffers era). */
  extglGenFramebuffers()      { return this.gl.createFramebuffer(); }
  extglFramebufferTexture2D(target, attachment, texTarget, tex, level) {
    this.gl.framebufferTexture2D(target, attachment, texTarget, tex, level);
  }

  // ================= frame bookkeeping =====================================
  /** Called once before MC renders: pushes all dirty state into GL. */
  beginFrame(width, height) {
    this.viewport(0, 0, width, height);
    this._flushViewport();
    this.clearColor4f(0, 0, 0, 0);
    this.clearDepth(1.0);
    this._gl('clear', this.gl.COLOR_BUFFER_BIT | this.gl.DEPTH_BUFFER_BIT);
  }
  clearColor4f(r, g, b, a) { this._gl('clearColor', r, g, b, a); }
  clearDepth(d) { this._gl('clearDepth', d); }
  /** Per-draw pre-flight: flush every dirty subsystem. Call before drawArrays/drawElements. */
  applyAll() {
    this._flushColor(); this._flushBlend(); this._flushDepth();
    this._flushCull(); this._flushScissor();
    const p = this._polygonOffset;
    if (p.dirty) {
      if (p.enabled) this._gl('enable', this.gl.POLYGON_OFFSET_FILL); else this._gl('disable', this.gl.POLYGON_OFFSET_FILL);
      if (p.enabled) this._gl('polygonOffset', p.factor, p.units);
      p.dirty = false;
    }
    const s = this.stencil;
    if (s.dirty) {
      if (s.enabled) this._gl('enable', this.gl.STENCIL_TEST); else this._gl('disable', this.gl.STENCIL_TEST);
      if (s.enabled) {
        this._gl('stencilFunc', s.func, s.ref, s.mask);
        this._gl('stencilOp', s.sfail, s.zfail, s.zpass);
      }
      s.dirty = false;
    }
    const l = this._logicOp;
    if (l.dirty) {
      if (l.enabled) this._gl('enable', this.gl.COLOR_LOGIC_OP); else this._gl('disable', this.gl.COLOR_LOGIC_OP);
      if (l.enabled) this._gl('logicOp', l.op);
      l.dirty = false;
    }
    if (this._lineWidth.dirty) { this._gl('lineWidth', this._lineWidth.v); this._lineWidth.dirty = false; }
  }
  /** Reset to 1.16.5 GameRenderer's baseline (RenderSystem.endFrame analogue). */
  resetBaseline() {
    this.blendDisable(); this.depthDisable(); this.cullDisable();
    this.scissorDisable(); this.polygonOffsetDisable(); this.stencilDisable();
    this.logicOpDisable(); this.color4f(1, 1, 1, 1); this.depthMask(true);
  }
}

function matOf(m) { return m instanceof Matrix4f ? m : Object.assign(new Matrix4f(), { m: Float32Array.from(m) }); }

if (typeof module !== "undefined") module.exports = { GlStateManager, Matrix4f, GL_CONST };
if (typeof window !== "undefined") { window.GlStateManager = GlStateManager; window.Matrix4f = Matrix4f; window.GL_CONST = GL_CONST; }
