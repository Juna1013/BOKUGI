export type GpuApi = {
  requestAdapter: () => Promise<GpuAdapter | null>;
  getPreferredCanvasFormat: () => string;
};

export type GpuAdapter = { requestDevice: () => Promise<GpuDevice> };

export type GpuDevice = {
  createBuffer: (descriptor: Record<string, unknown>) => GpuBuffer;
  createShaderModule: (descriptor: Record<string, unknown>) => unknown;
  createRenderPipeline: (descriptor: Record<string, unknown>) => GpuRenderPipeline;
  createComputePipeline: (descriptor: Record<string, unknown>) => GpuComputePipeline;
  createBindGroup: (descriptor: Record<string, unknown>) => GpuBindGroup;
  queue: {
    writeBuffer: (buffer: GpuBuffer, offset: number, data: ArrayBufferView) => void;
    submit: (commands: unknown[]) => void;
  };
  createCommandEncoder: () => GpuCommandEncoder;
};

export type GpuBuffer = {
  mapAsync: (mode: number) => Promise<void>;
  getMappedRange: () => ArrayBuffer;
  unmap: () => void;
  destroy: () => void;
};

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
  getCurrentTexture: () => { createView: () => unknown };
};

export const GPU_MAP_MODE_READ = 0x0001;
export const GPU_BUFFER_USAGE_MAP_READ = 0x0001;
export const GPU_BUFFER_USAGE_COPY_SRC = 0x0004;
export const GPU_BUFFER_USAGE_COPY_DST = 0x0008;
export const GPU_BUFFER_USAGE_UNIFORM = 0x0040;
export const GPU_BUFFER_USAGE_STORAGE = 0x0080;
