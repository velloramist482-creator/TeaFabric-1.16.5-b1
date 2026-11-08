# m2/ — Render shim layer (GlStateManager + RenderType + fixed-pipe shader family)

Owner: **Teacup Tiger** · milestone M2 · v1.1 · 2026-11-08

M2 is the GL simulator / shim layer the TeaVM-compiled 1.16.5 client runs on top of
(same role as eaglercraft's GL layer): a WebGL2 render-state machine that emulates
1.16.5's `GlStateManager` semantics, a RenderType state table, and the shader
programs world/GUI rendering needs.

**Key finding (verified against the original client.jar, SHA1 `37fd3c90…269c8`):**
1.16.5 ships **no core shaders** (those came in 1.17) — world/GUI rendering is
fixed-function GL. WebGL2 has no fixed pipeline, so M2 ships an 8-program
fixed-pipe fallback family (all self-written, zero Mojang assets).

## Layout

```
m2/
  GlStateManager.js        WebGL2 state machine + CPU matrix stacks (~470 LOC)
  RenderTypeStates.js      1.16.5 RenderType table, 13 presets incl. GUI family
  tools/convert_core_shaders.js   GLSL 1.50 -> GLSL ES 3.00 converter (+ #moj_import inlining)
  tools/inline_shims/      own function-equivalent light/fog shims
  samples/program/         8 shader programs (.vsh/.fsh/.json), self-written
  test/                    4 unit suites + 2 real-browser checks + bench
  demo/                    world demo (v1.0) + GUI bring-up demo (v1.1) + screenshots
  TEST_REPORT.md           full per-suite results, 132 assertions green
```

## How to run

```bash
# unit gates (no browser needed)
node m2/tools/convert_core_shaders.js --in m2/samples --out m2/build/shaders --shims m2/tools/inline_shims
node m2/test/test_glstatemanager.js   # 19/19
node m2/test/test_converter.js        # 68/68
node m2/test/test_rendertype.js       # 7/7
node m2/test/test_gui_shaders.js      # 19/19
node m2/test/bench_dedup.js           # PASS

# real-browser checks (need a WebGL2-capable Chromium; uses agent-browser)
node m2/test/run_webgl2_check.js      # 8/8 programs compile+link
node m2/test/run_gui_demo_check.js    # 11/11 pixel assertions, fps/non-black metrics
node m2/test/test_specializer.js      # 19/19 fixed-pipe JIT contract
node m2/test/run_specializer_check.js # 8/8 specialized combos compile+render
```

CI (`.github/workflows/ci.yml` in this PR) runs the unit gates + converter + a
zero-jar/epk red-line self-check on every push and PR.

## Results (v1.1 + v1.2, full regression re-run 2026-11-08)

| suite | result |
|---|---|
| GlStateManager unit | 19/19 |
| converter | 68/68 |
| RenderType table | 7/7 |
| GUI/fixed-pipe contract | 19/19 |
| specializer JIT contract (v1.2) | 19/19 |
| real WebGL2 compile+link (fallback family) | 8/8 |
| live GUI demo pixels | 11/11 (55 fps, 98.7% non-black, dedup 3594 skips) |
| specialized combos compile+render probe (v1.2) | 8/8 |
| **total** | **159 assertions green** |

**v1.2 adds the fixed-pipeline specializer JIT** (`Specializer.js`): each GL
state combination (lighting/fog/alphaTest/vertex format) gets a dedicated
state-baked GLSL ES 3.00 program generated on first use, LRU-cached, zero
runtime branches. GlStateManager gains CPU-only virtual state blocks
(lighting/fog/alphaTest) — WebGL2 has no such caps, so baking replaces
enable() calls entirely (verified: zero GL enable/disable calls emitted).

v1.1 fixed 7 real library bugs the GUI demo flushed out (per-program MVP dedup,
stack-key translation components, stale enabled attrib arrays, attrib size
pairing by name, lightmap sheet normalization, ortho near/far clipping,
`position_tex_color` missing `ColorModulator`) — each with a regression test.

## Contracts other milestones can rely on

- **MVP contract**: every program takes `ModelViewMat` + `ProjMat`.
- **ColorModulator**: all color-multiply programs expose it (setShaderColor equivalent).
- **GUI family is fog-free**; world programs take fog uniforms via shim.
- **UV2/lightmap**: texel×16 on the 256-wide sheet, fsh normalizes `/256.0`.
- **webmcReady**: `demo/gui_demo_standalone.html` sets `window.__M2_READY` and
  dispatches the `webmcReady` CustomEvent — the M2-side marker for the M6 smoke gate.

## Red-line self-check

- No Minecraft jar / class / epk / assets / decompiled artifacts in this tree.
  Shaders are self-written; the client.jar is only fetched to a gitignored
  `.cache/` for contract verification (SHA1-checked), never committed.
- This PR adds source + tests + CI only; `*.jar`/`*.zip` are already blocked by
  the repo `.gitignore`.

## Structure proposal to Repo Manager

One top-level directory per contributor-line (`m1/ m2/ m5/ …`) — this PR adds
`m2/` as the first; other lines' PRs can mirror it. Cross-line interfaces
(webmcReady, ShaderSource) are documented above; open a review comment if you
want a different layout and I'll rebase.
