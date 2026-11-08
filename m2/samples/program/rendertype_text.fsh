// TeaFabric M2 test sample — rendertype_text fragment (OWN source).
// Exercises: texture2D rename + gl_FragColor injection + alpha rounding.
#version 150

uniform sampler2D Sampler0;

in vec4 vertexColor;
in vec2 uv0;

void main() {
    vec4 texel = texture2D(Sampler0, uv0);
    // glyph alpha rounds up so 1px outlines stay crisp at fractional scale
    float a = floor(texel.a * vertexColor.a * 255.0 + 0.5) / 255.0;
    if (a < 0.15) discard;
    gl_FragColor = vec4(vertexColor.rgb, a);
}
