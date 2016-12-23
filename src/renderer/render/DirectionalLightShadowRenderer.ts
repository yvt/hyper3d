/// <reference path="../Prefix.d.ts" />

import * as three from "three";

import {
    RendererCore,
    GLStateFlags
} from "../core/RendererCore";

import {
    Vector3Pool,
    Vector4Pool,
    Matrix4Pool
} from "../utils/ObjectPool";

import { TextureRenderBuffer } from "../core/RenderBuffers";

import { GLFramebuffer } from "../core/GLFramebuffer";

import {
    GLProgram,
    GLProgramUniforms,
    GLProgramAttributes
} from "../core/GLProgram";

import {
    ViewVectors,
    computeViewVectorCoefFromProjectionMatrix
} from "../utils/Geometry";

import {
    ShadowMapRenderService,
    ShadowMapType
} from "./ShadowMapRenderer";

const enum ProgramFlags
{
    Default = 0,
    ClipByFarPlane = 1 << 0,
    ClipByNearPlane = 1 << 1,
}

interface PotentiallyHyperDirectionalLight extends three.DirectionalLight
{
    shadowCascadeCount?: number;
    shadowCamera?: three.Camera[];
}

export default class DirectionalLightShadowRenderer
{
    private width: number;
    private height: number;
    private infoMap: Map<three.DirectionalLight, LightInfo>;
    private viewVec: ViewVectors;
    private fb: GLFramebuffer;

    private program: {
        program: GLProgram;
        uniforms: GLProgramUniforms;
        attributes: GLProgramAttributes;
    }[];

    constructor(private core: RendererCore,
        private viewId: number,
        public lightBuffer: TextureRenderBuffer,
        private inDepth: TextureRenderBuffer,
        private inLinearDepth: TextureRenderBuffer,
        private shadowMapService: ShadowMapRenderService)
    {
        this.width = lightBuffer.width;
        this.height = lightBuffer.height;
        this.infoMap = new Map<three.DirectionalLight, LightInfo>();
        this.fb = GLFramebuffer.createFramebuffer(core.gl, {
            colors: [
                this.lightBuffer.texture
            ],
            depth: inDepth ? inDepth.texture : null
        });

        this.program = [];
        for (let i = 0; i < 4; ++i) {
            const program = core.shaderManager.get("VS_DirectionalLightShadow", "FS_DirectionalLightShadow",
                ["a_position"], {
                    clipByFarPlane: (i & ProgramFlags.ClipByFarPlane) != 0,
                    clipByNearPlane: (i & ProgramFlags.ClipByNearPlane) != 0
                });
            this.program.push({
                program,
                uniforms: program.getUniforms([
                    "u_linearDepth",
                    "u_viewDirCoefX", "u_viewDirCoefY", "u_viewDirOffset",
                    "u_shadowMap", "u_shadowMapMatrix",
                    "u_depthValue",
                    "u_farPlane", "u_nearPlane",
                    "u_shadowMapZScale"
                ]),
                attributes: program.getAttributes(["a_position"])
            });
        }
    }

    dispose(): void
    {
        this.fb.dispose();
    }

    reset(): void
    {
        this.infoMap.forEach((info, light) => {
            if (!info.used) {
                this.infoMap.delete(light);
            } else {
                info.used = false;
            }
        });

        if (!(this.core.currentCamera[this.viewId] instanceof three.PerspectiveCamera)) {
            throw new Error("Non-perspective camera is not supported by DirectionalLightShadowRenderer.");
        }

        this.viewVec = computeViewVectorCoefFromProjectionMatrix(this.core.currentCamera[this.viewId].projectionMatrix);
    }

