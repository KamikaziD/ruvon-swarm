"use strict";
/**
 * renderer_webgpu.js — WebGPU 3D instanced renderer for browser_demo_5.
 *
 * Renders up to N procedural quadcopters in a single instanced draw call.
 * Each frame:
 *   1. Reads drone state from a SharedArrayBuffer (SAB)
 *   2. Writes per-instance buffer via queue.writeBuffer()
 *   3. Executes 4 render passes: opaque → rotors → LED glow → trails
 *   4. 2D overlay rendered by caller on a separate HTML canvas
 *
 * SAB layout per drone (16 × f32 = 64 bytes):
 *   [0]x [1]y [2]z [3]vx [4]vy [5]vz
 *   [6]targetX [7]targetY [8]targetZ
 *   [9]pitch [10]roll [11]rotorPhase
 *   [12]battery [13]motorThrust [14]status_f32 [15]tier_f32
 *
 * Usage:
 *   const rh = await initRenderer(device, canvas, 64);
 *   // per frame:
 *   rh.update(sab, camera, t);
 *   // on resize:
 *   rh.resize(w, h);
 *   // click-to-pick:
 *   const idx = rh.pickDrone(ndcX, ndcY, sab, droneCount);
 */

// ── SAB field constants ───────────────────────────────────────────────────────
const F = 16; // floats per drone
const IX = {
  X:0, Y:1, Z:2, VX:3, VY:4, VZ:5,
  TX:6, TY:7, TZ:8, PITCH:9, ROLL:10,
  ROTOR:11, BATT:12, THRUST:13, STATUS:14, TIER:15,
};

// ── Drone geometry builder ────────────────────────────────────────────────────

/**
 * Build procedural quadcopter mesh.
 * Returns { vertices: Float32Array, indices: Uint16Array }
 *
 * Vertex layout (stride=8 floats):
 *   [0-2] local position xyz
 *   [3-5] normal xyz
 *   [6]   part_id  (0=body, 1=arm, 2=rotor)
 *   [7]   arm_index (0-3, only relevant when part_id>=1)
 */
function buildDroneMesh() {
  const verts = [];
  const idx   = [];
  let vi = 0; // current vertex index

  function pushTri(a, b, c) { idx.push(vi+a, vi+b, vi+c); }
  function pushVert(x, y, z, nx, ny, nz, part, arm) {
    verts.push(x, y, z, nx, ny, nz, part, arm);
  }
  function norm(a, b, c) {
    const d = Math.sqrt(a*a+b*b+c*c)||1;
    return [a/d, b/d, c/d];
  }

  // ── Body: octahedron, radius 5 (part_id=0) ────────────────────────────────
  const R = 5;
  const octVerts = [
    [0, R, 0], [R, 0, 0], [0, 0, R], [-R, 0, 0], [0, 0, -R], [0, -R, 0],
  ];
  const octFaces = [
    [0,1,2],[0,2,3],[0,3,4],[0,4,1],
    [5,2,1],[5,3,2],[5,4,3],[5,1,4],
  ];
  for (const [a,b,c] of octFaces) {
    const [ax,ay,az] = octVerts[a], [bx,by,bz] = octVerts[b], [cx,cy,cz] = octVerts[c];
    const cx_ = (ax+bx+cx)/3, cy_ = (ay+by+cy)/3, cz_ = (az+bz+cz)/3;
    const [nx,ny,nz] = norm(cx_,cy_,cz_);
    pushVert(ax,ay,az,nx,ny,nz,0,0);
    pushVert(bx,by,bz,nx,ny,nz,0,0);
    pushVert(cx,cy,cz,nx,ny,nz,0,0);
    pushTri(0,1,2);
    vi += 3;
  }

  // ── Arms: 4 thin boxes at 45°, 135°, 225°, 315° (part_id=1) ──────────────
  const ARM_L=10, ARM_W=1.5, ARM_H=1.2;
  for (let arm = 0; arm < 4; arm++) {
    const angle = arm * Math.PI / 2 + Math.PI / 4; // 45° offset
    const cos = Math.cos(angle), sin_ = Math.sin(angle);
    // Local arm box: along X axis, then rotated
    const bl = ARM_L, bw = ARM_W, bh = ARM_H;
    const corners = [
      [-bl*cos - bw*sin_, -bh, -bl*sin_ + bw*cos],
      [ bl*cos - bw*sin_,  bh,  bl*sin_ + bw*cos],
      [ bl*cos + bw*sin_,  bh,  bl*sin_ - bw*cos],
      [-bl*cos + bw*sin_, -bh, -bl*sin_ - bw*cos],
      // mirror top
      [-bl*cos - bw*sin_,  bh, -bl*sin_ + bw*cos],
      [ bl*cos - bw*sin_, -bh,  bl*sin_ + bw*cos],
      [ bl*cos + bw*sin_, -bh,  bl*sin_ - bw*cos],
      [-bl*cos + bw*sin_,  bh, -bl*sin_ - bw*cos],
    ];
    // Two faces (top and bottom — simplified to 2 triangles each side)
    const faces = [[0,1,2],[0,2,3],[4,5,6],[4,6,7]];
    for (const [a,b,c] of faces) {
      const [ax,ay,az] = corners[a], [bx,by,bz] = corners[b], [cx,cy,cz] = corners[c];
      const [nx,ny,nz] = norm(0, ay>0?1:-1, 0);
      pushVert(ax,ay,az,nx,ny,nz,1,arm);
      pushVert(bx,by,bz,nx,ny,nz,1,arm);
      pushVert(cx,cy,cz,nx,ny,nz,1,arm);
      pushTri(0,1,2);
      vi += 3;
    }
  }

  // ── Rotors: 4 flat discs at each arm tip (part_id=2) ─────────────────────
  const DISC_R = 8, DISC_SEG = 12;
  for (let arm = 0; arm < 4; arm++) {
    const angle = arm * Math.PI / 2 + Math.PI / 4;
    const cx = Math.cos(angle) * ARM_L, cz = Math.sin(angle) * ARM_L;
    const disc_y = ARM_H + 1;

    for (let s = 0; s < DISC_SEG; s++) {
      const a0 = (s / DISC_SEG) * Math.PI * 2;
      const a1 = ((s+1) / DISC_SEG) * Math.PI * 2;
      pushVert(cx, disc_y, cz,             0,1,0, 2, arm);
      pushVert(cx + Math.cos(a0)*DISC_R, disc_y, cz + Math.sin(a0)*DISC_R, 0,1,0, 2, arm);
      pushVert(cx + Math.cos(a1)*DISC_R, disc_y, cz + Math.sin(a1)*DISC_R, 0,1,0, 2, arm);
      pushTri(0,1,2);
      vi += 3;
    }
  }

  return {
    vertices: new Float32Array(verts),
    indices:  new Uint16Array(idx),
    numVerts: verts.length / 8,
    numIdx:   idx.length,
  };
}

