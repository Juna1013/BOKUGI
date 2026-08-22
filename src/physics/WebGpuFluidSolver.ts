import { CAP, DIFF, EVAP, VDAMP } from '../config.ts';
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
const WORKGROUP_SIZE = 64;

const computeShader = /* wgsl */ `
struct FluidCell {
  fluid: vec4<f32>,       // water, velocity x, velocity y, pigment 0
  pigments: vec4<f32>,   // pigment 1, pigment 2, fixed 0, fixed 1
  material: vec4<f32>,   // fixed 2, permeability, ambient x, ambient y
  paper: vec4<f32>,      // grain, unused...
};

struct SimInfo {
  size: vec2<u32>,
  operationCount: u32,
  step: u32,
};

struct Operation {
  a: vec4<f32>,
  b: vec4<f32>,
  c: vec4<f32>,
};

@group(0) @binding(0) var<storage, read> stateIn: array<FluidCell>;
@group(0) @binding(1) var<storage, read_write> stateOut: array<FluidCell>;
@group(0) @binding(2) var<uniform> info: SimInfo;

fn randomFactor(sourceIndex: u32, targetIndex: u32) -> f32 {
  let seed = f32(sourceIndex * 1664525u + targetIndex * 1013904223u + info.step * 747796405u);
  return 0.6 + fract(sin(seed) * 43758.5453) * 0.8;
}

// 戻り値は water, pigment0, pigment1, pigment2。
fn transfer(source: FluidCell, destination: FluidCell, sourceIndex: u32, targetIndex: u32) -> vec4<f32> {
  let water = source.fluid.x;
  let difference = water - destination.fluid.x;
  if (water <= ${CAP} || difference <= 0.0) {
    return vec4<f32>(0.0);
  }
  let amount = min(${DIFF} * destination.material.y * difference * randomFactor(sourceIndex, targetIndex), water * 0.18);
  let ratio = amount / water;
  return vec4<f32>(amount, source.fluid.w * ratio, source.pigments.x * ratio, source.pigments.y * ratio);
}

@compute @workgroup_size(${WORKGROUP_SIZE})
fn diffuseAndSettle(@builtin(global_invocation_id) invocation: vec3<u32>) {
  let count = info.size.x * info.size.y;
  let i = invocation.x;
  if (i >= count) { return; }

  let x = i % info.size.x;
  let y = i / info.size.x;
  let current = stateIn[i];
  var transported = vec4<f32>(current.fluid.x, current.fluid.w, current.pigments.x, current.pigments.y);
  let offsets = array<vec2<i32>, 4>(
    vec2<i32>(-1, 0), vec2<i32>(1, 0), vec2<i32>(0, -1), vec2<i32>(0, 1)
  );

  for (var n = 0u; n < 4u; n++) {
    let neighborPosition = vec2<i32>(i32(x), i32(y)) + offsets[n];
    if (
      neighborPosition.x < 0 || neighborPosition.y < 0 ||
      neighborPosition.x >= i32(info.size.x) || neighborPosition.y >= i32(info.size.y)
    ) { continue; }
    let j = u32(neighborPosition.y) * info.size.x + u32(neighborPosition.x);
    let neighbor = stateIn[j];
    transported += transfer(neighbor, current, j, i) - transfer(current, neighbor, i, j);
  }

  var result = current;
  let water = select(transported.x * ${EVAP}, 0.0, transported.x * ${EVAP} < 0.0008);
  let dry = 1.0 - min(water * 6.0, 1.0);
  let depositionRate = 0.003 + 0.05 * dry * dry;
  let mobile = max(transported.yzw, vec3<f32>(0.0));
  let deposited = mobile * depositionRate;

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

fn sampleState(position: vec2<f32>) -> FluidCell {
  let base = vec2<u32>(floor(position));
  let next = min(base + vec2<u32>(1u), info.size - vec2<u32>(1u));
  let fraction = fract(position);
  let topLeft = stateIn[base.y * info.size.x + base.x];
  let topRight = stateIn[base.y * info.size.x + next.x];
  let bottomLeft = stateIn[next.y * info.size.x + base.x];
  let bottomRight = stateIn[next.y * info.size.x + next.x];
  var sampled = topLeft;
  sampled.fluid = mix(mix(topLeft.fluid, topRight.fluid, fraction.x), mix(bottomLeft.fluid, bottomRight.fluid, fraction.x), fraction.y);
  sampled.pigments = mix(mix(topLeft.pigments, topRight.pigments, fraction.x), mix(bottomLeft.pigments, bottomRight.pigments, fraction.x), fraction.y);
  return sampled;
}

@compute @workgroup_size(${WORKGROUP_SIZE})
fn advect(@builtin(global_invocation_id) invocation: vec3<u32>) {
  let count = info.size.x * info.size.y;
  let i = invocation.x;
  if (i >= count) { return; }

  let current = stateIn[i];
  let wetness = min(current.fluid.x * 3.5, 1.0);
  var result = current;
  if (wetness >= 0.02) {
    let velocity = (current.fluid.yz + current.material.zw) * wetness;
    if (dot(velocity, velocity) >= 0.000001) {
      let position = vec2<f32>(f32(i % info.size.x), f32(i / info.size.x));
      let upper = vec2<f32>(info.size) - vec2<f32>(1.001);
      let sourcePosition = clamp(position - velocity, vec2<f32>(0.0), upper);
      let sampled = sampleState(sourcePosition);
      result.fluid.x = mix(current.fluid.x, sampled.fluid.x, wetness);
      result.fluid.w = mix(current.fluid.w, sampled.fluid.w, wetness);
      result.pigments.xy = mix(current.pigments.xy, sampled.pigments.xy, wetness);
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

@compute @workgroup_size(${WORKGROUP_SIZE})
fn applyOperations(@builtin(global_invocation_id) invocation: vec3<u32>) {
  let count = operationInfo.size.x * operationInfo.size.y;
  let i = invocation.x;
  if (i >= count) { return; }

  let position = vec2<f32>(f32(i % operationInfo.size.x), f32(i / operationInfo.size.x));
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
        cell.fluid.yz += operation.b.xy * falloff;
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
      if (u32(position.y) < frontRow) {
        if (pouring && cell.fluid.x < 2.2) { cell.fluid.x += 0.13; }
        if (cell.fluid.z < 1.4) { cell.fluid.z += 0.13; }
        cell.fluid.y += (operationNoise(i, u32(time)) - 0.5) * 0.07 + cell.material.z * 0.5;
        let dissolve = min(cell.fluid.x, 1.2) * 0.05;
        let fixedPigment = vec3<f32>(cell.pigments.z, cell.pigments.w, cell.material.x);
        let moved = fixedPigment * dissolve;
        cell.pigments.zw -= moved.xy;
        cell.material.x -= moved.z;
        cell.fluid.w += moved.x;
        cell.pigments.xy += moved.yz;
      }
      if (u32(position.y) + 3u >= operationInfo.size.y) {
        cell.fluid.x *= 0.55;
        cell.fluid.w *= 0.5;
        cell.pigments.xy *= vec2<f32>(0.5);
        cell.pigments.zw *= vec2<f32>(0.9);
        cell.material.x *= 0.9;
      }
      if (!pouring) {
        cell.fluid.x *= 0.95;
        cell.fluid.w *= 0.94;
        cell.pigments.xy *= vec2<f32>(0.94);
        cell.pigments.zw *= vec2<f32>(0.94);
        cell.material.x *= 0.94;
      }
    } else if (kind == 4u) {
      cell.fluid = vec4<f32>(0.0);
      cell.pigments = vec4<f32>(0.0);
      cell.material.x = 0.0;
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
  private readonly info = new Uint32Array(4);
  private readonly pendingOperations: number[] = [];
  private stepNumber = 0;
  private activeSteps = 0;
  private stateByteLength = 0;
  private version = 0;

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

  public get stateVersion(): number {
    return this.version;
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
      pass.dispatchWorkgroups(Math.ceil(this.grid.N / WORKGROUP_SIZE));
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
    pass.dispatchWorkgroups(Math.ceil(this.grid.N / WORKGROUP_SIZE));
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
    pass.dispatchWorkgroups(Math.ceil(this.grid.N / WORKGROUP_SIZE));
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
    this.device.queue.writeBuffer(this.infoBuffer, 0, this.info);
  }

  private swapState(): void {
    this.currentIndex = this.currentIndex === 0 ? 1 : 0;
    this.version++;
  }

  private packState(): Float32Array {
    const { N, w, u, v, p, d, perm, ambU, ambV, grain } = this.grid;
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
