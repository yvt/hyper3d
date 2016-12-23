/// <reference path="../Prefix.d.ts" />
/// <reference path="../gl/WEBGLDrawBuffers" />

import * as three from "three";
import { TextureManager } from "../render/TextureManager";
import {
    Texture2DProvider,
    TextureCubeProvider,
    Texture2D,
    TextureCube
} from "../render/TextureProvider";
import {
    ReflectionTextureCubeProvider,
    ReflectionTextureCube
} from "../render/ReflectionTextureProvider";
import { BitArray } from "../utils/BitArray";
import { GeometryRenderer } from "../render/GeometryRenderer";
import { ShadowMapRenderer } from "../render/ShadowMapRenderer";
import { GeometryManager } from "../render/GeometryManager";
import { LightRenderer } from "../render/LightRenderer";
import { ReflectionRenderer } from "../render/ReflectionRenderer";
import { HdrDemosaicFilterRenderer } from "../render/HdrDemosaicFilter";
import { RenderingController } from "../render/RenderingController";
import {
    JitterTexture,
    UniformJitterTexture,
    DitherJitterTexture,
    GaussianDitherJitterTexture,
    GaussianJitterTexture
} from "./JitterTexture";
import { QuadRenderer } from "./QuadRenderer";
import { ShaderManager, createShaderManager } from "./ShaderManager";
import { BufferVisualizer } from "./Visualizer";
import { ToneMappingFilterRenderer } from "../postfx/ToneMappingFilter";
import { MotionBlurFilterRenderer } from "../postfx/MotionBlurFilter";
import { ResampleFilterRenderer } from "../postfx/ResampleFilter";
import { SSAORenderer } from "../postfx/SSAORenderer";
import { TemporalAAFilterRenderer } from "../postfx/TemporalAAFilter";
import { BloomFilterRenderer } from "../postfx/BloomFilter";
import {
    HdrCompressFilter,
    HdrCompressDirection,
    HdrOperatorType
} from "../postfx/HdrCompressFilter";
import {
    WebGLHyperRendererParameters,
    WebGLHyperRendererCreationParameters,
    WebGLHyperRendererLogParameters,
    WebGLHyperRendererProfilerResult
} from "../public/WebGLHyperRenderer";
import { RendererCoreParameters } from "./RendererParameters";
import {
    RenderOperation,
    RenderPipeline,
    dumpRenderOperationAsDot
} from "./RenderPipeline";
import { TextureRenderBufferInfo, DummyRenderBufferInfo } from "./RenderBuffers";
import {
    HdrMosaicTextureRenderBufferInfo,
    LogRGBTextureRenderBufferInfo,
    LinearRGBTextureRenderBufferInfo
} from "./TypedRenderBuffers";
import {
    GLProgram,
    GLProgramUniforms,
    GLProgramAttributes
} from "../core/GLProgram";
import {
    computeFarDepthFromProjectionMatrix,
    ObjectBoundingBoxCalculator,
    ShadowCastingObjectBoundingBoxCalculator
} from "../utils/Geometry";
import { validateSRGBCompliance } from "../validator/SRGBValidator";
import { validateHalfFloatColorBuffer } from "../validator/FPColorBufferValidator";
import { LogManager } from "../utils/Logger";
import { Profiler } from "./Profiler";
import { StereoCamera } from "../public/Camera";

export enum HdrMode
{
    NativeHdr,
    MobileHdr
}

export class RendererCore
{
    ext: three.WebGLExtensions;

    supportsSRGB: boolean;
    supportsHdrTexture: boolean;
    supportsHdrRenderingBuffer: boolean;
    supportsMRT: boolean;
    hdrMode: HdrMode;

    textures: TextureManager<Texture2D>;
    textureCubes: TextureManager<TextureCube>;
    reflectionTextures: TextureManager<ReflectionTextureCube>;
    renderBuffers: RenderPipeline;
    vertexAttribs: VertexAttribState;
    state: GLState;
    profiler: Profiler;

    parameters: WebGLHyperRendererParameters;

