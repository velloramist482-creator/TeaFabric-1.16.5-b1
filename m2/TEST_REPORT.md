# TeaFabric M2 — Test Report (Teacup Tiger, 2026-11-08, v1.1)

## Deliverables under test
| File | Role | LOC |
|---|---|---|
| GlStateManager.js | WebGL2 render-state machine + CPU matrix stacks (1.16.5 GlStateManager semantics) | ~470 |
| RenderTypeStates.js | 1.16.5 RenderType state table (13 types incl. gui family) + one-call switcher | ~100 |
| tools/convert_core_shaders.js | Offline core-shader converter: GLSL 1.50 -> GLSL ES 3.00, #moj_import inlining | ~230 |
| tools/inline_shims/{light,fog}.glsl | OWN function-equivalent fallbacks (zero Mojang assets) | ~40 |
| samples/program/* (8 programs) | Self-written fixed-pipe fallback family: 3 world/text + **5 new GUI/v1.1** | ~200 |
| demo/gui_demo*.html | **NEW v1.1**: MC-style GUI bring-up (all 8 programs in one frame) | ~330 |
| web/index.html | webmcReady double-signal loader stub (M2 side of the M6 gate) | ~30 |

## v1.1 shader family (fixed-pipeline fallback — 1.16.5 has NO core shaders)
Verified against the original client.jar (SHA1 37fd3c90…269c8): 1.16.5 ships only
post-processing shaders; world/GUI rendering is FIXED-FUNCTION GL. WebGL2 has no
fixed pipeline, so M2 provides the program family:

| program | vertex format equivalent | attributes | samplers |
|---|---|---|---|
| position | PositionFormat (current color) | Position | — |
| position_color | PositionColorFormat | Position, Color | — |
| position_tex | PositionTexFormat (GUI blit path) | Position, UV0 | Sampler0 |
| position_tex_color | PositionTexColorFormat | Position, UV0, Color | Sampler0 |
| position_tex_color_normal | PositionTexColorNormalFormat | Position, UV0, Color, Normal | Sampler0 |
| position_tex_lightmap_color | PositionTexLightmapColorFormat (world quads/signs) | Position, UV0, UV2, Color | Sampler0, Sampler2 |
| rendertype_solid | M3 chunk path (fogged, lighting dirs) | Position, UV0, Color, UV2 | Sampler0, Sampler2 |
| rendertype_text | font quads | Position, UV0, Color | Sampler0 |

Contract: ModelViewMat+ProjMat everywhere; ColorModulator on all color-multiply
programs; GUI family fog-free; UV2 = texel×16 on the 256-wide lightmap sheet
(fsh divides by 256.0). position_tex_color gained ColorModulator in v1.1
(family-wide global-tint hook) — breaking change vs v1.0, documented here.

## Suite A — GlStateManager unit tests
`node test/test_glstatemanager.js` → **19/19 PASS** (was 16, +3 in v1.1)
New: MVP dedup is PER-PROGRAM (switch program ⇒ re-upload; uniforms persist per
program ⇒ switch-back needs none; stale entry ⇒ upload). This regression guards
two REAL bugs found by the GUI demo (see Bugs #8/#9).

## Suite B — Converter assertions
`node test/test_converter.js` → **68/68 PASS** (manifest now 8 programs)

## Suite C — REAL WebGL2 compile/link (headless Chromium)
`node test/run_webgl2_check.js` → **8/8 ALL GREEN**
```
PASS position / position_color / position_tex / position_tex_color /
     position_tex_color_normal / position_tex_lightmap_color /
     rendertype_solid / rendertype_text   (vs ✓ fs ✓ link ✓)
```

## Suite D — RenderType state-table tests
`node test/test_rendertype.js` → **7/7 PASS** (13 types; gui/gui_overlay/
gui_text_hover added in v1.1)

## Suite E — GUI/fixed-pipe shader contract tests (NEW v1.1)
`node test/test_gui_shaders.js` → **19/19 PASS**
Covers: attribute order per vertex-format contract ×6, MVP uniforms everywhere,
GUI family fog-free, ColorModulator placement, ES 3.00 hygiene (no legacy
tokens/fixed-pipe builtins), lightmap /256.0 normalization, normal-shading term,
gui_overlay/gui_text_hover state values, gui dedup (0 extra calls), gui→overlay→gui
blend flip (exactly 1 enable + 1 disable), unknown preset fail-fast, Y-down GUI
ortho (m[5]<0).

## Suite F — Dedup benchmark
`node test/bench_dedup.js` → PASS (50% reduction, unchanged from v1.0)

## Suite G — LIVE 3D demo (v1.0, still green)
demo/demo.html: 54-60 fps, 8 GL calls/frame, 100% non-black.

## Suite H — LIVE GUI bring-up demo (NEW v1.1, real WebGL2)
`node demo/build_gui_demo.js && node test/run_gui_demo_check.js` → **11/11 PASS**
```
frames=90  fps=55  GL calls (first 5 frames)=215  dedup skips=3594  non-black=98.7%
regions: dirt bg ✓  white logo ✓  gradient buttons+1px borders ✓
         hover overlay ✓  tooltip panel + purple text bars ✓
         stone×lightmap panel ✓  normal-shaded cube ✓
```
One frame exercises ALL 8 programs through GlStateManager + RenderType presets,
MC-GUI ortho (top-left origin, Y-down), and dispatches the webmcReady signal
(window.__M2_READY + CustomEvent) — the M2-side marker for the M6 smoke gate.

## Bugs found & fixed during v1.1 (proof the suites work)
8. **MVP dedup leaked across programs** — uniformMatrix4fvMVP skipped uploads by
   matrix-state only; after a program switch the new program kept ZERO matrices
   (vertices collapse to origin). Fix: per-program key.
9. **Object->string key collision** — first fix concatenated `this._program`,
   but every WebGLProgram stringifies to '[object WebGLProgram]' ⇒ still
   deduped across ALL programs. Fix: Map keyed by object identity.
10. **_stackKey missed translation components** — mv[12..14] not sampled, so a
    program's stale entry matched after translatef. Fix: full 16-float key.
11. **Stale enabled attrib arrays + per-draw buffer delete** — enabled arrays
    pointing at deleted buffers make drawArrays fail silently in headless
    (GL_INVALID_OPERATION, zero output, no exception). Fix: disable 0..7 before
    re-specifying pointers.
12. **Attrib size pairing by declaration index** — GLSL compilers assign
    attribute locations in arbitrary order; sizes must be paired BY NAME.
13. **Lightmap sheet normalization** — UV2 must be sampled as (uv2+0.5)/256.0
    per the v1.0 texel×16 contract; raw sampling hit the dimmest clamped texel.
14. **ortho near/far clipping of z-scaled geometry** — GUI demo cube z=±15 was
    outside the [-1,1] ortho range; only a sliver survived. Fix: z-squash.

## Red-line self-check
- zero Mojang assets in the tree: shaders are self-written; client.jar lives in
  .cache/ (gitignored), used ONLY for contract verification (SHA1-checked).
- deliverable zips contain no jar/class/epk assets.

## Suite totals (v1.1): 19+68+8+7+19+bench+11 = **132 assertions green**

> Full regression re-run 2026-11-08 10:20 UTC+8 on the exact tree pushed in this
> PR: all suites re-executed, 132/132 still green (converter 68, GSM 19,
> rendertype 7, GUI contract 19, real-browser 8/8 compile + 11/11 GUI pixels).

---

# v1.2 — Fixed-pipeline specializer JIT (2026-11-08, same day)

Route aligned with the reference project's "per GL-state-combination on-demand
shader specialization + cache": WebGL2 has no fixed pipeline, so on FIRST use of
each state combination a dedicated GLSL ES 3.00 program is GENERATED with the
state baked in as constants (zero runtime branches), compiled once, and cached
(LRU, cap 64).

## New deliverables
| File | Role | LOC |
|---|---|---|
| Specializer.js | snapshot -> normalized key -> state-baked ES 3.00 generator -> LRU cache | ~230 |
| GlStateManager.js (ext) | CPU-only virtual state blocks: lighting (2 directional lights + model ambient), fog (linear/exp/exp2), alphaTest, shadeModel; fogf/fogfv/lightfv/lightModelfv/alphaFunc/shadeModel; NO GL enable calls for these caps (WebGL2 has none — baking replaces them) | +110 |
| test/test_specializer.js | 19 contract tests (below) | ~200 |
| test/run_specializer_check.js | REAL browser compile+link of 4 representative combos + one-frame pixel probe with fog/light validation; CDP tab hygiene (no renderer leaks) | ~260 |

## Suite I — Specializer contract tests
`node test/test_specializer.js` → **19/19 PASS**
Covers: snapshot/key order-independence, fog-mode/ref key splitting, state
baking (fog off ⇒ ZERO fog code in source — the no-branch guarantee), linear
fog literal baking, exp2 formula, alphaTest discard+ref literal, lighting-off
skips the normal pipeline, headlight combo uses the SAME shade formula as the
fallback family, UV2 texel×16 /256.0 contract, LRU miss/hit/evict/refresh,
virtual caps issue ZERO GL calls, virtual-cap dedup skips, state mutation +
fail-fast pnames, ES 3.00 hygiene, stable fpjit_<fnv> naming.

## Suite J — Specializer REAL WebGL2 verification
`node test/run_specializer_check.js` → **8/8 PASS**
```
4 combos compile+link in real WebGL2: gui(fog off) / world(lighting+linear fog
+UV2+alpha off) / cutout(exp2 fog+alpha test) / headlight(fallback-equivalent)
one-frame probe (full-state combo): nonBlack 51.6% (full-screen tri)
  center rgb(189,202,217) — blue-dominant (fog color) AND lit-but-fogged;
  matches the analytic prediction r≈187 from shade×light×fogFactor.
```
Also fixed during bring-up: vec3() constructor fed 4 components (position w) —
a REAL bug caught by the real GLSL compiler, invisible to string tests.

## Suite totals (v1.2): 132 + 19 + 8 = **159 assertions green**
