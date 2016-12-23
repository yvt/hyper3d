/// <reference path="../Prefix.d.ts" />
/// <reference path="../gl/WEBGLDrawBuffers.d.ts" />

import * as three from "three";

import {
    DepthTextureRenderBufferInfo,
    GBuffer0TextureRenderBufferInfo,
    GBuffer1TextureRenderBufferInfo,
    GBuffer2TextureRenderBufferInfo,
    GBuffer3TextureRenderBufferInfo,
    LinearDepthTextureRenderBufferInfo,
    GBufferMosaicTextureRenderBufferInfo
} from "../core/TypedRenderBuffers";

import { Shader } from "./MaterialManager";

import {
    TextureRenderBuffer,
    TextureRenderBufferFormat
} from "../core/RenderBuffers";

import {
    BaseGeometryPassRenderer,
    BaseGeometryPassShader,
    BaseGeometryPassShaderFlags,
    BaseGeometryPassMaterialManager,
    ObjectWithGeometry
} from "./BaseGeometryPassRenderer";

import {
    RenderOperator,
    RenderOperation
} from "../core/RenderPipeline";

import {
    RendererCore,
    GLStateFlags
} from "../core/RendererCore";

import { Material } from "../public/Materials";

import { GLFramebuffer } from "../core/GLFramebuffer";

import {
    GLProgram,
    GLProgramUniforms,
    GLProgramAttributes
} from "../core/GLProgram";

import { CropFilterRenderer } from "../postfx/CropFilter";

import { Matrix4Pool } from "../utils/ObjectPool";

export interface GeometryPassOutput
{
    g0: GBuffer0TextureRenderBufferInfo;
    g1: GBuffer1TextureRenderBufferInfo;
    g2: GBuffer2TextureRenderBufferInfo;
    g3: GBuffer3TextureRenderBufferInfo;
    linearDepth: LinearDepthTextureRenderBufferInfo;
    depth: DepthTextureRenderBufferInfo;
}
export class GeometryRenderer
{
    gpMaterials: GeometryPassMaterialManager;
    gpMaterialsStereo: GeometryPassMaterialManager;

    private cropFilter: CropFilterRenderer;

    constructor(public renderer: RendererCore)
    {
        this.gpMaterials = new GeometryPassMaterialManager(renderer, false);
        if (this.renderer.supportsMRT) {
            this.gpMaterialsStereo = new GeometryPassMaterialManager(renderer, true);
        }
        this.cropFilter = new CropFilterRenderer(renderer);
    }

    dispose(): void
    {
        this.gpMaterials.dispose();
        this.gpMaterialsStereo.dispose();
    }

    setupShadowPass(ops: RenderOperation[])
    {

    }

