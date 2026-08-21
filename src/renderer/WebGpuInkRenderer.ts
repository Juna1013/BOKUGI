import { ABS, PIGMENT_DENSITY } from '../config.ts';
import type { FluidGrid } from '../physics/FluidGrid.ts';

/**
 * WebGPU の型定義は TypeScript の標準 DOM lib に含まれないため、ここでは
 * 実行時に利用する API の形だけを宣言する。WebGPU 非対応環境では生成されない。
 */
type GpuApi = {
  requestAdapter: () => Promise<GpuAdapter | null>;
  getPreferredCanvasFormat: () => string;
};

type GpuAdapter = { requestDevice: () => Promise<GpuDevice> };
type GpuDevice = {
  createBuffer: (descriptor: Record<string, unknown>) => GpuBuffer;
  createShaderModule: (descriptor: Record<string, unknown>) => unknown;
  createRenderPipeline: (descriptor: Record<string, unknown>) => GpuPipeline;
  createBindGroup: (descriptor: Record<string, unknown>) => GpuBindGroup;
  queue: {
    writeBuffer: (buffer: GpuBuffer, offset: number, data: ArrayBufferView) => void;
    submit: (commands: unknown[]) => void;
  };
  createCommandEncoder: () => GpuCommandEncoder;
};
type GpuBuffer = unknown;
type GpuPipeline = { getBindGroupLayout: (index: number) => unknown };
type GpuBindGroup = unknown;
type GpuCommandEncoder = {
  beginRenderPass: (descriptor: Record<string, unknown>) => GpuRenderPass;
  finish: () => unknown;
};
type GpuRenderPass = {
  setPipeline: (pipeline: GpuPipeline) => void;
  setBindGroup: (index: number, bindGroup: GpuBindGroup) => void;
  draw: (vertexCount: number) => void;
  end: () => void;
};
type GpuCanvasContext = {
  configure: (configuration: Record<string, unknown>) => void;
  getCurrentTexture: () => { createView: () => unknown };
};

const GPU_BUFFER_USAGE_STORAGE = 0x0080;
const GPU_BUFFER_USAGE_COPY_DST = 0x0008;

const shader = /* wgsl */ `
struct GridInfo {
  size: vec2<u32>,
  _padding: vec2<u32>,
};

// vec4 を2つ並べ、CPU 側の8 float（32 bytes）と stride を厳密に一致させる。
// f32 の直後に vec3 を置くと WGSL の16-byte alignmentで隙間が生じるため不可。
struct Cell {
  pigmentAndWater: vec4<f32>,
  material: vec4<f32>, // grain, unused, unused, unused
};

@group(0) @binding(0) var<storage, read> cells: array<Cell>;
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
  // WebGPU の NDC はY上向き、格子と Pointer Events はY下向き。
  output.uv = vec2<f32>(
    positions[index].x * 0.5 + 0.5,
    0.5 - positions[index].y * 0.5
  );
  return output;
}

fn cellAt(x: u32, y: u32) -> Cell {
  return cells[y * grid.size.x + x];
}

@fragment
fn fragmentMain(input: VertexOutput) -> @location(0) vec4<f32> {
  let dimensions = vec2<f32>(grid.size);
  let position = clamp(input.uv * dimensions - vec2<f32>(0.5), vec2<f32>(0.0), dimensions - vec2<f32>(1.001));
  let base = vec2<u32>(floor(position));
  let next = min(base + vec2<u32>(1u), grid.size - vec2<u32>(1u));
  let fraction = fract(position);

  let topLeft = cellAt(base.x, base.y);
  let topRight = cellAt(next.x, base.y);
  let bottomLeft = cellAt(base.x, next.y);
  let bottomRight = cellAt(next.x, next.y);
  let topPigment = mix(topLeft.pigmentAndWater, topRight.pigmentAndWater, fraction.x);
  let bottomPigment = mix(bottomLeft.pigmentAndWater, bottomRight.pigmentAndWater, fraction.x);
  let pigmentAndWater = mix(topPigment, bottomPigment, fraction.y);
  let topGrain = mix(topLeft.material.x, topRight.material.x, fraction.x);
  let bottomGrain = mix(bottomLeft.material.x, bottomRight.material.x, fraction.x);
  let grain = mix(topGrain, bottomGrain, fraction.y);
  let pigment = pigmentAndWater.rgb;
  let wetSheen = pigmentAndWater.a * 0.05;
  let absorption = vec3<f32>(
    pigment.x * ${ABS[0][0]} + pigment.y * ${ABS[1][0]} + pigment.z * ${ABS[2][0]},
    pigment.x * ${ABS[0][1]} + pigment.y * ${ABS[1][1]} + pigment.z * ${ABS[2][1]},
    pigment.x * ${ABS[0][2]} + pigment.y * ${ABS[1][2]} + pigment.z * ${ABS[2][2]}
  );
  let color = exp(-(absorption * ${PIGMENT_DENSITY} + vec3<f32>(wetSheen)) * grain);
  return vec4<f32>(color, 1.0);
}
`;

