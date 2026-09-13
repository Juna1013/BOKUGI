import { ABS, PIGMENT_DENSITY } from '../config.ts';
import { WebGpuFluidSolver } from '../physics/WebGpuFluidSolver.ts';
import type { FluidGrid } from '../physics/FluidGrid.ts';
import {
  GPU_BUFFER_USAGE_COPY_DST,
  GPU_BUFFER_USAGE_UNIFORM,
  type GpuApi,
  type GpuBindGroup,
  type GpuBuffer,
  type GpuCanvasContext,
  type GpuDevice,
  type GpuRenderPipeline,
} from './WebGpuTypes.ts';

const shader = /* wgsl */ `
struct GridInfo {
  size: vec2<u32>,
  _padding: vec2<u32>,
};

struct FluidCell {
  fluid: vec4<f32>,       // water, velocity x, velocity y, pigment 0
  pigments: vec4<f32>,   // pigment 1, pigment 2, fixed 0, fixed 1
  material: vec4<f32>,   // fixed 2, permeability, ambient x, ambient y
  paper: vec4<f32>,      // grain, unused...
};

@group(0) @binding(0) var<storage, read> cells: array<FluidCell>;
@group(0) @binding(1) var<uniform> grid: GridInfo;

struct VertexOutput {
  @builtin(position) position: vec4<f32>,
  @location(0) uv: vec2<f32>,
};

@vertex
fn vertexMain(@builtin(vertex_index) index: u32) -> VertexOutput {
  var positions = array<vec2<f32>, 3>(
    vec2<f32>(-1.0, -1.0), vec2<f32>(3.0, -1.0), vec2<f32>(-1.0, 3.0)
  );
  var output: VertexOutput;
  output.position = vec4<f32>(positions[index], 0.0, 1.0);
  output.uv = vec2<f32>(positions[index].x * 0.5 + 0.5, 0.5 - positions[index].y * 0.5);
  return output;
}

// セルの光学密度（Lambert-Beer の指数部）。紙目の係数もここで掛けておく。
fn densityAt(x: i32, y: i32) -> vec3<f32> {
  let clamped = clamp(vec2<i32>(x, y), vec2<i32>(0), vec2<i32>(grid.size) - vec2<i32>(1));
  let cell = cells[u32(clamped.y) * grid.size.x + u32(clamped.x)];
  let pigment = vec3<f32>(
    cell.pigments.z * 1.15 + cell.fluid.w * 0.55,
    cell.pigments.w * 1.15 + cell.pigments.x * 0.55,
    cell.material.x * 1.15 + cell.pigments.y * 0.55
  );
  let absorption = vec3<f32>(
    pigment.x * ${ABS[0][0]} + pigment.y * ${ABS[1][0]} + pigment.z * ${ABS[2][0]},
    pigment.x * ${ABS[0][1]} + pigment.y * ${ABS[1][1]} + pigment.z * ${ABS[2][1]},
    pigment.x * ${ABS[0][2]} + pigment.y * ${ABS[1][2]} + pigment.z * ${ABS[2][2]}
  );
  return (absorption * ${PIGMENT_DENSITY} + vec3<f32>(cell.fluid.x * 0.05)) * cell.paper.x;
}

// Mitchell–Netravali (B = C = 1/3) の三次補間カーネル。
// 双線形補間で出るセル境界の折れ目を消しつつ、リンギングをほぼ起こさない。
fn mitchell(distance: f32) -> f32 {
  let x = abs(distance);
  let x2 = x * x;
  let x3 = x2 * x;
  if (x < 1.0) {
    return (7.0 * x3 - 12.0 * x2 + 16.0 / 3.0) / 6.0;
  }
  if (x < 2.0) {
    return (-7.0 / 3.0 * x3 + 12.0 * x2 - 20.0 * x + 32.0 / 3.0) / 6.0;
  }
  return 0.0;
}

fn cubicWeights(fraction: f32) -> vec4<f32> {
  return vec4<f32>(
    mitchell(1.0 + fraction),
    mitchell(fraction),
    mitchell(1.0 - fraction),
    mitchell(2.0 - fraction)
  );
}

@fragment
fn fragmentMain(input: VertexOutput) -> @location(0) vec4<f32> {
  let position = input.uv * vec2<f32>(grid.size) - vec2<f32>(0.5);
  let base = vec2<i32>(floor(position));
  let fraction = position - vec2<f32>(base);
  var weightsX = cubicWeights(fraction.x);
  var weightsY = cubicWeights(fraction.y);

  // 4x4 近傍の光学密度を三次補間する。密度（対数空間）で補間してから
  // 指数を取るため、濃淡の境界が滑らかにつながる。
  var density = vec3<f32>(0.0);
  for (var j = 0; j < 4; j++) {
    var row = vec3<f32>(0.0);
    for (var i = 0; i < 4; i++) {
      row += densityAt(base.x + i - 1, base.y + j - 1) * weightsX[i];
    }
    density += row * weightsY[j];
  }
  let color = exp(-max(density, vec3<f32>(0.0)));
  return vec4<f32>(color, 1.0);
}
`;