    ctrler: RenderingController;
    geometryRenderer: GeometryRenderer;
    shadowRenderer: ShadowMapRenderer;
    geometryManager: GeometryManager;
    uniformJitter: JitterTexture;
    gaussianJitter: JitterTexture;
    uniformDitherJitter: JitterTexture;
    gaussianDitherJitter: JitterTexture;
    quadRenderer: QuadRenderer;
    shaderManager: ShaderManager;
    passthroughRenderer: PassThroughRenderer;
    bufferVisualizer: BufferVisualizer;
    lightRenderer: LightRenderer;
    reflectionRenderer: ReflectionRenderer;
    hdrDemosaic: HdrDemosaicFilterRenderer;
    toneMapFilter: ToneMappingFilterRenderer;
    resampler: ResampleFilterRenderer;
    ssaoRenderer: SSAORenderer;
    temporalAA: TemporalAAFilterRenderer;
    bloom: BloomFilterRenderer;
    motionBlur: MotionBlurFilterRenderer;
    hdrCompress: HdrCompressFilter;

    currentScene: three.Scene;
    currentCamera: three.Camera[];
    depthFar: number;

    sceneBounds: three.Box3;
    shadowCasterBounds: three.Box3;

    /** Objects removed from the scene tree are deleted as soon as possible.
        * Setting this to true prevents this behavior.
        * FIXME: no used
        */
    deferGC: boolean;

    useFullResolutionGBuffer: boolean;
    useFPBuffer: boolean;

    width: number;
    height: number;

    renderWidth: number;
    renderHeight: number;

    log: LogManager;

    constructor(public gl: WebGLRenderingContext, private params: WebGLHyperRendererCreationParameters)
    {
        if (params == null) {
            this.params = params = {};
        } else {
            this.params = params = Object.create(params);
        }

        this.log = new LogManager();

        if (typeof params.log === "object") {
            const topics = <WebGLHyperRendererLogParameters> params.log;
            for (const key in topics) {
                if (topics[key]) {
                    this.log.enableTopic(key);
                }
            }
        } else if (typeof params.log === "boolean" && params.log) {
            this.log.enableAllTopics();
        }

        this.parameters = new RendererCoreParameters(this);

        this.useFullResolutionGBuffer = params.useFullResolutionGBuffer == null ? false :
            params.useFullResolutionGBuffer;

        this.ext = new three.WebGLExtensions(this.gl);
        this.ext.get("OES_texture_float");
        this.ext.get("OES_texture_float_linear");
        this.ext.get("OES_texture_half_float");
        this.ext.get("OES_texture_half_float_linear");
        this.ext.get("OES_standard_derivatives");
        this.ext.get("EXT_frag_depth");
        if (!this.ext.get("WEBGL_depth_texture")) {
            throw new Error("required WebGL extension WEBGL_depth_texture is not supported.");
        }
        if (!this.ext.get("EXT_shader_texture_lod")) {
            throw new Error("required WebGL extension EXT_shader_texture_lod is not supported.");
        }

        this.supportsSRGB = !!(this.ext.get("EXT_sRGB"));
        this.supportsHdrTexture = !!(this.ext.get("OES_texture_half_float") &&
            this.ext.get("OES_texture_half_float_linear"));
        this.supportsMRT = !!(this.ext.get("WEBGL_draw_buffers"));
        this.supportsHdrRenderingBuffer = false;
        this.hdrMode = HdrMode.MobileHdr;

        if (this.supportsMRT) {
            this.useFullResolutionGBuffer = true;
        }

        this.renderWidth = this.width = gl.drawingBufferWidth;
        this.renderHeight = this.height = gl.drawingBufferHeight;

        this.deferGC = false;
        this.depthFar = 1000;

        this.shadowCasterBounds = null;
        this.sceneBounds = null;

        this.setup();
    }

    get useWiderTemporalAA(): boolean
    {
        return !this.useFullResolutionGBuffer;
    }

