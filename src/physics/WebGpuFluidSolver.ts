import {
  CAP,
  DIFF,
  EVAP,
  VDAMP,
  DEPOSIT_WET,
  DEPOSIT_DRY,
  EDGE_DEPOSIT,
  EDGE_WATER_FLOOR,
  EDGE_RATE_MAX,
  FLOW_RELAX,
  FLOW_JITTER,
} from '../config.ts';
import {
  GPU_BUFFER_USAGE_COPY_DST,
  GPU_BUFFER_USAGE_COPY_SRC,
  GPU_BUFFER_USAGE_MAP_READ,
  GPU_BUFFER_USAGE_STORAGE,
  GPU_BUFFER_USAGE_UNIFORM,
  GPU_MAP_MODE_READ,
  type GpuBindGroup,
  type GpuBuffer,
  type GpuComputePipeline,
  type GpuDevice,
} from '../renderer/WebGpuTypes.ts';
import type { ColorIndex } from '../types/physics.ts';
import type { FluidGrid } from './FluidGrid.ts';
import { FluidSolver } from './FluidSolver.ts';

const FLOATS_PER_CELL = 16;
const FLOATS_PER_OPERATION = 12;
const MAX_OPERATIONS = 2048;

/**
 * ワークグループは 16×16 の 2D タイル。1D の 64 スレッドで走らせると隣の行が
 * メモリ上で遠く、モバイル GPU では拡散ステンシルの 9 セル読み出しがキャッシュに
 * 乗らない。2D にして、拡散はさらにタイル + 1 セルの縁を共有メモリへ一度だけ載せる。
 * 16×16 = 256 スレッド、共有メモリ 10 KB は WebGPU の最低保証（256 / 16 KB）に収まる。
 */
export const TILE_SIZE = 16;
const HALO_SIZE = TILE_SIZE + 2;
const HALO_CELLS = HALO_SIZE * HALO_SIZE;

