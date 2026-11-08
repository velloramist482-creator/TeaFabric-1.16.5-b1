// TeaFabric M2 v1.1 — GUI fallback program: position_tex (OWN source).
// Texel x ColorModulator (fixed-pipe: texture * glColor). GUI family: no fog.
#version 150

uniform sampler2D Sampler0;
uniform vec4 ColorModulator;

in vec2 uv0;

void main() {
    vec4 texel = texture2D(Sampler0, uv0);
    gl_FragColor = texel * ColorModulator;
}