    setupMultiViewGeometryPass(width: number, height: number, numViews: number, ops: RenderOperation[]): GeometryPassOutput[]
    {
        const drawBuffers = <WebGLDrawBuffers> this.renderer.ext.get("WEBGL_draw_buffers");
        const maxNumBuffers = drawBuffers ? this.renderer.gl.getParameter(drawBuffers.MAX_DRAW_BUFFERS_WEBGL) : 1;
        const ret: GeometryPassOutput[] = [];

        if (!this.renderer.useFullResolutionGBuffer ||
            maxNumBuffers < 5 ||
            numViews !== 2 ||
            this.renderer.params.useInstancedStereoRendering === false) {
            // Unsupported configuration; fall back to the naïve approach
            for (let i = 0; i < numViews; ++i) {
                ret.push(this.setupGeometryPass(width, height, i, ops));
            }
            return ret;
        }

        const rawDepth = new DepthTextureRenderBufferInfo("Raw Depth", width * 2, height,
            TextureRenderBufferFormat.Depth);
        const outpMerged: GeometryPassOutput = {
            g0: new GBuffer0TextureRenderBufferInfo("G0.LR", width * 2, height,
                this.renderer.supportsSRGB ?
                    TextureRenderBufferFormat.SRGBA8 :
                    TextureRenderBufferFormat.RGBA8),
            g1: new GBuffer1TextureRenderBufferInfo("G1.LR", width * 2, height,
                TextureRenderBufferFormat.RGBA8),
            g2: new GBuffer2TextureRenderBufferInfo("G2.LR", width * 2, height,
                TextureRenderBufferFormat.RGBA8),
            g3: new GBuffer3TextureRenderBufferInfo("G3.LR", width * 2, height,
                this.renderer.supportsSRGB ?
                    TextureRenderBufferFormat.SRGBA8 :
                    TextureRenderBufferFormat.RGBA8),
            linearDepth: new LinearDepthTextureRenderBufferInfo("Depth.LR", width * 2, height,
                TextureRenderBufferFormat.RGBA8),
            depth: rawDepth
        };
        ops.push({
            inputs: {},
            outputs: {
                g0: outpMerged.g0,
                g1: outpMerged.g1,
                g2: outpMerged.g2,
                g3: outpMerged.g3,
                depth: rawDepth,
                linearDepth: outpMerged.linearDepth
            },
            bindings: [],
            optionalOutputs: [],
            name: "Geometry Pass",
            factory: (cfg) => new GeometryPassRenderer(this, 0, true,
                null,
                [
                    <TextureRenderBuffer> cfg.outputs["g0"],
                    <TextureRenderBuffer> cfg.outputs["g1"],
                    <TextureRenderBuffer> cfg.outputs["g2"],
                    <TextureRenderBuffer> cfg.outputs["g3"],
                    <TextureRenderBuffer> cfg.outputs["linearDepth"]
                ],
                <TextureRenderBuffer> cfg.outputs["depth"])
        });

        const {cropFilter} = this;
        for (let i = 0; i < 2; ++i) {
            const x = i * width, y = 0;
            ret.push({
                g0: cropFilter.setup(outpMerged.g0, { x, y, width, height }, ops),
                g1: cropFilter.setup(outpMerged.g1, { x, y, width, height }, ops),
                g2: cropFilter.setup(outpMerged.g2, { x, y, width, height }, ops),
                g3: cropFilter.setup(outpMerged.g3, { x, y, width, height }, ops),
                depth: outpMerged.depth,
                linearDepth: cropFilter.setup(outpMerged.linearDepth, { x, y, width, height }, ops),
            });
        }

        return ret;
    }