const computeShader = /* wgsl */ `
struct FluidCell {
  fluid: vec4<f32>,       // water, velocity x, velocity y, pigment 0
  pigments: vec4<f32>,   // pigment 1, pigment 2, fixed 0, fixed 1
  material: vec4<f32>,   // fixed 2, permeability, ambient x, ambient y
  paper: vec4<f32>,      // grain, fiber A·cos2θ, fiber A·sin2θ, unused
};

struct SimInfo {
  size: vec2<u32>,
  operationCount: u32,
  step: u32,
  depositScale: f32,
};

struct Operation {
  a: vec4<f32>,
  b: vec4<f32>,
  c: vec4<f32>,
};

const TILE = ${TILE_SIZE}u;
const HALO = ${HALO_SIZE}u;
const HALO_CELLS = ${HALO_CELLS}u;

@group(0) @binding(0) var<storage, read> stateIn: array<FluidCell>;
@group(0) @binding(1) var<storage, read_write> stateOut: array<FluidCell>;
@group(0) @binding(2) var<uniform> info: SimInfo;

// 拡散ステンシル用の共有メモリ。タイルと縁 1 セル分の、拡散に要る成分だけを置く。
var<workgroup> tileFluid: array<vec4<f32>, HALO_CELLS>;  // water, pigment 0, 1, 2
var<workgroup> tilePaper: array<vec4<f32>, HALO_CELLS>;  // permeability, cos2, sin2, 格子内なら 1

fn randomFactor(sourceIndex: u32, targetIndex: u32) -> f32 {
  let seed = f32(sourceIndex * 1664525u + targetIndex * 1013904223u + info.step * 747796405u);
  return 0.6 + fract(sin(seed) * 43758.5453) * 0.8;
}

// 繊維方向による拡散の重み。CPU 版 fiberWeight と同じ式・同じ近傍順序。
// 軸方向 4 つは 2/3、斜め 4 つは 1/3 を基準にし、繊維に沿う向きを 1+A、直交を 1-A 倍する。
fn fiberWeight(neighbor: u32, cos2: f32, sin2: f32) -> f32 {
  if (neighbor < 2u) { return (2.0 / 3.0) * (1.0 + cos2); }
  if (neighbor < 4u) { return (2.0 / 3.0) * (1.0 - cos2); }
  if (neighbor < 6u) { return (1.0 / 3.0) * (1.0 + sin2); }
  return (1.0 / 3.0) * (1.0 - sin2);
}

// source から destination へ運ばれる water, pigment0, pigment1, pigment2。
fn transfer(
  source: vec4<f32>,
  destinationWater: f32,
  destinationPermeability: f32,
  sourceIndex: u32,
  targetIndex: u32,
  weight: f32,
) -> vec4<f32> {
  let water = source.x;
  let difference = water - destinationWater;
  if (water <= ${CAP} || difference <= 0.0) {
    return vec4<f32>(0.0);
  }
  let amount = min(
    ${DIFF} * destinationPermeability * difference * randomFactor(sourceIndex, targetIndex) * weight,
    water * 0.18 * weight
  );
  return vec4<f32>(amount, source.yzw * (amount / water));
}

// 顔料の定着率。CPU 版 depositionRate と同じ式。
fn depositionRate(water: f32, gradient: f32) -> f32 {
  let dry = 1.0 - min(water * 6.0, 1.0);
  let edge = dry * gradient / (water + ${EDGE_WATER_FLOOR});
  return min(${DEPOSIT_WET} + ${DEPOSIT_DRY} * dry * dry + ${EDGE_DEPOSIT} * edge, ${EDGE_RATE_MAX});
}

@compute @workgroup_size(${TILE_SIZE}, ${TILE_SIZE})
fn diffuseAndSettle(
  @builtin(global_invocation_id) global: vec3<u32>,
  @builtin(local_invocation_id) local: vec3<u32>,
  @builtin(workgroup_id) group: vec3<u32>,
) {
  let size = vec2<i32>(info.size);

  // タイル + 縁を共有メモリへ。324 セルを 256 スレッドで分担する。
  let origin = vec2<i32>(group.xy * TILE) - vec2<i32>(1);
  let localIndex = local.y * TILE + local.x;
  for (var t = localIndex; t < HALO_CELLS; t += TILE * TILE) {
    let position = origin + vec2<i32>(i32(t % HALO), i32(t / HALO));
    var fluid = vec4<f32>(0.0);
    var paper = vec4<f32>(0.0);
    if (all(position >= vec2<i32>(0)) && all(position < size)) {
      let cell = stateIn[u32(position.y) * info.size.x + u32(position.x)];
      fluid = vec4<f32>(cell.fluid.x, cell.fluid.w, cell.pigments.x, cell.pigments.y);
      paper = vec4<f32>(cell.material.y, cell.paper.y, cell.paper.z, 1.0);
    }
    tileFluid[t] = fluid;
    tilePaper[t] = paper;
  }
  workgroupBarrier();

  if (global.x >= info.size.x || global.y >= info.size.y) { return; }
  let i = global.y * info.size.x + global.x;
  let current = stateIn[i];
  let center = (local.y + 1u) * HALO + local.x + 1u;
  let currentFluid = tileFluid[center];
  let currentPaper = tilePaper[center];
  var transported = currentFluid;
  // CPU 版 NEIGHBOR_DX / NEIGHBOR_DY と同じ順序。先頭 4 つが軸方向。
  let offsets = array<vec2<i32>, 8>(
    vec2<i32>(-1, 0), vec2<i32>(1, 0), vec2<i32>(0, -1), vec2<i32>(0, 1),
    vec2<i32>(1, 1), vec2<i32>(-1, -1), vec2<i32>(1, -1), vec2<i32>(-1, 1)
  );
  // 軸方向の隣の水分。端は自分の値で代用し、中央差分で勾配を取る。
  var axialWater = vec4<f32>(currentFluid.x);

  for (var n = 0u; n < 8u; n++) {
    let offset = offsets[n];
    let neighborTile = u32(i32(center) + offset.y * i32(HALO) + offset.x);
    let neighborPaper = tilePaper[neighborTile];
    if (neighborPaper.w < 0.5) { continue; }
    let neighborFluid = tileFluid[neighborTile];
    let neighborPosition = vec2<i32>(global.xy) + offset;
    let j = u32(neighborPosition.y) * info.size.x + u32(neighborPosition.x);
    if (n < 4u) { axialWater[n] = neighborFluid.x; }
    transported += transfer(neighborFluid, currentFluid.x, currentPaper.x, j, i, fiberWeight(n, currentPaper.y, currentPaper.z))
      - transfer(currentFluid, neighborFluid.x, neighborPaper.x, i, j, fiberWeight(n, neighborPaper.y, neighborPaper.z));
  }

  var result = current;
  let water = select(transported.x * ${EVAP}, 0.0, transported.x * ${EVAP} < 0.0008);
  let gradient = length(vec2<f32>(axialWater.y - axialWater.x, axialWater.w - axialWater.z) * 0.5);
  var mobile = max(transported.yzw, vec3<f32>(0.0));
  // 見えない量になった浮遊顔料は 0 にする（CPU 版 PIGMENT_EPSILON と同じ）。
  if (mobile.x + mobile.y + mobile.z < 0.00001) { mobile = vec3<f32>(0.0); }
  let deposited = mobile * depositionRate(water, gradient) * info.depositScale;

  result.fluid = vec4<f32>(water, current.fluid.y * ${VDAMP}, current.fluid.z * ${VDAMP}, mobile.x - deposited.x);
  result.pigments = vec4<f32>(
    mobile.y - deposited.y,
    mobile.z - deposited.z,
    current.pigments.z + deposited.x,
    current.pigments.w + deposited.y
  );
  result.material.x = current.material.x + deposited.z;
  stateOut[i] = result;
}

// 移流の汲み出し元。紙の外にはみ出した角は白紙（水も墨も 0）として重みだけ残す。
// CPU 版 advect と同じ扱いで、縁のセルが自分自身を汲み続ける汲み出し口にならないようにする。
fn sampleWeight(cell: vec2<i32>, weight: f32) -> f32 {
  let size = vec2<i32>(info.size);
  let inside = all(cell >= vec2<i32>(0)) && all(cell < size);
  return select(0.0, weight, inside);
}

fn sampleIndex(cell: vec2<i32>) -> u32 {
  let size = vec2<i32>(info.size);
  let clamped = clamp(cell, vec2<i32>(0), size - vec2<i32>(1));
  return u32(clamped.y) * info.size.x + u32(clamped.x);
}

/** 双線形の汲み出し。fluid（水・速度・墨0）と pigments（墨1・墨2）だけを混ぜる。 */
fn sampleState(position: vec2<f32>) -> FluidCell {
  let base = vec2<i32>(floor(position));
  let fraction = position - floor(position);
  let corners = array<vec2<i32>, 4>(
    base,
    base + vec2<i32>(1, 0),
    base + vec2<i32>(0, 1),
    base + vec2<i32>(1, 1)
  );
  let weights = vec4<f32>(
    (1.0 - fraction.x) * (1.0 - fraction.y),
    fraction.x * (1.0 - fraction.y),
    (1.0 - fraction.x) * fraction.y,
    fraction.x * fraction.y
  );

  var fluid = vec4<f32>(0.0);
  var pigments = vec4<f32>(0.0);
  for (var c = 0u; c < 4u; c++) {
    let corner = corners[c];
    let weight = sampleWeight(corner, weights[c]);
    if (weight <= 0.0) { continue; }
    let cell = stateIn[sampleIndex(corner)];
    fluid += cell.fluid * weight;
    pigments += cell.pigments * weight;
  }

  var sampled = stateIn[sampleIndex(base)];
  sampled.fluid = fluid;
  sampled.pigments = pigments;
  return sampled;
}

@compute @workgroup_size(${TILE_SIZE}, ${TILE_SIZE})
fn advect(@builtin(global_invocation_id) global: vec3<u32>) {
  if (global.x >= info.size.x || global.y >= info.size.y) { return; }
  let i = global.y * info.size.x + global.x;

  let current = stateIn[i];
  let wetness = min(current.fluid.x * 3.5, 1.0);
  var result = current;
  if (wetness >= 0.02) {
    let velocity = (current.fluid.yz + current.material.zw) * wetness;
    if (dot(velocity, velocity) >= 0.000001) {
      let position = vec2<f32>(global.xy);
      // 紙の外へ 1 セル分まで遡らせる。そこは白紙なので、縁の墨は薄まって出ていく。
      let sourcePosition = clamp(
        position - velocity,
        vec2<f32>(-1.0),
        vec2<f32>(info.size)
      );
      let sampled = sampleState(sourcePosition);
      result.fluid.x = mix(current.fluid.x, sampled.fluid.x, wetness);
      result.fluid.w = mix(current.fluid.w, sampled.fluid.w, wetness);
      // WGSL は多成分スウィズルへの代入を許さないため、成分ごとに書き込む。
      let pigments = mix(current.pigments.xy, sampled.pigments.xy, wetness);
      result.pigments.x = pigments.x;
      result.pigments.y = pigments.y;
    }
  }
  stateOut[i] = result;
}

@group(0) @binding(0) var<storage, read_write> operationState: array<FluidCell>;
@group(0) @binding(1) var<storage, read> operations: array<Operation>;
@group(0) @binding(2) var<uniform> operationInfo: SimInfo;

fn operationNoise(index: u32, step: u32) -> f32 {
  return fract(sin(f32(index * 1103515245u + step * 12345u)) * 43758.5453);
}

@compute @workgroup_size(${TILE_SIZE}, ${TILE_SIZE})
fn applyOperations(@builtin(global_invocation_id) global: vec3<u32>) {
  if (global.x >= operationInfo.size.x || global.y >= operationInfo.size.y) { return; }
  let i = global.y * operationInfo.size.x + global.x;

  let position = vec2<f32>(global.xy);
  var cell = operationState[i];
  for (var operationIndex = 0u; operationIndex < operationInfo.operationCount; operationIndex++) {
    let operation = operations[operationIndex];
    let kind = u32(operation.a.x);

    if (kind <= 2u) {
      let delta = position - operation.a.yz;
      let radius = operation.a.w;
      let distanceSquared = dot(delta, delta);
      if (distanceSquared > radius * radius) { continue; }

      if (kind == 0u) {
        let falloff = exp(-distanceSquared / (radius * radius * 0.35));
        cell.fluid.x = min(cell.fluid.x + operation.b.x * falloff, 2.4);
        let pigment = operation.b.y * falloff;
        let color = u32(operation.b.z);
        if (color == 0u) { cell.fluid.w = min(cell.fluid.w + pigment, 1.5); }
        if (color == 1u) { cell.pigments.x = min(cell.pigments.x + pigment, 1.5); }
        if (color == 2u) { cell.pigments.y = min(cell.pigments.y + pigment, 1.5); }
      } else if (kind == 1u) {
        let falloff = exp(-distanceSquared / (radius * radius * 0.4));
        cell.fluid.y += operation.b.x * falloff;
        cell.fluid.z += operation.b.y * falloff;
      } else {
        let distance = sqrt(distanceSquared);
        if (distance >= 0.5) {
          let strength = operation.b.x * 0.9 * exp(-distanceSquared / (radius * radius * 0.3)) / distance;
          cell.fluid.y += -delta.y * strength;
          cell.fluid.z += delta.x * strength;
        }
      }
    } else if (kind == 3u) {
      let time = operation.a.y;
      let sweepFrames = operation.a.z;
      let totalFrames = operation.a.w;
      let frontRow = min(operationInfo.size.y, u32(floor(f32(operationInfo.size.y) * time / sweepFrames)) + 2u);
      let pouring = time < totalFrames - 100.0;
      if (global.y < frontRow) {
        if (pouring && cell.fluid.x < 2.2) { cell.fluid.x += 0.13; }
        if (cell.fluid.z < 1.4) { cell.fluid.z += 0.13; }
        cell.fluid.y += (operationNoise(i, u32(time)) - 0.5) * 0.07 + cell.material.z * 0.5;
        let dissolve = min(cell.fluid.x, 1.2) * 0.05;
        let fixedPigment = vec3<f32>(cell.pigments.z, cell.pigments.w, cell.material.x);
        let moved = fixedPigment * dissolve;
        cell.pigments.z -= moved.x;
        cell.pigments.w -= moved.y;
        cell.material.x -= moved.z;
        cell.fluid.w += moved.x;
        cell.pigments.x += moved.y;
        cell.pigments.y += moved.z;
      }
      if (global.y + 3u >= operationInfo.size.y) {
        cell.fluid.x *= 0.55;
        cell.fluid.w *= 0.5;
        cell.pigments.x *= 0.5;
        cell.pigments.y *= 0.5;
        cell.pigments.z *= 0.9;
        cell.pigments.w *= 0.9;
        cell.material.x *= 0.9;
      }
      if (!pouring) {
        cell.fluid.x *= 0.95;
        cell.fluid.w *= 0.94;
        cell.pigments.x *= 0.94;
        cell.pigments.y *= 0.94;
        cell.pigments.z *= 0.94;
        cell.pigments.w *= 0.94;
        cell.material.x *= 0.94;
      }
    } else if (kind == 4u) {
      cell.fluid = vec4<f32>(0.0);
      cell.pigments = vec4<f32>(0.0);
      cell.material.x = 0.0;
    } else if (kind == 5u) {
      // 流し書き。CPU 版 flowStep と同じ: 水を張る／引かせ、濡れたセルの速度を流れへ寄せる。
      var water = max(cell.fluid.x, operation.b.x) * operation.b.y;
      if (water < 0.0008) { water = 0.0; }
      cell.fluid.x = water;
      if (water > ${CAP}) {
        let flow = operation.a.yz;
        let speed = length(flow);
        let perp = select(vec2<f32>(0.0), vec2<f32>(-flow.y, flow.x) / max(speed, 0.0001), speed > 0.0);
        let jitter = (operationNoise(i, operationInfo.step + 7u) - 0.5) * ${FLOW_JITTER};
        cell.fluid.y += (flow.x - cell.fluid.y) * ${FLOW_RELAX} + perp.x * jitter;
        cell.fluid.z += (flow.y - cell.fluid.z) * ${FLOW_RELAX} + perp.y * jitter;
      }
    }
  }
  operationState[i] = cell;
}
`;

