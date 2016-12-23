/// <reference path="../Prefix.d.ts" />

import * as three from "three";

import {
    TextureRenderBufferInfo,
    TextureRenderBufferFormat,
    TextureRenderBuffer
} from "../core/RenderBuffers";

import {
    LinearDepthTextureRenderBufferInfo,
    GBuffer2TextureRenderBufferInfo
} from "../core/TypedRenderBuffers";

import {
    RenderOperator,
    RenderOperation
} from "../core/RenderPipeline";

import {
    RendererCore,
    GLStateFlags
} from "../core/RendererCore";

import {
    GLProgram,
    GLProgramUniforms,
    GLProgramAttributes
} from "../core/GLProgram";

import { GLFramebuffer } from "../core/GLFramebuffer";

import {
    BilateralFilterRenderer,
    BilateralFilterDirection
} from "./BilateralFilter";

import {
    ViewVectors,
    computeViewVectorCoefFromProjectionMatrix
} from "../utils/Geometry";

export interface SSAOInput
{
    g2: GBuffer2TextureRenderBufferInfo;
    linearDepth: LinearDepthTextureRenderBufferInfo;
    linearDepthHalf: LinearDepthTextureRenderBufferInfo;
}
export interface SSAOOutput
{
    output: TextureRenderBufferInfo;
}

export class SSAORenderer
{
    private bilateral: BilateralFilterRenderer;

    constructor(public renderer: RendererCore)
    {
        this.bilateral = new BilateralFilterRenderer(renderer);
    }

    dispose(): void
    {
        this.bilateral.dispose();
    }

    setupFilter(input: SSAOInput, viewId: number, ops: RenderOperation[]): SSAOOutput
    {
        const width = input.linearDepth.width;
        const height = input.linearDepth.height;

        const aoBuf = new TextureRenderBufferInfo("SSAO Raw Result", (width + 1) >> 1, (height + 1) >> 1,
            TextureRenderBufferFormat.R8);

        ops.push({
            inputs: {
                g2: input.g2,
                linearDepth: input.linearDepthHalf
            },
            outputs: {
                output: aoBuf
            },
            bindings: [],
            optionalOutputs: [],
            name: "SSAO",
            factory: (cfg) => new SSAORendererInstance(this, viewId,
                <TextureRenderBuffer> cfg.inputs["g2"],
                <TextureRenderBuffer> cfg.inputs["linearDepth"],
                <TextureRenderBuffer> cfg.outputs["output"])
        });

        const bilit1 = this.bilateral.setupFilter({
            input: aoBuf,
            linearDepth: input.linearDepth
        }, {
            dir: BilateralFilterDirection.Horitonzal,
            outWidth: width,
            outHeight: height,
            kernelScale: 2
        }, ops);

        const bilit2 = this.bilateral.setupFilter({
            input: bilit1.output,
            linearDepth: input.linearDepth
        }, {
            dir: BilateralFilterDirection.Vertical,
            outWidth: width,
            outHeight: height,
            kernelScale: 2
        }, ops);

        const outp: SSAOOutput = {
            output: bilit2.output
        };

        return outp;
    }
}

export class SSAORendererInstance implements RenderOperator
{
    private fb: GLFramebuffer;
    private tmpMat: three.Matrix4;
    private projectionViewMat: three.Matrix4;
    private viewMat: three.Matrix4;
    private viewVec: ViewVectors;

    private program: {
        program: GLProgram;
        uniforms: GLProgramUniforms;
        attributes: GLProgramAttributes;
    };

    constructor(
        private parent: SSAORenderer,
        private viewId: number,
        private inG2: TextureRenderBuffer,
        private inLinearDepth: TextureRenderBuffer,
        private out: TextureRenderBuffer
    )
    {

        this.fb = GLFramebuffer.createFramebuffer(parent.renderer.gl, {
            depth: null,
            colors: [
                out.texture
            ]
        });

        this.tmpMat = new three.Matrix4();
        this.projectionViewMat = new three.Matrix4();
        this.viewMat = null;
        this.viewVec = null;

        {
            const program = parent.renderer.shaderManager.get("VS_SSAO", "FS_SSAO",
                ["a_position"]);
            this.program = {
                program,
                uniforms: program.getUniforms([
                    "u_linearDepth", "u_g2",
                    "u_viewDirCoefX", "u_viewDirCoefY", "u_viewDirOffset",
                    "u_sampleOffsetScale"
                ]),
                attributes: program.getAttributes(["a_position"])
            };
        }
    }
    beforeRender(): void
    {
        this.viewMat = this.parent.renderer.currentCamera[this.viewId].matrixWorldInverse;
        this.projectionViewMat.multiplyMatrices(
            this.parent.renderer.currentCamera[this.viewId].projectionMatrix,
            this.parent.renderer.currentCamera[this.viewId].matrixWorldInverse
        );
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
        this.parent.renderer.invalidateFramebuffer(gl.COLOR_ATTACHMENT0);
        this.parent.renderer.state.flags =
            GLStateFlags.DepthWriteDisabled;

        gl.activeTexture(gl.TEXTURE0);
        gl.bindTexture(gl.TEXTURE_2D, this.inG2.texture);
        gl.activeTexture(gl.TEXTURE1);
        gl.bindTexture(gl.TEXTURE_2D, this.inLinearDepth.texture);

        const kernelSize = Math.min(this.out.width, this.out.height) * 0.002;

        const p = this.program;
        p.program.use();
        gl.uniform1i(p.uniforms["u_g2"], 0);
        gl.uniform1i(p.uniforms["u_linearDepth"], 1);
        gl.uniform2f(p.uniforms["u_viewDirOffset"],
            this.viewVec.offset.x, this.viewVec.offset.y);
        gl.uniform2f(p.uniforms["u_viewDirCoefX"],
            this.viewVec.coefX.x, this.viewVec.coefX.y);
        gl.uniform2f(p.uniforms["u_viewDirCoefY"],
            this.viewVec.coefY.x, this.viewVec.coefY.y);
        gl.uniform2f(p.uniforms["u_sampleOffsetScale"],
            kernelSize / this.out.width, kernelSize / this.out.height);

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
