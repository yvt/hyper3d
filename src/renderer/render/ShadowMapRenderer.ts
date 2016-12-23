/// <reference path="../Prefix.d.ts" />

import * as three from "three";

import { Shader } from "./MaterialManager";

import {
    RenderBufferInfo,
    RenderPipeline,
    RenderBuffer
} from "../core/RenderPipeline";

import {
    BaseGeometryPassRenderer,
    BaseGeometryPassShader,
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

import { GLProgramUniforms } from "../core/GLProgram";

export interface ShadowPassOutput
{
    shadowMaps: ShadowMapRenderBufferInfo;
}

export class ShadowMapRenderer
{
    gpMaterials: ShadowGeometryPassMaterialManager;
    gpCubeMaterials: ShadowGeometryPassMaterialManager;

    depthShadowMapTexture: WebGLTexture;
    colorShadowMapTexture: WebGLTexture; // to make framebuffer complete

    normalShadowMapFramebuffer: GLFramebuffer;

    cubeShadowMapTexture: WebGLTexture;
    cubeShadowMapDepthRB: WebGLRenderbuffer;
    cubeShadowMapFramebuffer: GLFramebuffer[];

    normalShadowMapSize: number;
    cubeShadowMapSize: number;

    constructor(public renderer: RendererCore)
    {
        this.gpMaterials = new ShadowGeometryPassMaterialManager(renderer);
        this.gpCubeMaterials = new ShadowCubeGeometryPassMaterialManager(renderer);

        const gl = renderer.gl;

        this.normalShadowMapSize = 2048;
        this.cubeShadowMapSize = 512;

        const ext = renderer.ext.get("WEBGL_depth_texture");
        if (!ext) {
            throw new Error("Depth texture not supported");
        }

        this.depthShadowMapTexture = gl.createTexture();
        gl.bindTexture(gl.TEXTURE_2D, this.depthShadowMapTexture);
        gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.NEAREST);
        gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.NEAREST);
        gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
        gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
        gl.texImage2D(gl.TEXTURE_2D, 0, gl.DEPTH_STENCIL, this.normalShadowMapSize, this.normalShadowMapSize, 0,
            gl.DEPTH_STENCIL, ext.UNSIGNED_INT_24_8_WEBGL, null);

        this.colorShadowMapTexture = gl.createTexture();
        gl.bindTexture(gl.TEXTURE_2D, this.colorShadowMapTexture);
        gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.NEAREST);
        gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.NEAREST);
        gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
        gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
        gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, this.normalShadowMapSize, this.normalShadowMapSize, 0,
            gl.RGBA, gl.UNSIGNED_BYTE, null);

        this.normalShadowMapFramebuffer = GLFramebuffer.createFramebuffer(gl, {
            depth: this.depthShadowMapTexture,
            colors: [this.colorShadowMapTexture]
        });

        this.cubeShadowMapTexture = gl.createTexture();
        gl.bindTexture(gl.TEXTURE_CUBE_MAP, this.cubeShadowMapTexture);
        gl.texParameteri(gl.TEXTURE_CUBE_MAP, gl.TEXTURE_MAG_FILTER, gl.NEAREST);
        gl.texParameteri(gl.TEXTURE_CUBE_MAP, gl.TEXTURE_MIN_FILTER, gl.NEAREST);
        gl.texParameteri(gl.TEXTURE_CUBE_MAP, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
        gl.texParameteri(gl.TEXTURE_CUBE_MAP, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
        for (let i = 0; i < 6; ++i) {
            gl.texImage2D(gl.TEXTURE_CUBE_MAP_POSITIVE_X + i, 0, gl.RGBA, this.cubeShadowMapSize, this.cubeShadowMapSize, 0,
                gl.RGBA, gl.UNSIGNED_BYTE, null);
        }

        this.cubeShadowMapDepthRB = gl.createRenderbuffer();
        gl.bindRenderbuffer(gl.RENDERBUFFER, this.cubeShadowMapDepthRB);
        gl.renderbufferStorage(gl.RENDERBUFFER, gl.DEPTH_COMPONENT16,
            this.cubeShadowMapSize, this.cubeShadowMapSize);

        this.cubeShadowMapFramebuffer = [];
        for (let i = 0; i < 6; ++i) {
            this.cubeShadowMapFramebuffer.push(GLFramebuffer.createFramebuffer(gl, {
                depth: this.cubeShadowMapDepthRB,
                colors: [this.cubeShadowMapTexture]
            }, gl.TEXTURE_CUBE_MAP_POSITIVE_X + i));
        }
    }

    dispose(): void
    {
        this.gpMaterials.dispose();

        const gl = this.renderer.gl;
        gl.deleteTexture(this.depthShadowMapTexture);

        this.normalShadowMapFramebuffer.dispose();

        gl.deleteTexture(this.cubeShadowMapTexture);
        gl.deleteRenderbuffer(this.cubeShadowMapDepthRB);
        for (const fb of this.cubeShadowMapFramebuffer) {
            fb.dispose();
        }
    }

    setupShadowPass(ops: RenderOperation[]): ShadowPassOutput
    {
        const outp: ShadowPassOutput = {
            shadowMaps: new ShadowMapRenderBufferInfo()
        };

        ops.push({
            inputs: {},
            outputs: {
                shadowMaps: outp.shadowMaps
            },
            bindings: [],
            optionalOutputs: ["shadowMaps"],
            name: "Geometry Pass",
            factory: (cfg) => new ShadowMapRenderServiceImpl(this,
                <ShadowMapRenderBufferImpl> cfg.outputs["shadowMaps"])
        });

        return outp;
    }

}