// ── WGSL Shaders ─────────────────────────────────────────────────────────────

const DRONE_SHADER = /* wgsl */`
struct Camera {
  view : mat4x4<f32>,
  proj : mat4x4<f32>,
  eye  : vec3<f32>,
  time : f32,
}

struct DroneInstance {
  pos         : vec3<f32>,   // [0-2]
  _pad0       : f32,
  quat        : vec4<f32>,   // [3-6]  pitch/roll quaternion
  rotor_phase : f32,         // [7]
  battery     : f32,         // [8]
  status      : u32,         // [9]  0=active 1=low_bat 2=offline 3=landed
  tier        : u32,         // [10] 1,2,3
  _pad1       : u32,
}

struct VertexIn {
  @location(0) local_pos  : vec3<f32>,
  @location(1) normal     : vec3<f32>,
  @location(2) part_id    : f32,
  @location(3) arm_index  : f32,
}

struct VertexOut {
  @builtin(position) clip_pos : vec4<f32>,
  @location(0) world_pos      : vec3<f32>,
  @location(1) base_color     : vec3<f32>,
  @location(2) battery        : f32,
  @location(3) status_f       : f32,
  @location(4) normal_w       : vec3<f32>,
}

@group(0) @binding(0) var<uniform> camera   : Camera;
@group(0) @binding(1) var<storage, read> instances : array<DroneInstance>;

const PI = 3.14159265;
const HALF_PI = 1.5707963;

fn quat_rotate(q: vec4<f32>, v: vec3<f32>) -> vec3<f32> {
  let u = q.xyz;
  let s = q.w;
  return 2.0 * dot(u, v) * u
       + (s*s - dot(u,u)) * v
       + 2.0 * s * cross(u, v);
}

fn rot_y(angle: f32, v: vec3<f32>) -> vec3<f32> {
  let c = cos(angle); let s = sin(angle);
  return vec3<f32>(c*v.x + s*v.z, v.y, -s*v.x + c*v.z);
}

fn tier_color(tier: u32) -> vec3<f32> {
  if (tier == 1u) { return vec3<f32>(0.94, 0.60, 0.60); }  // red
  if (tier == 2u) { return vec3<f32>(0.64, 0.84, 0.65); }  // green
  return vec3<f32>(0.31, 0.76, 0.97);                       // blue (tier 3)
}

@vertex
fn vs_main(@builtin(instance_index) inst_idx: u32, vin: VertexIn) -> VertexOut {
  let inst = instances[inst_idx];
  var lp = vin.local_pos;

  // Landed: collapse rotors to ground
  if (inst.status == 3u && vin.part_id > 0.5) {
    lp.y = 0.0;
  }

  // Rotor spin: apply rotation around Y for part_id == 2
  if (vin.part_id > 1.5) {
    let spin = inst.rotor_phase + vin.arm_index * HALF_PI;
    // Spin around disc center (arm tip) — simplify by rotating around world Y
    let arm_offset = lp - vec3<f32>(lp.x, lp.y, lp.z); // already arm-local in geometry
    lp = rot_y(spin * 0.5, lp); // half-speed for visual appeal
  }

  // Apply instance orientation quaternion (pitch + roll)
  let rotated = quat_rotate(inst.quat, lp);
  // World position
  let world_pos = rotated + inst.pos;

  // Camera transform
  let view_pos = camera.view * vec4<f32>(world_pos, 1.0);
  let clip_pos = camera.proj * view_pos;

  var out: VertexOut;
  out.clip_pos   = clip_pos;
  out.world_pos  = world_pos;
  out.base_color = tier_color(inst.tier);
  out.battery    = inst.battery;
  out.status_f   = f32(inst.status);
  out.normal_w   = quat_rotate(inst.quat, vin.normal);
  return out;
}

@fragment
fn fs_main(in: VertexOut) -> @location(0) vec4<f32> {
  let dist     = length(in.world_pos - camera.eye);
  let fog      = 1.0 - clamp((dist - 400.0) / 800.0, 0.0, 1.0);
  let pulse    = 0.6 + 0.4 * sin(camera.time * 8.0);
  let low_bat  = in.battery < 0.15;
  let led_dim  = select(1.0, pulse, low_bat);
  let dead     = select(1.0, 0.3, in.status_f == 2.0);

  // Simple diffuse with ambient
  let light_dir = normalize(vec3<f32>(0.4, 1.0, 0.6));
  let diff      = max(dot(normalize(in.normal_w), light_dir), 0.0);
  let ambient   = 0.35;
  let lighting  = ambient + (1.0 - ambient) * diff;

  let color = in.base_color * lighting * led_dim * dead * fog;
  return vec4<f32>(color, 1.0);
}
`;

