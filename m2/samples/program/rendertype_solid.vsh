// TeaFabric M2 test sample — rendertype_solid equivalent (OWN source).
// Structure mirrors the 1.16.5 solid-terrain program: position/uv/color/
// lightmap attribs + directional lights + fog. Written from scratch.
#version 150

#moj_import <light.glsl>
#moj_import <fog.glsl>

in vec3 Position;
in vec2 UV0;
in vec4 Color;
in ivec2 UV2;

uniform sampler2D Sampler0;
uniform sampler2D Sampler2;

uniform mat4 ModelViewMat;
uniform mat4 ProjMat;
uniform vec4 ColorModulator;
uniform vec3 Light0_Direction;
uniform vec3 Light1_Direction;
uniform float FogStart;
uniform float FogEnd;
uniform vec4 FogColor;

out vec4 vertexColor;
out vec2 uv0;
out vec4 lightMapColor;
out vec3 vertexDistance;

void main() {
    gl_Position = ProjMat * ModelViewMat * vec4(Position, 1.0);

    vertexColor = minecraft_mix_light(Light0_Direction, Light1_Direction,
                    minecraft_sample_lightmap(Sampler2, UV2) * Color) * ColorModulator;
    uv0 = UV0;
    vertexDistance = (ModelViewMat * vec4(Position, 1.0)).xyz;
}
