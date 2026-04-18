"use strict";
/**
 * camera.js — Orbit camera for WebGPU 3D rendering.
 * Produces view + projection matrices as Float32Array (column-major, WebGPU convention).
 *
 * Coordinate system:
 *   World X = right   (maps from drone.x - canvasW/2)
 *   World Y = up      (maps from drone.z — altitude)
 *   World Z = depth   (maps from drone.y - canvasH/2)
 */
export class OrbitCamera {
  constructor(target = [0, 100, 0]) {
    this.theta = Math.PI / 4;       // azimuth (around world-Y axis)
    this.phi   = Math.PI / 3;       // elevation from Y-axis
    this.radius = 900;
    this.target = [...target];
    this.fov  = 60 * Math.PI / 180; // vertical FOV in radians
    this.near = 1;
    this.far  = 12000;

    this._targetRadius = 900;
    this._lastPinchDist = null;
  }

  /** Call once per frame to smooth the radius lerp. */
  update() {
    const diff = this._targetRadius - this.radius;
    if (Math.abs(diff) > 0.5) this.radius += diff * 0.04;
  }

  /** Smoothly animate to a new radius (e.g. on launch). */
  animateToRadius(r) { this._targetRadius = r; }

  /** World-space eye position. */
  getEye() {
    const sinPhi = Math.sin(this.phi), cosPhi = Math.cos(this.phi);
    const sinThe = Math.sin(this.theta), cosThe = Math.cos(this.theta);
    return [
      this.target[0] + this.radius * sinPhi * cosThe,
      this.target[1] + this.radius * cosPhi,
      this.target[2] + this.radius * sinPhi * sinThe,
    ];
  }

  /** View matrix (lookAt). Returns Float32Array[16], column-major. */
  getViewMatrix() { return lookAt(this.getEye(), this.target, [0, 1, 0]); }

  /** Perspective projection. Returns Float32Array[16], column-major. */
  getProjMatrix(width, height) { return perspective(this.fov, width / height, this.near, this.far); }

  /**
   * Camera UBO data: [view(16), proj(16), eye(3), time(1)] = 36 floats = 144 bytes.
   * time is used for pulsing animations in the fragment shader.
   */
  getUBOData(width, height, time) {
    const buf = new Float32Array(36);
    buf.set(this.getViewMatrix(), 0);
    buf.set(this.getProjMatrix(width, height), 16);
    const eye = this.getEye();
    buf[32] = eye[0]; buf[33] = eye[1]; buf[34] = eye[2]; buf[35] = time;
    return buf;
  }

  // ── Input handlers ──────────────────────────────────────────────────────

  onMouseDrag(dx, dy) {
    this.theta -= dx * 0.005;
    this.phi = Math.max(0.05, Math.min(Math.PI - 0.05, this.phi - dy * 0.005));
  }

  onWheel(delta) {
    this._targetRadius = Math.max(150, Math.min(3500, this._targetRadius + delta * 0.6));
  }

  onTouchStart(touches) {
    if (touches.length === 2) {
      this._lastPinchDist = Math.hypot(
        touches[0].clientX - touches[1].clientX,
        touches[0].clientY - touches[1].clientY,
      );
    }
  }

  onTouchMove(touches, prevTouches) {
    if (touches.length === 1 && prevTouches?.length === 1) {
      this.onMouseDrag(
        touches[0].clientX - prevTouches[0].clientX,
        touches[0].clientY - prevTouches[0].clientY,
      );
    } else if (touches.length === 2) {
      const dist = Math.hypot(
        touches[0].clientX - touches[1].clientX,
        touches[0].clientY - touches[1].clientY,
      );
      if (this._lastPinchDist != null && dist > 0) {
        this._targetRadius = Math.max(150, Math.min(3500, this._targetRadius * (this._lastPinchDist / dist)));
      }
      this._lastPinchDist = dist;
    }
  }
}

// ── Pure-JS mat4 helpers (column-major, right-handed) ──────────────────────

function lookAt(eye, center, up) {
  const f = norm3(sub3(center, eye));
  const r = norm3(cross3(f, up));
  const u = cross3(r, f);
  const m = new Float32Array(16);
  m[0]=r[0];   m[4]=r[1];   m[8]=r[2];    m[12]=-dot3(r, eye);
  m[1]=u[0];   m[5]=u[1];   m[9]=u[2];    m[13]=-dot3(u, eye);
  m[2]=-f[0];  m[6]=-f[1];  m[10]=-f[2];  m[14]= dot3(f, eye);
  m[3]=0;      m[7]=0;      m[11]=0;      m[15]=1;
  return m;
}

function perspective(fovy, aspect, near, far) {
  const f = 1 / Math.tan(fovy / 2);
  const nf = 1 / (near - far);
  const m = new Float32Array(16);
  m[0] = f / aspect;
  m[5] = f;
  m[10] = (far + near) * nf;
  m[11] = -1;
  m[14] = 2 * far * near * nf;
  return m;
}

function sub3(a, b)  { return [a[0]-b[0], a[1]-b[1], a[2]-b[2]]; }
function dot3(a, b)  { return a[0]*b[0] + a[1]*b[1] + a[2]*b[2]; }
function cross3(a,b) { return [a[1]*b[2]-a[2]*b[1], a[2]*b[0]-a[0]*b[2], a[0]*b[1]-a[1]*b[0]]; }
function norm3(v)    { const m = Math.hypot(v[0],v[1],v[2]) || 1; return [v[0]/m,v[1]/m,v[2]/m]; }