export class WebGpuFluidSolver extends FluidSolver {
  private readonly device: GpuDevice;
  private readonly diffusePipeline: GpuComputePipeline;
  private readonly advectPipeline: GpuComputePipeline;
  private readonly operationPipeline: GpuComputePipeline;
  private readonly infoBuffer: GpuBuffer;
  private readonly operationBuffer: GpuBuffer;
  private stateBuffers: [GpuBuffer, GpuBuffer] | null = null;
  private simulationBindGroups: [GpuBindGroup, GpuBindGroup] | null = null;
  private advectBindGroups: [GpuBindGroup, GpuBindGroup] | null = null;
  private operationBindGroups: [GpuBindGroup, GpuBindGroup] | null = null;
  private currentIndex: 0 | 1 = 0;
  // size(2), operationCount, step の u32 と depositScale の f32。uniform の構造体に合わせて 32 バイト取る。
  private readonly info = new Uint32Array(8);
  private readonly infoFloats = new Float32Array(this.info.buffer);
  private readonly pendingOperations: number[] = [];
  private stepNumber = 0;
  private activeSteps = 0;
  private stateByteLength = 0;
  private version = 0;
  private fieldRevision = 0;

  constructor(grid: FluidGrid, device: GpuDevice) {
    super(grid);
    this.device = device;
    const module = device.createShaderModule({ code: computeShader });
    this.diffusePipeline = device.createComputePipeline({ layout: 'auto', compute: { module, entryPoint: 'diffuseAndSettle' } });
    this.advectPipeline = device.createComputePipeline({ layout: 'auto', compute: { module, entryPoint: 'advect' } });
    this.operationPipeline = device.createComputePipeline({ layout: 'auto', compute: { module, entryPoint: 'applyOperations' } });
    this.infoBuffer = device.createBuffer({ size: this.info.byteLength, usage: GPU_BUFFER_USAGE_UNIFORM | GPU_BUFFER_USAGE_COPY_DST });
    this.operationBuffer = device.createBuffer({
      size: MAX_OPERATIONS * FLOATS_PER_OPERATION * Float32Array.BYTES_PER_ELEMENT,
      usage: GPU_BUFFER_USAGE_STORAGE | GPU_BUFFER_USAGE_COPY_DST,
    });
    this.allocateState();
  }

