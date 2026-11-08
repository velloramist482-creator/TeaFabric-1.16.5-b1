// TeaFabric M2 v1.1 — GUI fallback program: position_tex (OWN source).
// Fixed-pipeline equivalent of 1.16.5 PositionTexFormat and the GUI blit
// path (AbstractGui.blit -> textured quad). WebGL2 has no fixed pipeline,
// so texel x current color becomes texel x ColorModulator here — same
// function, named contract kept from M2 v1.0.
#version 150

in vec3 Position;
in vec2 UV0;

uniform mat4 ModelViewMat;
uniform mat4 ProjMat;

out vec2 uv0;

void main() {
    gl_Position = ProjMat * ModelViewMat * vec4(Position, 1.0);
    uv0 = UV0;
}
