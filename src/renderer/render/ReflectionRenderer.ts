/// <reference path="../Prefix.d.ts" />
/// <reference path="TextureManager.ts" />
/// <reference path="../core/RenderBufferManager.ts" />
/// <reference path="../core/RendererCore.ts" />
/// <reference path="MaterialManager.ts" />
/// <reference path="../core/GLFramebuffer.ts" />
/// <reference path="GeometryRenderer.ts" />
/// <reference path="HdrDemosaicFilter.ts" />
/// <reference path="../utils/Geometry.ts" />
/// <reference path="../public/ReflectionProbe.ts" />
module Hyper.Renderer
{
	export interface ReflectionPassInput
	{
		g0: TextureRenderBufferInfo;
		g1: TextureRenderBufferInfo;
		g2: TextureRenderBufferInfo;
		g3: TextureRenderBufferInfo;
		depth: TextureRenderBufferInfo;
		linearDepth: TextureRenderBufferInfo;
		ssao: TextureRenderBufferInfo;
		
		lit: TextureRenderBufferInfo;
	}
	
	export interface ReflectionPassOutput
	{
		lit: TextureRenderBufferInfo;
	}
	
	export class ReflectionRenderer
	{
		constructor(public renderer: RendererCore)
		{
		}
		
		dispose(): void
		{
		}
		
		setupReflectionPass(input: ReflectionPassInput, ops: RenderOperation[]): ReflectionPassOutput
		{
			const width = input.g0.width;
			const height = input.g0.height;
			
			const outp: ReflectionPassOutput = {
				lit: new TextureRenderBufferInfo("Reflection Added Mosaicked", width, height,
					this.renderer.supportsSRGB ?
						TextureRenderBufferFormat.SRGBA8 :
						TextureRenderBufferFormat.RGBA8)
			};
			
			const iblDone = new TextureRenderBufferInfo("IBL Lit", width, height,
					this.renderer.supportsSRGB ?
						TextureRenderBufferFormat.SRGBA8 :
						TextureRenderBufferFormat.RGBA8);
						
			const demosaiced = this.renderer.hdrDemosaic.setupFilter(input.lit, {
				halfSized: false	
			}, ops);
						
			const depthCullEnabled =
				input.depth.width == width &&
				input.depth.height == height &&
				input.depth.isDepthBuffer;
			
			ops.push({
				inputs: {
					g0: input.g0,
					g1: input.g1,
					g2: input.g2,
					g3: input.g3,
					linearDepth: input.linearDepth,
					depth: depthCullEnabled ? input.depth : null,
					ssao: input.ssao
				},
				outputs: {
					lit: iblDone
				},
				bindings: [
					'lit', 'lit'
				],
				optionalOutputs: [],
				name: "IBL Pass",
				factory: (cfg) => new ImageBasedLightRenderer(this,
					<TextureRenderBuffer> cfg.inputs['g0'],
					<TextureRenderBuffer> cfg.inputs['g1'],
					<TextureRenderBuffer> cfg.inputs['g2'],
					<TextureRenderBuffer> cfg.inputs['g3'],
					<TextureRenderBuffer> cfg.inputs['linearDepth'],
					<TextureRenderBuffer> cfg.inputs['depth'],
					<TextureRenderBuffer> cfg.inputs['ssao'],
					<TextureRenderBuffer> cfg.outputs['lit'])
			});
			
			ops.push({
				inputs: {
					g0: input.g0,
					g1: input.g1,
					g2: input.g2,
					reflections: iblDone,
					linearDepth: input.linearDepth,
					color: demosaiced,
					lit: input.lit
				},
				outputs: {
					lit: outp.lit
				},
				bindings: [
					'lit', 'lit'
				],
				optionalOutputs: [],
				name: "Screen-space Reflections",
				factory: (cfg) => new SSRRenderer(this,
					<TextureRenderBuffer> cfg.inputs['g0'],
					<TextureRenderBuffer> cfg.inputs['g1'],
					<TextureRenderBuffer> cfg.inputs['g2'],
					<TextureRenderBuffer> cfg.inputs['reflections'],
					<TextureRenderBuffer> cfg.inputs['color'],
					<TextureRenderBuffer> cfg.inputs['linearDepth'],
					<TextureRenderBuffer> cfg.inputs['lit'],
					<TextureRenderBuffer> cfg.outputs['lit'])
			});
			
			
			return outp;
		}
		
	}
	
	const enum IBLShaderFlags
	{
		Default = 0,
		IsBlendPass = 1 << 0
	}
	