const ROTOR_SHADER = /* wgsl */`
// Additive rotor disc pass — same bindings, additive blend
struct Camera { view:mat4x4<f32>, proj:mat4x4<f32>, eye:vec3<f32>, time:f32 }
struct DroneInstance { pos:vec3<f32>, _p0:f32, quat:vec4<f32>, rotor_phase:f32, battery:f32, status:u32, tier:u32, _p1:u32 }
struct VertexIn { @location(0) local_pos:vec3<f32>, @location(1) normal:vec3<f32>, @location(2) part_id:f32, @location(3) arm_index:f32 }
struct VertexOut { @builtin(position) cp:vec4<f32>, @location(0) alpha:f32, @location(1) color:vec3<f32> }

@group(0) @binding(0) var<uniform> camera:Camera;
@group(0) @binding(1) var<storage,read> instances:array<DroneInstance>;

fn quat_r(q:vec4<f32>,v:vec3<f32>)->vec3<f32>{let u=q.xyz;let s=q.w;return 2.0*dot(u,v)*u+(s*s-dot(u,u))*v+2.0*s*cross(u,v);}
fn tier_c(t:u32)->vec3<f32>{if(t==1u){return vec3(0.94,0.60,0.60);}if(t==2u){return vec3(0.64,0.84,0.65);}return vec3(0.31,0.76,0.97);}

@vertex fn vs(@builtin(instance_index) ii:u32, vin:VertexIn)->VertexOut {
  let inst = instances[ii];
  if (vin.part_id < 1.5) { // skip non-rotor vertices by sending behind clip
    var out:VertexOut; out.cp=vec4(0.0,0.0,-2.0,1.0); out.alpha=0.0; out.color=vec3(0.0); return out;
  }
  let spin = inst.rotor_phase + vin.arm_index * 1.5707963;
  var lp = vin.local_pos;
  let cx = cos(spin); let sx = sin(spin);
  lp = vec3(cx*lp.x - sx*lp.z, lp.y, sx*lp.x + cx*lp.z);
  let wp = quat_r(inst.quat, lp) + inst.pos;
  var out:VertexOut;
  out.cp = camera.proj * camera.view * vec4(wp, 1.0);
  out.alpha = select(0.0, 0.18, inst.status != 2u && inst.status != 3u);
  out.color = tier_c(inst.tier);
  return out;
}
@fragment fn fs(in:VertexOut)->@location(0) vec4<f32> { return vec4(in.color * 0.8, in.alpha); }
`;

