// TeaFabric M2 v1.1 — GUI fallback program: position (OWN source).
// Fragments take the current-color uniform verbatim (glColor equivalent).
#version 150

uniform vec4 Color;

void main() {
    gl_FragColor = Color;
}
