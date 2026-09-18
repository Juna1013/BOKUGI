import {
  ABS,
  PIGMENT_DENSITY,
  FIBER_ANISO,
  GRAIN_AMPLITUDE_WET,
  GRAIN_AMPLITUDE_DRY,
  GRAIN_KNEE_DENSITY,
  FIBER_WARP_CELLS,
  FIBER_WARP_GRADIENT_KNEE,
  GLOSS_STRENGTH,
} from '../config.ts';
import { WebGpuFluidSolver, TILE_SIZE } from '../physics/WebGpuFluidSolver.ts';
import type { FluidGrid } from '../physics/FluidGrid.ts';
import { describeGpu, type GpuProfile } from '../quality/DeviceProfile.ts';
import type { ShadingDetail } from '../quality/FrameBudgetMonitor.ts';
import {
  GPU_BUFFER_USAGE_COPY_DST,
  GPU_BUFFER_USAGE_MAP_READ,
  GPU_BUFFER_USAGE_UNIFORM,
  GPU_COPY_BYTES_PER_ROW_ALIGNMENT,
  GPU_MAP_MODE_READ,
  GPU_TEXTURE_USAGE_COPY_SRC,
  GPU_TEXTURE_USAGE_RENDER_ATTACHMENT,
  GPU_TEXTURE_USAGE_STORAGE_BINDING,
  GPU_TEXTURE_USAGE_TEXTURE_BINDING,
  type GpuApi,
  type GpuBindGroup,
  type GpuBuffer,
  type GpuCanvasContext,
  type GpuCommandEncoder,
  type GpuComputePipeline,
  type GpuDevice,
  type GpuRenderPipeline,
  type GpuSampler,
  type GpuTexture,
  type GpuTextureView,
} from './WebGpuTypes.ts';

/**
 * 描画パイプライン。
 *
 * 1. shade（compute）: 格子の各セルで Lambert-Beer の光学密度を求め、rgba16float の
 *    テクスチャに書く（rgb = 密度、a = 水分）。
 * 2. bakePaper（compute）: 紙目・繊維方向・浸透率を別テクスチャに焼く。紙の場が
 *    置き換わった時だけ。
 * 3. fragment: 画素ごとにテクスチャを読む。格子は 3 px だが、ここで画面解像度の
 *    表現を足す。
 *    - 繊維に沿った毛羽: 密度の読み出し位置を繊維方向へノイズでずらし、滲みの縁を繊維状にする。
 *    - 紙の粒状感: 紙の微細な高低で光学密度（= 光路長）を揺らす。乾くほど強い。
 *    - 濡れの艶: 水面の傾きと紙の微細法線から鏡面反射を求め、濡れた墨を紙色へ寄せる。
 *
 * 以前はフラグメントが 64 バイトのセル構造体を画素あたり 16 回ストレージバッファから
 * 読んでいた。テクスチャにしたのは、モバイル GPU ではテクスチャキャッシュ経由の
 * 8 バイト読み出しの方がはるかに軽いため。
 */