  public override get isGpu(): boolean {
    return true;
  }

  public get gpuDevice(): GpuDevice {
    return this.device;
  }

  public get stateBuffer(): GpuBuffer {
    if (!this.stateBuffers) throw new Error('GPU流体状態が初期化されていません');
    return this.stateBuffers[this.currentIndex];
  }

  /** ステップごとに進む。描画側はこれで「どのバッファが最新か」を追う。 */
  public get stateVersion(): number {
    return this.version;
  }

  /**
   * 紙の静的な場（紙目・繊維・浸透率）が置き換わった回数。
   * 格子の作り直しと CPU からのアップロードでだけ進むので、描画側は
   * これが変わった時にだけ紙のテクスチャを焼き直せばよい。
   */
  public get fieldVersion(): number {
    return this.fieldRevision;
  }

  public override resize(width: number, height: number): void {
    this.grid.resize(width, height);
    this.wet = 0;
    this.activeSteps = 0;
    this.pendingOperations.length = 0;
    this.allocateState();
  }

  public override runSteps(count: number): void {
    if (count <= 0 || !this.simulationBindGroups) return;
    this.flushOperations();
    this.writeInfo(0);
    const encoder = this.device.createCommandEncoder();
    for (let step = 0; step < count; step++) {
      const pass = encoder.beginComputePass();
      pass.setPipeline(this.diffusePipeline);
      pass.setBindGroup(0, this.simulationBindGroups[this.currentIndex]);
      this.dispatchGrid(pass);
      pass.end();
      this.swapState();
    }
    this.stepNumber += count;
    this.activeSteps = Math.max(0, this.activeSteps - count);
    this.wet = this.activeSteps > 0 ? 1 : 0;
    this.device.queue.submit([encoder.finish()]);
  }

