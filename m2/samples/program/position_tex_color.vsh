// TeaFabric M2 test sample — position_tex_color equivalent (OWN source).
// Minimal GUI-style program: exercises pure varyings without imports.
#version 150

in vec3 Position;
in vec2 UV0;
in vec4 Color;

uniform mat4 ModelViewMat;
uniform mat4 ProjMat;

out vec2 uv0;
out vec4 vColor;

void main() {
    gl_Position = ProjMat * ModelViewMat * vec4(Position, 1.0);
    uv0 = UV0;
    vColor = Color;
}