const shader = /* wgsl */ `
struct GridInfo {
  size: vec2<u32>,
  cellSize: f32,
  detail: f32,
};

struct FluidCell {
  fluid: vec4<f32>,       // water, velocity x, velocity y, pigment 0
  pigments: vec4<f32>,   // pigment 1, pigment 2, fixed 0, fixed 1
  material: vec4<f32>,   // fixed 2, permeability, ambient x, ambient y
  paper: vec4<f32>,      // grain, fiber A·cos2θ, fiber A·sin2θ, unused
};

// ---- 格子 → テクスチャ（compute） ----
@group(0) @binding(0) var<storage, read> cells: array<FluidCell>;
@group(0) @binding(1) var<uniform> grid: GridInfo;
@group(0) @binding(2) var densityOut: texture_storage_2d<rgba16float, write>;
@group(0) @binding(2) var paperOut: texture_storage_2d<rgba16float, write>;

// 密度への掛け算で入る揺らぎの減衰率。薄い所は 1、密度が knee を越えるにつれ
// 1 / (1 + d / knee) に落ち、対数空間の振れ幅が密度に比例して膨らむのを止める。
fn grainDamping(density: vec3<f32>) -> f32 {
  let mean = max(dot(density, vec3<f32>(1.0 / 3.0)), 0.0);
  return 1.0 / (1.0 + mean / ${GRAIN_KNEE_DENSITY});
}

// セルの光学密度（Lambert-Beer の指数部）。紙目の係数もここで掛けておく。
@compute @workgroup_size(${TILE_SIZE}, ${TILE_SIZE})
fn shade(@builtin(global_invocation_id) id: vec3<u32>) {
  if (id.x >= grid.size.x || id.y >= grid.size.y) { return; }
  let cell = cells[id.y * grid.size.x + id.x];
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
  let base = absorption * ${PIGMENT_DENSITY} + vec3<f32>(cell.fluid.x * 0.05);
  // 紙目の係数も密度への掛け算なので、濃い所では振れ幅を抑える（fragment の粒と同じ扱い）。
  let density = base * (1.0 + (cell.paper.x - 1.0) * grainDamping(base));
  textureStore(densityOut, vec2<i32>(id.xy), vec4<f32>(density, cell.fluid.x));
}

@compute @workgroup_size(${TILE_SIZE}, ${TILE_SIZE})
fn bakePaper(@builtin(global_invocation_id) id: vec3<u32>) {
  if (id.x >= grid.size.x || id.y >= grid.size.y) { return; }
  let cell = cells[id.y * grid.size.x + id.x];
  textureStore(paperOut, vec2<i32>(id.xy), vec4<f32>(cell.paper.x, cell.paper.y, cell.paper.z, cell.material.y));
}

// ---- テクスチャ → 画面（render） ----
@group(0) @binding(0) var densityTex: texture_2d<f32>;
@group(0) @binding(1) var paperTex: texture_2d<f32>;
@group(0) @binding(2) var linearSampler: sampler;
@group(0) @binding(3) var<uniform> view: GridInfo;

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

fn hash12(p: vec2<f32>) -> f32 {
  var p3 = fract(vec3<f32>(p.x, p.y, p.x) * 0.1031);
  p3 += dot(p3, p3.yzx + 33.33);
  return fract((p3.x + p3.y) * p3.z);
}

// 画面座標で評価する Value Noise。フレーム間で不変なので、紙の模様として静止して見える。
fn valueNoise(p: vec2<f32>) -> f32 {
  let cellId = floor(p);
  let f = fract(p);
  let u = f * f * (3.0 - 2.0 * f);
  let a = hash12(cellId);
  let b = hash12(cellId + vec2<f32>(1.0, 0.0));
  let c = hash12(cellId + vec2<f32>(0.0, 1.0));
  let d = hash12(cellId + vec2<f32>(1.0, 1.0));
  return mix(mix(a, b, u.x), mix(c, d, u.x), u.y);
}

const PI = 3.14159265;
const STREAK_BINS = 8.0;

// 固定した向きの座標系で評価する繊維の筋。繊維に沿って長く（周期 11 px）、直交方向に細かい（1.7 px）。
fn streakAt(css: vec2<f32>, bin: f32) -> f32 {
  let wrapped = bin - STREAK_BINS * floor(bin / STREAK_BINS);
  let angle = (wrapped / STREAK_BINS - 0.5) * PI;
  let dir = vec2<f32>(cos(angle), sin(angle));
  let perp = vec2<f32>(-dir.y, dir.x);
  return valueNoise(vec2<f32>(dot(css, dir) / 11.0, dot(css, perp) / 1.7) + vec2<f32>(wrapped * 37.0, wrapped * 11.0));
}

// 繊維の向き θ ∈ (-π/2, π/2] に沿った筋。向きを 8 方向に量子化し、隣り合う 2 方向を混ぜる。
// 画素ごとの向きでそのまま座標を回すと、向きが変わる所で座標系が渦を巻いて
// 指紋のような同心円の筋が出る。固定した方向の座標系なら筋は真っ直ぐ走る。
fn streakNoise(css: vec2<f32>, theta: f32) -> f32 {
  let binPosition = (theta / PI + 0.5) * STREAK_BINS;
  let bin = floor(binPosition);
  let t = binPosition - bin;
  return mix(streakAt(css, bin), streakAt(css, bin + 1.0), smoothstep(0.0, 1.0, t));
}

fn densityAt(x: i32, y: i32) -> vec4<f32> {
  let clamped = clamp(vec2<i32>(x, y), vec2<i32>(0), vec2<i32>(view.size) - vec2<i32>(1));
  return textureLoad(densityTex, clamped, 0);
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

// 4x4 近傍の光学密度を三次補間する。密度（対数空間）で補間してから
// 指数を取るため、濃淡の境界が滑らかにつながる。
fn cubicSample(position: vec2<f32>) -> vec4<f32> {
  let base = vec2<i32>(floor(position));
  let fraction = position - vec2<f32>(base);
  var weightsX = cubicWeights(fraction.x);
  var weightsY = cubicWeights(fraction.y);
  var sum = vec4<f32>(0.0);
  for (var j = 0; j < 4; j++) {
    var row = vec4<f32>(0.0);
    for (var i = 0; i < 4; i++) {
      row += densityAt(base.x + i - 1, base.y + j - 1) * weightsX[i];
    }
    sum += row * weightsY[j];
  }
  return sum;
}

@fragment
fn fragmentMain(input: VertexOutput) -> @location(0) vec4<f32> {
  let sizeF = vec2<f32>(view.size);
  let full = view.detail > 0.5;
  // CSS px 座標。描画 DPR が変わっても紙の模様が動かないよう、格子基準で取る。
  let css = input.uv * sizeF * view.cellSize;

  // 紙: grain, A·cos2θ, A·sin2θ, 浸透率。格子より粗い場なので双線形で十分。
  let paper = textureSampleLevel(paperTex, linearSampler, input.uv, 0.0);
  let aniso = paper.yz;
  let alignment = clamp(length(aniso) / ${FIBER_ANISO}, 0.0, 1.0);
  let theta = 0.5 * atan2(aniso.y, aniso.x);
  let fiberDir = vec2<f32>(cos(theta), sin(theta));

  // 紙の微細な高低。繊維に沿った筋と、等方の粒（2 オクターブ）を重ねる。
  let streak = streakNoise(css, theta);
  let fine = valueNoise(css / 2.3);
  let coarse = valueNoise(css / 5.0 + vec2<f32>(7.1, 3.3));
  let height = mix(mix(fine, coarse, 0.55), streak, 0.15 + 0.25 * alignment);

  var position = input.uv * sizeF - vec2<f32>(0.5);
  // 軸方向の隣（半セル先）を先に読む。rgb の差は密度勾配（毛羽の抑え）、a の差は水面の傾き（艶）に使う。
  let texel = vec2<f32>(0.5) / sizeF;
  var slope = vec2<f32>(0.0);
  if (full) {
    let left = textureSampleLevel(densityTex, linearSampler, input.uv - vec2<f32>(texel.x, 0.0), 0.0);
    let right = textureSampleLevel(densityTex, linearSampler, input.uv + vec2<f32>(texel.x, 0.0), 0.0);
    let up = textureSampleLevel(densityTex, linearSampler, input.uv - vec2<f32>(0.0, texel.y), 0.0);
    let down = textureSampleLevel(densityTex, linearSampler, input.uv + vec2<f32>(0.0, texel.y), 0.0);
    slope = vec2<f32>(right.a - left.a, down.a - up.a);
    let gradient = length(vec2<f32>(
      dot(right.rgb - left.rgb, vec3<f32>(1.0 / 3.0)),
      dot(down.rgb - up.rgb, vec3<f32>(1.0 / 3.0))
    ));
    // 繊維に沿って読み出し位置をずらす。滲みの縁が繊維の向きに毛羽立つ。
    // 上塗りの縁のように密度が急に変わる所では、ずらしが画素大のギザギザになるので寝かせる。
    let warpDamping = 1.0 / (1.0 + gradient / ${FIBER_WARP_GRADIENT_KNEE});
    position += fiberDir * (streak - 0.5) * ${FIBER_WARP_CELLS} * (0.4 + 0.6 * alignment) * warpDamping;
  }
  var sampled: vec4<f32>;
  if (full) {
    sampled = cubicSample(position);
  } else {
    sampled = textureSampleLevel(densityTex, linearSampler, (position + vec2<f32>(0.5)) / sizeF, 0.0);
  }

  let water = max(sampled.a, 0.0);
  let dry = 1.0 - min(water * 6.0, 1.0);
  // 紙の谷に沈んだ顔料ほど光路が長い。乾くほど粒が立つ。
  let grainAmplitude = mix(${GRAIN_AMPLITUDE_WET}, ${GRAIN_AMPLITUDE_DRY}, dry);
  let base = max(sampled.rgb, vec3<f32>(0.0));
  // 濃い墨ほど紙の目が沈む。揺らぎを密度で飽和させ、上塗りが画素大の斑にならないようにする。
  let density = base * (1.0 + (height - 0.5) * 2.0 * grainAmplitude * grainDamping(base));
  var color = exp(-density);

  if (full) {
    // 濡れた墨の艶。水面の傾き（格子）と紙の微細法線（画素）から鏡面反射を求める。
    let heightX = valueNoise((css + vec2<f32>(1.0, 0.0)) / 2.3) - fine;
    let heightY = valueNoise((css + vec2<f32>(0.0, 1.0)) / 2.3) - fine;
    let normal = normalize(vec3<f32>(-slope * 6.0 - vec2<f32>(heightX, heightY) * 0.6, 1.0));
    let lightDir = normalize(vec3<f32>(-0.35, -0.55, 0.75));
    let halfVector = normalize(lightDir + vec3<f32>(0.0, 0.0, 1.0));
    let specular = pow(max(dot(normal, halfVector), 0.0), 28.0);
    let wetness = smoothstep(0.03, 0.35, water);
    // 乗算合成なので紙より明るくはできない。墨がある所だけ紙色へ寄せて艶にする。
    let inkAmount = 1.0 - dot(color, vec3<f32>(1.0 / 3.0));
    color = mix(color, vec3<f32>(1.0), specular * wetness * inkAmount * ${GLOSS_STRENGTH});
  }
  return vec4<f32>(color, 1.0);
}
`;

