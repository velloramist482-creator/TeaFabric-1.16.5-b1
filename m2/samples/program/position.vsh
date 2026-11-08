// TeaFabric M2 v1.1 — GUI fallback program: position (OWN source).
// Fixed-pipeline equivalent of 1.16.5 PositionFormat: flat "current color"
// quads (solid fills, window panes). Emulates glColor semantics with the
// Color uniform, since WebGL2 has no fixed-function pipeline at all.
#version 150

in vec3 Position;

uniform mat4 ModelViewMat;
uniform mat4 ProjMat;
uniform vec4 Color;

void main() {
    gl_Position = ProjMat * ModelViewMat * vec4(Position, 1.0);
}