export enum ShadowMapType
{
    Normal
}

export class ShadowMapRenderBufferInfo extends RenderBufferInfo
{
    constructor()
    {
        super("Shadow Maps");

        this.hash = 931810;
        this.cost = 0;
    }
    canMergeWith(o: RenderBufferInfo): boolean
    {
        if (o instanceof ShadowMapRenderBufferInfo) {
            return this == o;
        }
        return false;
    }
    create(manager: RenderPipeline): ShadowMapRenderBuffer
    {
        return new ShadowMapRenderBufferImpl();
    }
    get physicalFormatDescription(): string
    {
        return "Service";
    }
    get logicalFormatDescription(): string
    {
        return "Shadow Maps Provider";
    }
}

export interface ShadowMapRenderBuffer extends RenderBuffer
{
    service: ShadowMapRenderService;
}

export interface ShadowMapRenderService
{
    /** Must be called in `beforeRender`. */
    prepareShadowMap(camera: three.Camera | three.CubeCamera, type: ShadowMapType): void;

    /** Must be called in `perform`. */
    renderShadowMap(camera: three.Camera | three.CubeCamera, type: ShadowMapType): void;
    currentShadowMapDepth: WebGLTexture;
    shadowMapWidth: number;
    shadowMapHeight: number;

    currentCubeShadowDistanceMap: WebGLTexture;
    cubeShadowDistanceMapSize: number;
}

class ShadowMapRenderBufferImpl implements ShadowMapRenderBufferImpl
{
    service: ShadowMapRenderService;

    constructor()
    {
        this.service = null;
    }

    dispose(): void
    {
    }
}

class ShadowGeometryPassMaterialManager extends BaseGeometryPassMaterialManager
{
    constructor(core: RendererCore)
    {
        super(core, "VS_ShadowMapGeometry", "FS_ShadowMapGeometry");
    }

    createShader(material: Material, flags: number): Shader // override
    {
        return new ShadowGeometryPassShader(this, material, flags);
    }
}

class ShadowGeometryPassShader extends BaseGeometryPassShader
{
    geoUniforms: GLProgramUniforms;

    constructor(public manager: BaseGeometryPassMaterialManager, public source: Material, flags: number)
    {
        super(manager, source, flags);

        this.geoUniforms = this.glProgram.getUniforms([
            "u_halfRenderSize"
        ]);
    }
}

class ShadowCubeGeometryPassMaterialManager extends BaseGeometryPassMaterialManager
{
    constructor(core: RendererCore)
    {
        super(core, "VS_CubeShadowMapGeometry", "FS_CubeShadowMapGeometry");
    }

    createShader(material: Material, flags: number): Shader // override
    {
        return new ShadowCubeGeometryPassShader(this, material, flags);
    }
}

class ShadowCubeGeometryPassShader extends BaseGeometryPassShader
{
    geoUniforms: GLProgramUniforms;

    constructor(public manager: BaseGeometryPassMaterialManager, public source: Material, flags: number)
    {
        super(manager, source, flags);

        this.geoUniforms = this.glProgram.getUniforms([
            "u_viewPositionScale", "u_halfRenderSize"
        ]);
    }
}

class ShadowMapRenderServiceImpl implements RenderOperator, ShadowMapRenderService
{
    private normalRenderer: ShadowMapTextureRenderer;
    private cubeRenderer: ShadowMapCubeTextureRenderer;

    constructor(
        private parent: ShadowMapRenderer,
        private outShadowMap: ShadowMapRenderBufferImpl
    )
    {
        this.normalRenderer = new ShadowMapTextureRenderer(parent);
        this.cubeRenderer = new ShadowMapCubeTextureRenderer(parent);
        this.outShadowMap.service = this;
    }

    beforeRender(): void
    {
    }
    perform(): void
    {
    }
    afterRender(): void
    {
    }

    get currentShadowMapDepth(): WebGLTexture
    {
        return this.parent.depthShadowMapTexture;
    }
    get shadowMapWidth(): number
    {
        return this.parent.normalShadowMapSize;
    }
    get shadowMapHeight(): number
    {
        return this.parent.normalShadowMapSize;
    }

    get currentCubeShadowDistanceMap(): WebGLTexture
    {
        return this.parent.cubeShadowMapTexture;
    }
    get cubeShadowDistanceMapSize(): number
    {
        return this.parent.cubeShadowMapSize;
    }

