// TeaFabric M2 v1.1 — GUI fallback program: position_color (OWN source).
// Fixed-pipeline equivalent of 1.16.5 PositionColorFormat: per-vertex color
// (gradient fills, button backgrounds, borders). Vertex color is modulated
// by ColorModulator, matching the M2 v1.0 uniform contract.
#version 150

in vec3 Position;
in vec4 Color;

uniform mat4 ModelViewMat;
uniform mat4 ProjMat;

out vec4 vColor;

void main() {
    gl_Position = ProjMat * ModelViewMat * vec4(Position, 1.0);
    vColor = Color;
}