// ── Ghost SAF Dot shader ──────────────────────────────────────────────────────
// Renders remote squads as camera-facing billboard quads with additive glow.
// One draw call per frame, no physics, no geometry — just position + color.
const GHOST_SHADER = /* wgsl */`
struct Camera {
  view : mat4x4<f32>,
  proj : mat4x4<f32>,
  eye  : vec3<f32>,
  time : f32,
}

struct GhostInst {
  pos   : vec3<f32>,
  alpha : f32,
  color : vec3<f32>,
  _pad  : f32,
}

@group(0) @binding(0) var<uniform> camera : Camera;
@group(0) @binding(1) var<storage, read> ghosts : array<GhostInst>;

struct VOut {
  @builtin(position) cp : vec4<f32>,
  @location(0) uv       : vec2<f32>,
  @location(1) color    : vec3<f32>,
  @location(2) alpha    : f32,
}

// 6 vertices = 2 triangles = one billboard quad
const QUAD_UV = array<vec2<f32>, 6>(
  vec2(-1.0, -1.0), vec2(1.0, -1.0), vec2(1.0,  1.0),
  vec2(-1.0, -1.0), vec2(1.0,  1.0), vec2(-1.0,  1.0),
);

const DOT_RADIUS : f32 = 7.0; // world units — ~half a drone body

@vertex fn vs_ghost(
  @builtin(vertex_index)   vi : u32,
  @builtin(instance_index) ii : u32,
) -> VOut {
  let g  = ghosts[ii];
  let uv = QUAD_UV[vi];

  // Extract camera right/up from the view matrix (inverse rotation rows).
  // WGSL mat4 is column-major: view[col][row]
  let right = vec3<f32>(camera.view[0][0], camera.view[1][0], camera.view[2][0]);
  let up    = vec3<f32>(camera.view[0][1], camera.view[1][1], camera.view[2][1]);

  // Billboard: expand quad in camera-right/up directions
  let world_pos = g.pos
    + right * (uv.x * DOT_RADIUS)
    + up    * (uv.y * DOT_RADIUS);

  var out : VOut;
  out.cp    = camera.proj * camera.view * vec4<f32>(world_pos, 1.0);
  out.uv    = uv;
  out.color = g.color;
  out.alpha = g.alpha;
  return out;
}

@fragment fn fs_ghost(in : VOut) -> @location(0) vec4<f32> {
  let d = length(in.uv);
  if (d > 1.0) { discard; }
  // Soft gaussian glow — bright core, fade to edge
  let glow = exp(-d * d * 2.5);
  let pulse = 0.75 + 0.25 * sin(in.alpha); // alpha encodes shimmer phase (0..2π per squad)
  return vec4<f32>(in.color * glow * pulse, glow * 0.85);
}
`;

// Squad slot → RGB color (sovereign=slot0 is local, so ghosts start at slot1)
const GHOST_COLORS = [
  [0.0,  1.0,  0.533], // #00FF88 sovereign green  (slot 0 — fallback)
  [0.0,  0.667, 1.0],  // #00AAFF blue              (slot 1)
  [0.0,  1.0,  0.867], // #00FFDD teal              (slot 2)
  [1.0,  0.8,  0.0],   // #FFCC00 gold              (slot 3)
  [0.8,  0.0,  1.0],   // #CC00FF purple            (slot 4)
  [1.0,  0.4,  0.0],   // #FF6600 orange            (slot 5)
  [0.0,  0.8,  0.4],   // #00CC66 mint              (slot 6)
  [1.0,  0.2,  0.6],   // #FF3399 pink              (slot 7)
];

// ── Instance buffer pack ──────────────────────────────────────────────────────

/**
 * Pack SAB drone data into a compact instance buffer for the GPU.
 * Instance layout (12 floats + 2 u32 = ~56 bytes, padded to 64):
 *   [0-2] pos xyz
 *   [3]   pad
 *   [4-7] quat xyzw
 *   [8]   rotor_phase
 *   [9]   battery (0-1)
 *   [10]  status (as u32 via f32 bit reinterpret — use u32 view)
 *   [11]  tier
 *   [12-15] pad
 */