    setup(): void
    {
        this.shaderManager = createShaderManager(this);
        this.vertexAttribs = new VertexAttribState(this.gl);
        this.state = new GLState(this.gl);
        this.profiler = new Profiler(this, this.log.getLogger("profiler"));

        // this is required by WebGL comformance test
        this.quadRenderer = new QuadRenderer(this);

        // check capability
        if (this.supportsSRGB) {
            if (!validateSRGBCompliance(this)) {
                console.warn("WebGLHyperRenderer: defective EXT_sRGB detected; disabling sRGB support.");
                this.supportsSRGB = false;
            }
        }

        // a certain browser implicitly supports FP render buffer
        // in spite of the lack of support for EXT_color_buffer_half_float.
        if (validateHalfFloatColorBuffer(this)) {
            this.supportsHdrRenderingBuffer = true;
        }
        this.hdrMode = this.supportsHdrRenderingBuffer &&
            this.params.useFPBuffer ? HdrMode.NativeHdr : HdrMode.MobileHdr;

        // set global shader parameters
        this.shaderManager.setGlobalParameter("globalUseFullResolutionGBuffer", this.useFullResolutionGBuffer);
        this.shaderManager.setGlobalParameter("globalSupportsSRGB", this.supportsSRGB);

        // global uniform values
        this.updateGlobalUniforms();

        this.textures = new TextureManager<Texture2D>(this, new Texture2DProvider());
        this.textureCubes = new TextureManager<TextureCube>(this, new TextureCubeProvider());
        this.reflectionTextures = new TextureManager<ReflectionTextureCube>(this,
            new ReflectionTextureCubeProvider(this));
        this.ctrler = new RenderingController(this);
        this.geometryManager = new GeometryManager(this);
        this.renderBuffers = new RenderPipeline(this);
        this.uniformJitter = new UniformJitterTexture(this.gl);
        this.gaussianJitter = new GaussianJitterTexture(this.gl);
        this.uniformDitherJitter = new DitherJitterTexture(this.gl);
        this.gaussianDitherJitter = new GaussianDitherJitterTexture(this.gl);
        this.geometryRenderer = new GeometryRenderer(this);
        this.shadowRenderer = new ShadowMapRenderer(this);
        this.passthroughRenderer = new PassThroughRenderer(this);
        this.bufferVisualizer = new BufferVisualizer(this);
        this.lightRenderer = new LightRenderer(this);
        this.reflectionRenderer = new ReflectionRenderer(this);
        this.hdrDemosaic = new HdrDemosaicFilterRenderer(this);
        this.ssaoRenderer = new SSAORenderer(this);
        this.resampler = new ResampleFilterRenderer(this);
        this.toneMapFilter = new ToneMappingFilterRenderer(this);
        this.temporalAA = new TemporalAAFilterRenderer(this, {
            useWiderFilter: this.useWiderTemporalAA
        });
        this.bloom = new BloomFilterRenderer(this);
        this.motionBlur = new MotionBlurFilterRenderer(this);
        this.hdrCompress = new HdrCompressFilter(this);

        this.compilePipeline();
    }

    private updateGlobalUniforms(): void
    {
        this.shaderManager.setGlobalUniform("globalRenderSize", true, this.renderWidth, this.renderHeight);
        this.shaderManager.setGlobalUniform("globalQuadRenderSize", true, 4 * this.renderWidth, 4 * this.renderHeight);
        this.shaderManager.setGlobalUniform("globalDoubleRenderSize", true, 2 * this.renderWidth, 2 * this.renderHeight);
        this.shaderManager.setGlobalUniform("globalHalfRenderSize", true, 0.5 * this.renderWidth, 0.5 * this.renderHeight);
        this.shaderManager.setGlobalUniform("globalQuadInvRenderSize", true, 4 / this.renderWidth, 4 / this.renderHeight);
        this.shaderManager.setGlobalUniform("globalDoubleInvRenderSize", true, 2 / this.renderWidth, 2 / this.renderHeight);
        this.shaderManager.setGlobalUniform("globalInvRenderSize", true, 1 / this.renderWidth, 1 / this.renderHeight);
        this.shaderManager.setGlobalUniform("globalHalfInvRenderSize", true, 0.5 / this.renderWidth, 0.5 / this.renderHeight);
        this.shaderManager.setGlobalUniform("globalQuarterInvRenderSize", true, 0.25 / this.renderWidth, 0.25 / this.renderHeight);
        this.shaderManager.setGlobalUniform("globalDepthFar", true, this.depthFar);
        this.shaderManager.setGlobalUniform("globalInvDepthFar", true, 1 / this.depthFar);
    }

