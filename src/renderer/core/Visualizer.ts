/// <reference path="../Prefix.d.ts" />

import {
    TextureRenderBuffer,
    TextureRenderBufferInfo,
    DummyRenderBufferInfo
} from "./RenderBuffers";

import {
    RendererCore,
    GLStateFlags
} from "./RendererCore";

import {
    RenderOperation,
    RenderOperator
} from "./RenderPipeline";

import {
    GLProgram,
    GLProgramUniforms,
    GLProgramAttributes
} from "./GLProgram";

// these values are used in shader
export const enum GBufferAttributeType
{
    Albedo = 0,
    Normal = 1,
    Velocity = 2,
    Roughness = 3,
    Metallic = 4,
    Specular = 5,
    Preshaded = 6,
    MaterialId = 7
}

export interface VisualizeGBufferInput
{
    g0: TextureRenderBufferInfo;
    g1: TextureRenderBufferInfo;
    g2: TextureRenderBufferInfo;
    g3: TextureRenderBufferInfo;
}

export class BufferVisualizer
{
    constructor(private core: RendererCore)
    {
    }

    dispose(): void
    {
    }

    setupColorVisualizer(input: TextureRenderBufferInfo, ops: RenderOperation[]): DummyRenderBufferInfo
    {
        const outp = new DummyRenderBufferInfo("Visualized Output");

        ops.push({
            inputs: {
                input: input
            },
            outputs: {
                output: outp
            },
            optionalOutputs: ["output"],
            name: "Visualize Color Buffer",
            factory: (cfg) => new BufferVisualizerInstance(
                this.core,
                <TextureRenderBuffer> cfg.inputs["input"],
                "FS_VisualizeColor")
        });

        return outp;
    }

    setupSeparateStereoColorVisualizer(inputLeft: TextureRenderBufferInfo, inputRight: TextureRenderBufferInfo, ops: RenderOperation[]): DummyRenderBufferInfo
    {
        const outp = new DummyRenderBufferInfo("Visualized Output");

        ops.push({
            inputs: {
                inputLeft: inputLeft,
                inputRight: inputRight,
            },
            outputs: {
                output: outp
            },
            optionalOutputs: ["output"],
            name: "Visualize Color Buffer",
            factory: (cfg) => new SeparateStereoBufferVisualizerInstance(
                this.core,
                <TextureRenderBuffer> cfg.inputs["inputLeft"],
                <TextureRenderBuffer> cfg.inputs["inputRight"],
                "FS_VisualizeColor")
        });

        return outp;
    }

    setupLinearDepthVisualizer(input: TextureRenderBufferInfo, ops: RenderOperation[]): DummyRenderBufferInfo
    {
        const outp = new DummyRenderBufferInfo("Visualized Output");

        ops.push({
            inputs: {
                input: input
            },
            outputs: {
                output: outp
            },
            optionalOutputs: ["output"],
            name: "Visualize Linear Depth Buffer",
            factory: (cfg) => new BufferVisualizerInstance(
                this.core,
                <TextureRenderBuffer> cfg.inputs["input"],
                "FS_VisualizeLinearDepth")
        });

        return outp;
    }

    setupGBufferVisualizer(input: VisualizeGBufferInput, type: GBufferAttributeType, ops: RenderOperation[]): DummyRenderBufferInfo
    {
        const outp = new DummyRenderBufferInfo("Visualized Output");

        let name = `${type}`;
        switch (type) {
            case GBufferAttributeType.Albedo: name = "Albedo"; break;
            case GBufferAttributeType.Normal: name = "Normal"; break;
            case GBufferAttributeType.Velocity: name = "Velocity"; break;
            case GBufferAttributeType.Roughness: name = "Roughness"; break;
            case GBufferAttributeType.Metallic: name = "Metallic"; break;
            case GBufferAttributeType.Specular: name = "Specular"; break;
            case GBufferAttributeType.Preshaded: name = "Preshaded"; break;
            case GBufferAttributeType.MaterialId: name = "MaterialId"; break;
        }

        ops.push({
            inputs: {
                g0: input.g0,
                g1: input.g1,
                g2: input.g2,
                g3: input.g3,
            },
            outputs: {
                output: outp
            },
            optionalOutputs: ["output"],
            name: `Visualize ${type}`,
            factory: (cfg) => new GBufferVisualizerInstance(
                this.core,
                <TextureRenderBuffer> cfg.inputs["g0"],
                <TextureRenderBuffer> cfg.inputs["g1"],
                <TextureRenderBuffer> cfg.inputs["g2"],
                <TextureRenderBuffer> cfg.inputs["g3"],
                type)
        });

        return outp;
    }
}

class BufferVisualizerInstance implements RenderOperator
{
    private program: GLProgram;
    private uniforms: GLProgramUniforms;
    private attributes: GLProgramAttributes;

