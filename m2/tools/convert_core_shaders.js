#!/usr/bin/env node
/**
 * TeaFabric M2 — Core shader offline converter
 * ============================================
 * Converts vanilla-1.16.5-format core shaders (GLSL 1.50 + #moj_import +
 * program JSON) into GLSL ES 3.00 suitable for WebGL2, fully OFFLINE:
 * the runtime never translates or re-parses anything (contract v1).
 *
 * Red line honored: this tool ships ZERO Mojang assets. Run it against the
 * assets you extracted locally (assets/minecraft/shaders/*); the built-in
 * --shims directory only contains OUR OWN function-equivalent fallbacks.
 *
 * Transformations (GLSL 1.50 -> GLSL ES 3.00):
 *   #version 150            -> #version 300 es
 *   attribute (vertex)      -> in
 *   varying   (vertex)      -> out
 *   varying   (fragment)    -> in
 *   gl_FragColor            -> injected "out vec4" + rename
 *   texture2D/texture3D     -> texture, textureLod, textureProj
 *   missing precision       -> insert precision highp float/int (fragment)
 *   #moj_import <f.glsl>    -> recursive inline expansion (offline!)
 *   gl_TexCoord / gl_FogFragCoord / gl_MultiTexCoordN / gl_Normal and other
 *                           fixed-pipe builtins -> HARD ERROR (fail fast, they
 *                           replaced by named varyings during extraction)
 *
 * Usage:
 *   node tools/convert_core_shaders.js --in <srcDir> --out <outDir> [--shims <dir>]
 *   srcDir layout (vanilla extraction):
 *     <srcDir>/program/*.json | *.vsh | *.fsh | core/*.vsh|*.fsh
 *   Output:
 *     <outDir>/program/<name>.vsh300 / .fsh300  (converted GLSL ES 3.00)
 *     <outDir>/manifest.json                    (programs + uniforms + attributes,
 *                                                consumed by the JS RenderPipeline)
 */
'use strict';
const fs = require('fs');
const path = require('path');

// ---------------------------------------------------------------- helpers ----
const GLSL_ES_FORBIDDEN = [
  [/gl_TexCoord/g, 'gl_TexCoord'],
  [/gl_FogFragCoord/g, 'gl_FogFragCoord'],
  [/gl_MultiTexCoord\d/g, 'gl_MultiTexCoord*'],
  [/gl_NormalMatrix/g, 'gl_NormalMatrix'],
  [/gl_Normal\b/g, 'gl_Normal'],
  [/gl_Vertex\b/g, 'gl_Vertex'],
  [/gl_ModelViewProjectionMatrix/g, 'gl_ModelViewProjectionMatrix'],
  [/gl_ModelViewMatrix/g, 'gl_ModelViewMatrix'],
  [/gl_ProjectionMatrix/g, 'gl_ProjectionMatrix'],
  [/gl_FrontColor/g, 'gl_FrontColor'],
  [/gl_Color\b/g, 'gl_Color'],
];

class ConvertError extends Error {
  constructor(msg, file, line) { super(`${file}:${line || '?'} — ${msg}`); this.file = file; }
}

function resolveImport(impPath, searchDirs, file) {
  for (const dir of searchDirs) {
    // vanilla style: #moj_import <light.glsl> lives under program/ or core/
    for (const sub of ['', 'program/', 'core/', 'include/']) {
      const cand = path.join(dir, sub, impPath);
      if (fs.existsSync(cand)) return fs.readFileSync(cand, 'utf8');
    }
  }
  throw new ConvertError(`#moj_import target not found: ${impPath} (searched: ${searchDirs.join(', ')})`, file);
}

/** Recursively inline #moj_import directives (offline expansion). */
function inlineImports(src, searchDirs, file, seen = new Set()) {
  return src.replace(/^(\s*)#moj_import\s+[<"]([^>"]+)[>"]/gm, (m, indent, imp) => {
    if (seen.has(imp)) return `// [teafabric] skip duplicate import <${imp}>`;
    seen.add(imp);
    const content = resolveImport(imp, searchDirs, file);
    const expanded = inlineImports(content, searchDirs, path.join(path.dirname(file), imp), seen);
    return `// [teafabric] begin inline <${imp}>\n${expanded}\n// [teafabric] end inline <${imp}>`;
  });
}