function packInstances(sab, droneCount, instF32, instU32) {
  const src = new Float32Array(sab);
  const { cos, sin } = Math;

  for (let i = 0; i < droneCount; i++) {
    const s = i * F;   // SAB offset
    const d = i * 16;  // instance buffer offset (16 floats/drone for alignment)

    // Position
    instF32[d + 0] = src[s + IX.X];
    instF32[d + 1] = src[s + IX.Z]; // Z in world = altitude → Y in canvas space
    instF32[d + 2] = src[s + IX.Y];
    instF32[d + 3] = 0; // pad

    // Quaternion from pitch + roll
    const pitch = src[s + IX.PITCH];
    const roll  = src[s + IX.ROLL];
    const cp = cos(pitch/2), sp = sin(pitch/2);
    const cr = cos(roll/2),  sr = sin(roll/2);
    instF32[d + 4] = sp * cr;  // qx
    instF32[d + 5] = sp * sr;  // qy
    instF32[d + 6] = cp * sr;  // qz
    instF32[d + 7] = cp * cr;  // qw

    instF32[d + 8]  = src[s + IX.ROTOR];          // rotor_phase
    instF32[d + 9]  = src[s + IX.BATT] / 100;     // battery 0-1
    instU32[d + 10] = Math.round(src[s + IX.STATUS]);  // status u32
    instU32[d + 11] = Math.round(src[s + IX.TIER]);    // tier u32
    // pads
    instF32[d + 12] = instF32[d + 13] = instF32[d + 14] = instF32[d + 15] = 0;
  }
}

// ── Remote squad packer ───────────────────────────────────────────────────────
// Packs compact drone objects (from mesh SWARM_STATE) into the GPU instance buffer.
// drones:   [{x,y,z,vx,vy,vz,status,tier,battery,rotorPhase}]
// startIdx: first drone slot in the instance buffer
function packRemoteSquad(drones, instF32, instU32, startIdx) {
  for (let i = 0; i < drones.length; i++) {
    const d = drones[i];
    const di = (startIdx + i) * 16;
    instF32[di+0] = d.x ?? 0;
    instF32[di+1] = d.z ?? 0;   // SAB Z = altitude → GPU Y
    instF32[di+2] = d.y ?? 0;   // SAB Y = ground Y → GPU Z
    instF32[di+3] = 0;           // pad
    // Identity quaternion (no pitch/roll from remote — position only)
    instF32[di+4] = 0; instF32[di+5] = 0; instF32[di+6] = 0; instF32[di+7] = 1;
    instF32[di+8]  = (d.rotorPhase ?? 0);   // rotor phase
    instF32[di+9]  = Math.min((d.battery ?? 80) / 100, 1);
    instU32[di+10] = Math.round(d.status ?? 0);
    instU32[di+11] = Math.round(d.tier ?? 2);
    instF32[di+12] = instF32[di+13] = instF32[di+14] = instF32[di+15] = 0;
  }
}

// ── Main export ───────────────────────────────────────────────────────────────

/**
 * Initialize the WebGPU renderer.
 * @param {GPUDevice}    device
 * @param {HTMLCanvasElement} canvas  — the #webgpu-canvas element
 * @param {number}       maxDrones
 * @returns {RendererHandle}
 */
