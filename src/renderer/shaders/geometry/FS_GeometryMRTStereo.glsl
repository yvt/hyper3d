#pragma require FS_Geometry
#pragma require DepthFetch
#pragma parameter globalSupportsSRGB
#extension GL_EXT_draw_buffers : require

varying highp float v_clipDistance;

void main()
{
    if (v_clipDistance < 0.0) {
        discard;
    }
    GBufferContents g = evaluateGeometry();
    vec4 g0, g1, g2, g3;

    encodeGBuffer(g0, g1, g2, g3, g);

#if !c_globalSupportsSRGB
    g0.xyz = sqrt(g0.xyz);
#endif

    gl_FragData[0] = g0;
    gl_FragData[1] = g1;
    gl_FragData[2] = g2;
    gl_FragData[3] = g3;

    if (gl_MaxDrawBuffers >= 5) {
        // When 5 or more buffers are supported,
        // lineer depth value can be written.
        gl_FragData[4] = encodeGDepth(v_screenPosition.w); // contains depth value
    }
}