    prepare(light: PotentiallyHyperDirectionalLight): void
    {
        let info = this.infoMap.get(light);
        if (info == null) {
            info = {
                used: true,
                splits: [],
                dir: new three.Vector3()
            };
            this.infoMap.set(light, info);
        }

        // compute normalized dircetion
        info.dir.copy(light.position);
        info.dir.normalize();

        // cascades
        const numCascades = light.shadowCascadeCount || 2;
        const splits = info.splits;
        while (splits.length < numCascades + 1) {
            splits.push(0);
        }

        const eye = <three.PerspectiveCamera> this.core.currentCamera[this.viewId];
        const near = splits[0] = eye.near;
        const far = splits[splits.length - 1] = eye.far;
        const diff = (far - near) / numCascades;
        const logNear = Math.log(near);
        const logFar = Math.log(far);
        const logDiff = (logFar - logNear) / numCascades;
        for (let i = 1; i < splits.length - 1; ++i) {
            // uniform split scheme
            const unifSplit = near + diff * i;

            // logarithm split scheme
            const logSplit = Math.exp(logNear + logDiff * i);

            // mix
            splits[i] = (unifSplit + logSplit) * 0.5;
        }

        let cameras: three.Camera[] = <any> light.shadowCamera;
        if (cameras == null || !(cameras instanceof Array)) {
            light.shadowCamera = <any> (cameras = []);
        }

        // create cameras
        while (cameras.length < numCascades) {
            // don't care about parameters; we'll create proj matrix by our own
            cameras.push(new three.OrthographicCamera(0, 0, 0, 0));
        }
        cameras.length = numCascades; // discard unneeded cameras

        // frustum corners
        const corners: three.Vector3[] = [];
        const invViewMat = eye.matrixWorld;
        for (let i = 0; i < 8; ++i) {
            const fc = Vector3Pool.alloc();
            corners.push(fc);
        }

        // use normal shadow maps if view vector and light is parallel
        const front = Vector3Pool.alloc();
        front.set(0, 0, -1);
        front.applyMatrix4(invViewMat);
        const useNormalSM = Math.abs(info.dir.dot(front));
        Vector3Pool.free(front);

        // setup cameras
        for (let i = 0; i < numCascades; ++i) {
            const camera = cameras[i];
            const splitNear = splits[i], splitFar = splits[i + 1];

            for (let i = 0; i < 8; ++i) {
                const fc = corners[i];
                fc.set(this.viewVec.offset.x, this.viewVec.offset.y, -1);
                if (i & 1) {
                    fc.x += this.viewVec.coefX.x;
                    fc.y += this.viewVec.coefX.y;
                } else {
                    fc.x -= this.viewVec.coefX.x;
                    fc.y -= this.viewVec.coefX.y;
                }
                if (i & 2) {
                    fc.x += this.viewVec.coefY.x;
                    fc.y += this.viewVec.coefY.y;
                } else {
                    fc.x -= this.viewVec.coefY.x;
                    fc.y -= this.viewVec.coefY.y;
                }

                fc.multiplyScalar((i & 4) ? splitFar : splitNear);
                fc.applyMatrix4(invViewMat);
            }

            if (useNormalSM || true) {
                this.setupShadowMapCamera(camera, info, corners);
            } else {
                this.setupLiSPSMCamera(camera, info, corners, splitNear, splitFar);
            }

            this.shadowMapService.prepareShadowMap(camera, ShadowMapType.Normal);
        }

        for (const v of corners) {
            Vector3Pool.free(v);
        }
    }

    render(light: PotentiallyHyperDirectionalLight): void
    {
        const info = this.infoMap.get(light);
        const cameras: three.Camera[] = <any> light.shadowCamera;
        const gl = this.core.gl;
        const profiler = this.core.profiler;

        profiler.begin("Light Buffer Generation");

        const eye = this.core.currentCamera[this.viewId];
        const eyeProjMat = eye.projectionMatrix;

        const numCascades = light.shadowCascadeCount || 2;

        for (let i = numCascades; i > 0; ) {
            --i;
            const camera = cameras[i];
            this.shadowMapService.renderShadowMap(camera, ShadowMapType.Normal);

            let flags = ProgramFlags.Default;
            if (i < numCascades - 1) {
                flags |= ProgramFlags.ClipByFarPlane;
            }

            // now shadow map is available. render to the light buffer.
            this.fb.bind();
            if (i == 0) {
                this.core.state.flags = GLStateFlags.DepthWriteDisabled;
            } else {
                if (this.inDepth == null) {
                    // hardware depth test is unavailable
                    flags |= ProgramFlags.ClipByNearPlane;
                    this.core.state.flags = GLStateFlags.DepthWriteDisabled;
                } else {
                    this.core.state.flags = GLStateFlags.DepthWriteDisabled | GLStateFlags.DepthTestEnabled;
                }
            }
            gl.viewport(0, 0, this.width, this.height);
            if (i == numCascades - 1) {
                this.core.invalidateFramebuffer(gl.COLOR_ATTACHMENT0);
            }

            gl.activeTexture(gl.TEXTURE0);
            gl.bindTexture(gl.TEXTURE_2D, this.inLinearDepth.texture);
            gl.activeTexture(gl.TEXTURE1);
            gl.bindTexture(gl.TEXTURE_2D, this.shadowMapService.currentShadowMapDepth);

            const p = this.program[flags];
            p.program.use();

            gl.uniform1i(p.uniforms["u_linearDepth"], 0);
            gl.uniform1i(p.uniforms["u_shadowMap"], 1);
            gl.uniform2f(p.uniforms["u_viewDirOffset"],
                this.viewVec.offset.x, this.viewVec.offset.y);
            gl.uniform2f(p.uniforms["u_viewDirCoefX"],
                this.viewVec.coefX.x, this.viewVec.coefX.y);
            gl.uniform2f(p.uniforms["u_viewDirCoefY"],
                this.viewVec.coefY.x, this.viewVec.coefY.y);

            const m1 = Matrix4Pool.alloc();
            const m2 = Matrix4Pool.alloc();
            const m3 = Matrix4Pool.alloc();

            m2.multiplyMatrices(camera.projectionMatrix,
                camera.matrixWorldInverse);
            m1.multiplyMatrices(m2, eye.matrixWorld);
            m2.makeScale(.5, .5, .5).multiply(m1);
            m3.makeTranslation(.5, .5, .5).multiply(m2);
            gl.uniformMatrix4fv(p.uniforms["u_shadowMapMatrix"], false, m3.elements);

            const v = Vector4Pool.alloc();
            v.set(light.position.x, light.position.y, light.position.z, 0); v.normalize();
            v.applyMatrix4(m3);
            gl.uniform1f(p.uniforms["u_shadowMapZScale"], 1 / v.length());
            Vector4Pool.free(v);

            Matrix4Pool.free(m1);
            Matrix4Pool.free(m2);
            Matrix4Pool.free(m3);

            const far = -info.splits[i];
            const farPostZ = (far * eyeProjMat.elements[10] + eyeProjMat.elements[14]) /
                (far * eyeProjMat.elements[11] + eyeProjMat.elements[15]);
            gl.uniform1f(p.uniforms["u_depthValue"], farPostZ);

            gl.uniform1f(p.uniforms["u_farPlane"], info.splits[i + 1]);
            gl.uniform1f(p.uniforms["u_nearPlane"], info.splits[i]);

            this.core.quadRenderer.render(p.attributes["a_position"]);
        }

        profiler.end();
    }