    setupGeometryPass(width: number, height: number, viewId: number, ops: RenderOperation[]): GeometryPassOutput
    {
        const fullRes = this.renderer.useFullResolutionGBuffer && !this.renderer.supportsMRT;
        const mosaicked = new GBufferMosaicTextureRenderBufferInfo("Mosaicked G-Buffer",
            fullRes ? width * 2 : width, fullRes ? height * 2 : height,
            TextureRenderBufferFormat.RGBA8);
        const rawDepth = new DepthTextureRenderBufferInfo("Raw Depth",
            fullRes ? width * 2 : width, fullRes ? height * 2 : height,
            TextureRenderBufferFormat.Depth);
        const outp: GeometryPassOutput = {
            g0: new GBuffer0TextureRenderBufferInfo("G0", width, height,
                this.renderer.supportsSRGB ?
                    TextureRenderBufferFormat.SRGBA8 :
                    TextureRenderBufferFormat.RGBA8),
            g1: new GBuffer1TextureRenderBufferInfo("G1", width, height,
                TextureRenderBufferFormat.RGBA8),
            g2: new GBuffer2TextureRenderBufferInfo("G2", width, height,
                TextureRenderBufferFormat.RGBA8),
            g3: new GBuffer3TextureRenderBufferInfo("G3", width, height,
                this.renderer.supportsSRGB ?
                    TextureRenderBufferFormat.SRGBA8 :
                    TextureRenderBufferFormat.RGBA8),
            linearDepth: new LinearDepthTextureRenderBufferInfo("Depth", width, height,
                TextureRenderBufferFormat.RGBA8),
            depth: rawDepth
        };

        const drawBuffers = <WebGLDrawBuffers> this.renderer.ext.get("WEBGL_draw_buffers");
        const maxNumBuffers = drawBuffers ? this.renderer.gl.getParameter(drawBuffers.MAX_DRAW_BUFFERS_WEBGL) : 1;

        if (this.renderer.supportsMRT) {
            ops.push({
                inputs: {},
                outputs: {
                    g0: outp.g0,
                    g1: outp.g1,
                    g2: outp.g2,
                    g3: outp.g3,
                    depth: rawDepth,
                    linearDepth: maxNumBuffers >= 5 ? outp.linearDepth : null
                },
                bindings: [],
                optionalOutputs: [],
                name: "Geometry Pass",
                factory: (cfg) => new GeometryPassRenderer(this, viewId, false,
                    null,
                    [
                        <TextureRenderBuffer> cfg.outputs["g0"],
                        <TextureRenderBuffer> cfg.outputs["g1"],
                        <TextureRenderBuffer> cfg.outputs["g2"],
                        <TextureRenderBuffer> cfg.outputs["g3"],
                        maxNumBuffers >= 5 ? <TextureRenderBuffer> cfg.outputs["linearDepth"] : null
                    ],
                    <TextureRenderBuffer> cfg.outputs["depth"])
            });
        } else {
            ops.push({
                inputs: {},
                outputs: {
                    mosaic: mosaicked,
                    depth: rawDepth
                },
                bindings: [],
                optionalOutputs: [],
                name: "Geometry Pass",
                factory: (cfg) => new GeometryPassRenderer(this, viewId, false,
                    <TextureRenderBuffer> cfg.outputs["mosaic"],
                    null,
                    <TextureRenderBuffer> cfg.outputs["depth"])
            });
        }

        if (!this.renderer.supportsMRT || maxNumBuffers < 5) {
            ops.push({
                inputs: {
                    mosaic: this.renderer.supportsMRT ? null : mosaicked,
                    depth: rawDepth
                },
                outputs: {
                    g0: this.renderer.supportsMRT ? null : outp.g0,
                    g1: this.renderer.supportsMRT ? null : outp.g1,
                    g2: this.renderer.supportsMRT ? null : outp.g2,
                    g3: this.renderer.supportsMRT ? null : outp.g3,
                    depth: outp.linearDepth
                },
                bindings: [],
                optionalOutputs: [
                    "g0", "g1", "g2", "g3", "depth"
                ],
                name: "Demosaick G-Buffer",
                factory: (cfg) => new DemosaicGBufferRenderer(this, viewId,
                    this.renderer.supportsMRT ? null : <TextureRenderBuffer> cfg.inputs["mosaic"],
                    <TextureRenderBuffer> cfg.inputs["depth"],
                    [
                        this.renderer.supportsMRT ? null : <TextureRenderBuffer> cfg.outputs["g0"],
                        this.renderer.supportsMRT ? null : <TextureRenderBuffer> cfg.outputs["g1"],
                        this.renderer.supportsMRT ? null : <TextureRenderBuffer> cfg.outputs["g2"],
                        this.renderer.supportsMRT ? null : <TextureRenderBuffer> cfg.outputs["g3"],
                        <TextureRenderBuffer> cfg.outputs["depth"]
                    ])
            });
        }

        return outp;
    }

}

class GeometryPassShader extends BaseGeometryPassShader
{
    geoUniforms: GLProgramUniforms;

    constructor(public manager: BaseGeometryPassMaterialManager, public source: Material, flags: number)
    {
        super(manager, source, flags);

        this.geoUniforms = this.glProgram.getUniforms([
            "u_screenVelOffset",
            "u_projectionMatrix2",
            "u_viewProjectionMatrix2",
            "u_viewModelMatrix2",
            "u_viewMatrix2",
            "u_lastViewProjectionMatrix2"
        ]);
    }
}

class GeometryPassMaterialManager extends BaseGeometryPassMaterialManager
{
    constructor(core: RendererCore, stereo: boolean)
    {
        super(core, stereo ? "VS_GeometryStereo" : "VS_Geometry", stereo ? "FS_GeometryMRTStereo" : core.supportsMRT ? "FS_GeometryMRT" : "FS_GeometryNoMRT");
    }

    createShader(material: Material, flags: number): Shader // override
    {
        return new GeometryPassShader(this, material, flags | BaseGeometryPassShaderFlags.NeedsLastPosition);
    }
}