const UNIFORM_BYTES = 16;

export class WebGpuInkRenderer {
  public readonly profile: GpuProfile;
  private readonly context: GpuCanvasContext;
  private readonly device: GpuDevice;
  private readonly format: string;
  private readonly shadePipeline: GpuComputePipeline;
  private readonly bakePipeline: GpuComputePipeline;
  private readonly renderPipeline: GpuRenderPipeline;
  private readonly sampler: GpuSampler;
  private readonly uniformBuffer: GpuBuffer;
  private readonly uniformData = new ArrayBuffer(UNIFORM_BYTES);
  private detail: ShadingDetail = 'full';
  private gridWidth = 0;
  private gridHeight = 0;
  private cellSize = 3;
  private densityTexture: GpuTexture | null = null;
  private paperTexture: GpuTexture | null = null;
  private densityView: GpuTextureView = null;
  private paperView: GpuTextureView = null;
  private renderBindGroup: GpuBindGroup | null = null;
  private readonly shadeBindGroups = new Map<GpuBuffer, GpuBindGroup>();
  private readonly bakeBindGroups = new Map<GpuBuffer, GpuBindGroup>();
  private bakedFieldVersion = -1;

  private constructor(
    device: GpuDevice,
    format: string,
    context: GpuCanvasContext,
    profile: GpuProfile,
  ) {
    this.device = device;
    this.format = format;
    this.context = context;
    this.profile = profile;
    const module = device.createShaderModule({ code: shader });
    this.shadePipeline = device.createComputePipeline({ layout: 'auto', compute: { module, entryPoint: 'shade' } });
    this.bakePipeline = device.createComputePipeline({ layout: 'auto', compute: { module, entryPoint: 'bakePaper' } });
    this.renderPipeline = device.createRenderPipeline({
      layout: 'auto',
      vertex: { module, entryPoint: 'vertexMain' },
      fragment: { module, entryPoint: 'fragmentMain', targets: [{ format }] },
      primitive: { topology: 'triangle-list' },
    });
    this.sampler = device.createSampler({
      magFilter: 'linear',
      minFilter: 'linear',
      addressModeU: 'clamp-to-edge',
      addressModeV: 'clamp-to-edge',
    });
    this.uniformBuffer = device.createBuffer({
      size: UNIFORM_BYTES,
      usage: GPU_BUFFER_USAGE_COPY_DST | GPU_BUFFER_USAGE_UNIFORM,
    });
    this.configure();
  }