  public override simStep(): void {
    this.runSteps(1);
  }

  public override advect(): void {
    if (!this.advectBindGroups) return;
    this.flushOperations();
    this.writeInfo(0);
    const encoder = this.device.createCommandEncoder();
    const pass = encoder.beginComputePass();
    pass.setPipeline(this.advectPipeline);
    pass.setBindGroup(0, this.advectBindGroups[this.currentIndex]);
    this.dispatchGrid(pass);
    pass.end();
    this.swapState();
    this.device.queue.submit([encoder.finish()]);
  }

  public override deposit(
    cx: number,
    cy: number,
    waterAmount: number,
    pigmentAmount: number,
    radius: number,
    curColor: ColorIndex,
  ): void {
    this.grid.includeArea(cx, cy, radius * this.grid.CS);
    this.queueOperation([0, cx / this.grid.CS, cy / this.grid.CS, radius, waterAmount, pigmentAmount, curColor, 0, 0, 0, 0, 0]);
    this.activeSteps = Math.max(this.activeSteps, 24_000);
    this.wet = 1;
  }

  public override addVel(cx: number, cy: number, vx: number, vy: number, radius: number): void {
    this.queueOperation([1, cx / this.grid.CS, cy / this.grid.CS, radius, vx, vy, 0, 0, 0, 0, 0, 0]);
  }