class GeometryPassRenderer extends BaseGeometryPassRenderer implements RenderOperator
{
    private fb: GLFramebuffer;

    private pointSizeMatrix: Float32Array;

    secondViewState = {
        projectionMat: new three.Matrix4(),
        projectionViewMat: new three.Matrix4(),
        viewMat: new three.Matrix4(),
        frustum: new three.Frustum(),
        lastViewProjMat: new three.Matrix4()
    };

    constructor(
        private parent: GeometryRenderer,
        private viewId: number,
        private stereo: boolean,
        private outMosaic: TextureRenderBuffer,
        private outBuffers: TextureRenderBuffer[],
        private outDepth: TextureRenderBuffer
    )
    {
        super(parent.renderer, stereo ? parent.gpMaterialsStereo : parent.gpMaterials, true, stereo ? 2 : 1);

        if (outBuffers) {
            if (outBuffers[4] == null) {
                outBuffers.pop();
            }
            this.fb = GLFramebuffer.createFramebuffer(parent.renderer.gl, {
                depth: outDepth.texture,
                colors: outBuffers.map((buffer) => buffer.texture)
            });
        } else {
            this.fb = GLFramebuffer.createFramebuffer(parent.renderer.gl, {
                depth: outDepth.texture,
                colors: [
                    outMosaic.texture
                ]
            });
        }

        this.pointSizeMatrix = new Float32Array(9);
    }

    setupAdditionalUniforms(mesh: ObjectWithGeometry, shader: BaseGeometryPassShader): void // override
    {
        const shd = <GeometryPassShader> shader;
        const gl = this.parent.renderer.gl;
        const ctrler = this.parent.renderer.ctrler;
        gl.uniform2f(shd.geoUniforms["u_screenVelOffset"], ctrler.screenVelOffX, ctrler.screenVelOffY);

        if (this.stereo) {
            const state = this.secondViewState;
            gl.uniformMatrix4fv(shd.geoUniforms["u_projectionMatrix2"], false,

                state.projectionMat.elements);
            gl.uniformMatrix4fv(shd.geoUniforms["u_viewProjectionMatrix2"], false,
                state.projectionViewMat.elements);
            gl.uniformMatrix4fv(shd.geoUniforms["u_lastViewProjectionMatrix2"], false,
                state.lastViewProjMat.elements);

            const m = Matrix4Pool.alloc();
            m.multiplyMatrices(state.viewMat, mesh.matrixWorld);
            gl.uniformMatrix4fv(shd.geoUniforms["u_viewModelMatrix2"], false,
                m.elements);
            Matrix4Pool.free(m);

            gl.uniformMatrix4fv(shd.geoUniforms["u_viewMatrix2"], false,
                state.viewMat.elements);
        }
    }

    beforeRender(): void
    {
    }
    perform(): void
    {
        this.fb.bind();

        const gl = this.parent.renderer.gl;
        gl.viewport(0, 0, this.outDepth.width, this.outDepth.height);
        gl.clearColor(0.5, 0.5, 0.5, 0.5); // this should be safe value
        if (this.outBuffers && this.outBuffers.length >= 5) {
            this.parent.renderer.state.flags = GLStateFlags.DepthTestEnabled |
                GLStateFlags.ColorAttachment1Enabled | GLStateFlags.ColorAttachment2Enabled |
                GLStateFlags.ColorAttachment3Enabled | GLStateFlags.ColorAttachment4Enabled;
        } else if (this.outBuffers) {
            this.parent.renderer.state.flags = GLStateFlags.DepthTestEnabled |
                GLStateFlags.ColorAttachment1Enabled | GLStateFlags.ColorAttachment2Enabled |
                GLStateFlags.ColorAttachment3Enabled;
        } else {
            this.parent.renderer.state.flags = GLStateFlags.DepthTestEnabled;
        }
        gl.clear(gl.COLOR_BUFFER_BIT | gl.DEPTH_BUFFER_BIT);

        // Precompute parameters for the second view
        if (this.stereo) {
            const state = this.secondViewState;
            const secondCamera = this.parent.renderer.currentCamera[1];
            const projectionMatrix = this.parent.renderer.ctrler.jitteredProjectiveMatrix[1];
            state.viewMat.copy(secondCamera.matrixWorldInverse);
            state.projectionMat.copy(projectionMatrix);
            state.projectionViewMat.multiplyMatrices(
                projectionMatrix,
                secondCamera.matrixWorldInverse
            );
            state.frustum.setFromMatrix(state.projectionViewMat);
        }

        this.renderGeometry(this.parent.renderer.currentCamera[this.viewId].matrixWorldInverse,
            this.parent.renderer.ctrler.jitteredProjectiveMatrix[this.viewId]);

        if (this.stereo) {
            const state = this.secondViewState;
            state.lastViewProjMat.copy(state.projectionViewMat);
        }
    }
    afterRender(): void
    {

    }

