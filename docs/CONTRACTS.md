# Cross-line contracts (M2 side) — keep M1/M3/M5/M6 honest

These are the interface promises M2 makes to the rest of TeaFabric. Change
them only with a green cross-line test on both sides.

## 1. MVP uniforms (all programs)
Every program — handwritten family and JIT-generated — takes
`uniform mat4 ModelViewMat; uniform mat4 ProjMat;`. View space is the
ModelView output; the GUI uses an ortho with **top-left origin, Y-down**
(projection m[5] < 0). M3 chunk renderer: build ModelView = view matrix only.

## 2. Color channels (v1.3, two independent knobs)
- `glColor4f` → **CurrentColor** uniform — the fixed-pipe diffuse color
  (texEnv combine input, lighting material).
- `RenderSystem.setShaderColor` equivalent → **setColorModulator()** →
  **ColorModulator** uniform — the global tint hook every color-multiply
  program multiplies at the end.
They are NOT the same state; the real-machine probe pins this
(rgb 255,64,128 vs 255,255,255 in `run_specializer_check.js`).

## 3. UV2 lightmap (texel × 16)
Brightness values are texel coordinates on the **256-wide** lightmap sheet:
`uv2 = lightTexCoord * 16`, sampled as `(uv2 + 0.5) / 256.0`.
M3/M5: when packing vertex light data, use this exact contract.

## 4. Vertex formats (1.16.5 order)
`Position(3f)`, `UV0(2f)`, `Color(4f)`, `Normal(3f)`, `UV2(2f)` — attribute
NAMES are the contract (`getAttribLocation(prog, 'UV0')` etc.); the JIT and
the fallback family both bind by name.

## 5. RenderType presets
`RenderTypeStates.applyRenderType(gsm, name)` — 15 presets. Unknown names
fail fast (loud crash beats silent misrender). M3: extend the table rather
than hand-toggling GL state.

## 6. webmcReady double signal (M6 smoke gate)
The page is "ready" when **both** are true: `window.__M2_READY === true` and a
`webmcReady` CustomEvent has fired on `window`. See `web/index.html`.

## 7. Zero-GL virtual caps
`glEnable(GL_LIGHTING/FOG/ALPHA_TEST)` and `glTexEnvi(...)` issue **zero** GL
calls — they are CPU state, baked by the Specializer. Tests pin this; do not
"optimize" them into real enable() calls (WebGL2 has no such caps).

## 8. COOP/COEP deployment (M3 handoff)
Cloudflare Pages `_headers` (preferred) or coi-serviceworker shim — see root
README. M2 itself needs no SharedArrayBuffer.
