// TeaFabric M2 test sample — rendertype_solid fragment (OWN source).
#version 150

#moj_import <fog.glsl>

uniform sampler2D Sampler0;

in vec4 vertexColor;
in vec2 uv0;
in vec3 vertexDistance;

uniform float FogStart;
uniform float FogEnd;
uniform vec4 FogColor;

void main() {
    vec4 texel = texture2D(Sampler0, uv0);
    if (texel.a < 0.1) discard;
    gl_FragColor = minecraft_apply_fog(texel * vertexColor, vertexDistance, FogStart, FogEnd, FogColor);
}