  public static async create(canvas: HTMLCanvasElement): Promise<WebGpuInkRenderer | null> {
    const gpu = (navigator as Navigator & { gpu?: GpuApi }).gpu;
    if (!gpu) return null;

    try {
      // ノート PC では省電力側の GPU を避ける。電話には GPU が一つなので影響しない。
      const adapter =
        (await gpu.requestAdapter({ powerPreference: 'high-performance' })) ??
        (await gpu.requestAdapter());
      if (!adapter) return null;
      const profile = describeGpu(adapter);
      // SwiftShader 等のソフトウェア実装は、画素シェーディングを含めると CPU パスより遅い。
      if (profile.isFallback) return null;
      const device = await adapter.requestDevice();
      const context = canvas.getContext('webgpu') as unknown as GpuCanvasContext | null;
      if (!context) return null;
      return new WebGpuInkRenderer(device, gpu.getPreferredCanvasFormat(), context, profile);
    } catch {
      return null;
    }
  }

  public createSolver(grid: FluidGrid): WebGpuFluidSolver {
    return new WebGpuFluidSolver(grid, this.device);
  }

  /** 格子の寸法が変わった。中間テクスチャを作り直す。 */
  public resize(grid: FluidGrid): void {
    this.gridWidth = grid.gw;
    this.gridHeight = grid.gh;
    this.cellSize = grid.CS;
    this.densityTexture?.destroy();
    this.paperTexture?.destroy();
    const descriptor = {
      size: [grid.gw, grid.gh],
      format: 'rgba16float',
      usage: GPU_TEXTURE_USAGE_STORAGE_BINDING | GPU_TEXTURE_USAGE_TEXTURE_BINDING,
    };
    this.densityTexture = this.device.createTexture(descriptor);
    this.paperTexture = this.device.createTexture(descriptor);
    this.densityView = this.densityTexture.createView();
    this.paperView = this.paperTexture.createView();
    this.shadeBindGroups.clear();
    this.bakeBindGroups.clear();
    this.bakedFieldVersion = -1;
    this.renderBindGroup = this.device.createBindGroup({
      layout: this.renderPipeline.getBindGroupLayout(0),
      entries: [
        { binding: 0, resource: this.densityView },
        { binding: 1, resource: this.paperView },
        { binding: 2, resource: this.sampler },
        { binding: 3, resource: { buffer: this.uniformBuffer } },
      ],
    });
    this.writeUniform();
  }

