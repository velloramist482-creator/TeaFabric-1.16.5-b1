// TeaFabric M2 v1.1 — GUI fallback program: position_color (OWN source).
// Per-vertex color x ColorModulator. No texture, no fog (GUI family).
#version 150

uniform vec4 ColorModulator;

in vec4 vColor;

void main() {
    gl_FragColor = vColor * ColorModulator;
}
