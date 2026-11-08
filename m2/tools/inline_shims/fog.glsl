// TeaFabric M2 — fog.glsl equivalent (OWN implementation, function
// signatures follow the 1.16.5 core-shader call convention).
vec4 minecraft_apply_fog(vec4 color, vec3 vertexDistance, float fogStart, float fogEnd, vec4 fogColor) {
    float dist = length(vertexDistance);
    float t = clamp((dist - fogStart) / (fogEnd - fogStart), 0.0, 1.0);
    return vec4(mix(color.rgb, fogColor.rgb, t), color.a);
}