    dispose(): void
    {
        this.fb.dispose();

        BaseGeometryPassRenderer.prototype.dispose.call(this);
    }
}

class DemosaicGBufferRenderer implements RenderOperator
{
    private programs: GLProgram[];
    private uniforms: GLProgramUniforms[];
    private attributes: GLProgramAttributes[];
    private fbs: GLFramebuffer[];
    private outWidth: number;
    private outHeight: number;

    constructor(
        private parent: GeometryRenderer,
        private viewId: number,
        private inMosaic: TextureRenderBuffer,
        private inDepth: TextureRenderBuffer,
        private outG: TextureRenderBuffer[]
    )
    {
        this.programs = [];
        this.fbs = [];
        this.uniforms = [];
        this.attributes = [];

        this.outWidth = 1;
        this.outHeight = 1;

        for (let i = 0; i < outG.length; ++i) {
            const g = outG[i];
            if (g) {
                this.programs.push(this.parent.renderer.shaderManager.get("VS_GBufferDemosaic", "FS_GBufferDemosaic",
                    ["a_position"], {
                    gBufferIndex: i
                }));
                this.fbs.push(GLFramebuffer.createFramebuffer(parent.renderer.gl, {
                    depth: null,
                    colors: [g.texture]
                }));
                this.outWidth = g.width;
                this.outHeight = g.height;
            }
        }
        for (const p of this.programs) {
            this.uniforms.push(p.getUniforms(["u_uvScale", "u_mosaic", "u_depth", "u_depthLinearizeCoef"]));
            this.attributes.push(p.getAttributes(["a_position"]));
        }
    }
    beforeRender(): void
    {
    }
    perform(): void
    {
        const programs = this.programs;
        const uniforms = this.uniforms;
        const attributes = this.attributes;
        const fbs = this.fbs;
        const quadRenderer = this.parent.renderer.quadRenderer;
        const gl = this.parent.renderer.gl;

        this.parent.renderer.state.flags = GLStateFlags.Default;

        gl.activeTexture(gl.TEXTURE0);
        gl.bindTexture(gl.TEXTURE_2D, this.inMosaic.texture);

        gl.activeTexture(gl.TEXTURE1);
        gl.bindTexture(gl.TEXTURE_2D, this.inDepth.texture);

        gl.viewport(0, 0, this.outWidth, this.outHeight);

        const proj = this.parent.renderer.currentCamera[this.viewId].projectionMatrix;

        for (let i = 0; i < fbs.length; ++i) {
            const unif = uniforms[i];

            fbs[i].bind();
            programs[i].use();

            this.parent.renderer.invalidateFramebuffer(gl.COLOR_ATTACHMENT0, gl.DEPTH_ATTACHMENT);

            gl.uniform1i(unif["u_mosaic"], 0);
            gl.uniform1i(unif["u_depth"], 1);
            gl.uniform4f(unif["u_uvScale"], 0.5, 0.5, 0.5, 0.5);
            gl.uniform4f(unif["u_depthLinearizeCoef"],
                proj.elements[15], -proj.elements[14],
                proj.elements[11], -proj.elements[10]);

            quadRenderer.render(attributes[i]["a_position"]);
        }
    }
    afterRender(): void
    {
    }
    dispose(): void
    {
        for (const fb of this.fbs) {
            fb.dispose();
        }
        // shaders are owned by ShaderManager.
    }
}
