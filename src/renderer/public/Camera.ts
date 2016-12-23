/// <reference path="../Prefix.d.ts" />

import * as three from "three";

export class StereoCamera extends three.Camera
{
    leftCamera = new three.PerspectiveCamera();
    rightCamera = new three.PerspectiveCamera();
    far = 20000;
    near = 0.1;
    fov = 50;
    aspect = 1;

    constructor(fov?: number, aspect?: number, near?: number, far?: number)
    {
        super();
        this.add(this.leftCamera);
        this.add(this.rightCamera);
        this.distance = 0.06;
        this.fov = fov;
        this.aspect = aspect;
        this.near = near;
        this.far = far;
    }

    get distance(): number
    {
        return this.rightCamera.position.x;
    }
    set distance(value: number)
    {
        this.leftCamera.position.x = -value;
        this.rightCamera.position.x = value;
    }

    updateProjectionMatrix(): void
    {
        this.leftCamera.near = this.near;
        this.leftCamera.far = this.far;
        this.leftCamera.fov = this.fov;
        this.leftCamera.aspect = this.aspect;
        this.rightCamera.near = this.near;
        this.rightCamera.far = this.far;
        this.rightCamera.fov = this.fov;
        this.rightCamera.aspect = this.aspect;
        this.leftCamera.updateProjectionMatrix();
        this.rightCamera.updateProjectionMatrix();
    }
}