  public override swirl(cx: number, cy: number): void {
    const radius = 27 / this.grid.CS;
    const direction = Math.random() < 0.5 ? 1 : -1;
    this.queueOperation([2, cx / this.grid.CS, cy / this.grid.CS, radius, direction, 0, 0, 0, 0, 0, 0, 0]);
  }

  public override rinseStep(t: number, sweepFrames: number, totalFrames: number): void {
    this.grid.includeViewport();
    this.queueOperation([3, t, sweepFrames, totalFrames, 0, 0, 0, 0, 0, 0, 0, 0]);
    this.activeSteps = Math.max(this.activeSteps, 24_000);
    this.wet = 1;
  }

  public override flowStep(vx: number, vy: number, waterFloor: number, dryFactor: number): void {
    this.grid.includeViewport();
    this.queueOperation([5, vx, vy, 0, waterFloor, dryFactor, 0, 0, 0, 0, 0, 0]);
    // 張った水が引くまで描画を続けさせる（GPU 版の wet は残りステップ数で決まる）。
    this.activeSteps = Math.max(this.activeSteps, 600);
    this.wet = 1;
  }

  public override clearAll(): void {
    this.grid.includeViewport();
    this.pendingOperations.length = 0;
    this.queueOperation([4, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0]);
    this.flushOperations();
    this.activeSteps = 0;
    this.wet = 0;
  }

