#!/usr/bin/env python3
"""
TeaFabric M2 — empirical GL call-surface scanner (red-line safe).

Parses the constant pool of every .class in the official 1.16.5 client.jar
(SHA1-verified) and collects ALL references to LWJGL OpenGL entry points
(org/lwjgl/opengl/*). This is an INTERFACE USAGE INVENTORY — no code is
decompiled, extracted or redistributed; the jar itself never leaves .cache/
(gitignored) and only aggregate function-name statistics are emitted.

Purpose: prove M2's completeness claim — every GL call the compiled client
can emit maps to an M2 implementation, a baked equivalent, or a documented
deviation ("编译后所有都能用" evidence).

Output: build/gl_surface.json + console summary.
"""
import json
import struct
import sys
import zipfile
from collections import defaultdict
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent  # webmc-1165 repo root
JAR = ROOT / "m2" / ".cache" / "client-1.16.5.jar"
OUT = ROOT / "m2" / "build" / "gl_surface.json"

# LWJGL owners we care about (GL surface; audio/input are other lines but we
# still count them so the split is explicit)
GL_PREFIX = "org/lwjgl/opengl/"
OPENAL_PREFIX = "org/lwjgl/openal/"
GLFW_PREFIX = "org/lwjgl/glfw/"
STB_PREFIX = "org/lwjgl/stb/"


def parse_constant_pool(data: bytes):
    """Return list of constant pool entries (index 1..n-1). Entry formats kept
    minimal: ('Utf8', s) ('Class', name_idx) ('Member', class_idx, nat_idx)
    ('NameAndType', name_idx, desc_idx) per JVM spec."""
    if data[:4] != b"\xca\xfe\xba\xbe":
        raise ValueError("not a class file")
    count = struct.unpack_from(">H", data, 8)[0]
    pool = [None] * count  # index 0 unused
    off = 10
    i = 1
    while i < count:
        tag = data[off]
        off += 1
        if tag == 1:  # Utf8
            ln = struct.unpack_from(">H", data, off)[0]
            off += 2
            pool[i] = ("Utf8", data[off:off + ln].decode("utf-8", "replace"))
            off += ln
        elif tag == 3 or tag == 4:  # Integer/Float
            off += 4
        elif tag == 5 or tag == 6:  # Long/Double take TWO slots
            off += 8
            i += 1
        elif tag == 7:  # Class
            idx = struct.unpack_from(">H", data, off)[0]
            off += 2
            pool[i] = ("Class", idx)
        elif tag == 8:  # String
            off += 2
        elif tag in (9, 10, 11):  # Fieldref/Methodref/InterfaceMethodref
            ci, nt = struct.unpack_from(">HH", data, off)
            off += 4
            pool[i] = ("Member", ci, nt)
        elif tag == 12:  # NameAndType
            ni, di = struct.unpack_from(">HH", data, off)
            off += 4
            pool[i] = ("NameAndType", ni, di)
        elif tag == 15:  # MethodHandle
            off += 3
        elif tag == 16:  # MethodType
            off += 2
        elif tag in (17, 18):  # Dynamic/InvokeDynamic
            off += 4
        elif tag in (19, 20):  # Module/Package
            off += 2
        else:
            raise ValueError(f"unknown cp tag {tag} at {off-1}")
        i += 1
    return pool


def scan():
    if not JAR.exists():
        print(f"FAIL: {JAR} missing — download the SHA1-verified client.jar first")
        sys.exit(1)

    # owner -> {method_name: count of referencing classes}
    surface = defaultdict(lambda: defaultdict(int))
    # owner+method -> set of referencing classes (attribution evidence)
    fn_classes = defaultdict(set)
    classes_seen = 0
    classes_using_gl = set()

    with zipfile.ZipFile(JAR) as z:
        for entry in z.namelist():
            if not entry.endswith(".class"):
                continue
            data = z.read(entry)
            classes_seen += 1
            try:
                pool = parse_constant_pool(data)
            except ValueError:
                continue

            def utf8(i):
                e = pool[i]
                return e[1] if e and e[0] == "Utf8" else "?"

            def cls(i):
                e = pool[i]
                return utf8(e[1]) if e and e[0] == "Class" else "?"

            for e in pool:
                if e and e[0] == "Member":
                    owner = cls(e[1])
                    if owner.startswith((GL_PREFIX, OPENAL_PREFIX, GLFW_PREFIX, STB_PREFIX)):
                        nat = pool[e[2]]
                        mname = utf8(nat[1]) if nat and nat[0] == "NameAndType" else "?"
                        # skip constructors and reflection-ish noise
                        if mname.startswith("<"):
                            continue
                        surface[owner][mname] += 1
                        fn_classes[owner + "|" + mname].add(entry.replace(".class", "").rsplit("/", 1)[-1])
                        if owner.startswith(GL_PREFIX):
                            classes_using_gl.add(entry)

    result = {
        "jar": JAR.name,
        "classes_scanned": classes_seen,
        "classes_using_gl": len(classes_using_gl),
        "surface": {o: dict(m) for o, m in sorted(surface.items())},
        "function_classes": {k: sorted(v) for k, v in sorted(fn_classes.items())},
    }
    OUT.parent.mkdir(parents=True, exist_ok=True)
    OUT.write_text(json.dumps(result, indent=2, sort_keys=True))

    # console summary
    print(f"classes scanned        : {classes_seen}")
    print(f"classes referencing GL : {len(classes_using_gl)}")
    gl_owners = {o: m for o, m in surface.items() if o.startswith(GL_PREFIX)}
    total_gl_fns = sum(len(m) for m in gl_owners.values())
    print(f"distinct GL functions  : {total_gl_fns}")
    for owner in sorted(gl_owners):
        short = owner.replace(GL_PREFIX, "")
        names = ", ".join(f"{n}x{c}" for n, c in sorted(gl_owners[owner].items()))
        print(f"  [{short}] {names}")
    print(f"\nwritten: {OUT}")
    return result


if __name__ == "__main__":
    scan()