export class WebGpuInkRenderer {
  private readonly context: GpuCanvasContext;
  private readonly device: GpuDevice;
  private readonly format: string;
  private readonly pipeline: GpuPipeline;
  private cellBuffer: GpuBuffer | null = null;
  private gridBuffer: GpuBuffer | null = null;
  private bindGroup: GpuBindGroup | null = null;
  private cellData = new Float32Array(0);
  private gridInfo = new Uint32Array(4);
  private cellCount = 0;
  private gridWidth = 0;
  private gridHeight = 0;

  private constructor(canvas: HTMLCanvasElement, device: GpuDevice, format: string, context: GpuCanvasContext) {
    this.device = device;
    this.format = format;
    this.context = context;
    this.pipeline = device.createRenderPipeline({
      layout: 'auto',
      vertex: { module: device.createShaderModule({ code: shader }), entryPoint: 'vertexMain' },
      fragment: { module: device.createShaderModule({ code: shader }), entryPoint: 'fragmentMain', targets: [{ format }] },
      primitive: { topology: 'triangle-list' },
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

  public resize(gw: number, gh: number): void {
    if (this.gridWidth === gw && this.gridHeight === gh) return;
    this.gridWidth = gw;
    this.gridHeight = gh;
    this.gridInfo = new Uint32Array([gw, gh, 0, 0]);

    const cellCount = gw * gh;
    if (this.cellCount === cellCount) return;
    this.cellCount = cellCount;
    this.cellData = new Float32Array(cellCount * 8);
    this.cellBuffer = this.device.createBuffer({ size: this.cellData.byteLength, usage: GPU_BUFFER_USAGE_STORAGE | GPU_BUFFER_USAGE_COPY_DST });
    this.gridBuffer = this.device.createBuffer({ size: this.gridInfo.byteLength, usage: GPU_BUFFER_USAGE_COPY_DST | 0x0040 });
    this.bindGroup = this.device.createBindGroup({
      layout: this.pipeline.getBindGroupLayout(0),
      entries: [
        { binding: 0, resource: { buffer: this.cellBuffer } },
        { binding: 1, resource: { buffer: this.gridBuffer } },
      ],
    });
  }

  public initSmoothing(): void {
    // 格子補間はフラグメントシェーダーで行うため Canvas 2D の設定は不要。
  }

  public render(grid: FluidGrid, _W: number, _H: number): void {
    if (!this.cellBuffer || !this.gridBuffer || !this.bindGroup) return;
    const { N, d, p, w, grain } = grid;
    const cells = this.cellData;

    for (let i = 0; i < N; i++) {
      const offset = i * 8;
      cells[offset] = (d[0][i] ?? 0) * 1.15 + (p[0][i] ?? 0) * 0.55;
      cells[offset + 1] = (d[1][i] ?? 0) * 1.15 + (p[1][i] ?? 0) * 0.55;
      cells[offset + 2] = (d[2][i] ?? 0) * 1.15 + (p[2][i] ?? 0) * 0.55;
      cells[offset + 3] = w[i] ?? 0;
      cells[offset + 4] = grain[i] ?? 1;
    }

    this.device.queue.writeBuffer(this.cellBuffer, 0, cells);
    this.device.queue.writeBuffer(this.gridBuffer, 0, this.gridInfo);
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