    dispose(): void
    {
        this.motionBlur.dispose();
        this.bloom.dispose();
        this.temporalAA.dispose();
        this.toneMapFilter.dispose();
        this.resampler.dispose();
        this.ssaoRenderer.dispose();
        this.hdrDemosaic.dispose();
        this.reflectionRenderer.dispose();
        this.lightRenderer.dispose();
        this.bufferVisualizer.dispose();
        this.passthroughRenderer.dispose();
        this.geometryRenderer.dispose();
        this.ctrler.dispose();
        this.shadowRenderer.dispose();
        this.textures.dispose();
        this.quadRenderer.dispose();
        this.geometryManager.dispose();
        this.renderBuffers.dispose();
        this.uniformDitherJitter.dispose();
        this.gaussianDitherJitter.dispose();
        this.uniformJitter.dispose();
        this.gaussianJitter.dispose();
        this.shaderManager.dispose();
        this.hdrCompress.dispose();
        this.profiler.dispose();
    }

    compilePipeline(): void
    {
        const ops: RenderOperation[] = [];

        const numViews = this.params.useStereoRendering ? 2 : 1;
        const viewWidth = this.renderWidth;
        const viewHeight = this.renderHeight;
        let output: DummyRenderBufferInfo;
        const outputs: TextureRenderBufferInfo[] = [];

        const shadowMaps = this.shadowRenderer.setupShadowPass(ops);

        for (let i = 0; i < numViews; ++i) {
            const gbuffer = this.geometryRenderer.setupGeometryPass(viewWidth, viewHeight, i, ops);
            const linearDepthHalf = this.resampler.setupNearestResampler(gbuffer.linearDepth, {
                outWidth: (gbuffer.linearDepth.width + 1) >> 1,
                outHeight: (gbuffer.linearDepth.height + 1) >> 1
            }, ops);

            const ssao = this.ssaoRenderer.setupFilter({
                g2: gbuffer.g2,
                linearDepth: gbuffer.linearDepth,
                linearDepthHalf: linearDepthHalf
            }, i, ops);

            const lightBuf = this.hdrMode == HdrMode.MobileHdr ?
                this.lightRenderer.setupMobileHdrLightPass({
                    g0: gbuffer.g0,
                    g1: gbuffer.g1,
                    g2: gbuffer.g2,
                    g3: gbuffer.g3,
                    linearDepth: gbuffer.linearDepth,
                    depth: gbuffer.depth,
                    shadowMaps: shadowMaps.shadowMaps,
                    ssao: ssao.output
                }, i, ops) :
                this.lightRenderer.setupNativeHdrLightPass({
                    g0: gbuffer.g0,
                    g1: gbuffer.g1,
                    g2: gbuffer.g2,
                    g3: gbuffer.g3,
                    linearDepth: gbuffer.linearDepth,
                    depth: gbuffer.depth,
                    shadowMaps: shadowMaps.shadowMaps,
                    ssao: ssao.output
                }, i, ops);

            const reflections = this.reflectionRenderer.setupReflectionPass({
                g0: gbuffer.g0,
                g1: gbuffer.g1,
                g2: gbuffer.g2,
                g3: gbuffer.g3,
                linearDepth: gbuffer.linearDepth,
                depth: gbuffer.depth,
                ssao: ssao.output,
                lit: lightBuf
            }, i, ops);

            let demosaiced = reflections instanceof HdrMosaicTextureRenderBufferInfo ?
                <LogRGBTextureRenderBufferInfo> this.hdrDemosaic.setupFilter(reflections, {
                    halfSized: false
                }, ops) :
                <LinearRGBTextureRenderBufferInfo> reflections;

            if (this.hdrMode == HdrMode.NativeHdr) {
                demosaiced = this.hdrCompress.setupFilter(demosaiced,
                    HdrOperatorType.Reinhard, HdrCompressDirection.Encode,
                    1, ops);
                demosaiced = this.temporalAA.setupFilter({
                    color: demosaiced,
                    linearDepth: gbuffer.linearDepth,
                    g0: gbuffer.g0, g1: gbuffer.g1
                }, ops);
                demosaiced = this.hdrCompress.setupFilter(demosaiced,
                    HdrOperatorType.Reinhard, HdrCompressDirection.Decode,
                    1, ops);
            }

            demosaiced = this.motionBlur.setupFilter({
                color: demosaiced,
                g0: gbuffer.g0,
                g1: gbuffer.g1,
                linearDepth: gbuffer.linearDepth
            }, {
                maxBlur: Math.max(this.renderWidth, this.renderHeight) / 40
            }, ops);

            demosaiced = this.bloom.setupFilter(demosaiced, ops);

            let toneMapped = this.toneMapFilter.setupFilter(demosaiced, i, ops);

            if (this.hdrMode == HdrMode.MobileHdr) {
                toneMapped = this.temporalAA.setupFilter({
                    color: toneMapped,
                    linearDepth: gbuffer.linearDepth,
                    g0: gbuffer.g0, g1: gbuffer.g1
                }, ops);
            }

            let visualizedBuf = toneMapped;
            outputs.push(visualizedBuf);
        }

        if (outputs.length === 1) {
            let visualized = this.bufferVisualizer.setupColorVisualizer(outputs[0], ops);
            output = visualized;
        } else if (outputs.length === 2) {
            let visualized = this.bufferVisualizer.setupSeparateStereoColorVisualizer(
                outputs[0], outputs[1], ops);
            output = visualized;
        }

        const logger = this.log.getLogger("pipeline");
        if (logger.isEnabled)
            logger.log(dumpRenderOperationAsDot(ops));

        this.renderBuffers.setup(ops, [output]);
    }