function checkForbidden(src, file) {
  for (const [re, name] of GLSL_ES_FORBIDDEN) {
    const m = src.match(re);
    if (m) {
      const line = src.slice(0, src.indexOf(m[0])).split('\n').length;
      throw new ConvertError(`fixed-function builtin "${name}" must be replaced with named in/out before conversion`, file, line);
    }
  }
}

function convertGLSL(src, { isVertex, name, searchDirs }) {
  let out = inlineImports(src, searchDirs, name);

  checkForbidden(out, name);

  // version bump
  if (/^\s*#\s*version\s+150/m.test(out)) out = out.replace(/^\s*#\s*version\s+150\s*$/m, '#version 300 es');
  else if (!/^\s*#\s*version\s+300\s+es/m.test(out)) out = `#version 300 es\n${out}`;
  else out = out.replace(/^(\s*)#\s*version\s+300\s+es/m, '#version 300 es');

  // normalize: #version must be line 0 (some drivers reject trailing headers)
  const vLines = out.split('\n');
  const vIdx = vLines.findIndex(l => /^\s*#\s*version\s/.test(l));
  if (vIdx > 0) { const [vl] = vLines.splice(vIdx, 1); vLines.unshift(vl); out = vLines.join('\n'); }

  const isFragment = !isVertex;

  // varying/attribute rewriting (word-boundary, skip comments is unnecessary:
  // GLSL comments in vanilla sources never contain these words as identifiers)
  if (isVertex) {
    out = out.replace(/\battribute\s+/g, 'in ');
    out = out.replace(/\bvarying\s+/g, 'out ');
  } else {
    out = out.replace(/\bvarying\s+/g, 'in ');
  }

  // texture sampling family
  out = out
    .replace(/\btexture2DLod\b/g, 'textureLod')
    .replace(/\btexture3DLod\b/g, 'textureLod')
    .replace(/\btexture2DProj\b/g, 'textureProj')
    .replace(/\btexture3D\b/g, 'texture')
    .replace(/\btexture2D\b/g, 'texture');

  if (isFragment) {
    // gl_FragColor -> named out
    if (/\bgl_FragColor\b/.test(out)) {
      out = out.replace(/\bgl_FragColor\b/g, 'm2_fragColor');
      if (!/^\s*(layout\s*\(.+\)\s*)?out\s+vec4\s+m2_fragColor\s*;/m.test(out)) {
        // inject right after the last precision/extension header line
        const inject = 'layout(location = 0) out vec4 m2_fragColor;\n';
        const lines = out.split('\n');
        let idx = 0;
        for (let i = 0; i < lines.length; i++) {
          if (/^\s*(#version|#extension|precision\s)/.test(lines[i])) idx = i + 1;
        }
        lines.splice(idx, 0, inject.trimEnd());
        out = lines.join('\n');
      }
    }
    // ES 3.00 requires explicit precision in fragment shaders
    if (!/^\s*precision\s+\w+p\s+float\s*;/m.test(out)) {
      out = out.replace(/(#version 300 es\s*\n)/, '$1precision highp float;\nprecision highp int;\n');
    }
    // m2_fragColor declaration must come before use — move to top block if injected late
    const declIdx = out.indexOf('out vec4 m2_fragColor');
    const useIdx = out.indexOf('m2_fragColor', declIdx + 22);
    if (declIdx >= 0 && useIdx >= 0 && declIdx > useIdx) {
      // rare path: declared after use — relocate declaration after version/precision block
      out = out.replace(/^(layout\s*\(.+\)\s*)?out\s+vec4\s+m2_fragColor;\s*$/m, '');
      out = out.replace(/(#version 300 es\s*\n)/, '$1layout(location = 0) out vec4 m2_fragColor;\n');
    }
  }

  // final sanity: no leftover legacy tokens
  for (const [re, name2] of [[/\battribute\b/, 'attribute'], [/\bvarying\b/, 'varying'], [/\btexture2D\b/, 'texture2D'], [/gl_FragColor/, 'gl_FragColor']]) {
    if (re.test(out)) {
      const line = out.slice(0, out.search(re)).split('\n').length;
      throw new ConvertError(`post-transform residue "${name2}" remained`, name, line);
    }
  }
  return out;
}

// ---------------------------------------------------------------- pipeline ---
function scanPrograms(srcDir) {
  const progDir = path.join(srcDir, 'program');
  const dir = fs.existsSync(progDir) ? progDir : srcDir;
  return fs.readdirSync(dir)
    .filter(f => f.endsWith('.json'))
    .map(f => {
      const json = JSON.parse(fs.readFileSync(path.join(dir, f), 'utf8'));
      return { name: f.replace(/\.json$/, ''), dir, json };
    });
}

function main() {
  const args = process.argv.slice(2);
  const opt = (k, d) => { const i = args.indexOf(k); return i >= 0 ? args[i + 1] : d; };
  const srcDir = opt('--in', null);
  const outDir = opt('--out', null);
  const shimsDir = opt('--shims', path.join(__dirname, 'inline_shims'));
  if (!srcDir || !outDir) {
    console.error('Usage: convert_core_shaders.js --in <srcDir> --out <outDir> [--shims <dir>]');
    process.exit(2);
  }
  const searchDirs = [srcDir, path.join(srcDir, 'program'), path.join(srcDir, 'core'), shimsDir];

  const programs = scanPrograms(srcDir);
  const manifest = { generator: 'teafabric-m2/convert_core_shaders', glslTarget: '300 es', convertedAt: new Date().toISOString(), programs: [] };
  let okCount = 0, skipCount = 0;
  const errors = [];

  fs.mkdirSync(path.join(outDir, 'program'), { recursive: true });

  for (const { name, dir, json } of programs) {
    try {
      const vsPath = json.vertexShader ? path.join(dir, json.vertexShader) : path.join(dir, `${name}.vsh`);
      const fsPath = json.fragmentShader ? path.join(dir, json.fragmentShader) : path.join(dir, `${name}.fsh`);
      if (!fs.existsSync(vsPath) || !fs.existsSync(fsPath)) { skipCount++; continue; }

      const vsSrc = fs.readFileSync(vsPath, 'utf8');
      const fsSrc = fs.readFileSync(fsPath, 'utf8');
      const vs300 = convertGLSL(vsSrc, { isVertex: true, name: `${name}.vsh`, searchDirs });
      const fs300 = convertGLSL(fsSrc, { isVertex: false, name: `${name}.fsh`, searchDirs });

      fs.writeFileSync(path.join(outDir, 'program', `${name}.vsh300`), vs300);
      fs.writeFileSync(path.join(outDir, 'program', `${name}.fsh300`), fs300);

      // collect uniforms/attributes for the JS pipeline (manifest)
      const attrs = new Set(json.attributes || []);
      const unis = new Set((json.uniforms || []).map(u => u.name));
      // attributes ONLY from vertex source (fragment "in" = varying interface)
      for (const m of vsSrc.matchAll(/\b(?:in|attribute)\s+\w+\s+(\w+)\s*;/g)) attrs.add(m[1]);
      for (const src of [vsSrc, fsSrc]) {
        for (const m of src.matchAll(/\buniform\s+\w+\s+(\w+)\s*;/g)) unis.add(m[1]);
        for (const m of src.matchAll(/#moj_import\s+[<"]([^>"]+)[>"]/g)) {
          const inc = resolveImport(m[1], searchDirs, name);
          for (const u of inc.matchAll(/\buniform\s+\w+\s+(\w+)\s*;/g)) unis.add(u[1]);
        }
      }
      const samplers = [...unis].filter(u => /^Sampler/.test(u));
      manifest.programs.push({ name, vertex: `program/${name}.vsh300`, fragment: `program/${name}.fsh300`, attributes: [...attrs], uniforms: [...unis], samplers });
      okCount++;
    } catch (e) {
      errors.push(e.message);
      if (process.env.TF_STRICT === '1') throw e;
    }
  }

  fs.writeFileSync(path.join(outDir, 'manifest.json'), JSON.stringify(manifest, null, 2));
  console.log(`converted=${okCount} skipped=${skipCount} errors=${errors.length}`);
  errors.forEach(e => console.error('  ERROR ' + e));
  process.exit(errors.length && process.env.TF_STRICT === '1' ? 1 : 0);
}

if (require.main === module) main();
module.exports = { convertGLSL, inlineImports, checkForbidden, ConvertError };
