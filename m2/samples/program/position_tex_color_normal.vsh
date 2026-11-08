// TeaFabric M2 v1.1 — GUI fallback program: position_tex_color_normal (OWN source).
// Fixed-pipeline equivalent of 1.16.5 PositionTexColorNormalFormat.
// Fixed-pipe GL_LIGHTING has no WebGL2 counterpart, so the normal participates
// through our own documented headlight-lambert term: shade = a + (1-a)*max(dot(n, L), 0)
// with L = view-space fixed light. Contract documented in TEST_REPORT.md.
#version 150

in vec3 Position;
in vec2 UV0;
in vec4 Color;
in vec3 Normal;

uniform mat4 ModelViewMat;
uniform mat4 ProjMat;

out vec2 uv0;
out vec4 vColor;
out vec3 vNormal;

void main() {
    gl_Position = ProjMat * ModelViewMat * vec4(Position, 1.0);
    uv0 = UV0;
    vColor = Color;
    // normal in view space (model-view rotation only, no projection)
    vNormal = normalize((ModelViewMat * vec4(Normal, 0.0)).xyz);
}
