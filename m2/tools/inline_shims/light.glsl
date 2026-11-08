// TeaFabric M2 — light.glsl equivalent (OWN implementation, function
// signatures follow the 1.16.5 core-shader call convention).
// NOTE (ES 3.00): implicit int->float conversion is ILLEGAL in GLSL ES 3.00
// (it was allowed in GLSL 1.50). All ivec2 lightmap coords are explicitly
// cast — caught by the real-WebGL2 compile stage of CI.
vec4 minecraft_mix_light(vec3 light0, vec3 light1, vec4 color) {
    float l0 = max(0.0, dot(normalize(light0 + vec3(0.0, 0.001, 0.0)), vec3(0.0, 1.0, 0.0)));
    float l1 = max(0.0, dot(normalize(light1 + vec3(0.0, 0.001, 0.0)), vec3(0.0, 1.0, 0.0)));
    float lm = max(l0, l1);
    return vec4(color.rgb * lm, color.a);
}

vec4 minecraft_mix_light_mid_block(vec3 light0, vec3 light1, vec3 midBlock, vec4 color) {
    float lift = clamp(1.0 - length(midBlock) * 0.1, 0.75, 1.0);
    return minecraft_mix_light(light0, light1, color) * vec4(lift, lift, lift, 1.0);
}

vec4 minecraft_sample_lightmap(sampler2D lightMap, ivec2 uv) {
    return texture(lightMap, (vec2(uv) + vec2(0.5)) / 256.0);
}
