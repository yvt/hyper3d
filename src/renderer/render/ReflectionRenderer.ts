/// <reference path="../Prefix.d.ts" />

import * as three from "three";

import {
    DepthTextureRenderBufferInfo,
    GBuffer0TextureRenderBufferInfo,
    GBuffer1TextureRenderBufferInfo,
    GBuffer2TextureRenderBufferInfo,
    GBuffer3TextureRenderBufferInfo,
    LinearDepthTextureRenderBufferInfo,
    HdrMosaicTextureRenderBufferInfo,
    LinearRGBTextureRenderBufferInfo,
    LogRGBTextureRenderBufferInfo
} from "../core/TypedRenderBuffers";

import {
    TextureRenderBufferInfo,
    TextureRenderBuffer,
    TextureRenderBufferFormat
} from "../core/RenderBuffers";

import {
    RenderOperator,
    RenderOperation
} from "../core/RenderPipeline";

import {
    RendererCore,
    GLStateFlags
} from "../core/RendererCore";

import { ReflectionProbe } from "../public/ReflectionProbe";

import {
    ViewVectors,
    computeViewVectorCoefFromProjectionMatrix
} from "../utils/Geometry";

import { Matrix4Pool } from "../utils/ObjectPool";

import { GLFramebuffer } from "../core/GLFramebuffer";

import { ReflectionTextureCube } from "./ReflectionTextureProvider";

import {
    GLProgram,
    GLProgramUniforms,
    GLProgramAttributes
} from "../core/GLProgram";

export interface ReflectionPassInput<T extends HdrMosaicTextureRenderBufferInfo | LinearRGBTextureRenderBufferInfo>
{
    g0: GBuffer0TextureRenderBufferInfo;
    g1: GBuffer1TextureRenderBufferInfo;
    g2: GBuffer2TextureRenderBufferInfo;
    g3: GBuffer3TextureRenderBufferInfo;
    depth: DepthTextureRenderBufferInfo;
    linearDepth: LinearDepthTextureRenderBufferInfo;
    ssao: TextureRenderBufferInfo;

    lit: T;
}

export class ReflectionRenderer
{
    constructor(public renderer: RendererCore)
    {
    }

    dispose(): void
    {
    }

