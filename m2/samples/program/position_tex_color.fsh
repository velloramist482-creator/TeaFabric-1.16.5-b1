// TeaFabric M2 v1.1 — GUI fallback program: position_tex_color (OWN source).
// v1.1 contract unification: adds ColorModulator so the whole GUI family
// shares one global-tint hook (setShaderColor equivalent) without rebuilding
// vertex buffers. Vertex color stays the primary modulator.
#version 150

uniform sampler2D Sampler0;
uniform vec4 ColorModulator;

in vec2 uv0;
in vec4 vColor;

void main() {
    vec4 texel = texture2D(Sampler0, uv0);
    gl_FragColor = texel * vColor * ColorModulator;
}
