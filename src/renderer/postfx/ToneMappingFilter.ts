/// <reference path="../Prefix.d.ts" />

import * as three from "three";

import {
    TextureRenderBufferFormat,
    TextureRenderBuffer
} from "../core/RenderBuffers";

import {
    LogRGBTextureRenderBufferInfo,
    LinearRGBTextureRenderBufferInfo
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
    ViewVectors,
    computeViewVectorCoefFromProjectionMatrix
} from "../utils/Geometry";

export interface ToneMappingFilterParameters
{

    vignette: number;

    autoExposureEnabled: boolean;
    // TODO: more auto exposure parameters

    exposureBias: number;

    // TODO: more color adjustments (like Photoshop)
    //       or maybe use 3D LUT?
    // TODO: maybe dual toning?
    color: three.Vector3;
    highlightCrush: number;
    contrast: number;

}
export class ToneMappingFilterRenderer
{
    params: ToneMappingFilterParameters; // value can be modified

    constructor(public renderer: RendererCore)
    {
        this.params = {
            vignette: 1,
            autoExposureEnabled: true,
            exposureBias: 0,
            color: new three.Vector3(1, 1, 1),
            highlightCrush: 0.2,
            contrast: 0.5
        };
    }

    dispose(): void
    {
    }

    /** input must be LogRGB. */
    setupFilter(input: LogRGBTextureRenderBufferInfo | LinearRGBTextureRenderBufferInfo, viewId: number, ops: RenderOperation[]): LinearRGBTextureRenderBufferInfo
    {
        let width = input.width;
        let height = input.height;

        // FIXME: we don't need SRGB if we use gammaed output
        const outp = new LinearRGBTextureRenderBufferInfo("Tone Mapped", width, height,
            this.renderer.supportsSRGB ? TextureRenderBufferFormat.SRGBA8 : TextureRenderBufferFormat.RGBA8);

        ops.push({
            inputs: {
                input: input,
            },
            outputs: {
                output: outp
            },
            bindings: [],
            optionalOutputs: [],
            name: `Tone Mapping`,
            factory: (cfg) => new ToneMappingFilterRendererInstance(this, viewId,
                <TextureRenderBuffer> cfg.inputs["input"],
                <TextureRenderBuffer> cfg.outputs["output"],
                input instanceof LogRGBTextureRenderBufferInfo)
        });
        return outp;
    }
}

class ToneMappingFilterRendererInstance implements RenderOperator
{
    private fb: GLFramebuffer;

    private program: {
        program: GLProgram;
        uniforms: GLProgramUniforms;
        attributes: GLProgramAttributes;
    };

    private viewVecs: ViewVectors;

    constructor(
        private parent: ToneMappingFilterRenderer,
        private viewId: number,
        private input: TextureRenderBuffer,
        private out: TextureRenderBuffer,
        inputIsLogRGB: boolean
    )
    {

        this.fb = GLFramebuffer.createFramebuffer(parent.renderer.gl, {
            depth: null,
            colors: [
                out.texture
            ]
        });

        this.viewVecs = null;

        {
            const program = parent.renderer.shaderManager.get("VS_ToneMapping", "FS_ToneMapping",
                ["a_position"], {
                    inputIsLogRGB
                });
            this.program = {
                program,
                uniforms: program.getUniforms([
                    "u_input",

                    "u_vignetteAmount",
                    "u_vignetteScale",

                    "u_gain",

                    "u_color",

                    "u_highlightCrush",
                    "u_contrast"
                ]),
                attributes: program.getAttributes(["a_position"])
            };
        }
    }
    beforeRender(): void
    {
    }
    perform(): void
    {
        this.fb.bind();

        const gl = this.parent.renderer.gl;
        gl.viewport(0, 0, this.out.width, this.out.height);
        this.parent.renderer.invalidateFramebuffer(gl.COLOR_ATTACHMENT0);
        this.parent.renderer.state.flags = GLStateFlags.DepthWriteDisabled;

        gl.activeTexture(gl.TEXTURE0);
        gl.bindTexture(gl.TEXTURE_2D, this.input.texture);

        const p = this.program;
        p.program.use();
        gl.uniform1i(p.uniforms["u_input"], 0);

        const params = this.parent.params;

        this.viewVecs =
            computeViewVectorCoefFromProjectionMatrix(this.parent.renderer.currentCamera[this.viewId].projectionMatrix,
            this.viewVecs);
        gl.uniform1f(p.uniforms["u_vignetteAmount"], params.vignette);
        gl.uniform2f(p.uniforms["u_vignetteScale"], this.viewVecs.coefX.length(), this.viewVecs.coefY.length());

        gl.uniform1f(p.uniforms["u_gain"], Math.pow(2, params.exposureBias));

        gl.uniform3f(p.uniforms["u_color"], params.color.x, params.color.y, params.color.z);

        // TODO: auto exposure

        gl.uniform1f(p.uniforms["u_highlightCrush"], params.highlightCrush);
        gl.uniform1f(p.uniforms["u_contrast"], params.contrast);

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