    setupReflectionPass<T extends HdrMosaicTextureRenderBufferInfo | LinearRGBTextureRenderBufferInfo>
    (input: ReflectionPassInput<T>, viewId: number, ops: RenderOperation[]): T
    {
        const width = input.g0.width;
        const height = input.g0.height;

        const outp: T = <any> (
            input.lit instanceof LinearRGBTextureRenderBufferInfo ?
                new LinearRGBTextureRenderBufferInfo("Reflection Added", width, height,
                    TextureRenderBufferFormat.RGBAF16) :
                new HdrMosaicTextureRenderBufferInfo("Reflection Added Mosaicked", width, height,
                    this.renderer.supportsSRGB ?
                        TextureRenderBufferFormat.SRGBA8 :
                        TextureRenderBufferFormat.RGBA8));

        const iblDone: T = <any> (
            input.lit instanceof LinearRGBTextureRenderBufferInfo ?
                new LinearRGBTextureRenderBufferInfo("IBL Lit", width, height,
                    TextureRenderBufferFormat.RGBAF16) :
                new HdrMosaicTextureRenderBufferInfo("IBL Lit Mosaicked", width, height,
                    this.renderer.supportsSRGB ?
                        TextureRenderBufferFormat.SRGBA8 :
                        TextureRenderBufferFormat.RGBA8));

        const demosaiced = input.lit instanceof LinearRGBTextureRenderBufferInfo ? input.lit :
            this.renderer.hdrDemosaic.setupFilter(input.lit, {
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
                "lit", "lit"
            ],
            optionalOutputs: [],
            name: "IBL Pass",
            factory: (cfg) => new ImageBasedLightRenderer(this, viewId,
                <TextureRenderBuffer> cfg.inputs["g0"],
                <TextureRenderBuffer> cfg.inputs["g1"],
                <TextureRenderBuffer> cfg.inputs["g2"],
                <TextureRenderBuffer> cfg.inputs["g3"],
                <TextureRenderBuffer> cfg.inputs["linearDepth"],
                <TextureRenderBuffer> cfg.inputs["depth"],
                <TextureRenderBuffer> cfg.inputs["ssao"],
                <TextureRenderBuffer> cfg.outputs["lit"],
                input.lit instanceof HdrMosaicTextureRenderBufferInfo)
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
                lit: outp
            },
            bindings: [
                "lit", "lit"
            ],
            optionalOutputs: [],
            name: "Screen-space Reflections",
            factory: (cfg) => new SSRRenderer(this, viewId,
                <TextureRenderBuffer> cfg.inputs["g0"],
                <TextureRenderBuffer> cfg.inputs["g1"],
                <TextureRenderBuffer> cfg.inputs["g2"],
                <TextureRenderBuffer> cfg.inputs["reflections"],
                <TextureRenderBuffer> cfg.inputs["color"],
                <TextureRenderBuffer> cfg.inputs["linearDepth"],
                <TextureRenderBuffer> cfg.inputs["lit"],
                <TextureRenderBuffer> cfg.outputs["lit"],
                input.lit instanceof HdrMosaicTextureRenderBufferInfo,
                demosaiced instanceof LogRGBTextureRenderBufferInfo)
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
    private tmpMat: three.Matrix4;
    private projectionViewMat: three.Matrix4;
    private viewMat: three.Matrix4;
    private invViewMat: three.Matrix4;
    private viewVec: ViewVectors;

    private probes: ReflectionProbe[];

    private ambientProgram: {
        program: GLProgram;
        uniforms: GLProgramUniforms;
        attributes: GLProgramAttributes;
    }[];

    constructor(
        private parent: ReflectionRenderer,
        private viewId: number,
        private inG0: TextureRenderBuffer,
        private inG1: TextureRenderBuffer,
        private inG2: TextureRenderBuffer,
        private inG3: TextureRenderBuffer,
        private inLinearDepth: TextureRenderBuffer,
        private inDepth: TextureRenderBuffer,
        private inSSAO: TextureRenderBuffer,
        private outLit: TextureRenderBuffer,
        private useHdrMosaic: boolean
    )
    {

        this.fb = GLFramebuffer.createFramebuffer(parent.renderer.gl, {
            depth: inDepth ? inDepth.texture : null,
            colors: [
                outLit.texture
            ]
        });

        this.tmpMat = new three.Matrix4();
        this.projectionViewMat = new three.Matrix4();
        this.viewMat = null;
        this.viewVec = null;
        this.probes = [];

        this.ambientProgram = [];
        for (let i = 0; i < 2; ++i) {
            // for native HDR mode, no non-blending pass is required
            if (!useHdrMosaic && (i & IBLShaderFlags.IsBlendPass) == 0) {
                this.ambientProgram.push(null);
                continue;
            }

            const program = parent.renderer.shaderManager.get("VS_DeferredAmbientIBL", "FS_DeferredAmbientIBL",
                ["a_position"], {
                    isBlendPass: (i & IBLShaderFlags.IsBlendPass) != 0,
                    useHdrMosaic
                });
            this.ambientProgram.push({
                program,
                uniforms: program.getUniforms([
                    "u_g0", "u_g1", "u_g2", "u_linearDepth", "u_ssao", "u_reflection",
                    "u_viewDirCoefX", "u_viewDirCoefY", "u_viewDirOffset",
                    "u_reflectionMatrix", "u_reflectionLodBias", "u_reflectionSize",
                    "u_dither", "u_ditherScale"
                ]),
                attributes: program.getAttributes(["a_position"])
            });
        }
    }
    beforeRender(): void
    {
        const currentCamera = this.parent.renderer.currentCamera[this.viewId];

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

        const jitter = this.parent.renderer.uniformJitter;

        // bind G-Buffer
        gl.activeTexture(gl.TEXTURE0);
        gl.bindTexture(gl.TEXTURE_2D, this.inG0.texture);
        gl.activeTexture(gl.TEXTURE1);
        gl.bindTexture(gl.TEXTURE_2D, this.inG1.texture);
        gl.activeTexture(gl.TEXTURE2);
        gl.bindTexture(gl.TEXTURE_2D, this.inG2.texture);
        gl.activeTexture(gl.TEXTURE3);
        gl.bindTexture(gl.TEXTURE_2D, jitter.texture);
        gl.activeTexture(gl.TEXTURE4);
        gl.bindTexture(gl.TEXTURE_2D, this.inLinearDepth.texture);
        gl.activeTexture(gl.TEXTURE5);
        gl.bindTexture(gl.TEXTURE_2D, this.inSSAO.texture);
        // TEXTURE6: reflection

        // setup common uniforms
        for (const p of this.ambientProgram) {
            if (!p) {
                continue;
            }
            p.program.use();
            gl.uniform1i(p.uniforms["u_g0"], 0);
            gl.uniform1i(p.uniforms["u_g1"], 1);
            gl.uniform1i(p.uniforms["u_g2"], 2);
            gl.uniform1i(p.uniforms["u_dither"], 3);
            gl.uniform1i(p.uniforms["u_linearDepth"], 4);
            gl.uniform1i(p.uniforms["u_ssao"], 5);
            gl.uniform1i(p.uniforms["u_reflection"], 6);
            gl.uniform2f(p.uniforms["u_viewDirOffset"],
                this.viewVec.offset.x, this.viewVec.offset.y);
            gl.uniform2f(p.uniforms["u_viewDirCoefX"],
                this.viewVec.coefX.x, this.viewVec.coefX.y);
            gl.uniform2f(p.uniforms["u_viewDirCoefY"],
                this.viewVec.coefY.x, this.viewVec.coefY.y);
            gl.uniform2f(p.uniforms["u_ditherScale"],
                this.outLit.width / jitter.size / 4,
                this.outLit.height / jitter.size / 4);
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

        if (this.useHdrMosaic) {
            // non-blending pass is only required for mobile HDR.
            // real HDR doesn't require the following procedure.

            // compute maximum possible luminance value
            // FIXME: hard edge might be visible
            // FIXME: RGB is ignored, so different shader must be used for performance
            this.parent.renderer.state.flags =
                GLStateFlags.DepthTestEnabled |
                GLStateFlags.DepthWriteDisabled |
                GLStateFlags.BlendEnabled |
                GLStateFlags.ColorRGBWriteDisabled;
            gl.blendFunc(gl.SRC_ALPHA, gl.ONE_MINUS_SRC_ALPHA);
            const ext = this.parent.renderer.ext.get("EXT_blend_minmax");
            if (ext)
                gl.blendEquation(ext.MAX_EXT);
            for (const p of this.probes) {
                this.renderProbe(p, false);
            }
            if (ext)
                gl.blendEquation(gl.FUNC_ADD);
        }

    }
    private renderTree(obj: three.Object3D): void
    {
        if (obj instanceof ReflectionProbe) {
            // TODO: frustum cull
            this.probes.push(obj);
        }

        for (const child of obj.children) {
            this.renderTree(child);
        }
    }
    private computeReflectionLodBias(tex: ReflectionTextureCube): number
    {
        return tex.log2Size - 20;
    }
    private renderProbe(probe: ReflectionProbe, isBlendPass: boolean): void
    {
        const gl = this.parent.renderer.gl;
        const isAmbient = !isFinite(probe.distance);
        const tex = this.parent.renderer.reflectionTextures.get(probe.texture);

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

            gl.uniformMatrix4fv(p.uniforms["u_reflectionMatrix"], false,
                reflMat.elements);

            gl.uniform1f(p.uniforms["u_reflectionLodBias"],
                this.computeReflectionLodBias(tex));

            gl.uniform1f(p.uniforms["u_reflectionSize"],
                1 << tex.log2Size);

            gl.activeTexture(gl.TEXTURE6);
            tex.bind();

            const quad = this.parent.renderer.quadRenderer;
            gl.depthFunc(gl.GREATER);
            quad.render(p.attributes["a_position"]);
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
    private tmpMat: three.Matrix4;
    private viewMat: three.Matrix4;
    private viewVec: ViewVectors;

    private program: {
        program: GLProgram;
        uniforms: GLProgramUniforms;
        attributes: GLProgramAttributes;
    };

    constructor(
        private parent: ReflectionRenderer,
        private viewId: number,
        private inG0: TextureRenderBuffer,
        private inG1: TextureRenderBuffer,
        private inG2: TextureRenderBuffer,
        private inReflections: TextureRenderBuffer,
        private inColor: TextureRenderBuffer,
        private inLinearDepth: TextureRenderBuffer,
        private inLit: TextureRenderBuffer,
        private out: TextureRenderBuffer,
        private useHdrMosaic: boolean,
        colorIsLogRGB: boolean
    )
    {

        this.fb = GLFramebuffer.createFramebuffer(parent.renderer.gl, {
            depth: null,
            colors: [
                out.texture
            ]
        });

        this.tmpMat = new three.Matrix4();
        this.viewMat = null;
        this.viewVec = null;

        {
            const program = parent.renderer.shaderManager.get("VS_SSR", "FS_SSR",
                ["a_position"], {
                    useHdrMosaic, colorIsLogRGB
                });
            this.program = {
                program,
                uniforms: program.getUniforms([
                    "u_linearDepth", "u_g0", "u_g1", "u_g2", "u_color", "u_reflections",
                    "u_viewDirCoefX", "u_viewDirCoefY", "u_viewDirOffset",
                    "u_projectionMatrix",
                    "u_stride",

                    "u_jitter", "u_jitterCoordScale"
                ]),
                attributes: program.getAttributes(["a_position"])
            };
        }
    }
    beforeRender(): void
    {
        this.viewMat = this.parent.renderer.currentCamera[this.viewId].matrixWorldInverse;
        this.viewVec = computeViewVectorCoefFromProjectionMatrix(
            this.parent.renderer.currentCamera[this.viewId].projectionMatrix,
            this.viewVec
        );
    }
    perform(): void
    {
        this.fb.bind();

        const gl = this.parent.renderer.gl;
        gl.viewport(0, 0, this.out.width, this.out.height);
        this.parent.renderer.state.flags =
            GLStateFlags.DepthWriteDisabled;

        if (this.inLit !== this.out) {
            this.parent.renderer.invalidateFramebuffer();
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
        gl.bindTexture(gl.TEXTURE_2D, this.parent.renderer.uniformDitherJitter.texture);

        const p = this.program;
        p.program.use();
        gl.uniform1i(p.uniforms["u_g0"], 0);
        gl.uniform1i(p.uniforms["u_g1"], 1);
        gl.uniform1i(p.uniforms["u_g2"], 2);
        gl.uniform1i(p.uniforms["u_linearDepth"], 3);
        gl.uniform1i(p.uniforms["u_color"], 4);
        gl.uniform1i(p.uniforms["u_reflections"], 5);
        gl.uniform1i(p.uniforms["u_jitter"], 6);
        gl.uniform2f(p.uniforms["u_viewDirOffset"],
            this.viewVec.offset.x, this.viewVec.offset.y);
        gl.uniform2f(p.uniforms["u_viewDirCoefX"],
            this.viewVec.coefX.x, this.viewVec.coefX.y);
        gl.uniform2f(p.uniforms["u_viewDirCoefY"],
            this.viewVec.coefY.x, this.viewVec.coefY.y);
        gl.uniform1f(p.uniforms["u_stride"], Math.ceil(this.inLinearDepth.height / 20));
        gl.uniform2f(p.uniforms["u_jitterCoordScale"],
            this.inLinearDepth.width / this.parent.renderer.uniformDitherJitter.size * (this.useHdrMosaic ? 0.5 : 1),
            this.inLinearDepth.height / this.parent.renderer.uniformDitherJitter.size * (this.useHdrMosaic ? 0.5 : 1));

        const m1 = Matrix4Pool.alloc();
        const m2 = Matrix4Pool.alloc();

        m1.makeTranslation(1, 1, 1).multiply(this.parent.renderer.currentCamera[this.viewId].projectionMatrix);
        m2.makeScale(this.inLinearDepth.width / 2, this.inLinearDepth.height / 2, 0.5).multiply(m1);
        gl.uniformMatrix4fv(p.uniforms["u_projectionMatrix"], false,
            m2.elements);

        Matrix4Pool.free(m1);
        Matrix4Pool.free(m2);

        const quad = this.parent.renderer.quadRenderer;
        quad.render(p.attributes["a_position"]);
    }
    afterRender(): void
    {
    }
    dispose(): void
    {
        this.fb.dispose();
    }
}