export async function initRenderer(device, canvas, maxDrones = 64) {
  const ctx = canvas.getContext("webgpu");
  const fmt = navigator.gpu.getPreferredCanvasFormat();
  ctx.configure({ device, format: fmt, alphaMode: "premultiplied" });

  // ── Geometry buffers ──────────────────────────────────────────────────────
  const mesh = buildDroneMesh();

  const vtxBuf = device.createBuffer({
    size:  mesh.vertices.byteLength,
    usage: GPUBufferUsage.VERTEX | GPUBufferUsage.COPY_DST,
  });
  device.queue.writeBuffer(vtxBuf, 0, mesh.vertices);

  const idxBuf = device.createBuffer({
    size:  mesh.indices.byteLength,
    usage: GPUBufferUsage.INDEX | GPUBufferUsage.COPY_DST,
  });
  device.queue.writeBuffer(idxBuf, 0, mesh.indices);

  // ── Instance buffer (16 floats × maxDrones, updated every frame) ─────────
  const instStride = 16 * 4; // 16 floats × 4 bytes
  const instBuf = device.createBuffer({
    size:  instStride * maxDrones,
    usage: GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_DST,
  });
  const instCPU   = new ArrayBuffer(instStride * maxDrones);
  const instF32   = new Float32Array(instCPU);
  const instU32   = new Uint32Array(instCPU);

  // ── Camera UBO (144 bytes) ────────────────────────────────────────────────
  const camBuf = device.createBuffer({
    size:  144,
    usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST,
  });

  // ── Depth texture ─────────────────────────────────────────────────────────
  let depthTex = null;
  function makeDepth(w, h) {
    if (w <= 0 || h <= 0) return;   // guard: WebGPU requires size > 0 in every dimension
    depthTex?.destroy();
    depthTex = device.createTexture({
      size: [w, h], format: "depth24plus",
      usage: GPUTextureUsage.RENDER_ATTACHMENT,
    });
  }
  makeDepth(canvas.width, canvas.height);

  // ── Bind group layout ─────────────────────────────────────────────────────
  const bgl = device.createBindGroupLayout({
    entries: [
      { binding: 0, visibility: GPUShaderStage.VERTEX | GPUShaderStage.FRAGMENT,
        buffer: { type: "uniform" } },
      { binding: 1, visibility: GPUShaderStage.VERTEX,
        buffer: { type: "read-only-storage" } },
    ],
  });
  const bindGroup = device.createBindGroup({
    layout: bgl,
    entries: [
      { binding: 0, resource: { buffer: camBuf } },
      { binding: 1, resource: { buffer: instBuf } },
    ],
  });

  const pipelineLayout = device.createPipelineLayout({ bindGroupLayouts: [bgl] });

  // ── Vertex buffer layout ──────────────────────────────────────────────────
  const vtxLayout = {
    arrayStride: 8 * 4,
    attributes: [
      { shaderLocation: 0, offset: 0,  format: "float32x3" }, // local_pos
      { shaderLocation: 1, offset: 12, format: "float32x3" }, // normal
      { shaderLocation: 2, offset: 24, format: "float32"   }, // part_id
      { shaderLocation: 3, offset: 28, format: "float32"   }, // arm_index
    ],
  };

  // ── Opaque pipeline (body + arms) ─────────────────────────────────────────
  const opaquePipeline = device.createRenderPipeline({
    layout: pipelineLayout,
    vertex: {
      module:     device.createShaderModule({ code: DRONE_SHADER }),
      entryPoint: "vs_main",
      buffers:    [vtxLayout],
    },
    fragment: {
      module:     device.createShaderModule({ code: DRONE_SHADER }),
      entryPoint: "fs_main",
      targets:    [{ format: fmt }],
    },
    depthStencil: { format: "depth24plus", depthWriteEnabled: true, depthCompare: "less" },
    primitive:    { topology: "triangle-list", cullMode: "back" },
  });

  // ── Rotor pipeline (additive, no depth write) ─────────────────────────────
  const rotorModule = device.createShaderModule({ code: ROTOR_SHADER });
  const rotorPipeline = device.createRenderPipeline({
    layout: pipelineLayout,
    vertex: { module: rotorModule, entryPoint: "vs", buffers: [vtxLayout] },
    fragment: {
      module:  rotorModule,
      entryPoint: "fs",
      targets: [{
        format: fmt,
        blend: {
          color: { srcFactor: "src-alpha", dstFactor: "one", operation: "add" },
          alpha: { srcFactor: "one",       dstFactor: "one", operation: "add" },
        },
      }],
    },
    depthStencil: { format: "depth24plus", depthWriteEnabled: false, depthCompare: "less-equal" },
    primitive:    { topology: "triangle-list", cullMode: "none" },
  });

  // ── Ghost SAF Dot pipeline ────────────────────────────────────────────────
  // Renders remote squads as additive billboard quads — no geometry, no physics.
  // Each ghost instance: [pos.xyz, alpha, color.rgb, _pad] = 8 floats = 32 bytes
  const MAX_GHOSTS    = 64 * 32;          // up to 32 remote squads × 64 drones
  const GHOST_STRIDE  = 8;               // floats per ghost instance
  const ghostCPU      = new Float32Array(MAX_GHOSTS * GHOST_STRIDE);
  const ghostBuf = device.createBuffer({
    size:  ghostCPU.byteLength,
    usage: GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_DST,
  });

  const ghostBgl = device.createBindGroupLayout({
    entries: [
      { binding: 0, visibility: GPUShaderStage.VERTEX | GPUShaderStage.FRAGMENT,
        buffer: { type: "uniform" } },
      { binding: 1, visibility: GPUShaderStage.VERTEX | GPUShaderStage.FRAGMENT,
        buffer: { type: "read-only-storage" } },
    ],
  });
  const ghostBindGroup = device.createBindGroup({
    layout: ghostBgl,
    entries: [
      { binding: 0, resource: { buffer: camBuf } },
      { binding: 1, resource: { buffer: ghostBuf } },
    ],
  });

  const ghostModule = device.createShaderModule({ code: GHOST_SHADER });
  const ghostPipeline = device.createRenderPipeline({
    layout: device.createPipelineLayout({ bindGroupLayouts: [ghostBgl] }),
    vertex:   { module: ghostModule, entryPoint: "vs_ghost" },
    fragment: {
      module:  ghostModule,
      entryPoint: "fs_ghost",
      targets: [{
        format: fmt,
        blend: {
          color: { srcFactor: "src-alpha", dstFactor: "one", operation: "add" },
          alpha: { srcFactor: "one",       dstFactor: "one", operation: "add" },
        },
      }],
    },
    depthStencil: { format: "depth24plus", depthWriteEnabled: false, depthCompare: "less-equal" },
    primitive:    { topology: "triangle-list", cullMode: "none" },
  });

  let _ghostCount = 0;

  // ── Trail state (ring buffer of last-N positions per drone) ──────────────
  const TRAIL_LEN = 10;
  const trails = Array.from({ length: maxDrones }, () =>
    Array.from({ length: TRAIL_LEN }, () => ({ x: 0, y: 0, z: 0 }))
  );
  const trailHeads = new Uint8Array(maxDrones);

  let _droneCount = maxDrones;

  // ── Drone position cache (for pick) ──────────────────────────────────────
  const droneWorldPos = new Float32Array(maxDrones * 3);

  // ── Render handle ─────────────────────────────────────────────────────────

  return {
    /**
     * Update and render one frame.
     * @param {SharedArrayBuffer} sab
     * @param {OrbitCamera}       camObj
     * @param {number}            t            — performance.now()
     * @param {number}            localCount   — local drones in SAB (slot 0)
     * @param {Map<string,Array>} remoteSquads — podId → [{x,y,z,status,tier,battery,...}]
     */
    update(sab, camObj, t, localCount = maxDrones, remoteSquads = null) {
      if (canvas.width <= 0 || canvas.height <= 0) return;   // skip frame: invalid canvas dimensions
      const src = new Float32Array(sab);

      // Pack local drones (slot 0) from SAB
      packInstances(sab, localCount, instF32, instU32);
      for (let i = 0; i < localCount; i++) {
        const b = i * F;
        droneWorldPos[i*3+0] = src[b + IX.X];
        droneWorldPos[i*3+1] = src[b + IX.Z];
        droneWorldPos[i*3+2] = src[b + IX.Y];
        const head = trailHeads[i];
        trails[i][head] = { x: src[b+IX.X], y: src[b+IX.Z], z: src[b+IX.Y] };
        trailHeads[i] = (head + 1) % TRAIL_LEN;
      }
      _droneCount = localCount; // main passes only render local drones

      // Upload local instance data only
      device.queue.writeBuffer(instBuf, 0, instCPU, 0, localCount * 16 * 4);

      // Pack remote squads as Ghost SAF Dots (additive billboard sprites, not full meshes)
      _ghostCount = 0;
      if (remoteSquads?.size) {
        let squadSlot = 1;
        for (const [, drones] of remoteSquads) {
          const rgb = GHOST_COLORS[squadSlot % GHOST_COLORS.length];
          for (let i = 0; i < drones.length && _ghostCount < MAX_GHOSTS; i++) {
            const d   = drones[i];
            const gi  = _ghostCount * GHOST_STRIDE;
            ghostCPU[gi + 0] = d.x ?? 0;
            ghostCPU[gi + 1] = d.z ?? 0;  // SAB Z (altitude) → GPU Y
            ghostCPU[gi + 2] = d.y ?? 0;  // SAB Y (ground)   → GPU Z
            // Use alpha channel as a shimmer phase offset per drone for visual variety
            ghostCPU[gi + 3] = (i / drones.length) * Math.PI * 2;
            ghostCPU[gi + 4] = rgb[0];
            ghostCPU[gi + 5] = rgb[1];
            ghostCPU[gi + 6] = rgb[2];
            ghostCPU[gi + 7] = 0; // pad
            _ghostCount++;
          }
          squadSlot++;
        }
        if (_ghostCount > 0) {
          // writeBuffer expects bytes; ghostCPU is Float32Array so multiply by 4
          device.queue.writeBuffer(ghostBuf, 0, ghostCPU.buffer, 0, _ghostCount * GHOST_STRIDE * 4);
        }
      }

      // Camera UBO via camera.getUBOData() — 36 floats = 144 bytes
      const timeS = (t / 1000) % (Math.PI * 200);
      const camData = camObj.getUBOData(canvas.width, canvas.height, timeS);
      device.queue.writeBuffer(camBuf, 0, camData);

      // ── Render ─────────────────────────────────────────────────────────
      const tex    = ctx.getCurrentTexture().createView();
      const depthV = depthTex.createView();

      const enc = device.createCommandEncoder();

      // Pass 1: Opaque (body + arms)
      const pass = enc.beginRenderPass({
        colorAttachments: [{
          view:       tex,
          loadOp:     "clear",
          storeOp:    "store",
          clearValue: { r: 0.02, g: 0.03, b: 0.06, a: 1.0 },
        }],
        depthStencilAttachment: {
          view: depthV, depthLoadOp: "clear", depthStoreOp: "store", depthClearValue: 1.0,
        },
      });
      pass.setPipeline(opaquePipeline);
      pass.setBindGroup(0, bindGroup);
      pass.setVertexBuffer(0, vtxBuf);
      pass.setIndexBuffer(idxBuf, "uint16");
      pass.drawIndexed(mesh.numIdx, _droneCount);
      pass.end();

      // Pass 2: Rotor discs (additive transparent)
      const rpass = enc.beginRenderPass({
        colorAttachments: [{ view: tex, loadOp: "load", storeOp: "store" }],
        depthStencilAttachment: {
          view: depthV, depthLoadOp: "load", depthStoreOp: "store",
        },
      });
      rpass.setPipeline(rotorPipeline);
      rpass.setBindGroup(0, bindGroup);
      rpass.setVertexBuffer(0, vtxBuf);
      rpass.setIndexBuffer(idxBuf, "uint16");
      rpass.drawIndexed(mesh.numIdx, _droneCount);
      rpass.end();

      // Pass 3: Ghost SAF Dots — remote squads as additive billboard quads
      if (_ghostCount > 0) {
        const gpass = enc.beginRenderPass({
          colorAttachments: [{ view: tex, loadOp: "load", storeOp: "store" }],
          depthStencilAttachment: {
            view: depthV, depthLoadOp: "load", depthStoreOp: "store",
          },
        });
        gpass.setPipeline(ghostPipeline);
        gpass.setBindGroup(0, ghostBindGroup);
        gpass.draw(6, _ghostCount); // 6 vertices per billboard quad × N ghosts
        gpass.end();
      }

      device.queue.submit([enc.finish()]);
    },

    resize(w, h) {
      canvas.width  = w;
      canvas.height = h;
      makeDepth(w, h);
    },

    /**
     * Pick the nearest drone to a canvas click.
     * @param {number} clientX  — CSS pixels relative to canvas (e.clientX - rect.left)
     * @param {number} clientY  — CSS pixels relative to canvas (e.clientY - rect.top)
     * @param {OrbitCamera} camObj
     * @returns {number} drone index or -1
     */
    pickDrone(clientX, clientY, camObj) {
      // canvas.width = wrap.clientWidth (CSS px, not HiDPI scaled).
      // clientX/Y are already CSS px relative to canvas — use directly.
      const px = clientX, py = clientY;
      const W = canvas.width, H = canvas.height;

      // VP = proj * view  (column-major)
      const vp = _multiplyMat4(
        camObj.getProjMatrix(W, H),
        camObj.getViewMatrix(),
      );

      const PICK_R = 40; // 40 CSS px pick radius
      let bestIdx = -1, bestDist2 = PICK_R * PICK_R;
      for (let i = 0; i < _droneCount; i++) {
        const wx = droneWorldPos[i*3+0];
        const wy = droneWorldPos[i*3+1];
        const wz = droneWorldPos[i*3+2];
        const [sx, sy] = _projectToScreen(wx, wy, wz, vp, W, H);
        const d2 = (px-sx)**2 + (py-sy)**2;
        if (d2 < bestDist2) { bestDist2 = d2; bestIdx = i; }
      }
      return bestIdx;
    },

    destroy() {
      vtxBuf.destroy();
      idxBuf.destroy();
      instBuf.destroy();
      camBuf.destroy();
      ghostBuf.destroy();
      depthTex?.destroy();
    },
  };
}

// ── Math helpers ──────────────────────────────────────────────────────────────

// Column-major matrix multiply: C = A * B
// In column-major storage: element (row, col) is at index col*4+row
function _multiplyMat4(a, b) {
  const out = new Float32Array(16);
  for (let col = 0; col < 4; col++) {
    for (let row = 0; row < 4; row++) {
      let sum = 0;
      for (let k = 0; k < 4; k++) sum += a[k*4+row] * b[col*4+k];
      out[col*4+row] = sum;
    }
  }
  return out;
}

function _projectToScreen(wx, wy, wz, vp, W, H) {
  // vp is column-major (as returned by camera.js)
  const x = vp[0]*wx + vp[4]*wy + vp[8]*wz  + vp[12];
  const y = vp[1]*wx + vp[5]*wy + vp[9]*wz  + vp[13];
  const w = vp[3]*wx + vp[7]*wy + vp[11]*wz + vp[15];
  if (w <= 0) return [-9999, -9999];
  const ndcX = x / w, ndcY = y / w;
  return [(ndcX + 1) * 0.5 * W, (1 - ndcY) * 0.5 * H];
}
