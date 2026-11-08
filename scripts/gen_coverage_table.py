#!/usr/bin/env python3
"""
Generates m2/docs/coverage_table.js from build/gl_surface.json + the
disposition rules below. Rerunning the scanner then this script keeps the
coverage matrix in lockstep with the real client.jar surface.

Dispositions:
  implemented — GLSM method drives real WebGL2 (deduped where cheap)
  virtual     — CPU-only state, no WebGL2 equivalent; baked by the specializer
                or consumed by the shim semantics (zero GL calls issued)
  alias       — same code path as another function (EXT/ARB spellings, double-typed)
  deviation   — accepted with a documented behavior difference (fail-fast/recorded)
"""
import json
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent  # webmc-1165 repo root
SURFACE = ROOT / "m2" / "build" / "gl_surface.json"
OUT = ROOT / "m2" / "docs" / "coverage_table.js"

# function name -> (disposition, GLSM entry point, note)
RULES = {
    # ---- GL11: state machine -------------------------------------------------
    "glAlphaFunc": ("virtual", "alphaFunc()", "baked into JIT programs as literal discard"),
    "glBindTexture": ("implemented", "bindTexture()", "deduped per unit"),
    "glBlendFunc": ("implemented", "blendFunc()", "→ blendFuncSeparate"),
    "glClear": ("implemented", "clear()", "also used by beginFrame()"),
    "glClearColor": ("implemented", "clearColor4f()"),
    "glClearDepth": ("implemented", "clearDepth()"),
    "glClearStencil": ("implemented", "clearStencil()"),
    "glColor4f": ("implemented", "color4f()", "feeds CurrentColor/ColorModulator uniforms"),
    "glColorMask": ("implemented", "colorMask()", "flushed via _flushColor"),
    "glColorMaterial": ("virtual", "colorMaterial()", "family always applies AMBIENT_AND_DIFFUSE"),
    "glColorPointer": ("virtual", "colorPointer()", "client-state record; GL20 attrib path is the live route"),
    "glDeleteTextures": ("implemented", "deleteTextures()"),
    "glDepthFunc": ("implemented", "depthFunc()"),
    "glDepthMask": ("implemented", "depthMask()"),
    "glDisable": ("implemented", "disable()", "generic cap dispatch incl. virtual caps"),
    "glDisableClientState": ("virtual", "disableClientState()", "client-state caps"),
    "glDrawArrays": ("implemented", "drawArrays()", "applyAll() pre-flight; texgen fail-fast"),
    "glEnable": ("implemented", "enable()", "generic cap dispatch incl. virtual caps"),
    "glEnableClientState": ("virtual", "enableClientState()", "client-state caps"),
    "glFogf": ("virtual", "fogf()", "baked: mode/density/start/end literals in JIT fsh"),
    "glFogfv": ("virtual", "fogfv()", "FOG_COLOR baked"),
    "glFogi": ("alias", "fogi()", "= fogf (GL_FOG_MODE int form)"),
    "glGenTextures": ("implemented", "genTextures()"),
    "glGetError": ("implemented", "getError()", "passthrough"),
    "glGetFloatv": ("implemented", "getFloatv()", "matrices/fog from CPU state, rest from GL"),
    "glGetInteger": ("implemented", "getInteger()", "getParameter passthrough"),
    "glGetString": ("implemented", "getString()", "WebGL2 VERSION/RENDERER"),
    "glGetTexImage": ("deviation", "—", "WebGL2 lacks readback-from-GPU-texture; returns null + warn (mods/screenshots only)"),
    "glGetTexLevelParameteri": ("implemented", "getTexLevelParameteri()", "sizes recorded at upload"),
    "glLightModelfv": ("virtual", "lightModelfv()", "model ambient baked"),
    "glLightfv": ("virtual", "lightfv()", "LIGHT0/LIGHT1 ambient/diffuse/specular/position baked"),
    "glLineWidth": ("implemented", "lineWidth()", "flushed in applyAll"),
    "glLoadIdentity": ("implemented", "loadIdentity()"),
    "glLogicOp": ("implemented", "logicOp()", "COLOR_LOGIC_OP is WebGL2 core"),
    "glMatrixMode": ("implemented", "matrixMode()"),
    "glMultMatrixf": ("implemented", "multMatrix()"),
    "glNormal3f": ("virtual", "normal3f()", "immediate-mode current normal record"),
    "glNormalPointer": ("virtual", "normalPointer()", "client-state record"),
    "glOrtho": ("implemented", "ortho()", "CPU Matrix4f"),
    "glPixelStorei": ("implemented", "pixelStorei()", "UNPACK/PACK_ALIGNMENT forwarded, rest recorded"),
    "glPixelTransferf": ("deviation", "pixelTransferf()", "recorded; scale applied CPU-side by upload caller (lightmap gen)"),
    "glPolygonMode": ("deviation", "polygonMode()", "recorded; WebGL2 always fills (wireframe = debug only)"),
    "glPolygonOffset": ("implemented", "polygonOffset()", "POLYGON_OFFSET_FILL is WebGL2 core"),
    "glPopAttrib": ("implemented", "popAttrib()", "full CPU snapshot restore + force-flush"),
    "glPopMatrix": ("implemented", "popMatrix()"),
    "glPushAttrib": ("implemented", "pushAttrib()", "full CPU snapshot (GL_ALL_ATTRIB_BITS semantics)"),
    "glPushMatrix": ("implemented", "pushMatrix()"),
    "glReadPixels": ("implemented", "readPixels()"),
    "glRotatef": ("implemented", "rotatef()"),
    "glScaled": ("alias", "scalef()", "GLdouble form, same semantics"),
    "glScalef": ("implemented", "scalef()"),
    "glShadeModel": ("virtual", "shadeModel()", "FLAT/SMOOTH noted; GUI/world use SMOOTH semantics"),
    "glStencilFunc": ("implemented", "stencilFunc()", "STENCIL_TEST is WebGL2 core"),
    "glStencilMask": ("implemented", "stencilMask()"),
    "glStencilOp": ("implemented", "stencilOp()"),
    "glTexCoordPointer": ("virtual", "texCoordPointer()", "per client unit; GL20 attrib path is the live route"),
    "glTexEnvi": ("virtual", "texEnvi()", "MODULATE/REPLACE/DECAL/ADD baked per-combo; BLEND/COMBINE fail-fast"),
    "glTexGenfv": ("deviation", "texGenfv()", "plane coefficients recorded; gen-mode enable fail-fasts at draw"),
    "glTexGeni": ("deviation", "texGeni()", "gen-mode recorded; SPHERE_MAP/... fail-fast at draw (documented)"),
    "glTexImage2D": ("implemented", "uploadTexture2D()", "records sizes for level queries"),
    "glTexParameterf": ("alias", "texParameterf()", "= texParameteri"),
    "glTexParameteri": ("implemented", "texParameter2D()"),
    "glTexSubImage2D": ("implemented", "subTexture2D()", "dynamic atlas/font updates"),
    "glTranslated": ("alias", "translatef()", "GLdouble form, same semantics"),
    "glTranslatef": ("implemented", "translatef()"),
    "glVertexPointer": ("virtual", "vertexPointer()", "client-state record"),
    "glViewport": ("implemented", "viewport()"),
    # ---- GL13: multitexture ----------------------------------------------------
    "glActiveTexture": ("implemented", "activeTexture()", "deduped"),
    "glClientActiveTexture": ("virtual", "clientActiveTexture()", "client-unit selector"),
    "glMultiTexCoord2f": ("virtual", "multiTexCoord2f()", "unit1 lightmap UV replay state"),
    # ---- GL14: blend -----------------------------------------------------------
    "glBlendColor": ("implemented", "blendColor()", "CONSTANT_COLOR factors"),
    "glBlendEquation": ("implemented", "blendEquation()", "also via blendFuncSeparateEXT pair form"),
    "glBlendFuncSeparate": ("implemented", "blendFuncSeparate()", "+ EXT mode pair variant"),
    # ---- GL15: VBO -------------------------------------------------------------
    "glBindBuffer": ("implemented", "bindBuffer()", "per-target dedup"),
    "glBufferData": ("implemented", "bufferData()"),
    "glDeleteBuffers": ("implemented", "deleteBuffer()"),
    "glGenBuffers": ("implemented", "genBuffer()"),
    # ---- GL20: shaders + uniforms (post-processing chains) ----------------------
    "glAttachShader": ("implemented", "attachShader()", "individual object path; createProgram() is the fused helper"),
    "glCompileShader": ("implemented", "compileShader()"),
    "glCopyTexSubImage2D": ("implemented", "copyTexSubImage2D()"),
    "glCreateProgram": ("implemented", "createProgramObject()"),
    "glCreateShader": ("implemented", "createShaderObject()"),
    "glDeleteProgram": ("implemented", "deleteProgram()"),
    "glDeleteShader": ("implemented", "deleteShader()"),
    "glEnableVertexAttribArray": ("implemented", "enableVertexAttribArray()"),
    "glGetAttribLocation": ("implemented", "getAttribLocation()"),
    "glGetProgramInfoLog": ("implemented", "getProgramInfoLog()"),
    "glGetProgrami": ("implemented", "getProgrami()", "LINK_STATUS etc. passthrough"),
    "glGetShaderInfoLog": ("implemented", "getShaderInfoLog()"),
    "glGetShaderi": ("implemented", "getShaderi()"),
    "glGetUniformLocation": ("implemented", "uniformLocation()", "cached per program"),
    "glLinkProgram": ("implemented", "linkProgram()"),
    "glScissor": ("implemented", "scissor()", "flushed in applyAll"),
    "glShaderSource": ("implemented", "shaderSource()"),
    "glUniform1fv": ("implemented", "uniform1fv()"),
    "glUniform1i": ("implemented", "uniform1i()"),
    "glUniform1iv": ("implemented", "uniform1iv()"),
    "glUniform2fv": ("implemented", "uniform2fv()"),
    "glUniform2iv": ("implemented", "uniform2iv()"),
    "glUniform3fv": ("implemented", "uniform3fv()"),
    "glUniform3iv": ("implemented", "uniform3iv()"),
    "glUniform4fv": ("implemented", "uniform4fv()"),
    "glUniform4iv": ("implemented", "uniform4iv()"),
    "glUniformMatrix2fv": ("implemented", "uniformMatrix2fv()"),
    "glUniformMatrix3fv": ("implemented", "uniformMatrix3fv()"),
    "glUniformMatrix4fv": ("implemented", "uniformMatrix4fv()", "+ MVP fused dedup variant"),
    "glUseProgram": ("implemented", "useProgram()", "deduped"),
    "glVertexAttribPointer": ("implemented", "vertexAttribPointer()"),
    # ---- GL30 / ARB / EXT framebuffer ------------------------------------------
    "glBindFramebuffer": ("implemented", "bindFramebuffer()"),
    "glBlitFramebuffer": ("implemented", "blitFramebuffer()", "WebGL2 core"),
    "glCheckFramebufferStatus": ("implemented", "checkFramebufferStatus()"),
    "glDeleteFramebuffers": ("implemented", "deleteFramebuffers()"),
    "glFramebufferTexture2D": ("implemented", "extglFramebufferTexture2D()"),
    "glGenFramebuffers": ("implemented", "extglGenFramebuffers()"),
    "glGetFramebufferAttachmentParameteri": ("implemented", "getFramebufferAttachmentParameteri()"),
    "glBindFramebufferEXT": ("alias", "bindFramebuffer()", "EXT spelling"),
    "glCheckFramebufferStatusEXT": ("alias", "checkFramebufferStatus()"),
    "glDeleteFramebuffersEXT": ("alias", "deleteFramebuffers()"),
    "glFramebufferTexture2DEXT": ("alias", "extglFramebufferTexture2D()"),
    "glGenFramebuffersEXT": ("alias", "extglGenFramebuffers()"),
    "glGetFramebufferAttachmentParameteriEXT": ("alias", "getFramebufferAttachmentParameteri()"),
    "glBlitFramebufferEXT": ("alias", "blitFramebufferEXT()"),
    # ---- debug callbacks (no KHR_debug in WebGL) ---------------------------------
    "glDebugMessageCallback": ("deviation", "debugMessageCallback()", "accepted + stored, never fired (WebGL has no KHR_debug)"),
    "glDebugMessageControl": ("deviation", "debugMessageControl()", "no-op"),
    "glDebugMessageCallbackARB": ("alias", "debugMessageCallback()", "ARB spelling"),
    "glDebugMessageControlARB": ("alias", "debugMessageControl()"),
    # ---- GL capability probe ------------------------------------------------------
    "createCapabilities": ("implemented", "createCapabilities()", "honest truth table: FBO/blit true, KHR_debug/NV_fog_distance false"),
    "getCapabilities": ("implemented", "getCapabilities()"),
}