  public initSmoothing(): void {
    // 格子補間はフラグメントシェーダーで行うため Canvas 2D の設定は不要。
  }

  /** 画素シェーディングの段階。FrameBudgetMonitor が端末の余裕に応じて切り替える。 */
  public setDetail(detail: ShadingDetail): void {
    if (this.detail === detail) return;
    this.detail = detail;
    this.writeUniform();
  }

  public render(solver: WebGpuFluidSolver, _W: number, _H: number): void {
    if (!this.renderBindGroup) return;
    solver.flushOperations();
    const encoder = this.device.createCommandEncoder();
    this.encodeFrame(encoder, solver, this.context.getCurrentTexture().createView());
    this.device.queue.submit([encoder.finish()]);
  }

  /**
   * 画面と同じシェーダーでオフスクリーンに描き、読み戻して Canvas 2D へ写す。
   * 作品カードの書き出し用。表示キャンバスは提示後に内容が破棄されうるので
   * 直接は読まない。
   */
  public async renderToCanvas(solver: WebGpuFluidSolver, target: HTMLCanvasElement): Promise<void> {
    if (!this.renderBindGroup) throw new Error('GPU 描画の準備ができていません');
    const width = target.width;
    const height = target.height;
    const limit = this.device.limits['maxTextureDimension2D'] ?? this.profile.maxTextureDimension2D;
    if (width > limit || height > limit) {
      throw new Error(`書き出しサイズ ${width}×${height} が GPU の上限 ${limit} を超えています`);
    }
    const ctx = target.getContext('2d');
    if (!ctx) throw new Error('書き出し用 Canvas 2D を取得できませんでした');

    solver.flushOperations();
    const texture = this.device.createTexture({
      size: [width, height],
      format: this.format,
      usage: GPU_TEXTURE_USAGE_RENDER_ATTACHMENT | GPU_TEXTURE_USAGE_COPY_SRC,
    });
    const bytesPerRow = Math.ceil((width * 4) / GPU_COPY_BYTES_PER_ROW_ALIGNMENT) * GPU_COPY_BYTES_PER_ROW_ALIGNMENT;
    const staging = this.device.createBuffer({
      size: bytesPerRow * height,
      usage: GPU_BUFFER_USAGE_MAP_READ | GPU_BUFFER_USAGE_COPY_DST,
    });

    try {
      const encoder = this.device.createCommandEncoder();
      this.encodeFrame(encoder, solver, texture.createView());
      encoder.copyTextureToBuffer(
        { texture },
        { buffer: staging, bytesPerRow, rowsPerImage: height },
        [width, height],
      );
      this.device.queue.submit([encoder.finish()]);

      await staging.mapAsync(GPU_MAP_MODE_READ);
      try {
        const source = new Uint8Array(staging.getMappedRange());
        const image = ctx.createImageData(width, height);
        const pixels = image.data;
        const rowBytes = width * 4;
        const swapRedBlue = this.format.startsWith('bgra');
        for (let y = 0; y < height; y++) {
          const row = source.subarray(y * bytesPerRow, y * bytesPerRow + rowBytes);
          pixels.set(row, y * rowBytes);
        }
        if (swapRedBlue) {
          for (let i = 0; i < pixels.length; i += 4) {
            const blue = pixels[i] ?? 0;
            pixels[i] = pixels[i + 2] ?? 0;
            pixels[i + 2] = blue;
          }
        }
        ctx.putImageData(image, 0, 0);
      } finally {
        staging.unmap();
      }
    } finally {
      staging.destroy();
      texture.destroy();
    }
  }