    startProfiling(callback: (result: WebGLHyperRendererProfilerResult) => void): void
    {
        this.profiler.startProfiling(callback);
    }

    stopProfiling(): void
    {
        this.profiler.stopProfiling();
    }

    invalidateFramebuffer(...attachments: number[]): void
    {
        // FIXME: variadic functions in TypeScript comes with dynamic allocation...
        // FIXME: this is only needed on TBR like mobile GPUs
        let bits = 0;
        const gl = this.gl;
        for (let i = 0; i < attachments.length; ++i) {
            switch (attachments[i]) {
                case gl.COLOR_ATTACHMENT0:
                    bits |= gl.COLOR_BUFFER_BIT;
                    break;
                case gl.DEPTH_ATTACHMENT:
                    bits |= gl.DEPTH_BUFFER_BIT;
                    break;
                case gl.STENCIL_ATTACHMENT:
                    bits |= gl.STENCIL_BUFFER_BIT;
                    break;
                case gl.DEPTH_STENCIL_ATTACHMENT:
                    bits |= gl.DEPTH_BUFFER_BIT;
                    bits |= gl.STENCIL_BUFFER_BIT;
                    break;
            }
        }
        if (attachments.length == 0) {
            // all
            bits = gl.COLOR_BUFFER_BIT |
                gl.DEPTH_BUFFER_BIT |
                gl.STENCIL_BUFFER_BIT;
        }
        gl.clear(bits);
    }

    render(scene: three.Scene, camera: three.Camera): void
    {
        this.currentScene = scene;
        if (camera instanceof StereoCamera) {
            this.currentCamera = [camera.leftCamera, camera.rightCamera];
        } else {
            this.currentCamera = [camera];
        }
        if (this.currentCamera.length !== (this.params.useStereoRendering ? 2 : 1)) {
            throw new Error("Bad camera type");
        }

        this.uniformJitter.update();
        this.gaussianJitter.update();
        this.uniformDitherJitter.update();
        this.gaussianDitherJitter.update();

        // compute bounding box
        this.sceneBounds = new ObjectBoundingBoxCalculator()
            .computeBoundingBox(scene, this.sceneBounds);
        this.shadowCasterBounds = new ShadowCastingObjectBoundingBoxCalculator()
            .computeBoundingBox(scene, this.shadowCasterBounds);

        // compute depth far
        {
            const proj = this.currentCamera[0].projectionMatrix;
            const newDepthFar = computeFarDepthFromProjectionMatrix(proj);
            if (newDepthFar != this.depthFar) {
                this.depthFar = newDepthFar;
                this.updateGlobalUniforms();
            }
        }

        if (scene.autoUpdate) {
            scene.updateMatrixWorld(false);
        }
        if (!camera.parent) {
            camera.updateMatrixWorld(false);
        }

        // update skeletons
        scene.traverse((obj) => {
            if (obj instanceof three.SkinnedMesh) {
                obj.skeleton.update();
            }
        });

        for (const cam of this.currentCamera) {
            cam.matrixWorldInverse.getInverse(cam.matrixWorld);
        }

        this.profiler.beginFrame();
        this.ctrler.beforeRender();
        this.renderBuffers.render();
        this.profiler.finalizeFrame();
    }
    setSize(width: number, height: number): void
    {
        if (width & 1) {
            throw new Error("width cannot be odd");
        }
        if (height & 1) {
            throw new Error("height cannot be odd");
        }

        width = Math.max(width | 0, 2);
        height = Math.max(height | 0, 2);

        this.renderWidth = this.width = width;
        this.renderHeight = this.height = height;
        this.renderWidth = (width / (this.params.useStereoRendering ? 2 : 1)) | 0;

        // global uniform values
        this.updateGlobalUniforms();

        this.compilePipeline();
    }
}