export class WebGpuInkRenderer {
  private readonly context: GpuCanvasContext;
  private readonly device: GpuDevice;
  private readonly format: string;
  private readonly pipeline: GpuRenderPipeline;
  private gridBuffer: GpuBuffer;
  private bindGroup: GpuBindGroup | null = null;
  private gridInfo = new Uint32Array(4);
  private boundStateVersion = -1;

  private constructor(canvas: HTMLCanvasElement, device: GpuDevice, format: string, context: GpuCanvasContext) {
    this.device = device;
    this.format = format;
    this.context = context;
    const module = device.createShaderModule({ code: shader });
    this.pipeline = device.createRenderPipeline({
      layout: 'auto',
      vertex: { module, entryPoint: 'vertexMain' },
      fragment: { module, entryPoint: 'fragmentMain', targets: [{ format }] },
      primitive: { topology: 'triangle-list' },
    });
    this.gridBuffer = device.createBuffer({
      size: this.gridInfo.byteLength,
      usage: GPU_BUFFER_USAGE_COPY_DST | GPU_BUFFER_USAGE_UNIFORM,
    });
    this.configure(canvas);
  }

  public static async create(canvas: HTMLCanvasElement): Promise<WebGpuInkRenderer | null> {
    const gpu = (navigator as Navigator & { gpu?: GpuApi }).gpu;
    if (!gpu) return null;

    try {
      const adapter = await gpu.requestAdapter();
      if (!adapter) return null;
      const device = await adapter.requestDevice();
      const context = canvas.getContext('webgpu') as unknown as GpuCanvasContext | null;
      if (!context) return null;
      return new WebGpuInkRenderer(canvas, device, gpu.getPreferredCanvasFormat(), context);
    } catch {
      return null;
    }
  }

  public createSolver(grid: FluidGrid): WebGpuFluidSolver {
    return new WebGpuFluidSolver(grid, this.device);
  }

  public resize(gw: number, gh: number): void {
    this.gridInfo = new Uint32Array([gw, gh, 0, 0]);
    this.device.queue.writeBuffer(this.gridBuffer, 0, this.gridInfo);
    this.boundStateVersion = -1;
  }

  public initSmoothing(): void {
    // 格子補間はフラグメントシェーダーで行うため Canvas 2D の設定は不要。
  }

  public render(solver: WebGpuFluidSolver, _W: number, _H: number): void {
    solver.flushOperations();
    if (this.boundStateVersion !== solver.stateVersion || !this.bindGroup) {
      this.bindGroup = this.device.createBindGroup({
        layout: this.pipeline.getBindGroupLayout(0),
        entries: [
          { binding: 0, resource: { buffer: solver.stateBuffer } },
          { binding: 1, resource: { buffer: this.gridBuffer } },
        ],
      });
      this.boundStateVersion = solver.stateVersion;
    }

    const encoder = this.device.createCommandEncoder();
    const pass = encoder.beginRenderPass({
      colorAttachments: [{
        view: this.context.getCurrentTexture().createView(),
        clearValue: { r: 1, g: 1, b: 1, a: 1 },
        loadOp: 'clear',
        storeOp: 'store',
      }],
    });
    pass.setPipeline(this.pipeline);
    pass.setBindGroup(0, this.bindGroup);
    pass.draw(3);
    pass.end();
    this.device.queue.submit([encoder.finish()]);
  }

  private configure(canvas: HTMLCanvasElement): void {
    this.context.configure({ device: this.device, format: this.format, alphaMode: 'premultiplied' });
    canvas.addEventListener('webgpucontextlost', () => window.location.reload(), { once: true });
  }
}
