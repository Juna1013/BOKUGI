/**
 * 使う範囲だけを手書きした WebGPU の型。@webgpu/types を入れずに済ませるための最小集合で、
 * 記述子は Record<string, unknown> のまま渡す。
 */
export type GpuApi = {
  requestAdapter: (options?: Record<string, unknown>) => Promise<GpuAdapter | null>;
  getPreferredCanvasFormat: () => string;
};

export type GpuAdapterInfo = {
  vendor?: string;
  architecture?: string;
  device?: string;
  description?: string;
  isFallbackAdapter?: boolean;
};

export type GpuAdapter = {
  requestDevice: (descriptor?: Record<string, unknown>) => Promise<GpuDevice>;
  /** Chrome 128+ / Safari 26+。古い実装では undefined。 */
  info?: GpuAdapterInfo;
  /** 旧 API。info.isFallbackAdapter に移った。 */
  isFallbackAdapter?: boolean;
  features: { has: (name: string) => boolean };
  limits: Record<string, number>;
};

export type GpuDevice = {
  createBuffer: (descriptor: Record<string, unknown>) => GpuBuffer;
  createTexture: (descriptor: Record<string, unknown>) => GpuTexture;
  createSampler: (descriptor?: Record<string, unknown>) => GpuSampler;
  createShaderModule: (descriptor: Record<string, unknown>) => unknown;
  createRenderPipeline: (descriptor: Record<string, unknown>) => GpuRenderPipeline;
  createComputePipeline: (descriptor: Record<string, unknown>) => GpuComputePipeline;
  createBindGroup: (descriptor: Record<string, unknown>) => GpuBindGroup;
  queue: {
    writeBuffer: (buffer: GpuBuffer, offset: number, data: ArrayBufferView) => void;
    submit: (commands: unknown[]) => void;
    onSubmittedWorkDone: () => Promise<void>;
  };
  createCommandEncoder: () => GpuCommandEncoder;
  limits: Record<string, number>;
  features: { has: (name: string) => boolean };
  /** デバイスが失われた時に解決する。'destroyed' は自前で destroy() した場合。 */
  lost: Promise<GpuDeviceLostInfo>;
};

export type GpuDeviceLostInfo = {
  reason: 'destroyed' | 'unknown' | undefined;
  message: string;
};

export type GpuBuffer = {
  mapAsync: (mode: number) => Promise<void>;
  getMappedRange: () => ArrayBuffer;
  unmap: () => void;
  destroy: () => void;
};

export type GpuTexture = {
  createView: (descriptor?: Record<string, unknown>) => GpuTextureView;
  destroy: () => void;
};
export type GpuTextureView = unknown;
export type GpuSampler = unknown;

export type GpuRenderPipeline = { getBindGroupLayout: (index: number) => unknown };
export type GpuComputePipeline = { getBindGroupLayout: (index: number) => unknown };
export type GpuBindGroup = unknown;

export type GpuCommandEncoder = {
  beginRenderPass: (descriptor: Record<string, unknown>) => GpuRenderPass;
  beginComputePass: () => GpuComputePass;
  copyBufferToBuffer: (
    source: GpuBuffer,
    sourceOffset: number,
    destination: GpuBuffer,
    destinationOffset: number,
    size: number,
  ) => void;
  copyTextureToBuffer: (
    source: Record<string, unknown>,
    destination: Record<string, unknown>,
    copySize: readonly number[],
  ) => void;
  finish: () => unknown;
};

export type GpuRenderPass = {
  setPipeline: (pipeline: GpuRenderPipeline) => void;
  setBindGroup: (index: number, bindGroup: GpuBindGroup) => void;
  draw: (vertexCount: number) => void;
  end: () => void;
};

export type GpuComputePass = {
  setPipeline: (pipeline: GpuComputePipeline) => void;
  setBindGroup: (index: number, bindGroup: GpuBindGroup) => void;
  dispatchWorkgroups: (x: number, y?: number, z?: number) => void;
  end: () => void;
};

export type GpuCanvasContext = {
  configure: (configuration: Record<string, unknown>) => void;
  getCurrentTexture: () => GpuTexture;
};

export const GPU_MAP_MODE_READ = 0x0001;
export const GPU_BUFFER_USAGE_MAP_READ = 0x0001;
export const GPU_BUFFER_USAGE_COPY_SRC = 0x0004;
export const GPU_BUFFER_USAGE_COPY_DST = 0x0008;
export const GPU_BUFFER_USAGE_UNIFORM = 0x0040;
export const GPU_BUFFER_USAGE_STORAGE = 0x0080;

export const GPU_TEXTURE_USAGE_COPY_SRC = 0x01;
export const GPU_TEXTURE_USAGE_TEXTURE_BINDING = 0x04;
export const GPU_TEXTURE_USAGE_STORAGE_BINDING = 0x08;
export const GPU_TEXTURE_USAGE_RENDER_ATTACHMENT = 0x10;

/** copyTextureToBuffer の bytesPerRow はこの倍数でなければならない。 */
export const GPU_COPY_BYTES_PER_ROW_ALIGNMENT = 256;