    constructor(private core: RendererCore,
        private input: TextureRenderBuffer,
        private shader: string)
    {
        this.program = core.shaderManager.get("VS_Passthrough", shader, [
            "a_position"
        ]);
        this.attributes = this.program.getAttributes(["a_position"]);
        this.uniforms = this.program.getUniforms(["u_texture", "u_uvScale"]);
    }
    dispose(): void
    {

    }
    beforeRender(): void
    { }
    perform(): void
    {
        const gl = this.core.gl;

        // bind default framebuffer
        gl.bindFramebuffer(gl.FRAMEBUFFER, null);

        gl.activeTexture(gl.TEXTURE0);
        gl.bindTexture(gl.TEXTURE_2D, this.input.texture);

        this.program.use();
        gl.uniform1i(this.uniforms["u_texture"], 0);
        gl.uniform4f(this.uniforms["u_uvScale"], 0.5, 0.5, 0.5, 0.5);

        gl.viewport(0, 0, gl.drawingBufferWidth, gl.drawingBufferHeight);
        gl.clearColor(0, 0, 0, 1);
        gl.clear(gl.COLOR_BUFFER_BIT);
        this.core.state.flags = GLStateFlags.Default;

        const quad = this.core.quadRenderer;
        quad.render(this.attributes["a_position"]);
    }
    afterRender(): void
    { }
}

class SeparateStereoBufferVisualizerInstance implements RenderOperator
{
    private program: GLProgram;
    private uniforms: GLProgramUniforms;
    private attributes: GLProgramAttributes;

    constructor(private core: RendererCore,
        private inputLeft: TextureRenderBuffer,
        private inputRight: TextureRenderBuffer,
        private shader: string)
    {
        this.program = core.shaderManager.get("VS_Passthrough", shader, [
            "a_position"
        ]);
        this.attributes = this.program.getAttributes(["a_position"]);
        this.uniforms = this.program.getUniforms(["u_texture", "u_uvScale"]);
    }
    dispose(): void
    {

    }
    beforeRender(): void
    { }
    perform(): void
    {
        const gl = this.core.gl;

        // bind default framebuffer
        gl.bindFramebuffer(gl.FRAMEBUFFER, null);

        gl.activeTexture(gl.TEXTURE0);

        this.program.use();
        gl.uniform1i(this.uniforms["u_texture"], 0);
        gl.uniform4f(this.uniforms["u_uvScale"], 0.5, 0.5, 0.5, 0.5);

        gl.viewport(0, 0, gl.drawingBufferWidth, gl.drawingBufferHeight);
        gl.clearColor(0, 0, 0, 1);
        gl.clear(gl.COLOR_BUFFER_BIT);
        this.core.state.flags = GLStateFlags.Default;

        const quad = this.core.quadRenderer;
        gl.viewport(0, 0, gl.drawingBufferWidth / 2 | 0, gl.drawingBufferHeight);
        gl.bindTexture(gl.TEXTURE_2D, this.inputLeft.texture);
        quad.render(this.attributes["a_position"]);

        gl.viewport(gl.drawingBufferWidth / 2 | 0, 0, gl.drawingBufferWidth / 2 | 0, gl.drawingBufferHeight);
        gl.bindTexture(gl.TEXTURE_2D, this.inputRight.texture);
        quad.render(this.attributes["a_position"]);
    }
    afterRender(): void
    { }
}

class GBufferVisualizerInstance implements RenderOperator
{
    private program: GLProgram;
    private uniforms: GLProgramUniforms;
    private attributes: GLProgramAttributes;

    constructor(private core: RendererCore,
        private inG0: TextureRenderBuffer,
        private inG1: TextureRenderBuffer,
        private inG2: TextureRenderBuffer,
        private inG3: TextureRenderBuffer,
        private type: GBufferAttributeType)
    {
        this.program = core.shaderManager.get("VS_Passthrough", "FS_VisualizeGBuffer", [
            "a_position"
        ], {
            "visualizedAttribute": type
        });
        this.attributes = this.program.getAttributes(["a_position"]);
        this.uniforms = this.program.getUniforms([
            "u_g0", "u_g1", "u_g2", "u_g3",
            "u_uvScale"
        ]);
    }
    dispose(): void
    {

    }
    beforeRender(): void
    { }
    perform(): void
    {
        const gl = this.core.gl;

        // bind default framebuffer
        gl.bindFramebuffer(gl.FRAMEBUFFER, null);

        gl.activeTexture(gl.TEXTURE0);
        gl.bindTexture(gl.TEXTURE_2D, this.inG0.texture);
        gl.activeTexture(gl.TEXTURE1);
        gl.bindTexture(gl.TEXTURE_2D, this.inG1.texture);
        gl.activeTexture(gl.TEXTURE2);
        gl.bindTexture(gl.TEXTURE_2D, this.inG2.texture);
        gl.activeTexture(gl.TEXTURE3);
        gl.bindTexture(gl.TEXTURE_2D, this.inG3.texture);

        this.program.use();
        gl.uniform1i(this.uniforms["u_g0"], 0);
        gl.uniform1i(this.uniforms["u_g1"], 1);
        gl.uniform1i(this.uniforms["u_g2"], 2);
        gl.uniform1i(this.uniforms["u_g3"], 3);
        gl.uniform4f(this.uniforms["u_uvScale"], 0.5, 0.5, 0.5, 0.5);

        gl.viewport(0, 0, gl.drawingBufferWidth, gl.drawingBufferHeight);
        gl.clearColor(0, 0, 0, 1);
        gl.clear(gl.COLOR_BUFFER_BIT);
        this.core.state.flags = GLStateFlags.Default;

        const quad = this.core.quadRenderer;
        quad.render(this.attributes["a_position"]);
    }
    afterRender(): void
    { }
}