class VertexAttribState extends BitArray
{
    constructor(private gl: WebGLRenderingContext)
    {
        super();
    }

    onToggledTrue(index: number): void
    {
        this.gl.enableVertexAttribArray(index);
    }
    onToggledFalse(index: number): void
    {
        this.gl.disableVertexAttribArray(index);
    }
}

export const enum GLStateFlags
{
    Default = 0,

    DepthTestEnabled = 1 << 0,
    DepthWriteDisabled = 1 << 1,
    StencilTestEnabled = 1 << 2,
    BlendEnabled = 1 << 3,

    ColorRedWriteDisabled = 1 << 4,
    ColorGreenWriteDisabled = 1 << 5,
    ColorBlueWriteDisabled = 1 << 6,
    ColorAlphaWriteDisabled = 1 << 7,
    ColorRGBWriteDisabled = ColorRedWriteDisabled | ColorGreenWriteDisabled | ColorBlueWriteDisabled,
    ColorWriteDisabled = ColorRGBWriteDisabled | ColorAlphaWriteDisabled,

    CullFaceDisabled = 1 << 8,

    FrontFaceCW = 1 << 9,

    ColorAttachment0Disabled = 1 << 10,
    ColorAttachment1Enabled = 1 << 11,
    ColorAttachment2Enabled = 1 << 12,
    ColorAttachment3Enabled = 1 << 13,
    ColorAttachment4Enabled = 1 << 14,

    ColorAttachmentFlags = ColorAttachment0Disabled | ColorAttachment1Enabled |
        ColorAttachment2Enabled | ColorAttachment3Enabled | ColorAttachment4Enabled
}

class GLState
{
    private flags_: GLStateFlags;
    private drawBuffers: number[];
    private extDrawBuffers: WebGLDrawBuffers;

    constructor(private gl: WebGLRenderingContext)
    {
        gl.disable(gl.DEPTH_TEST);
        gl.disable(gl.STENCIL_TEST);
        gl.disable(gl.BLEND);
        gl.depthMask(true);
        gl.colorMask(true, true, true, true);
        gl.enable(gl.CULL_FACE);
        gl.frontFace(gl.CCW);

        this.extDrawBuffers = gl.getExtension("WEBGL_draw_buffers");
        this.drawBuffers = this.extDrawBuffers ? [this.extDrawBuffers.COLOR_ATTACHMENT0_WEBGL] : null;

        if (this.drawBuffers) {
            this.extDrawBuffers.drawBuffersWEBGL(this.drawBuffers);
        }

        this.flags_ = 0;
    }

    get flags(): GLStateFlags
    {
        return this.flags_;
    }