  private encodeFrame(encoder: GpuCommandEncoder, solver: WebGpuFluidSolver, target: GpuTextureView): void {
    const stateBuffer = solver.stateBuffer;
    const compute = encoder.beginComputePass();
    if (this.bakedFieldVersion !== solver.fieldVersion) {
      compute.setPipeline(this.bakePipeline);
      compute.setBindGroup(0, this.computeBindGroup(this.bakeBindGroups, this.bakePipeline, stateBuffer, this.paperView));
      compute.dispatchWorkgroups(Math.ceil(this.gridWidth / TILE_SIZE), Math.ceil(this.gridHeight / TILE_SIZE));
      this.bakedFieldVersion = solver.fieldVersion;
    }
    compute.setPipeline(this.shadePipeline);
    compute.setBindGroup(0, this.computeBindGroup(this.shadeBindGroups, this.shadePipeline, stateBuffer, this.densityView));
    compute.dispatchWorkgroups(Math.ceil(this.gridWidth / TILE_SIZE), Math.ceil(this.gridHeight / TILE_SIZE));
    compute.end();

    const pass = encoder.beginRenderPass({
      colorAttachments: [{
        view: target,
        clearValue: { r: 1, g: 1, b: 1, a: 1 },
        loadOp: 'clear',
        storeOp: 'store',
      }],
    });
    pass.setPipeline(this.renderPipeline);
    pass.setBindGroup(0, this.renderBindGroup);
    pass.draw(3);
    pass.end();
  }

  /** 状態バッファは 2 枚をピンポンするので、バッファごとにバインドグループを持ち回す。 */
  private computeBindGroup(
    cache: Map<GpuBuffer, GpuBindGroup>,
    pipeline: GpuComputePipeline,
    stateBuffer: GpuBuffer,
    textureView: GpuTextureView,
  ): GpuBindGroup {
    const cached = cache.get(stateBuffer);
    if (cached) return cached;
    const bindGroup = this.device.createBindGroup({
      layout: pipeline.getBindGroupLayout(0),
      entries: [
        { binding: 0, resource: { buffer: stateBuffer } },
        { binding: 1, resource: { buffer: this.uniformBuffer } },
        { binding: 2, resource: textureView },
      ],
    });
    cache.set(stateBuffer, bindGroup);
    return bindGroup;
  }

  private writeUniform(): void {
    new Uint32Array(this.uniformData, 0, 2).set([this.gridWidth, this.gridHeight]);
    new Float32Array(this.uniformData, 8, 2).set([this.cellSize, this.detail === 'full' ? 1 : 0]);
    this.device.queue.writeBuffer(this.uniformBuffer, 0, new Uint8Array(this.uniformData));
  }

  private configure(): void {
    this.context.configure({ device: this.device, format: this.format, alphaMode: 'premultiplied' });
    this.watchDeviceLoss();
  }

  /**
   * WebGPU にはキャンバスの contextlost イベントが無く、デバイス喪失は
   * device.lost の解決で通知される。失われたデバイスへの submit は黙って
   * 捨てられ画面が固まるため、再読み込みして新しいデバイスで作り直す。
   */
  private watchDeviceLoss(): void {
    void this.device.lost.then((info) => {
      if (info.reason === 'destroyed') return;
      console.error('WebGPU デバイスが失われました。再読み込みします。', info.message);
      window.location.reload();
    });
  }
}
