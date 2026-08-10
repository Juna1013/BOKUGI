// ノイズ生成器
export function makeNoise(nx, ny) {
    const g = new Float32Array((nx + 1) * (ny + 1));
    for (let i = 0; i < g.length; i++) g[i] = Math.random();

    return (x, y) => {
        x = Math.max(0, Math.min(nx - 0.001, x));
        y = Math.max(0, Math.min(ny - 0.001, y));
        const xi = x | 0, yi = y | 0;
        const fx = x - xi, fy = y - yi;
        const sx = fx * fx * (3 - 2 * fx), sy = fy * fy * (3 - 2 * fy);
        const i0 = yi * (nx + 1) + xi;
        const a = g[i0], b = g[i0 + 1], c = g[i0 + nx + 1], d = g[i0 + nx + 2];
        return a + sx * (b - a) + sy * ((c - a) + sx * (a - b - c + d));
    };
}