  public flushOperations(): void {
    const operationCount = this.pendingOperations.length / FLOATS_PER_OPERATION;
    if (operationCount === 0 || !this.operationBindGroups) return;
    const data = new Float32Array(this.pendingOperations);
    this.pendingOperations.length = 0;
    this.device.queue.writeBuffer(this.operationBuffer, 0, data);
    this.writeInfo(operationCount);

    const encoder = this.device.createCommandEncoder();
    const pass = encoder.beginComputePass();
    pass.setPipeline(this.operationPipeline);
    pass.setBindGroup(0, this.operationBindGroups[this.currentIndex]);
    this.dispatchGrid(pass);
    pass.end();
    this.device.queue.submit([encoder.finish()]);
  }

  public override async readback(): Promise<void> {
    this.flushOperations();
    const staging = this.device.createBuffer({
      size: this.stateByteLength,
      usage: GPU_BUFFER_USAGE_MAP_READ | GPU_BUFFER_USAGE_COPY_DST,
    });
    const width = this.grid.gw;
    const height = this.grid.gh;
    const encoder = this.device.createCommandEncoder();
    encoder.copyBufferToBuffer(this.stateBuffer, 0, staging, 0, this.stateByteLength);
    this.device.queue.submit([encoder.finish()]);
    let mapped = false;
    let copy: ArrayBuffer;
    try {
      await staging.mapAsync(GPU_MAP_MODE_READ);
      mapped = true;
      copy = staging.getMappedRange().slice(0);
    } finally {
      try {
        if (mapped) staging.unmap();
      } finally {
        staging.destroy();
      }
    }
    if (width === this.grid.gw && height === this.grid.gh) this.unpackState(new Float32Array(copy));
  }

  public override uploadFromGrid(): void {
    if (!this.stateBuffers) return;
    this.pendingOperations.length = 0;
    const data = this.packState();
    this.device.queue.writeBuffer(this.stateBuffers[0], 0, data);
    this.device.queue.writeBuffer(this.stateBuffers[1], 0, data);
    this.currentIndex = 0;
    let maximumWater = 0;
    for (const water of this.grid.w) maximumWater = Math.max(maximumWater, water);
    this.activeSteps = maximumWater > CAP
      ? Math.max(1, Math.ceil(Math.log(CAP / maximumWater) / Math.log(EVAP)))
      : 0;
    this.wet = this.activeSteps > 0 ? 1 : 0;
    this.version++;
    this.fieldRevision++;
  }

  private dispatchGrid(pass: { dispatchWorkgroups: (x: number, y?: number, z?: number) => void }): void {
    pass.dispatchWorkgroups(
      Math.ceil(this.grid.gw / TILE_SIZE),
      Math.ceil(this.grid.gh / TILE_SIZE),
    );
  }

  private allocateState(): void {
    if (this.stateBuffers) {
      this.stateBuffers[0].destroy();
      this.stateBuffers[1].destroy();
    }
    this.stateByteLength = this.grid.N * FLOATS_PER_CELL * Float32Array.BYTES_PER_ELEMENT;
    this.stateBuffers = [
      this.device.createBuffer({ size: this.stateByteLength, usage: GPU_BUFFER_USAGE_STORAGE | GPU_BUFFER_USAGE_COPY_SRC | GPU_BUFFER_USAGE_COPY_DST }),
      this.device.createBuffer({ size: this.stateByteLength, usage: GPU_BUFFER_USAGE_STORAGE | GPU_BUFFER_USAGE_COPY_SRC | GPU_BUFFER_USAGE_COPY_DST }),
    ];
    this.currentIndex = 0;
    const initial = this.packState();
    this.device.queue.writeBuffer(this.stateBuffers[0], 0, initial);
    this.device.queue.writeBuffer(this.stateBuffers[1], 0, initial);
    this.rebuildBindGroups();
    this.version++;
    this.fieldRevision++;
  }

