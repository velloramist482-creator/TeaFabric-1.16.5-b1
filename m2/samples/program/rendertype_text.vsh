// TeaFabric M2 test sample — rendertype_text equivalent (OWN source).
// Exercises: attribute in-conversion + alpha discard + uniform rounding.
#version 150

in vec3 Position;
in vec2 UV0;
in vec4 Color;

uniform sampler2D Sampler0;
uniform mat4 ModelViewMat;
uniform mat4 ProjMat;
uniform vec4 ColorModulator;

out vec4 vertexColor;
out vec2 uv0;

void main() {
    gl_Position = ProjMat * ModelViewMat * vec4(Position, 1.0);
    vertexColor = Color * ColorModulator;
    uv0 = UV0;
}
