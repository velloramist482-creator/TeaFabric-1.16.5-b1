// TeaFabric M2 v1.1 — fixed-pipe fallback program: position_tex_lightmap_color (OWN source).
// texel(Sampler0) x light(Sampler2) x vertex color x ColorModulator.
// No fog uniforms here; M3's rendertype_solid already carries the fogged variant.
#version 150

uniform sampler2D Sampler0;
uniform sampler2D Sampler2;
uniform vec4 ColorModulator;

in vec2 uv0;
in vec2 uv2;
in vec4 vColor;

void main() {
    vec4 texel = texture2D(Sampler0, uv0);
    // v1.0 UV2 contract: texel coords x16 on a 256-wide lightmap sheet
    vec4 light = texture2D(Sampler2, (uv2 + vec2(0.5)) / 256.0);
    gl_FragColor = texel * light * vColor * ColorModulator;
}
