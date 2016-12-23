#pragma require VS_BaseGeometry
#pragma parameter useNormalMap
#pragma parameter usePointSize

attribute float a_viewId;

varying vec3 v_viewNormal;
#if c_useNormalMap
varying vec3 v_viewTangent;
varying vec3 v_viewBitangent;
#endif

uniform mat4 u_projectionMatrix2;
uniform mat4 u_viewProjectionMatrix2;
uniform mat4 u_viewMatrix2;

varying vec4 v_screenPosition;
varying vec3 v_lastScreenPosition;

uniform mat4 u_lastViewProjectionMatrix;
uniform mat4 u_lastViewProjectionMatrix2;
uniform vec2 u_screenVelOffset;

varying float v_clipDistance;

void main()
{
    evaluateGeometry();

    bool secondView = a_viewId > 0.5;

    gl_Position = (secondView ? u_viewProjectionMatrix2 : u_viewProjectionMatrix) * vec4(worldPosition, 1.);

    v_screenPosition.xyz = gl_Position.xyw;
    v_lastScreenPosition = ((secondView ? u_lastViewProjectionMatrix2 : u_lastViewProjectionMatrix) * vec4(lastWorldPosition, 1.)).xyw;
    v_screenPosition.xy += u_screenVelOffset * v_screenPosition.z;

    mat4 viewMatrix = secondView ? u_viewMatrix2 : u_viewMatrix;

    v_screenPosition.w = -(viewMatrix * vec4(worldPosition, 1.)).z; // depth

    v_viewNormal = (viewMatrix * vec4(worldNormal, 0.)).xyz;
#if c_useNormalMap
    v_viewTangent = (viewMatrix * vec4(worldTangent, 0.)).xyz;
    v_viewBitangent = cross(v_viewNormal, v_viewTangent);
#endif

#if c_usePointSize
    gl_PointSize = computeProjectedPointSize(m_pointSize, secondView ? u_projectionMatrix2 : u_projectionMatrix, gl_Position, u_globalHalfRenderSize);
	v_viewNormal = vec3(0., 0., 1.);
#if c_useNormalMap
    v_viewTangent = vec3(1., 0., 0.);
    v_viewBitangent = vec3(0., -1., 0.);
#endif
#endif

    if (secondView) {
        gl_Position.x = gl_Position.x * 0.5 + gl_Position.w * 0.5;
        v_clipDistance = gl_Position.x;
    } else {
        gl_Position.x = gl_Position.x * 0.5 - gl_Position.w * 0.5;
        v_clipDistance = -gl_Position.x;
    }
}