    private computeMinZByShadowCasterBounds(dir: three.Vector3): number
    {
        const bounds = this.core.shadowCasterBounds;
        let z: number;
        z = (dir.x > 0 ? bounds.max.x : bounds.min.x) * dir.x;
        z += (dir.y > 0 ? bounds.max.y : bounds.min.y) * dir.y;
        z += (dir.z > 0 ? bounds.max.z : bounds.min.z) * dir.z;
        return z;
    }

    private setupShadowMapCamera(camera: three.Camera, info: LightInfo, frustumCorners: three.Vector3[]): void
    {
        const tmp1 = Vector3Pool.alloc();
        const tmp2 = Vector3Pool.alloc();
        const tmp3 = Vector3Pool.alloc();

        const eye = this.core.currentCamera[this.viewId];

        // decide axis
        const texU = tmp1;
        const texV = tmp2;
        const dir = info.dir;

        texU.set(0, 1, 0); // up vector
        texU.applyMatrix4(eye.matrixWorld);
        texU.cross(dir);
        texU.normalize();

        texV.crossVectors(texU, dir);

        // compute limits
        let minX = Infinity, maxX = -Infinity;
        let minY = Infinity, maxY = -Infinity;
        let minZ = Infinity, maxZ = -Infinity;
        for (const p of frustumCorners) {
            const px = p.dot(texU);
            const py = p.dot(texV);
            const pz = p.dot(dir);
            minX = Math.min(minX, px); maxX = Math.max(maxX, px);
            minY = Math.min(minY, py); maxY = Math.max(maxY, py);
            minZ = Math.min(minZ, pz); maxZ = Math.max(maxZ, pz);
        }

        // extend the near plane
        maxZ = Math.max(maxZ, this.computeMinZByShadowCasterBounds(dir));

        // build matrix
        const midX = (minX + maxX) * 0.5;
        const midY = (minY + maxY) * 0.5;
        const midZ = (minZ + maxZ) * 0.5;
        const texW = tmp3.copy(dir);

        const camMat = camera.matrixWorldInverse;
        camMat.set(texU.x, texU.y, texU.z, -midX,
                    texV.x, texV.y, texV.z, -midY,
                    texW.x, texW.y, texW.z, -midZ,
                    0, 0, 0, 1);
        camera.matrixWorld.getInverse(camMat);
        camera.projectionMatrix.set(
            -2 / (maxX - minX), 0, 0, 0,
            0, 2 / (maxY - minY), 0, 0,
            0, 0, -2 / (maxZ - minZ), 0,
            0, 0, 0, 1);

        Vector3Pool.free(tmp1);
        Vector3Pool.free(tmp2);
        Vector3Pool.free(tmp3);
    }

    private setupLiSPSMCamera(camera: three.Camera, info: LightInfo, frustumCorners: three.Vector3[],
        near: number, far: number): void
    {

    }
}

interface LightInfo
{
    used: boolean;
    splits: number[];
    dir: three.Vector3;
}
