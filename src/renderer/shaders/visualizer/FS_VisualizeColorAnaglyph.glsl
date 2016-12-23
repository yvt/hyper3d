#pragma parameter globalSupportsSRGB
uniform sampler2D u_texture1;
uniform sampler2D u_texture2;
varying highp vec2 v_texCoord;
void main()
{
    gl_FragColor.yz = vec2(dot(texture2D(u_texture1, v_texCoord).xyz, vec3(0.299, 0.587, 0.114)));
    gl_FragColor.x = dot(texture2D(u_texture2, v_texCoord).xyz, vec3(0.299, 0.587, 0.114));
#if c_globalSupportsSRGB
    gl_FragColor.xyz = sqrt(gl_FragColor.xyz);
#endif
    gl_FragColor.w = 1.;
}