    prepareShadowMap(camera: three.Camera | three.CubeCamera, type: ShadowMapType): void
    {
        // nothing to do for now
    }

    renderShadowMap(camera: three.Camera | three.CubeCamera, type: ShadowMapType): void
    {
        const profiler = this.parent.renderer.profiler;

        if (camera instanceof three.Camera) {
            profiler.begin("Normal Shadow Maps");
            this.normalRenderer.render(camera);
            profiler.end();
        } else if (camera instanceof three.CubeCamera) {
            profiler.begin("Cube Shadow Maps");
            this.cubeRenderer.render(camera);
            profiler.end();
        } else {
            throw new Error("unknown camera type");
        }
    }

    dispose(): void
    {
    }
}

class ShadowMapTextureRenderer extends BaseGeometryPassRenderer
{
    constructor(
        private parent: ShadowMapRenderer
    )
    {
        super(parent.renderer, parent.gpMaterials, false);
    }

    skipsMesh(mesh: three.Mesh): boolean
    {
        return !mesh.castShadow;
    }

    skipsPoints(points: three.Points): boolean
    {
        return !points.castShadow;
    }

    render(camera: three.Camera): void
    {
        const gl = this.parent.renderer.gl;
        this.parent.normalShadowMapFramebuffer.bind();
        gl.viewport(0, 0, this.parent.normalShadowMapSize, this.parent.normalShadowMapSize);
        this.parent.renderer.state.flags = GLStateFlags.DepthTestEnabled;
        gl.clear(gl.DEPTH_BUFFER_BIT | gl.COLOR_BUFFER_BIT);
        this.parent.renderer.state.flags = GLStateFlags.DepthTestEnabled |
            GLStateFlags.ColorWriteDisabled;
        gl.polygonOffset(2, 2);
        gl.enable(gl.POLYGON_OFFSET_FILL);

        this.renderGeometry(camera.matrixWorldInverse,
            camera.projectionMatrix);

        gl.disable(gl.POLYGON_OFFSET_FILL);
    }

    setupAdditionalUniforms(mesh: ObjectWithGeometry, shader: BaseGeometryPassShader): void // override
    {
        const shd = <ShadowGeometryPassShader> shader;
        const gl = this.parent.renderer.gl;
        gl.uniform2f(shd.geoUniforms["u_halfRenderSize"],
            this.parent.normalShadowMapSize >> 1, this.parent.normalShadowMapSize >> 1);
    }

    dispose(): void
    {
        BaseGeometryPassRenderer.prototype.dispose.call(this);
    }
}

class ShadowMapCubeTextureRenderer extends BaseGeometryPassRenderer
{
    private invFar: number;

    constructor(
        private parent: ShadowMapRenderer
    )
    {
        super(parent.renderer, parent.gpCubeMaterials, false);

        this.invFar = 0;
    }

    skipsMesh(mesh: three.Mesh): boolean
    {
        return !mesh.castShadow;
    }

    skipsPoints(points: three.Points): boolean
    {
        return !points.castShadow;
    }

    render(camera: three.CubeCamera): void
    {
        const profiler = this.parent.renderer.profiler;

        profiler.begin("Setup");

        const gl = this.parent.renderer.gl;
        gl.viewport(0, 0, this.parent.cubeShadowMapSize, this.parent.cubeShadowMapSize);
        this.parent.renderer.state.flags = GLStateFlags.DepthTestEnabled | GLStateFlags.FrontFaceCW;
        gl.clearColor(1, 1, 1, 1); // far away

        profiler.end();

        for (let i = 0; i < 6; ++i) {
            this.parent.cubeShadowMapFramebuffer[i].bind();

            const cam = camera.children[i];
            if (cam instanceof three.PerspectiveCamera) {
                profiler.begin("Face");

                gl.clear(gl.DEPTH_BUFFER_BIT | gl.COLOR_BUFFER_BIT);

                cam.matrixWorldInverse.getInverse(cam.matrixWorld);

                this.invFar = 1 / cam.far;

                this.renderGeometry(cam.matrixWorldInverse,
                    cam.projectionMatrix);

                profiler.end();
            } else {
                throw new Error("child of CubeCamera wasn't camera");
            }
        }
    }

    setupAdditionalUniforms(mesh: ObjectWithGeometry, shader: BaseGeometryPassShader): void // override
    {
        const shd = <ShadowCubeGeometryPassShader> shader;
        const gl = this.parent.renderer.gl;
        gl.uniform1f(shd.geoUniforms["u_viewPositionScale"], this.invFar);
        gl.uniform2f(shd.geoUniforms["u_halfRenderSize"],
            this.parent.cubeShadowMapSize >> 1, this.parent.cubeShadowMapSize >> 1);
    }

    dispose(): void
    {
        BaseGeometryPassRenderer.prototype.dispose.call(this);
    }
}
