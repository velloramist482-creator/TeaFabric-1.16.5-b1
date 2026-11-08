// TeaFabric M2 v1.1 — fixed-pipe fallback program: position_tex_lightmap_color (OWN source).
// Fixed-pipeline equivalent of 1.16.5 PositionTexLightmapColorFormat — THE quad
// format 1.16.5 uses for world faces and sign text. UV2 is the lightmap texel
// coordinate (x16 scale, established in M2 v1.0 demo). Both textures sampled,
// then vertex color x ColorModulator. This is the M3 chunk-fallback backbone.
#version 150

in vec3 Position;
in vec2 UV0;
in vec2 UV2;
in vec4 Color;

uniform mat4 ModelViewMat;
uniform mat4 ProjMat;

out vec2 uv0;
out vec2 uv2;
out vec4 vColor;

void main() {
    gl_Position = ProjMat * ModelViewMat * vec4(Position, 1.0);
    uv0 = UV0;
    uv2 = UV2;
    vColor = Color;
}
