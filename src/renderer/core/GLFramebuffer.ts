/// <reference path="../Prefix.d.ts" />
/// <reference path="../gl/WEBGLDrawBuffers.d.ts" />

import { IDisposable } from "../utils/Utils";

export interface GLFramebufferAttachments
{
    depth?: WebGLTexture;
    colors: WebGLTexture[];
}

export class GLFramebuffer implements IDisposable
{
    constructor(private gl: WebGLRenderingContext, public handle: WebGLFramebuffer)
    {
    }

    static createFramebuffer(gl: WebGLRenderingContext, attachments: GLFramebufferAttachments,
        texTarget?: number): GLFramebuffer
    {
        if (texTarget == null) {
            texTarget = gl.TEXTURE_2D;
        }

        const handle = gl.createFramebuffer();
        gl.bindFramebuffer(gl.FRAMEBUFFER, handle);

        if (attachments.depth != null) {
            if (attachments.depth instanceof WebGLTexture) {
                gl.framebufferTexture2D(gl.FRAMEBUFFER, gl.DEPTH_STENCIL_ATTACHMENT,
                    gl.TEXTURE_2D, attachments.depth, 0);
            } else if (attachments.depth instanceof WebGLRenderbuffer) {
                gl.framebufferRenderbuffer(gl.FRAMEBUFFER, gl.DEPTH_ATTACHMENT,
                    gl.RENDERBUFFER, attachments.depth);
            }
        }

        const colors = attachments.colors;
        if (colors.length == 1) {
            gl.framebufferTexture2D(gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT0,
                texTarget, colors[0], 0);
        } else {
            const ext = <WebGLDrawBuffers> gl.getExtension("WEBGL_draw_buffers");
            for (let i = 0; i < colors.length; ++i) {
                gl.framebufferTexture2D(gl.FRAMEBUFFER, ext.COLOR_ATTACHMENT0_WEBGL + i,
                    texTarget, colors[i], 0);
            }

            const buffers: number[] = [];
            for (let i = 0; i < colors.length; ++i) {
                buffers.push(ext.COLOR_ATTACHMENT0_WEBGL + i);
            }
            ext.drawBuffersWEBGL(buffers);
        }

        const status = gl.checkFramebufferStatus(gl.FRAMEBUFFER);

        if (status != gl.FRAMEBUFFER_COMPLETE) {
            gl.deleteFramebuffer(handle);
            throw new Error(`incomplete framebuffer: ${status}`);
        }

        return new GLFramebuffer(gl, handle);
    }

    bind(): void
    {
        this.gl.bindFramebuffer(this.gl.FRAMEBUFFER, this.handle);
    }

    dispose(): void
    {
        this.gl.deleteFramebuffer(this.handle);
    }

}