    set flags(newValue: GLStateFlags)
    {
        const diff = newValue ^ this.flags_;
        if (!diff) {
            return;
        }

        const gl = this.gl;
        if (diff & GLStateFlags.DepthTestEnabled) {
            if (newValue & GLStateFlags.DepthTestEnabled) {
                gl.enable(gl.DEPTH_TEST);
            } else {
                gl.disable(gl.DEPTH_TEST);
            }
        }
        if (diff & GLStateFlags.DepthWriteDisabled) {
            if (newValue & GLStateFlags.DepthWriteDisabled) {
                gl.depthMask(false);
            } else {
                gl.depthMask(true);
            }
        }
        if (diff & GLStateFlags.ColorWriteDisabled) {
            gl.colorMask(
                !(newValue & GLStateFlags.ColorRedWriteDisabled),
                !(newValue & GLStateFlags.ColorGreenWriteDisabled),
                !(newValue & GLStateFlags.ColorBlueWriteDisabled),
                !(newValue & GLStateFlags.ColorAlphaWriteDisabled)
            );
        }
        if (diff & GLStateFlags.StencilTestEnabled) {
            if (newValue & GLStateFlags.StencilTestEnabled) {
                gl.enable(gl.STENCIL_TEST);
            } else {
                gl.disable(gl.STENCIL_TEST);
            }
        }
        if (diff & GLStateFlags.BlendEnabled) {
            if (newValue & GLStateFlags.BlendEnabled) {
                gl.enable(gl.BLEND);
            } else {
                gl.disable(gl.BLEND);
            }
        }
        if (diff & GLStateFlags.CullFaceDisabled) {
            if (newValue & GLStateFlags.CullFaceDisabled) {
                gl.disable(gl.CULL_FACE);
            } else {
                gl.enable(gl.CULL_FACE);
            }
        }
        if (diff & GLStateFlags.FrontFaceCW) {
            if (newValue & GLStateFlags.FrontFaceCW) {
                gl.frontFace(gl.CW);
            } else {
                gl.frontFace(gl.CCW);
            }
        }
        if (diff & GLStateFlags.ColorAttachmentFlags) {
            this.drawBuffers.length = 0;
            if (!(diff & GLStateFlags.ColorAttachment0Disabled)) {
                this.drawBuffers.push(this.extDrawBuffers.COLOR_ATTACHMENT0_WEBGL);
            }
            if (diff & GLStateFlags.ColorAttachment1Enabled) {
                this.drawBuffers.push(this.extDrawBuffers.COLOR_ATTACHMENT1_WEBGL);
            }
            if (diff & GLStateFlags.ColorAttachment2Enabled) {
                this.drawBuffers.push(this.extDrawBuffers.COLOR_ATTACHMENT2_WEBGL);
            }
            if (diff & GLStateFlags.ColorAttachment3Enabled) {
                this.drawBuffers.push(this.extDrawBuffers.COLOR_ATTACHMENT3_WEBGL);
            }
            if (diff & GLStateFlags.ColorAttachment4Enabled) {
                this.drawBuffers.push(this.extDrawBuffers.COLOR_ATTACHMENT4_WEBGL);
            }
            // this is actually a framebuffer state, not a context one
            // this.extDrawBuffers.drawBuffersWEBGL(this.drawBuffers);
        }

        this.flags_ = newValue;
    }

}

class PassThroughRenderer
{
    private normal: {
        program: GLProgram;
        uniforms: GLProgramUniforms;
        attrs: GLProgramAttributes;
    };
    private modulated: {
        program: GLProgram;
        uniforms: GLProgramUniforms;
        attrs: GLProgramAttributes;
    };

    constructor(private core: RendererCore)
    {
        {
            const p = core.shaderManager.get("VS_Passthrough", "FS_Passthrough", [
                "a_position"
            ]);
            this.normal = {
                program: p,
                uniforms: p.getUniforms(["u_uvScale", "u_texture"]),
                attrs: p.getAttributes([
                    "a_position"
                ])
            };
        }
        {
            const p = core.shaderManager.get("VS_Passthrough", "FS_PassthroughModulated", [
                "a_position"
            ]);
            this.modulated = {
                program: p,
                uniforms: p.getUniforms(["u_uvScale", "u_texture", "u_modulation"]),
                attrs: p.getAttributes([
                    "a_position"
                ])
            };
        }
    }

    dispose(): void
    { }

    render(): void
    {
        const gl = this.core.gl;
        const p = this.normal;
        p.program.use();
        gl.uniform4f(p.uniforms["u_uvScale"], 0.5, 0.5, 0.5, 0.5);
        gl.uniform1i(p.uniforms["u_texture"], 0);
        this.core.quadRenderer.render(p.attrs["a_position"]);
    }

    renderModulated(r: number, g: number, b: number, a: number): void
    {
        const gl = this.core.gl;
        const p = this.modulated;
        p.program.use();
        gl.uniform4f(p.uniforms["u_uvScale"], 0.5, 0.5, 0.5, 0.5);
        gl.uniform1i(p.uniforms["u_texture"], 0);
        gl.uniform4f(p.uniforms["u_modulation"], r, g, b, a);
        this.core.quadRenderer.render(p.attrs["a_position"]);
    }
}