	class ImageBasedLightRenderer implements RenderOperator
	{
		private fb: GLFramebuffer;
		private tmpMat: THREE.Matrix4;
		private projectionViewMat: THREE.Matrix4;
		private viewMat: THREE.Matrix4;
		private invViewMat: THREE.Matrix4;
		private viewVec: ViewVectors;
		
		private probes: ReflectionProbe[];
		
		private ambientProgram: {
			program: GLProgram;
			uniforms: GLProgramUniforms;
			attributes: GLProgramAttributes;		
		}[];
		
		constructor(
			private parent: ReflectionRenderer,
			private inG0: TextureRenderBuffer,
			private inG1: TextureRenderBuffer,
			private inG2: TextureRenderBuffer,
			private inG3: TextureRenderBuffer,
			private inLinearDepth: TextureRenderBuffer,
			private inDepth: TextureRenderBuffer,
			private inSSAO: TextureRenderBuffer,
			private outLit: TextureRenderBuffer
		)
		{
			
			this.fb = GLFramebuffer.createFramebuffer(parent.renderer.gl, {
				depth: inDepth ? inDepth.texture : null,
				colors: [
					outLit.texture
				]
			});
			
			this.tmpMat = new THREE.Matrix4();
			this.projectionViewMat = new THREE.Matrix4();
			this.viewMat = null;
			this.viewVec = null;
			this.probes = [];
			
			this.ambientProgram = [];
			for (let i = 0; i < 2; ++i) {
				const program = parent.renderer.shaderManager.get('VS_DeferredAmbientIBL', 'FS_DeferredAmbientIBL',
					['a_position'], {
						isBlendPass: (i & IBLShaderFlags.IsBlendPass) != 0
					});
				this.ambientProgram.push({
					program,
					uniforms: program.getUniforms([
						'u_g0', 'u_g1', 'u_g2', 'u_g3', 'u_linearDepth', 'u_ssao', 'u_reflection',
						'u_viewDirCoefX', 'u_viewDirCoefY', 'u_viewDirOffset', 'u_reflectionMatrix'
					]),
					attributes: program.getAttributes(['a_position'])
				});
			}
		}
		beforeRender(): void
		{
			const scene = this.parent.renderer.currentScene;
			const currentCamera = this.parent.renderer.currentCamera;
			
			this.viewMat = currentCamera.matrixWorldInverse;
			this.invViewMat = currentCamera.matrixWorld;
			this.projectionViewMat.multiplyMatrices(
				currentCamera.projectionMatrix,
				currentCamera.matrixWorldInverse
			);
			this.viewVec = computeViewVectorCoefFromProjectionMatrix(
				currentCamera.projectionMatrix,
				this.viewVec
			);
		}
		perform(): void
		{
			const scene = this.parent.renderer.currentScene;
			const gl = this.parent.renderer.gl;
			
			this.fb.bind();
			gl.viewport(0, 0, this.outLit.width, this.outLit.height);
			
			this.parent.renderer.state.flags = 
				GLStateFlags.DepthTestEnabled |
				GLStateFlags.DepthWriteDisabled;
				
			gl.clearColor(0, 0, 0, 0);
			gl.clear(gl.COLOR_BUFFER_BIT);
			
			// bind G-Buffer
			gl.activeTexture(gl.TEXTURE0);
			gl.bindTexture(gl.TEXTURE_2D, this.inG0.texture);
			gl.activeTexture(gl.TEXTURE1);
			gl.bindTexture(gl.TEXTURE_2D, this.inG1.texture);
			gl.activeTexture(gl.TEXTURE2);
			gl.bindTexture(gl.TEXTURE_2D, this.inG2.texture);
			gl.activeTexture(gl.TEXTURE3);
			gl.bindTexture(gl.TEXTURE_2D, this.inG3.texture); // FIXME: not needed in dynamic light pass
			gl.activeTexture(gl.TEXTURE4);
			gl.bindTexture(gl.TEXTURE_2D, this.inLinearDepth.texture);
			gl.activeTexture(gl.TEXTURE5);
			gl.bindTexture(gl.TEXTURE_2D, this.inSSAO.texture);
			// TEXTURE6: reflection
			
			// setup common uniforms
			for (const p of this.ambientProgram) {
				p.program.use();
				gl.uniform1i(p.uniforms['u_g0'], 0);
				gl.uniform1i(p.uniforms['u_g1'], 1);
				gl.uniform1i(p.uniforms['u_g2'], 2);
				gl.uniform1i(p.uniforms['u_g3'], 3);
				gl.uniform1i(p.uniforms['u_linearDepth'], 4);
				gl.uniform1i(p.uniforms['u_ssao'], 5);
				gl.uniform1i(p.uniforms['u_reflection'], 6);
				gl.uniform2f(p.uniforms['u_viewDirOffset'],
					this.viewVec.offset.x, this.viewVec.offset.y);
				gl.uniform2f(p.uniforms['u_viewDirCoefX'],
					this.viewVec.coefX.x, this.viewVec.coefX.y);
				gl.uniform2f(p.uniforms['u_viewDirCoefY'],
					this.viewVec.coefY.x, this.viewVec.coefY.y);
			}
			
			// traverse scene
			this.probes.length = 0;
			this.renderTree(scene);
			
			// sort reflection probes by priority
			this.probes.sort((a, b) => a.priority - b.priority);
			
			// render reflection probes
			this.parent.renderer.state.flags = 
				GLStateFlags.DepthTestEnabled |
				GLStateFlags.DepthWriteDisabled |
				GLStateFlags.BlendEnabled |
				GLStateFlags.ColorAlphaWriteDisabled;
			gl.blendFunc(gl.SRC_ALPHA, gl.ONE_MINUS_SRC_ALPHA);
			for (const p of this.probes) {
				this.renderProbe(p, true);
			}
			
			// compute maximum possible luminance value
			// FIXME: hard edge might be visible
			this.parent.renderer.state.flags = 
				GLStateFlags.DepthTestEnabled |
				GLStateFlags.DepthWriteDisabled |
				GLStateFlags.BlendEnabled |
				GLStateFlags.ColorRGBWriteDisabled;
			gl.blendFunc(gl.SRC_ALPHA, gl.ONE_MINUS_SRC_ALPHA);
			const ext = this.parent.renderer.ext.get('EXT_blend_minmax');
			if (ext)
				gl.blendEquation(ext.MAX_EXT);
			for (const p of this.probes) {
				this.renderProbe(p, true);
			}
			if (ext)
				gl.blendEquation(gl.FUNC_ADD);
			
		}
		private renderTree(obj: THREE.Object3D): void
		{
			if (obj instanceof ReflectionProbe) {
				// TODO: frustum cull
				this.probes.push(obj);
			}
			
			for (const child of obj.children) {
				this.renderTree(child);
			}
		}
		private renderProbe(probe: ReflectionProbe, isBlendPass: boolean): void
		{
			const gl = this.parent.renderer.gl;
			const isAmbient = !isFinite(probe.distance);
			const tex = this.parent.renderer.textures.get(probe.texture);
			
			if (tex.textureTarget != gl.TEXTURE_CUBE_MAP) {
				throw new Error("reflection texture is not cubemap!");
			}
			
			let flags = IBLShaderFlags.Default;
			if (isBlendPass) {
				flags |= IBLShaderFlags.IsBlendPass;
			}
			
			const reflMat = this.tmpMat;
			reflMat.getInverse(probe.matrixWorld);
			reflMat.multiply(this.invViewMat);
			
			if (isAmbient) {
				const p = this.ambientProgram[flags];
				p.program.use();
				
				gl.uniformMatrix4fv(p.uniforms['u_reflectionMatrix'], false,
					reflMat.elements);
				
				gl.activeTexture(gl.TEXTURE6);
				tex.bind();
				
				const quad = this.parent.renderer.quadRenderer;
				gl.depthFunc(gl.GREATER);	
				quad.render(p.attributes['a_position']);
				gl.depthFunc(gl.LESS);
			}
			
			// TODO: renderProbe
		}
		
		
		afterRender(): void
		{
		}
		dispose(): void
		{
			this.fb.dispose();
		}
	}
	
	
	export class SSRRenderer implements RenderOperator
	{
		private fb: GLFramebuffer;
		private tmpMat: THREE.Matrix4;
		private viewMat: THREE.Matrix4;
		private viewVec: ViewVectors;
		
