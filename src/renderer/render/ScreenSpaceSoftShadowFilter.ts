/// <reference path="../Prefix.d.ts" />

import * as three from "three";

import {
    TextureRenderBuffer
} from "../core/RenderBuffers";

import {
    RenderOperator
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
    computeViewVectorCoefFromProjectionMatrix,
    ViewVectors
} from "../utils/Geometry";

import {
    Vector3Pool,
    Vector4Pool
} from "../utils/ObjectPool";

export const enum ScreenSpaceSoftShadowDirection
{
    Horitonzal,
    Vertical
}

const enum ProgramFlags
{
    Zero = 0,
    PositionalLight = 1 << 0
}

// FIXME: use the standard rendering pipeline operation model

export class ScreenSpaceSoftShadowRendererInstance implements RenderOperator
{
    private fb: GLFramebuffer;

    private program: {
        program: GLProgram;
        uniforms: GLProgramUniforms;
        attributes: GLProgramAttributes;
    }[];

    light: three.Light;
    viewVec: ViewVectors;

    constructor(
        private core: RendererCore,
        private viewId: number,
        private input: TextureRenderBuffer,
        private inLinearDepth: TextureRenderBuffer,
        private out: TextureRenderBuffer,
        private dir: ScreenSpaceSoftShadowDirection
    )
    {

        this.fb = GLFramebuffer.createFramebuffer(core.gl, {
            depth: null,
            colors: [
                out.texture
            ]
        });

        this.light = null;

        this.program = [];

        for (let i = 0; i < 2; ++i) {
            const program = core.shaderManager.get("VS_ScreenSpaceSoftShadow", "FS_ScreenSpaceSoftShadow",
                ["a_position"], {
                    isPositionalLight: (i & ProgramFlags.PositionalLight) != 0,
                    direction: dir == ScreenSpaceSoftShadowDirection.Vertical ? 1 : 0,
                    numSamples: 8
                });
            this.program.push({
                program,
                uniforms: program.getUniforms([
                    "u_input", "u_linearDepth",
                    "u_maxBlur",
                    "u_viewDirOffset", "u_viewDirCoefX", "u_viewDirCoefY",
                    "u_covSScale",
                    "u_lightU", "u_lightV", "u_lightDir",
                    "u_jitter", "u_jitterScale"
                ]),
                attributes: program.getAttributes(["a_position"])
            });
        }

        this.viewVec = null;
    }
    beforeRender(): void
    {
        this.viewVec = computeViewVectorCoefFromProjectionMatrix(
            this.core.currentCamera[this.viewId].projectionMatrix, this.viewVec);
    }
    perform(): void
    {
        this.fb.bind();

        const gl = this.core.gl;
        gl.viewport(0, 0, this.out.width, this.out.height);
        this.core.invalidateFramebuffer(gl.COLOR_ATTACHMENT0);
        this.core.state.flags =
            GLStateFlags.DepthWriteDisabled;

        const jitter = this.core.uniformJitter;

        gl.activeTexture(gl.TEXTURE1);
        gl.bindTexture(gl.TEXTURE_2D, this.inLinearDepth.texture);
        gl.activeTexture(gl.TEXTURE0);
        gl.bindTexture(gl.TEXTURE_2D, this.input.texture);
        gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
        gl.activeTexture(gl.TEXTURE2);
        gl.bindTexture(gl.TEXTURE_2D, jitter.texture);

        const light = this.light;

        let flags = ProgramFlags.Zero;

        if (!(light instanceof three.DirectionalLight)) {
            flags |= ProgramFlags.PositionalLight;
        }

        const p = this.program[flags];
        p.program.use();
        gl.uniform1i(p.uniforms["u_input"], 0);
        gl.uniform1i(p.uniforms["u_linearDepth"], 1);
        gl.uniform1i(p.uniforms["u_jitter"], 2);

        gl.uniform2f(p.uniforms["u_viewDirOffset"],
            this.viewVec.offset.x, this.viewVec.offset.y);
        gl.uniform2f(p.uniforms["u_viewDirCoefX"],
            this.viewVec.coefX.x, this.viewVec.coefX.y);
        gl.uniform2f(p.uniforms["u_viewDirCoefY"],
            this.viewVec.coefY.x, this.viewVec.coefY.y);
        const invCoefX = 1 / this.viewVec.coefX.x;
        const invCoefY = 1 / this.viewVec.coefY.y;
        gl.uniform3f(p.uniforms["u_covSScale"],
            invCoefX * invCoefX,
            invCoefY * invCoefY,
            -invCoefX * invCoefY);

        gl.uniform2f(p.uniforms["u_jitterScale"],
            this.out.width / jitter.size,
            this.out.height / jitter.size);

        if (light instanceof three.DirectionalLight) {
            const v2 = Vector4Pool.alloc();
            v2.set(light.position.x, light.position.y, light.position.z, 0);
            v2.applyMatrix4(this.core.currentCamera[this.viewId].matrixWorldInverse);
            v2.normalize();

            const v = Vector3Pool.alloc();
            const up = Vector3Pool.alloc();
            v.set(v2.x, v2.y, v2.z);
            gl.uniform3f(p.uniforms["u_lightDir"],
                v.x, v.y, v.z);
            if (Math.abs(v.z) > 0.5) {
                up.set(1, 0, 0);
            } else {
                up.set(0, 0, 1);
            }
            v.cross(up); v.normalize();
            gl.uniform3f(p.uniforms["u_lightU"],
                v.x, v.y, v.z);
            up.set(v2.x, v2.y, v2.z);
            v.cross(up);
            gl.uniform3f(p.uniforms["u_lightV"],
                v.x, v.y, v.z);
            Vector3Pool.free(v);
            Vector3Pool.free(up);
            Vector4Pool.free(v2);
        }

        gl.uniform1f(p.uniforms["u_maxBlur"], 0.05 * 0.05);

        const quad = this.core.quadRenderer;
        quad.render(p.attributes["a_position"]);

        gl.activeTexture(gl.TEXTURE0);
        gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.NEAREST);
    }
    afterRender(): void
    {
    }
    dispose(): void
    {
        this.fb.dispose();
    }
}