  private rebuildBindGroups(): void {
    if (!this.stateBuffers) return;
    const simulationLayout = this.diffusePipeline.getBindGroupLayout(0);
    this.simulationBindGroups = [
      this.device.createBindGroup({
        layout: simulationLayout,
        entries: [
          { binding: 0, resource: { buffer: this.stateBuffers[0] } },
          { binding: 1, resource: { buffer: this.stateBuffers[1] } },
          { binding: 2, resource: { buffer: this.infoBuffer } },
        ],
      }),
      this.device.createBindGroup({
        layout: simulationLayout,
        entries: [
          { binding: 0, resource: { buffer: this.stateBuffers[1] } },
          { binding: 1, resource: { buffer: this.stateBuffers[0] } },
          { binding: 2, resource: { buffer: this.infoBuffer } },
        ],
      }),
    ];

    const advectLayout = this.advectPipeline.getBindGroupLayout(0);
    this.advectBindGroups = [
      this.device.createBindGroup({
        layout: advectLayout,
        entries: [
          { binding: 0, resource: { buffer: this.stateBuffers[0] } },
          { binding: 1, resource: { buffer: this.stateBuffers[1] } },
          { binding: 2, resource: { buffer: this.infoBuffer } },
        ],
      }),
      this.device.createBindGroup({
        layout: advectLayout,
        entries: [
          { binding: 0, resource: { buffer: this.stateBuffers[1] } },
          { binding: 1, resource: { buffer: this.stateBuffers[0] } },
          { binding: 2, resource: { buffer: this.infoBuffer } },
        ],
      }),
    ];

    const operationLayout = this.operationPipeline.getBindGroupLayout(0);
    this.operationBindGroups = [0, 1].map((index) => this.device.createBindGroup({
      layout: operationLayout,
      entries: [
        { binding: 0, resource: { buffer: this.stateBuffers![index as 0 | 1] } },
        { binding: 1, resource: { buffer: this.operationBuffer } },
        { binding: 2, resource: { buffer: this.infoBuffer } },
      ],
    })) as [GpuBindGroup, GpuBindGroup];
  }

  private queueOperation(values: readonly number[]): void {
    if (this.pendingOperations.length / FLOATS_PER_OPERATION >= MAX_OPERATIONS) this.flushOperations();
    this.pendingOperations.push(...values);
  }

  private writeInfo(operationCount: number): void {
    this.info[0] = this.grid.gw;
    this.info[1] = this.grid.gh;
    this.info[2] = operationCount;
    this.info[3] = this.stepNumber;
    this.infoFloats[4] = this.depositScale;
    this.device.queue.writeBuffer(this.infoBuffer, 0, this.info);
  }

  private swapState(): void {
    this.currentIndex = this.currentIndex === 0 ? 1 : 0;
    this.version++;
  }

  private packState(): Float32Array {
    const { N, w, u, v, p, d, perm, ambU, ambV, grain, fiberCos2, fiberSin2 } = this.grid;
    const data = new Float32Array(N * FLOATS_PER_CELL);
    for (let i = 0; i < N; i++) {
      const offset = i * FLOATS_PER_CELL;
      data[offset] = w[i] ?? 0;
      data[offset + 1] = u[i] ?? 0;
      data[offset + 2] = v[i] ?? 0;
      data[offset + 3] = p[0][i] ?? 0;
      data[offset + 4] = p[1][i] ?? 0;
      data[offset + 5] = p[2][i] ?? 0;
      data[offset + 6] = d[0][i] ?? 0;
      data[offset + 7] = d[1][i] ?? 0;
      data[offset + 8] = d[2][i] ?? 0;
      data[offset + 9] = perm[i] ?? 1;
      data[offset + 10] = ambU[i] ?? 0;
      data[offset + 11] = ambV[i] ?? 0;
      data[offset + 12] = grain[i] ?? 1;
      data[offset + 13] = fiberCos2[i] ?? 0;
      data[offset + 14] = fiberSin2[i] ?? 0;
    }
    return data;
  }

  private unpackState(data: Float32Array): void {
    const { N, w, w2, u, v, p, p2, d } = this.grid;
    for (let i = 0; i < N; i++) {
      const offset = i * FLOATS_PER_CELL;
      w[i] = data[offset] ?? 0;
      w2[i] = w[i] ?? 0;
      u[i] = data[offset + 1] ?? 0;
      v[i] = data[offset + 2] ?? 0;
      p[0][i] = data[offset + 3] ?? 0;
      p[1][i] = data[offset + 4] ?? 0;
      p[2][i] = data[offset + 5] ?? 0;
      d[0][i] = data[offset + 6] ?? 0;
      d[1][i] = data[offset + 7] ?? 0;
      d[2][i] = data[offset + 8] ?? 0;
      for (let c = 0; c < 3; c++) p2[c as ColorIndex][i] = p[c as ColorIndex][i] ?? 0;
    }
  }
}
