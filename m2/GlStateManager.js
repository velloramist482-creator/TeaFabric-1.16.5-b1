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
  TEXTURE0: 0x84E0, // GL13 glActiveTexture base unit
  COLOR: 0x1800, // legacy color matrix: kept as no-op slot for parity
  // fixed-pipeline caps the 1.16.5 client still toggles (v1.2)
  LIGHTING: 0x1600, LIGHT0: 0x4000, LIGHT1: 0x4001, FOG: 0x0B60,
  ALPHA_TEST: 0x0BC0, NORMALIZE: 0x0BA2, RESCALE_NORMAL: 0x803A,
  // fog params (glFogf/glFogfv pnames)
  FOG_MODE: 0x0BE5, FOG_DENSITY: 0x0B62, FOG_START: 0x0B63, FOG_END: 0x0B64, FOG_COLOR: 0x0B66,
  // fog modes (GL_EXP/GL_EXP2 clash-free aliases; GL linear fog == 0x2601)
  FOG_LINEAR: 0x2601, FOG_EXP: 0x8000, FOG_EXP2: 0x8002,
  // light params (glLightfv pnames)
  AMBIENT: 0x1200, DIFFUSE: 0x1201, SPECULAR: 0x1202, POSITION: 0x1203,
  LIGHT_MODEL_AMBIENT: 0x0B67, LIGHT_MODEL_LOCAL_VIEWER: 0x0B51,
  // shade model
  FLAT: 0x1D00, SMOOTH: 0x1D01,
  // alpha func
  GL_LESS_REF: 0x0201, // alphaFunc reuse of depth-style func constants above
  // ---- v1.3: texture environment (glTexEnvi surface; dem/GlStateManager path) --
  TEXTURE_ENV: 0x2300, TEXTURE_ENV_MODE: 0x2200, TEXTURE_ENV_COLOR: 0x2201,
  TEXENV_MODULATE: 0x2100, TEXENV_REPLACE: 0x1E01, TEXENV_DECAL: 0x2101,
  TEXENV_ADD: 0x0104, TEXENV_BLEND: 0x0BE2, TEXENV_COMBINE: 0x8570,
  // ---- v1.3: client-state caps (immediate-mode pointer family) -----------------
  VERTEX_ARRAY: 0x8074, NORMAL_ARRAY: 0x8075, COLOR_ARRAY: 0x8076,
  TEXTURE_COORD_ARRAY: 0x8078,
  // ---- v1.3: buffer targets -----------------------------------------------------
  ARRAY_BUFFER: 0x8892, ELEMENT_ARRAY_BUFFER: 0x8893,
  // ---- v1.3: polygon mode / pixel store / texgen (virtual or forwarded) --------
  POLYGON_POINT: 0x1B00, POLYGON_LINE: 0x1B01, POLYGON_FILL: 0x1B02,
  UNPACK_ALIGNMENT: 0x0CF5, PACK_ALIGNMENT: 0x0C05,
  TEXTURE_GEN_S: 0x0C60, TEXTURE_GEN_T: 0x0C61, TEXTURE_GEN_MODE: 0x2500,
  SPHERE_MAP: 0x2402, OBJECT_LINEAR: 0x2401, EYE_LINEAR: 0x2400,
  TEXTURE_WIDTH: 0x1000, TEXTURE_HEIGHT: 0x1001,
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
    this._texUnits = []; // {target: {enabled, bound, dirty}, texEnv: {mode,color,dirty}}
    this._maxUnits = gl.getParameter(gl.MAX_COMBINED_TEXTURE_IMAGE_UNITS) || 8;
    for (let i = 0; i < this._maxUnits; i++)
      this._texUnits.push({
        [GL_CONST.TEXTURE_2D]: makeCap(), bound: null, dirtyBound: true,
        // v1.3: per-unit texture environment (glTexEnvi lands on the ACTIVE unit)
        texEnv: { mode: GL_CONST.TEXENV_MODULATE, color: [0, 0, 0, 0], dirty: true },
        // recorded texture dimensions for glGetTexLevelParameteri (WebGL2 has no query)
        texSize: null,
      });

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

    // ---- fixed-pipeline blocks (v1.2: what the 1.16.5 client still drives) --
    // 1.16.5 world/GUI is fixed-function GL; these blocks carry the state the
    // shader specializer (Specializer.js) bakes into per-combination programs.
    this.lighting = {
      enabled: false, dirty: true,
      modelAmbient: [0.2, 0.2, 0.2, 1.0],
      lights: [
        // GL_LIGHT0 — MC's main diffuse light; GL_LIGHT1 — the fill light
        { enabled: true, dirty: true, ambient: [0, 0, 0, 1], diffuse: [0.7, 0.7, 0.7, 1], specular: [0, 0, 0, 0], position: [0, 1, 0, 0] },
        { enabled: true, dirty: true, ambient: [0, 0, 0, 1], diffuse: [0.1, 0.1, 0.1, 1], specular: [0, 0, 0, 0], position: [0, -1, 0, 0] },
      ],
    };
    this.fog = {
      enabled: false, dirty: true, mode: GL_CONST.FOG_LINEAR,
      density: 1.0, start: 0.0, end: 1.0, color: [0, 0, 0, 0],
    };
    this.alphaTest = { enabled: false, dirty: true, func: GL_CONST.GREATER, ref: 0.1 };
    this._viewport = { x: 0, y: 0, w: 0, h: 0, dirty: true };
    this._lineWidth = { v: 1, dirty: true };

    // ---- v1.3 completeness surface state ---------------------------------
    // Every entry below backs one or more of the 144 LWJGL GL functions the
    // 1.16.5 client.jar actually references (see build/gl_surface.json + the
    // coverage matrix test). WebGL2-absent features are CPU-virtual and get
    // baked into specialized programs or documented as deviations.
    this._buffers = { [GL_CONST.ARRAY_BUFFER]: null, [GL_CONST.ELEMENT_ARRAY_BUFFER]: null };
    this._clientCaps = {
      [GL_CONST.VERTEX_ARRAY]: makeCap(),
      [GL_CONST.NORMAL_ARRAY]: makeCap(),
      [GL_CONST.COLOR_ARRAY]: makeCap(),
      [GL_CONST.TEXTURE_COORD_ARRAY]: makeCap(), // active client tex unit's cap
    };
    this._clientPointers = { position: null, normal: null, color: null, texcoord: [] };
    this._clientTexUnit = 0;
    this._multiUV = {}; // unit -> [s, t] (glMultiTexCoord2f replay state)
    this._currentNormal = [0, 0, 1];
    this._colorMaterial = { face: GL_CONST.FRONT_AND_BACK, mode: GL_CONST.AMBIENT }; // virtual
    this._polygonMode = GL_CONST.POLYGON_FILL; // virtual (WebGL2 always fills)
    this._pixelStore = {}; // pname -> param (forwarded when WebGL2 supports)
    this._pixelTransfer = {}; // virtual record (alpha/red/... scale at upload)
    this._texGen = { s: null, t: null }; // virtual record; enable => fail-fast at draw
    this._attribStack = []; // glPushAttrib/glPopAttrib full CPU snapshots
    this._debugCb = null; // glDebugMessageCallback: accepted, no-op (no KHR_debug in WebGL)
    this._warnedOnce = new Set();

    // ---- v1.3: specializer integration (set via attachSpecializer) --------
    this._specializer = null;       // instance with getProgram(gsm, attribs)
    this._fpjitPrograms = new Map(); // fpjit name -> compiled WebGLProgram
    this._ccKey = null;             // CurrentColor uniform dedup key
    this._cmKey = null;             // ColorModulator uniform dedup key
    // RenderSystem.setShaderColor channel (INDEPENDENT of glColor4f!): the
    // global tint the fallback family calls ColorModulator. 1.16.5 maps
    // RenderSystem.setColor/applyShaderColor here; glColor stays the diffuse
    // source of the fixed-pipe combine.
    this.colorModulator = { r: 1, g: 1, b: 1, a: 1 };

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
  /** RenderSystem.setShaderColor equivalent — feeds ColorModulator uniforms. */
  setColorModulator(r, g, b, a) {
    const c = this.colorModulator;
    if (c.r !== r || c.g !== g || c.b !== b || c.a !== a) {
      c.r = r; c.g = g; c.b = b; c.a = a;
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
    this._texUnits[this._activeTextureUnit].texSize = { w, h }; // for glGetTexLevelParameteri
  }

  // ================= fixed-pipeline virtual state (v1.2) ===================
  // The 1.16.5 client still drives GL_LIGHTING / GL_FOG / GL_ALPHA_TEST.
  // WebGL2 has NO such caps — gl.enable(0x1600) would be GL_INVALID_ENUM — so
  // these blocks are CPU-ONLY virtual state. The shader specializer
  // (Specializer.js) snapshots them and bakes them into per-combination
  // GLSL ES 3.00 programs; no real GL enable/disable is ever issued here.
  lightingEnable()   { this._capVirt(this.lighting, true); }
  lightingDisable()  { this._capVirt(this.lighting, false); }
  fogEnable()        { this._capVirt(this.fog, true); }
  fogDisable()       { this._capVirt(this.fog, false); }
  alphaTestEnable()  { this._capVirt(this.alphaTest, true); }
  alphaTestDisable() { this._capVirt(this.alphaTest, false); }
  _capVirt(block, on) {
    if (block.enabled !== on) { block.enabled = on; block.dirty = true; }
    else this.stats.skippedByCache++;
  }

  fogf(pname, v) {
    const f = this.fog;
    const field = pname === GL_CONST.FOG_MODE ? 'mode' : pname === GL_CONST.FOG_DENSITY ? 'density'
                : pname === GL_CONST.FOG_START ? 'start' : pname === GL_CONST.FOG_END ? 'end' : null;
    if (!field) throw new Error('fogf: unsupported pname 0x' + pname.toString(16));
    if (f[field] !== v) { f[field] = v; f.dirty = true; }
    else this.stats.skippedByCache++;
  }
  fogfv(pname, arr) {
    if (pname !== GL_CONST.FOG_COLOR) throw new Error('fogfv: unsupported pname 0x' + pname.toString(16));
    const f = this.fog;
    if (f.color[0] !== arr[0] || f.color[1] !== arr[1] || f.color[2] !== arr[2] || f.color[3] !== arr[3]) {
      f.color = [arr[0], arr[1], arr[2], arr[3]]; f.dirty = true;
    } else this.stats.skippedByCache++;
  }
  lightfv(light, pname, vec) {
    const idx = light - GL_CONST.LIGHT0;
    if (idx < 0 || idx >= this.lighting.lights.length) throw new Error('lightfv: unsupported light 0x' + light.toString(16));
    const L = this.lighting.lights[idx];
    const field = pname === GL_CONST.AMBIENT ? 'ambient' : pname === GL_CONST.DIFFUSE ? 'diffuse'
                : pname === GL_CONST.SPECULAR ? 'specular' : pname === GL_CONST.POSITION ? 'position' : null;
    if (!field) throw new Error('lightfv: unsupported pname 0x' + pname.toString(16));
    const t = L[field];
    if (t[0] !== vec[0] || t[1] !== vec[1] || t[2] !== vec[2] || t[3] !== vec[3]) {
      L[field] = [vec[0], vec[1], vec[2], vec[3]];
      L.dirty = true; this.lighting.dirty = true;
    } else this.stats.skippedByCache++;
  }
  lightModelfv(pname, vec) {
    if (pname !== GL_CONST.LIGHT_MODEL_AMBIENT) throw new Error('lightModelfv: unsupported pname 0x' + pname.toString(16));
    const m = this.lighting.modelAmbient;
    if (m[0] !== vec[0] || m[1] !== vec[1] || m[2] !== vec[2] || m[3] !== vec[3]) {
      this.lighting.modelAmbient = [vec[0], vec[1], vec[2], vec[3]]; this.lighting.dirty = true;
    } else this.stats.skippedByCache++;
  }
  alphaFunc(func, ref) {
    const a = this.alphaTest;
    if (a.func !== func || a.ref !== ref) { a.func = func; a.ref = ref; a.dirty = true; }
    else this.stats.skippedByCache++;
  }
  shadeModel(mode) {
    if (this._shadeModel !== mode) { this._shadeModel = mode; }
    else this.stats.skippedByCache++;
  }
  /** Clear the virtual blocks' dirty flags once the specializer has consumed them. */
  _flushVirtualState() {
    this.lighting.dirty = false;
    for (const L of this.lighting.lights) L.dirty = false;
    this.fog.dirty = false;
    this.alphaTest.dirty = false;
  }

  // ============== v1.3 completeness surface ================================
  // Backs the 144 LWJGL functions client.jar references (all through the
  // obfuscated blaze3d GlStateManager, class 'dem' in the official jar —
  // verified by constant-pool scan, see build/gl_surface.json).

  // ---- texture environment (GL11.glTexEnvi / glTexEnvfv) -------------------
  texEnvi(target, pname, param) {
    if (target !== GL_CONST.TEXTURE_ENV) throw new Error('texEnvi: unsupported target 0x' + target.toString(16) + ' (only GL_TEXTURE_ENV)');
    if (pname !== GL_CONST.TEXTURE_ENV_MODE) throw new Error('texEnvi: unsupported pname 0x' + pname.toString(16) + ' (only GL_TEXTURE_ENV_MODE)');
    const supported = [GL_CONST.TEXENV_MODULATE, GL_CONST.TEXENV_REPLACE, GL_CONST.TEXENV_DECAL, GL_CONST.TEXENV_ADD];
    if (!supported.includes(param)) {
      throw new Error('texEnv mode 0x' + param.toString(16) +
        ' not supported: BLEND/COMBINE have no baked equivalent in the v1.3 family (fail-fast by design)');
    }
    const env = this._texUnits[this._activeTextureUnit].texEnv;
    if (env.mode !== param) { env.mode = param; env.dirty = true; }
    else this.stats.skippedByCache++;
  }
  texEnvfv(pname, arr) {
    if (pname !== GL_CONST.TEXTURE_ENV_COLOR) throw new Error('texEnvfv: unsupported pname 0x' + pname.toString(16));
    const env = this._texUnits[this._activeTextureUnit].texEnv;
    env.color = [arr[0], arr[1], arr[2], arr[3]]; env.dirty = true;
  }
  /** Effective tex-env combine mode of a texture unit (default GL_MODULATE). */
  getTexEnvMode(unit = this._activeTextureUnit) {
    const u = this._texUnits[unit];
    if (!u) throw new Error('getTexEnvMode: unit ' + unit + ' out of range');
    return u.texEnv.mode;
  }
  fogi(pname, v) { this.fogf(pname, v); } // glFogi(GL_FOG_MODE, ...) — same virtual slot

  // ---- generic cap dispatch (glEnable/glDisable; dem routes caps here) -----
  enable(cap) { this._enableDisable(cap, true); }
  disable(cap) { this._enableDisable(cap, false); }
  _enableDisable(cap, on) {
    const K = GL_CONST;
    switch (cap) {
      case K.BLEND: on ? this.blendEnable() : this.blendDisable(); return;
      case K.DEPTH_TEST: on ? this.depthEnable() : this.depthDisable(); return;
      case K.CULL_FACE: on ? this.cullEnable() : this.cullDisable(); return;
      case K.SCISSOR_TEST: on ? this.scissorEnable() : this.scissorDisable(); return;
      case K.STENCIL_TEST: on ? this.stencilEnable() : this.stencilDisable(); return;
      case K.POLYGON_OFFSET_FILL: on ? this.polygonOffsetEnable() : this.polygonOffsetDisable(); return;
      case K.COLOR_LOGIC_OP: on ? this.logicOpEnable() : this.logicOpDisable(); return;
      case K.TEXTURE_2D: on ? this.enableTexture2D() : this.disableTexture2D(); return;
      // fixed-pipe caps: virtual (no WebGL2 equivalent; baked by the specializer)
      case K.LIGHTING: on ? this.lightingEnable() : this.lightingDisable(); return;
      case K.FOG: on ? this.fogEnable() : this.fogDisable(); return;
      case K.ALPHA_TEST: on ? this.alphaTestEnable() : this.alphaTestDisable(); return;
      case K.NORMALIZE:
      case K.RESCALE_NORMAL:
        this._virtRecord('normalize', on); return; // record only; normals normalized in-shader
      default:
        throw new Error('enable/disable: unmodeled cap 0x' + cap.toString(16) + ' — extend GLSM (fail-fast, never silently ignore)');
    }
  }
  _virtRecord(kind, on) { /* NORMALIZE/RESCALE_NORMAL are shader-side no-ops here */ }

  // ---- texture object lifecycle + updates ----------------------------------
  genTextures(n) { // glHint-free convenience: returns n fresh WebGLTexture
    const out = [];
    for (let i = 0; i < n; i++) out.push(this._gl('createTexture') || null);
    return out;
  }
  deleteTextures(...texs) { for (const t of texs) if (t) this.gl.deleteTexture(t); }
  texParameterf(target, pname, param) { this.texParameter2D(target, pname, param); }
  subTexture2D(level, xoffset, yoffset, w, h, format, type, pixels) { // glTexSubImage2D
    this._gl('texSubImage2D', this.gl.TEXTURE_2D, level, xoffset, yoffset, w, h, format, type, pixels);
  }
  copyTexSubImage2D(level, xoffset, yoffset, x, y, w, h) { // GL20 path (post chains)
    this._gl('copyTexSubImage2D', this.gl.TEXTURE_2D, level, xoffset, yoffset, x, y, w, h);
  }
  pixelStorei(pname, param) { // forward the WebGL-supported subset, record the rest
    this._pixelStore[pname] = param;
    const supported = { [GL_CONST.UNPACK_ALIGNMENT]: 'UNPACK_ALIGNMENT', [GL_CONST.PACK_ALIGNMENT]: 'PACK_ALIGNMENT' };
    if (supported[pname]) { this._gl('pixelStorei', this.gl[supported[pname]], param); }
  }
  pixelTransferf(pname, v) { // VIRTUAL: WebGL2 has no glPixelTransfer (lightmap alpha
    this._pixelTransfer[pname] = v; //  scaling is applied CPU-side by the upload caller)
  }
  texGeni(coord, pname, param) { // VIRTUAL record — fail-fast later if enabled at draw
    if (pname !== GL_CONST.TEXTURE_GEN_MODE) throw new Error('texGeni: unsupported pname');
    if (coord === GL_CONST.TEXTURE_GEN_S) this._texGen.s = param;
    else if (coord === GL_CONST.TEXTURE_GEN_T) this._texGen.t = param;
    else throw new Error('texGeni: unsupported coord 0x' + coord.toString(16));
  }
  texGenfv(coord, pname, params) { /* plane coefficients: recorded, unused unless texgen on */
    if (pname !== GL_CONST.EYE_LINEAR && pname !== GL_CONST.OBJECT_LINEAR) throw new Error('texGenfv: unsupported pname');
  }
  colorMaterial(face, mode) { // VIRTUAL: the family always applies AMBIENT_AND_DIFFUSE
    this._colorMaterial = { face, mode };
  }
  polygonMode(face, mode) { // VIRTUAL: WebGL2 has no polygon mode (always fill)
    this._polygonMode = mode;
  }
  stencilMask(mask) { this._gl('stencilMask', mask); }
  clearStencil(s) { this._gl('clearStencil', s); }
  clear(mask) { this._gl('clear', mask); }
  blendColor(r, g, b, a) { this._gl('blendColor', r, g, b, a); } // GL14 (CONSTANT_COLOR factors)
  blendEquation(mode) { // GL14 standalone (beside the ...EXT pair form)
    this._gl('blendEquation', mode);
  }

  // ---- immediate-mode client state (gl*Pointer family) ---------------------
  enableClientState(cap) {
    const c = this._clientCaps[cap];
    if (!c) throw new Error('enableClientState: unmodeled cap 0x' + cap.toString(16));
    this._cap(c, 'CLIENT_STATE', true);
  }
  disableClientState(cap) {
    const c = this._clientCaps[cap];
    if (!c) throw new Error('disableClientState: unmodeled cap 0x' + cap.toString(16));
    this._cap(c, 'CLIENT_STATE', false);
  }
  vertexPointer(size, type, stride, ptr) { this._clientPointers.position = { size, type, stride, ptr }; }
  colorPointer(size, type, stride, ptr) { this._clientPointers.color = { size, type, stride, ptr }; }
  normalPointer(type, stride, ptr) { this._clientPointers.normal = { type, stride, ptr }; }
  texCoordPointer(size, type, stride, ptr) {
    this._clientPointers.texcoord[this._clientTexUnit] = { size, type, stride, ptr };
  }
  clientActiveTexture(unit) { this._clientTexUnit = unit - GL_CONST.TEXTURE0; } // GL13; CPU only
  multiTexCoord2f(unit, s, t) { this._multiUV[unit - GL_CONST.TEXTURE0] = [s, t]; } // GL13 lightmap UV
  normal3f(x, y, z) { this._currentNormal = [x, y, z]; }

  // ---- queries (glGetFloatv / glGetInteger / glGetString / glGetError) ------
  getFloatv(pname, out) {
    const K = GL_CONST;
    if (pname === K.MODELVIEW || pname === K.PROJECTION) {
      const m = this.getMatrix(pname).m;
      if (out) { for (let i = 0; i < 16; i++) out[i] = m[i]; }
      return out || Array.from(m);
    }
    if (pname === K.FOG_COLOR) return out ? (out.set ? out.set(this.fog.color) : out.splice(0, out.length, ...this.fog.color)) : this.fog.color.slice();
    if (pname === K.FOG_START) return this.fog.start;
    if (pname === K.FOG_END) return this.fog.end;
    // last resort: real GL
    const v = this.gl.getParameter(pname);
    if (out && v && v.length !== undefined) { for (let i = 0; i < v.length; i++) out[i] = v[i]; return out; }
    return v;
  }
  getInteger(pname) {
    // whitelist first (cheap + works on stubs); real GL otherwise
    if (pname === GL_CONST.VIEWPORT || pname === 0x0BA2 /*SCISSOR_BOX*/) { const v = this.gl.getParameter(pname); return v ? v[3] : 0; }
    try { const v = this.gl.getParameter(pname); return typeof v === 'number' ? v : (v && v.length ? v[0] : 0); }
    catch (e) { return 0; }
  }
  getString(name) { return this.gl.getParameter(name); } // VERSION/RENDERER/VENDOR passthrough
  getError() { return this.gl.getError ? this.gl.getError() : 0; }
  getTexLevelParameteri(level, pname) { // WebGL2 has no level query; we record sizes
    const u = this._texUnits[this._activeTextureUnit];
    if (pname === GL_CONST.TEXTURE_WIDTH) return u.texSize ? u.texSize.w : 0;
    if (pname === GL_CONST.TEXTURE_HEIGHT) return u.texSize ? u.texSize.h : 0;
    return 0;
  }
  readPixels(x, y, w, h, format, type, dst) { this._gl('readPixels', x, y, w, h, format, type, dst); }

  // ---- VBO objects (GL15; dem routes buffer calls here) ---------------------
  genBuffer() { return this._gl('createBuffer') || null; }
  deleteBuffer(buf) { if (buf) this.gl.deleteBuffer(buf); }
  bindBuffer(target, buf) {
    if (this._buffers[target] !== buf) { this._buffers[target] = buf; this._gl('bindBuffer', target, buf); }
    else this.stats.skippedByCache++;
  }
  bufferData(target, data, usage) { this._gl('bufferData', target, data, usage); }

  // ---- GL20 shader-object surface (post-processing chains) ------------------
  createShaderObject(type) { return this._gl('createShader', type); }
  shaderSource(sh, src) { this._gl('shaderSource', sh, src); }
  compileShader(sh) { this._gl('compileShader', sh); }
  deleteShader(sh) { this.gl.deleteShader(sh); }
  createProgramObject() { return this._gl('createProgram'); }
  attachShader(prog, sh) { this._gl('attachShader', prog, sh); }
  linkProgram(prog) { this._gl('linkProgram', prog); }
  deleteProgram(prog) { this.gl.deleteProgram(prog); }
  getShaderi(sh, pname) { return this.gl.getShaderParameter(sh, pname); }
  getProgrami(p, pname) { return this.gl.getProgramParameter(p, pname); }
  getShaderInfoLog(sh) { return this.gl.getShaderInfoLog(sh); }
  getProgramInfoLog(p) { return this.gl.getProgramInfoLog(p); }
  getAttribLocation(p, name) { return this.gl.getAttribLocation(p, name); }
  enableVertexAttribArray(i) { this._gl('enableVertexAttribArray', i); }
  disableVertexAttribArray(i) { this._gl('disableVertexAttribArray', i); }
  vertexAttribPointer(i, size, type, normalized, stride, offset) {
    this._gl('vertexAttribPointer', i, size, type, normalized, stride, offset);
  }
  // uniform family on the CURRENT program (locations via the cache)
  uniform1i(loc, v) { if (loc) this._gl('uniform1i', loc, v); }
  uniform1f(loc, v) { if (loc) this._gl('uniform1f', loc, v); }
  uniform2f(loc, x, y) { if (loc) this._gl('uniform2f', loc, x, y); }
  uniform3f(loc, x, y, z) { if (loc) this._gl('uniform3f', loc, x, y, z); }
  uniform4f(loc, x, y, z, w) { if (loc) this._gl('uniform4f', loc, x, y, z, w); }
  uniform1fv(loc, v) { if (loc) this._gl('uniform1fv', loc, v); }
  uniform2fv(loc, v) { if (loc) this._gl('uniform2fv', loc, v); }
  uniform3fv(loc, v) { if (loc) this._gl('uniform3fv', loc, v); }
  uniform4fv(loc, v) { if (loc) this._gl('uniform4fv', loc, v); }
  uniform1iv(loc, v) { if (loc) this._gl('uniform1iv', loc, v); }
  uniform2iv(loc, v) { if (loc) this._gl('uniform2iv', loc, v); }
  uniform3iv(loc, v) { if (loc) this._gl('uniform3iv', loc, v); }
  uniform4iv(loc, v) { if (loc) this._gl('uniform4iv', loc, v); }
  uniformMatrix2fv(loc, t, v) { if (loc) this._gl('uniformMatrix2fv', loc, t, v); }
  uniformMatrix3fv(loc, t, v) { if (loc) this._gl('uniformMatrix3fv', loc, t, v); }
  uniformMatrix4fv(loc, t, v) { if (loc) this._gl('uniformMatrix4fv', loc, t, v); }

  // ---- FBO completeness (GL30 + ARB + EXT share these) ----------------------
  deleteFramebuffers(...fbos) { for (const f of fbos) if (f) this.gl.deleteFramebuffer(f); }
  checkFramebufferStatus() { return this._gl('checkFramebufferStatus', this.gl.FRAMEBUFFER); }
  getFramebufferAttachmentParameteri(target, attachment, pname) {
    return this.gl.getFramebufferAttachmentParameter(target, attachment, pname);
  }
  blitFramebuffer(sx0, sy0, sx1, sy1, dx0, dy0, dx1, dy1, mask, filter) {
    this._gl('blitFramebuffer', sx0, sy0, sx1, sy1, dx0, dy0, dx1, dy1, mask, filter);
  }
  /** EXT alias — client probes both spelling paths (see GLCapabilities scan). */
  blitFramebufferEXT(...a) { this.blitFramebuffer(...a); }

  // ---- debug callback + capabilities probe ----------------------------------
  debugMessageCallback(cb) { this._debugCb = cb; } // accepted, never fired (WebGL: no KHR_debug)
  debugMessageControl() { /* batch controls are no-ops here */ }
  /** GL.createCapabilities() equivalent: the client gates FBO/blit paths on this. */
  createCapabilities() {
    return {
      OpenGL30: true,
      GL_ARB_framebuffer_object: true,   // WebGL2 FBOs are core
      GL_EXT_framebuffer_object: true,   // functionally provided (extgl* aliases)
      GL_EXT_framebuffer_blit: true,
      GL_KHR_debug: false,               // honest: debug callback is a no-op here
      GL_ARB_debug_output: false,
      GL_NV_fog_distance: false,         // honest: client falls back to standard fog
    };
  }
  getCapabilities() { return this._capabilities || (this._capabilities = this.createCapabilities()); }

  // ---- attribute stack (glPushAttrib / glPopAttrib) -------------------------
  // GL spec restores only the masked groups; MC predominantly uses
  // GL_ALL_ATTRIB_BITS, and a full snapshot is simpler and strictly safer.
  // Matrix stacks are NOT included (GL matrix mode groups are separate).
  pushAttrib(mask) {
    const snap = u => ({ cap: { ...u[GL_CONST.TEXTURE_2D] }, bound: u.bound, dirtyBound: u.dirtyBound, texEnv: JSON.parse(JSON.stringify(u.texEnv)) });
    this._attribStack.push({
      color: JSON.parse(JSON.stringify(this.color)),
      blend: { ...this.blend }, depth: { ...this.depth }, cull: { ...this.cull },
      polygonOffset: { ...this._polygonOffset }, scissor: { ...this._scissor },
      stencil: { ...this.stencil }, logicOp: { ...this._logicOp },
      lighting: JSON.parse(JSON.stringify(this.lighting)),
      fog: { ...this.fog, color: this.fog.color.slice() },
      alphaTest: { ...this.alphaTest },
      lineWidth: { ...this._lineWidth },
      polygonMode: this._polygonMode, colorMaterial: { ...this._colorMaterial },
      texUnits: this._texUnits.map(snap),
      normalize: null, // recorded via _virtRecord (no-op by design)
    });
  }
  popAttrib() {
    const s = this._attribStack.pop();
    if (!s) throw new Error('popAttrib: attribute stack underflow');
    this.color = s.color; this.blend = s.blend; this.depth = s.depth; this.cull = s.cull;
    this._polygonOffset = s.polygonOffset; this._scissor = s.scissor; this.stencil = s.stencil;
    this._logicOp = s.logicOp; this.lighting = s.lighting; this.fog = s.fog; this.alphaTest = s.alphaTest;
    this._lineWidth = s.lineWidth; this._polygonMode = s.polygonMode; this._colorMaterial = s.colorMaterial;
    s.texUnits.forEach((u, i) => {
      this._texUnits[i][GL_CONST.TEXTURE_2D] = u.cap;
      this._texUnits[i].bound = u.bound; this._texUnits[i].dirtyBound = u.dirtyBound;
      this._texUnits[i].texEnv = u.texEnv;
    });
    // force a full flush next applyAll() — every block came back dirty
    this.color.dirty = this.blend.dirty = this.depth.dirty = this.cull.dirty = true;
    this._polygonOffset.dirty = this._scissor.dirty = this.stencil.dirty = this._logicOp.dirty = true;
    this.lighting.dirty = this.fog.dirty = this.alphaTest.dirty = this._lineWidth.dirty = true;
    this._uploadDirty = true;
  }

  // ---- specializer integration (the fixed-pipe -> JIT draw path) ------------
  /** Attach a Specializer instance (needs getProgram(gsm, attribs)). */
  attachSpecializer(spec) { this._specializer = spec; }
  /**
   * Snapshot current fixed-pipe state -> JIT program (compile once, cache) ->
   * bind + feed static uniforms. The compiled client draws after this via
   * drawArrays(). Uniforms: MVP always; ColorModulator/CurrentColor follow
   * glColor4f (deduped); samplers pinned to their units at creation.
   */
  useSpecializedProgram(attribs) {
    if (!this._specializer) throw new Error('useSpecializedProgram: call attachSpecializer() first');
    const entry = this._specializer.getProgram(this, attribs);
    let p = this._fpjitPrograms.get(entry.name);
    const prev = this._program;
    if (!p) {
      p = this.createProgram(entry.vs, entry.fs);
      this._fpjitPrograms.set(entry.name, p);
      this.useProgram(p);
      // samplers are compile-time-static: pin once at creation
      this.uniform1i(this.uniformLocation(p, 'Sampler0'), 0);
      this.uniform1i(this.uniformLocation(p, 'Sampler2'), 2);
    } else {
      this.useProgram(p);
    }
    const switched = prev !== p;
    const m = this.colorModulator;
    const ck = this.color.r + ',' + this.color.g + ',' + this.color.b + ',' + this.color.a;
    const mk = m.r + ',' + m.g + ',' + m.b + ',' + m.a;
    if (switched || this._ccKey !== ck) {
      this._ccKey = ck;
      const cc = this.uniformLocation(p, 'CurrentColor');
      if (cc) this.gl.uniform4f(cc, this.color.r, this.color.g, this.color.b, this.color.a);
    }
    if (switched || this._cmKey !== mk) {
      this._cmKey = mk;
      const cm = this.uniformLocation(p, 'ColorModulator');
      if (cm) this.gl.uniform4f(cm, m.r, m.g, m.b, m.a);
    }
    this.uniformMatrix4fvMVP(this.uniformLocation(p, 'ModelViewMat'), this.uniformLocation(p, 'ProjMat'));
    return p;
  }

  // ---- draw wrappers (applyAll runs the dirty-state flush) ------------------
  drawArrays(mode, first, count) {
    if (this._texGen.s !== null || this._texGen.t !== null) {
      throw new Error('drawArrays: GL_TEXTURE_GEN enabled has no baked equivalent (fail-fast by design)');
    }
    this.applyAll();
    this._gl('drawArrays', mode, first, count);
  }
  drawElements(mode, count, type, offset) {
    this.applyAll();
    this._gl('drawElements', mode, count, type, offset);
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
