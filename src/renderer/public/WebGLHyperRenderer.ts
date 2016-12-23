/// <reference path="../Prefix.d.ts" />

import * as three from "three";
import { RendererCore } from "../core/RendererCore";

import { REVISION } from "./Version";

export interface WebGLHyperRendererLogParameters
{
    core: boolean;
    shader: boolean;

    [topic: string]: boolean;
}

export interface WebGLHyperRendererCreationParameters
{
    canvas?: HTMLCanvasElement;
    useFullResolutionGBuffer?: boolean;
    useFPBuffer?: boolean;
    log?: WebGLHyperRendererLogParameters | boolean;
    useStereoRendering?: string;
}

export interface WebGLHyperRendererParameters
{
    bloomAmount: number;
    bloomSaturation: number;
    bloomTexture: three.Texture;
    motionBlurAmount: number;
    vignette: number;
    autoExposureEnabled: boolean;
    exposureBias: number;
    color: three.Vector3;
    highlightCrush: number;
    contrast: number;
}

export interface WebGLHyperRendererProfilerPhase
{
    name: string;
    time: number;
}

export interface WebGLHyperRendererProfilerResult
{
    phases: WebGLHyperRendererProfilerPhase[];
}

export class WebGLHyperRenderer implements three.Renderer
{
    private canvas: HTMLCanvasElement;

    private gl: WebGLRenderingContext;

    private core: RendererCore;

    constructor(params?: WebGLHyperRendererCreationParameters)
    {
        console.log(this.rendererInfo);

        params = params || {};

        this.canvas = params.canvas ? params.canvas : document.createElement("canvas");

        const glAttrs = {
            alpha: false,
            depth: false,
            stencil: false,
            antialias: false,
            preserveDrawingBuffer: false
        };

        this.gl = <WebGLRenderingContext> (
            this.canvas.getContext("webgl", glAttrs) ||
            this.canvas.getContext("experimental-webgl", glAttrs));

        if (!this.gl) {
            throw new Error("could not create WebGL context.");
        }

        this.canvas.addEventListener("webglcontextlost", () => {
            this.setup();
        });
        this.canvas.addEventListener("webglcontextrestored", () => {

        });

        this.core = new RendererCore(this.gl, params);
    }

    private setup(): void
    {

    }

    startProfiling(cb: (result: WebGLHyperRendererProfilerResult) => void): void
    {
        this.core.startProfiling(cb);
    }

    stopProfiling(): void
    {
        this.core.stopProfiling();
    }

    get rendererName(): string
    {
        return "Hyper.WebGLHyperRenderer";
    }

    get rendererVersion(): string
    {
        return REVISION;
    }

    get rendererInfo(): string
    {
        return `${this.rendererName} ${this.rendererVersion}`;
    }

    get context(): WebGLRenderingContext
    {
        return this.core.gl;
    }

    render(scene: three.Scene, camera: three.Camera): void
    {
        this.core.render(scene, camera);
    }
    setSize(width: number, height: number, updateStyle?: boolean): void
    {
        this.canvas.width = width;
        this.canvas.height = height;

        this.core.setSize(width, height);
    }
    get domElement(): HTMLCanvasElement
    {
        return this.canvas;
    }
    get parameters(): WebGLHyperRendererParameters
    {
        return this.core.parameters;
    }
}
