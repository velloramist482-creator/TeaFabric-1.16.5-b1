// TeaFabric M2 v1.1 — GUI fallback program: position_tex_color_normal (OWN source).
// texel x vertex color x headlight-lambert shade. GUI family: no fog, no lightmap.
#version 150

uniform sampler2D Sampler0;
uniform vec4 ColorModulator;

in vec2 uv0;
in vec4 vColor;
in vec3 vNormal;

const vec3 LIGHT_DIR = vec3(0.0, 0.0, 1.0); // headlight, view space
const float AMBIENT = 0.4;

void main() {
    vec4 texel = texture2D(Sampler0, uv0);
    float shade = AMBIENT + (1.0 - AMBIENT) * max(dot(normalize(vNormal), LIGHT_DIR), 0.0);
    gl_FragColor = texel * vColor * shade * ColorModulator;
}
