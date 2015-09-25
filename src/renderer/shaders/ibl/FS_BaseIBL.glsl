// this shader is abstract; must be imported and function implementations must be provided
#pragma require GBuffer
#pragma require ShadingModel
#pragma require HdrMosaic
#pragma require DepthFetch
#pragma parameter isBlendPass

uniform sampler2D u_g0;
uniform sampler2D u_g1;
uniform sampler2D u_g2;
uniform sampler2D u_g3;
uniform sampler2D u_linearDepth;
uniform sampler2D u_ssao;

varying highp vec2 v_texCoord;
varying mediump vec2 v_viewDir;

uniform samplerCube u_reflection;

uniform mat4 u_reflectionMatrix;

// to be provided by derived shader
float evaluateWeight(vec3 viewPos);

void emitIBLOutput(vec3 lit, float weight)
{
	vec4 mosaicked = encodeHdrMosaic(lit);
	gl_FragColor = mosaicked;

#if c_isBlendPass
	gl_FragColor.w = weight;
#endif
}

void main()
{
	vec4 g0 = texture2D(u_g0, v_texCoord);
	vec4 g1 = texture2D(u_g1, v_texCoord);
	vec4 g2 = texture2D(u_g2, v_texCoord);
	vec4 g3 = texture2D(u_g3, v_texCoord);

	if (isGBufferEmpty(g0, g1, g2, g3)) {
		discard;
		return;
	}

	GBufferContents g;
	decodeGBuffer(g, g0, g1, g2, g3);

	MaterialInfo mat = getMaterialInfoFromGBuffer(g);

	highp vec3 viewDir = vec3(v_viewDir, 1.);
	highp float depth = fetchDepth(u_linearDepth, v_texCoord);
	highp vec3 viewPos = viewDir * depth;

	float weight = evaluateWeight(viewPos);

	vec3 reflVector = reflect(-(viewDir), g.normal);
	reflVector = (u_reflectionMatrix * vec4(reflVector, 0.)).xyz;

	// sampling from image
	// TODO: lod bias dependent of texture resolution
	// TODO: correct lod bias
	vec4 refl = textureCube(u_reflection, reflVector, mat.roughness * 14.);
	refl.xyz *= refl.xyz; // linearize

	// apply SSAO
	float ssao = texture2D(u_ssao, v_texCoord).r;
	ssao *= ssao;
	ssao = mix(1., ssao, min(mat.roughness * 4., 1.));
	refl *= ssao;

	// lighting model
	refl *= evaluateReflection(clamp(0., 1., dot(g.normal, normalize(viewDir))), mat);

	emitIBLOutput(refl.xyz, weight);
}
