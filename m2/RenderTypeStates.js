/**
 * TeaFabric M2 — RenderType state table (1.16.5 behavior-equivalent, own work).
 * Maps the GL state each major vanilla RenderType expects, onto GlStateManager
 * calls, so M3's chunk/entity/text renderers only call: apply('rendertype_solid').
 * Values are derived from 1.16.5 public RenderType state documentation.
 * Red line: contains zero Mojang code — pure declarative table written here.
 */
'use strict';
// dual-environment import: Node (tests) / browser (live demo)
const { GL_CONST } = (typeof require === 'function' && typeof window === 'undefined')
  ? require('./GlStateManager.js')
  : { GL_CONST: window.GL_CONST };

const OFF = null;
const B = (src, dst, srcA = src, dstA = dst) => ({ on: true, src, dst, srcA, dstA });

/** GL state per render type. Blend semantics follow 1.16.5 RenderState definitions. */
const RENDER_TYPES = {
  rendertype_solid:        { blend: OFF, depth: { func: GL_CONST.LEQUAL, mask: true },  cull: GL_CONST.BACK,  colorMask: [true, true, true, true] },
  rendertype_cutout:       { blend: OFF, depth: { func: GL_CONST.LEQUAL, mask: true },  cull: GL_CONST.BACK,  colorMask: [true, true, true, true] },
  rendertype_cutout_mipped:{ blend: OFF, depth: { func: GL_CONST.LEQUAL, mask: true },  cull: GL_CONST.BACK,  colorMask: [true, true, true, true] },
  rendertype_translucent:  { blend: B(GL_CONST.SRC_ALPHA, GL_CONST.ONE_MINUS_SRC_ALPHA), depth: { func: GL_CONST.LEQUAL, mask: false }, cull: GL_CONST.BACK, colorMask: [true, true, true, true] },
  rendertype_text:         { blend: B(GL_CONST.SRC_ALPHA, GL_CONST.ONE_MINUS_SRC_ALPHA), depth: { func: GL_CONST.LEQUAL, mask: false }, cull: OFF, colorMask: [true, true, true, true] },
  rendertype_text_see_through: { blend: B(GL_CONST.SRC_ALPHA, GL_CONST.ONE_MINUS_SRC_ALPHA), depth: { func: GL_CONST.ALWAYS, mask: false }, cull: OFF, colorMask: [true, true, true, true] },
  rendertype_lines:        { blend: B(GL_CONST.SRC_ALPHA, GL_CONST.ONE_MINUS_SRC_ALPHA), depth: { func: GL_CONST.LEQUAL, mask: true },  cull: OFF, colorMask: [true, true, true, true], polygonOffset: { factor: -1, units: -1 } },
  rendertype_eyes:         { blend: B(GL_CONST.SRC_ALPHA, GL_CONST.ONE_MINUS_SRC_ALPHA), depth: { func: GL_CONST.LEQUAL, mask: true },  cull: OFF, colorMask: [true, true, true, true] },
  rendertype_weather:      { blend: B(GL_CONST.SRC_ALPHA, GL_CONST.ONE_MINUS_SRC_ALPHA), depth: { func: GL_CONST.LEQUAL, mask: true },  cull: OFF, colorMask: [true, true, true, true] },
  rendertype_armor_glint:  { blend: B(GL_CONST.SRC_COLOR, GL_CONST.ONE, GL_CONST.ZERO, GL_CONST.ONE), depth: { func: GL_CONST.LEQUAL, mask: true }, cull: OFF, colorMask: [true, true, true, true] },
  // GUI layer (1.16.5 draws GUIs without depth)
  gui:                     { blend: OFF, depth: { func: GL_CONST.LEQUAL, mask: false },  cull: OFF, colorMask: [true, true, true, true] },
  // GUI overlays (1.16.5: hovering tooltips, spectator widgets, boss bars drawn
  // over the base GUI): blending on, never write depth.
  gui_overlay:             { blend: B(GL_CONST.SRC_ALPHA, GL_CONST.ONE_MINUS_SRC_ALPHA), depth: { func: GL_CONST.LEQUAL, mask: false }, cull: OFF, colorMask: [true, true, true, true] },
  // Hover highlight (1.16.5 RenderType.text hover glow): must be visible even
  // behind previously drawn elements -> ALWAYS test, no depth write.
  gui_text_hover:          { blend: B(GL_CONST.SRC_ALPHA, GL_CONST.ONE_MINUS_SRC_ALPHA), depth: { func: GL_CONST.ALWAYS, mask: false }, cull: OFF, colorMask: [true, true, true, true] },
};

/** Apply a render type's state via GlStateManager (dedup handled there). */
function applyRenderType(gsm, name) {
  const st = RENDER_TYPES[name];
  if (!st) throw new Error('unknown render type: ' + name);
  if (st.blend) { gsm.blendEnable(); gsm.blendFuncSeparate(st.blend.src, st.blend.dst, st.blend.srcA, st.blend.dstA); }
  else gsm.blendDisable();
  gsm.depthEnable(); gsm.depthFunc(st.depth.func); gsm.depthMask(st.depth.mask);
  if (st.cull) { gsm.cullEnable(); gsm.cullFace(st.cull); } else gsm.cullDisable();
  if (st.polygonOffset) { gsm.polygonOffsetEnable(); gsm.polygonOffset(st.polygonOffset.factor, st.polygonOffset.units); }
  else gsm.polygonOffsetDisable();
  gsm.colorMask(...st.colorMask);
  gsm.applyAll();
  return st;
}

if (typeof module !== "undefined") module.exports = { RENDER_TYPES, applyRenderType };
if (typeof window !== "undefined") { window.RENDER_TYPES = RENDER_TYPES; window.applyRenderType = applyRenderType; }