def main():
    data = json.loads(SURFACE.read_text())
    # M2 scope = the OpenGL surface only. GLFW (window/input), OpenAL (audio)
    # and STB (image/font codecs) are separate milestone lines and explicitly
    # NOT covered by this matrix (see docs/COVERAGE.md for the split).
    GL_OWNERS = {
        "GL11", "GL13", "GL14", "GL15", "GL20", "GL30",
        "ARBFramebufferObject", "EXTFramebufferObject", "EXTFramebufferBlit",
        "ARBDebugOutput", "KHRDebug", "GL",
    }
    rows, missing = [], []
    for owner, fns in data["surface"].items():
        short = owner.rsplit("/", 1)[-1]
        if short not in GL_OWNERS:
            continue
        for fn in sorted(fns):
            rule = RULES.get(fn)
            if rule is None:
                missing.append(f"{short}.{fn}")
                continue
            rule = (rule + ("",))[:3]  # normalize: (disposition, entry, note)
            rows.append((short, fn) + rule)
    if missing:
        print("FAIL: functions scanned in client.jar but missing from RULES:")
        for m in missing:
            print("  " + m)
        raise SystemExit(1)

    unused = [k for k in RULES if k not in {r[1] for r in rows}]
    if unused:
        print("WARN: RULES entries not present in this jar's surface (kept for future versions):", unused)

    lines = [
        "/**",
        " * TeaFabric M2 v1.3 — GL call-surface coverage matrix (GENERATED FILE).",
        " * Source of truth: build/gl_surface.json (constant-pool scan of the",
        " * SHA1-verified 1.16.5 client.jar) + the disposition rules in",
        " * scripts/gen_coverage_table.py. Regenerate instead of hand-editing.",
        " *",
        " * Machine-enforced by test/test_completeness.js: every function the",
        " * compiled client can emit MUST appear here, or the test fails — this is",
        " * the \"compiled client runs with everything usable\" guarantee.",
        " */",
        "'use strict';",
        "",
        "const COVERAGE = [",
    ]
    for short, fn, disp, entry, note in rows:
        note_js = (note or "").replace("\\", "").replace("'", "\\'")
        lines.append(f"  {{ owner: '{short}', fn: '{fn}', disposition: '{disp}', entry: '{entry}', note: '{note_js}' }},")
    lines += [
        "];",
        "",
        "const SUMMARY = " + json.dumps(_summary(rows), indent=2) + ";",
        "",
        "if (typeof module !== 'undefined') module.exports = { COVERAGE, SUMMARY };",
        "if (typeof window !== 'undefined') { window.M2_COVERAGE = COVERAGE; window.M2_COVERAGE_SUMMARY = SUMMARY; }",
        "",
    ]
    OUT.parent.mkdir(parents=True, exist_ok=True)
    OUT.write_text("\n".join(lines))
    print(f"coverage rows: {len(rows)}  ->  {OUT}")
    print(_summary(rows))

def _summary(rows):
    from collections import Counter
    c = Counter(r[2] for r in rows)
    return {
        "total_functions": len(rows),
        "implemented": c.get("implemented", 0),
        "virtual": c.get("virtual", 0),
        "alias": c.get("alias", 0),
        "deviation": c.get("deviation", 0),
    }

if __name__ == "__main__":
    main()
