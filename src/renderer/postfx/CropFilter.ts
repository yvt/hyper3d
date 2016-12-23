/// <reference path="../Prefix.d.ts" />

import {
    TextureRenderBufferInfo,
    TextureRenderBuffer
} from "../core/RenderBuffers";

import {
    INearestResampleableRenderBufferInfo
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

export interface CropFilterParameters
{
    x: number;
    y: number;
    width: number;
    height: number;
}
export class CropFilterRenderer
{
    constructor(public renderer: RendererCore)
    {
    }

    dispose(): void
    {
    }

    setup<T extends TextureRenderBufferInfo>
    (input: INearestResampleableRenderBufferInfo<T>, params: CropFilterParameters, ops: RenderOperation[]): T
    {
        const width = params.width;
        const height = params.height;
        const outp: T =
            input.cloneWithDimension(input.name + " Cropped", width, height);

        ops.push({
            inputs: {
                input: input,
            },
            outputs: {
                output: outp
            },
            bindings: [],
            optionalOutputs: [],
            name: `Crop`,
            factory: (cfg) => new CropFilterRendererInstance(this,
                <TextureRenderBuffer> cfg.inputs["input"],
                <TextureRenderBuffer> cfg.outputs["output"],
                params.x / input.width, params.y / input.height,
                (params.x + params.width) / input.width,
                (params.y + params.height) / input.height)
        });
        return outp;
    }

}

export class CropFilterRendererInstance implements RenderOperator
{
    private fb: GLFramebuffer;

    private program: {
        program: GLProgram;
        uniforms: GLProgramUniforms;
        attributes: GLProgramAttributes;
    };

    constructor(
        private parent: CropFilterRenderer,
        private input: TextureRenderBuffer,
        private out: TextureRenderBuffer,
        private srcX1: number,
        private srcY1: number,
        private srcX2: number,
        private srcY2: number
    )
    {

        this.fb = GLFramebuffer.createFramebuffer(parent.renderer.gl, {
            depth: null,
            colors: [
                out.texture
            ]
        });

        {
            const program = parent.renderer.shaderManager.get("VS_Passthrough", "FS_Passthrough",
                ["a_position"]);
            this.program = {
                program,
                uniforms: program.getUniforms([
                    "u_texture",
                    "u_uvScale"
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
        this.parent.renderer.state.flags =
            GLStateFlags.DepthWriteDisabled;

        gl.activeTexture(gl.TEXTURE0);
        gl.bindTexture(gl.TEXTURE_2D, this.input.texture);

        const p = this.program;
        p.program.use();
        gl.uniform1i(p.uniforms["u_texture"], 0);
        gl.uniform4f(p.uniforms["u_uvScale"],
            (this.srcX2 - this.srcX1) * 0.5, (this.srcY2 - this.srcY1) * 0.5,
            (this.srcX1 + this.srcX2) * 0.5, (this.srcY1 + this.srcY2) * 0.5);

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