		private program: {
			program: GLProgram;
			uniforms: GLProgramUniforms;
			attributes: GLProgramAttributes;		
		};
		
		constructor(
			private parent: ReflectionRenderer,
			private inG0: TextureRenderBuffer,
			private inG1: TextureRenderBuffer,
			private inG2: TextureRenderBuffer,
			private inReflections: TextureRenderBuffer,
			private inColor: TextureRenderBuffer,
			private inLinearDepth: TextureRenderBuffer,
			private inLit: TextureRenderBuffer,
			private out: TextureRenderBuffer
		)
		{
			
			this.fb = GLFramebuffer.createFramebuffer(parent.renderer.gl, {
				depth: null,
				colors: [
					out.texture
				]
			});
			
			this.tmpMat = new THREE.Matrix4();
			this.viewMat = null;
			this.viewVec = null;
			
			{
				const program = parent.renderer.shaderManager.get('VS_SSR', 'FS_SSR',
					['a_position']);
				this.program = {
					program,
					uniforms: program.getUniforms([
						'u_linearDepth', 'u_g0', 'u_g1', 'u_g2', 'u_color', 'u_reflections',
						'u_viewDirCoefX', 'u_viewDirCoefY', 'u_viewDirOffset',
						'u_projectionMatrix',
						'u_stride',
						
						'u_jitter', 'u_jitterCoordScale'
					]),
					attributes: program.getAttributes(['a_position'])
				};
			}
		}
		beforeRender(): void
		{
			this.viewMat = this.parent.renderer.currentCamera.matrixWorldInverse;
			this.viewVec = computeViewVectorCoefFromProjectionMatrix(
				this.parent.renderer.currentCamera.projectionMatrix,
				this.viewVec
			);
		}
		perform(): void
		{
			const scene = this.parent.renderer.currentScene;
			this.fb.bind();
			
			const gl = this.parent.renderer.gl;
			gl.viewport(0, 0, this.out.width, this.out.height);
			this.parent.renderer.state.flags = 
				GLStateFlags.DepthWriteDisabled;
				
			if (this.inLit !== this.out) {
				this.parent.renderer.invalidateFramebuffer(gl.COLOR_ATTACHMENT0);
				gl.activeTexture(gl.TEXTURE0);
				gl.bindTexture(gl.TEXTURE_2D, this.inLit.texture);
				this.parent.renderer.passthroughRenderer.render();
			}
			
			this.parent.renderer.state.flags = 
				GLStateFlags.DepthWriteDisabled |
				GLStateFlags.BlendEnabled;
				
			gl.blendFunc(gl.ONE, gl.ONE);
			
			gl.activeTexture(gl.TEXTURE0);
			gl.bindTexture(gl.TEXTURE_2D, this.inG0.texture);
			gl.activeTexture(gl.TEXTURE1);
			gl.bindTexture(gl.TEXTURE_2D, this.inG1.texture);
			gl.activeTexture(gl.TEXTURE2);
			gl.bindTexture(gl.TEXTURE_2D, this.inG2.texture);
			gl.activeTexture(gl.TEXTURE3);
			gl.bindTexture(gl.TEXTURE_2D, this.inLinearDepth.texture);
			gl.activeTexture(gl.TEXTURE4);
			gl.bindTexture(gl.TEXTURE_2D, this.inColor.texture);
			gl.activeTexture(gl.TEXTURE5);
			gl.bindTexture(gl.TEXTURE_2D, this.inReflections.texture);
			gl.activeTexture(gl.TEXTURE6);
			gl.bindTexture(gl.TEXTURE_2D, this.parent.renderer.uniformJitter.texture);
			
			const kernelSize = Math.min(this.out.width, this.out.height) * 0.002;
			
			const p = this.program;
			p.program.use();
			gl.uniform1i(p.uniforms['u_g0'], 0);
			gl.uniform1i(p.uniforms['u_g1'], 1);
			gl.uniform1i(p.uniforms['u_g2'], 2);
			gl.uniform1i(p.uniforms['u_linearDepth'], 3);
			gl.uniform1i(p.uniforms['u_color'], 4);
			gl.uniform1i(p.uniforms['u_reflections'], 5);
			gl.uniform1i(p.uniforms['u_jitter'], 6);
			gl.uniform2f(p.uniforms['u_viewDirOffset'],
				this.viewVec.offset.x, this.viewVec.offset.y);
			gl.uniform2f(p.uniforms['u_viewDirCoefX'],
				this.viewVec.coefX.x, this.viewVec.coefX.y);
			gl.uniform2f(p.uniforms['u_viewDirCoefY'],
				this.viewVec.coefY.x, this.viewVec.coefY.y);
			gl.uniform1f(p.uniforms['u_stride'], Math.ceil(this.inLinearDepth.height / 80));
			gl.uniform2f(p.uniforms['u_jitterCoordScale'],
				this.inLinearDepth.width / this.parent.renderer.uniformJitter.size,
				this.inLinearDepth.height / this.parent.renderer.uniformJitter.size);
				
			tmpM2.makeTranslation(1, 1, 1).multiply(this.parent.renderer.currentCamera.projectionMatrix);
			tmpM3.makeScale(this.inLinearDepth.width / 2, this.inLinearDepth.height / 2, 0.5).multiply(tmpM2);
			gl.uniformMatrix4fv(p.uniforms['u_projectionMatrix'], false,
				tmpM3.elements);
				
			const quad = this.parent.renderer.quadRenderer;
			quad.render(p.attributes['a_position']);
		}
		afterRender(): void
		{
		}
		dispose(): void
		{
			this.fb.dispose();
		}
	}
}
