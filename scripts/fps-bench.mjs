// BOKUGI フレームレート計測ハーネス（headless Chrome + CDP）
//
// 使い方:
//   npx vite --port 5199 --strictPort &      # 先に開発サーバーを起動しておく
//   node scripts/fps-bench.mjs [出力先.json]
//
// macOS の Google Chrome を headless で起動し、WebGPU 経路と Canvas 2D 経路それぞれで
// 「描画中 / 滲み中 / 水洗い中 / 洗い後」のフレーム間隔とコールバック CPU 時間を記録する。
// 結果の読み方は docs/frame-rate.md を参照。
import { spawn } from 'node:child_process';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const CHROME = '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome';
const URL_BASE = 'http://localhost:5199/';
const OUT = process.argv[2] ?? 'fps-results.json';

const VIEWPORTS = {
  desktop: { width: 1440, height: 900, deviceScaleFactor: 2, mobile: false },
  mobile: { width: 390, height: 844, deviceScaleFactor: 3, mobile: true },
};
const SCENARIOS = [
  { renderer: 'webgpu', viewport: 'desktop', throttle: 1 },
  { renderer: 'webgpu', viewport: 'mobile', throttle: 1 },
  { renderer: 'webgpu', viewport: 'mobile', throttle: 4 },
  { renderer: 'canvas2d', viewport: 'desktop', throttle: 1 },
  { renderer: 'canvas2d', viewport: 'mobile', throttle: 1 },
  { renderer: 'canvas2d', viewport: 'mobile', throttle: 4 },
];
const PHASE_MS = 4000;

// ページ読み込み前に rAF をラップし、コールバックの CPU 時間とフレーム間隔を記録する
const INJECT = `
(() => {
  const orig = window.requestAnimationFrame.bind(window);
  window.__bench = { rec: false, frames: [] };
  window.requestAnimationFrame = (cb) => orig((t) => {
    const s = performance.now();
    cb(t);
    const e = performance.now();
    if (window.__bench.rec) window.__bench.frames.push([t, e - s]);
  });
})();`;

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

class Cdp {
  constructor(ws) { this.ws = ws; this.id = 0; this.pending = new Map(); this.handlers = []; 
    ws.addEventListener('message', (ev) => {
      const msg = JSON.parse(ev.data);
      if (msg.id && this.pending.has(msg.id)) {
        const { resolve, reject } = this.pending.get(msg.id); this.pending.delete(msg.id);
        msg.error ? reject(new Error(msg.error.message)) : resolve(msg.result);
      } else if (msg.method) this.handlers.forEach((h) => h(msg));
    });
  }
  send(method, params = {}, sessionId) {
    const id = ++this.id;
    this.ws.send(JSON.stringify({ id, method, params, sessionId }));
    return new Promise((resolve, reject) => this.pending.set(id, { resolve, reject }));
  }
}

async function launchChrome(renderer) {
  const port = 9300 + Math.floor(Math.random() * 500);
  const dir = mkdtempSync(join(tmpdir(), 'bokugi-fps-'));
  const flags = [
    '--headless=new', '--no-sandbox', `--remote-debugging-port=${port}`, `--user-data-dir=${dir}`,
    '--use-angle=metal', '--hide-scrollbars', '--no-first-run',
  ];
  if (renderer === 'webgpu') flags.push('--enable-unsafe-webgpu', '--enable-features=WebGPU');
  else flags.push('--disable-features=WebGPU');
  const proc = spawn(CHROME, flags, { stdio: 'ignore' });
  let ws;
  for (let i = 0; i < 50; i++) {
    await sleep(200);
    try {
      const res = await fetch(`http://127.0.0.1:${port}/json/version`);
      ws = (await res.json()).webSocketDebuggerUrl; break;
    } catch {}
  }
  if (!ws) { proc.kill(); throw new Error('Chrome did not start'); }
  const sock = new WebSocket(ws);
  await new Promise((r) => sock.addEventListener('open', r));
  return { proc, cdp: new Cdp(sock) };
}

async function evalIn(cdp, sid, expression, awaitPromise = false) {
  const r = await cdp.send('Runtime.evaluate', { expression, awaitPromise, returnByValue: true }, sid);
  if (r.exceptionDetails) throw new Error(r.exceptionDetails.text + ' ' + JSON.stringify(r.exceptionDetails.exception));
  return r.result.value;
}

function stats(frames) {
  if (frames.length < 2) return null;
  const deltas = []; const cpu = [];
  for (let i = 1; i < frames.length; i++) { deltas.push(frames[i][0] - frames[i - 1][0]); cpu.push(frames[i][1]); }
  const q = (arr, p) => { const s = [...arr].sort((a, b) => a - b); return s[Math.min(s.length - 1, Math.floor(p * s.length))]; };
  const mean = (arr) => arr.reduce((a, b) => a + b, 0) / arr.length;
  const durationMs = frames[frames.length - 1][0] - frames[0][0];
  return {
    frames: frames.length,
    fps: +(((frames.length - 1) / durationMs) * 1000).toFixed(1),
    frameMs: { mean: +mean(deltas).toFixed(2), p50: +q(deltas, 0.5).toFixed(2), p95: +q(deltas, 0.95).toFixed(2), max: +Math.max(...deltas).toFixed(2) },
    cpuMs: { mean: +mean(cpu).toFixed(2), p50: +q(cpu, 0.5).toFixed(2), p95: +q(cpu, 0.95).toFixed(2), max: +Math.max(...cpu).toFixed(2) },
    dropped: deltas.filter((d) => d > 25).length,
  };
}

async function record(cdp, sid, ms) {
  await evalIn(cdp, sid, 'window.__bench.frames = []; window.__bench.rec = true; true');
  await sleep(ms);
  return evalIn(cdp, sid, 'window.__bench.rec = false; JSON.stringify(window.__bench.frames)').then(JSON.parse);
}

// ページ内でストロークを描く。60Hz の pointermove で正弦波の軌跡を width の 70% ほど。
const STROKE = (durationMs) => `new Promise((done) => {
  const cv = document.getElementById('inkLayer');
  const W = innerWidth, H = innerHeight;
  const x0 = W * 0.15, x1 = W * 0.85, yc = H * 0.5, amp = H * 0.15;
  const mk = (type, x, y) => new PointerEvent(type, { pointerId: 1, pointerType: 'touch', isPrimary: true, clientX: x, clientY: y, buttons: 1, bubbles: true, cancelable: true });
  cv.dispatchEvent(mk('pointerdown', x0, yc));
  const start = performance.now();
  const tick = () => {
    const p = Math.min(1, (performance.now() - start) / ${durationMs});
    const x = x0 + (x1 - x0) * p, y = yc + Math.sin(p * Math.PI * 3) * amp;
    cv.dispatchEvent(mk('pointermove', x, y));
    if (p < 1) setTimeout(tick, 16); else { window.dispatchEvent(mk('pointerup', x, y)); done(true); }
  };
  tick();
})`;

async function runScenario(cdp, scenario) {
  const vp = VIEWPORTS[scenario.viewport];
  const { targetId } = await cdp.send('Target.createTarget', { url: 'about:blank' });
  const { sessionId: sid } = await cdp.send('Target.attachToTarget', { targetId, flatten: true });
  await cdp.send('Page.enable', {}, sid);
  await cdp.send('Runtime.enable', {}, sid);
  await cdp.send('Emulation.setDeviceMetricsOverride', { ...vp, screenWidth: vp.width, screenHeight: vp.height }, sid);
  if (vp.mobile) await cdp.send('Emulation.setTouchEmulationEnabled', { enabled: true, maxTouchPoints: 5 }, sid);
  await cdp.send('Emulation.setCPUThrottlingRate', { rate: scenario.throttle }, sid);
  const source = scenario.renderer === 'canvas2d'
    ? `Object.defineProperty(navigator, 'gpu', { value: undefined, configurable: true });` + INJECT
    : INJECT;
  await cdp.send('Page.addScriptToEvaluateOnNewDocument', { source }, sid);

  const loaded = new Promise((r) => cdp.handlers.push((m) => { if (m.method === 'Page.loadEventFired' && m.sessionId === sid) r(); }));
  await cdp.send('Page.navigate', { url: URL_BASE }, sid);
  await loaded;
  await sleep(2500); // GPU 初期化と紙の描画を待つ

  const env = await evalIn(cdp, sid, `({
    gpu: !!navigator.gpu,
    usesWebGpu: (() => { try { return !!document.getElementById('inkLayer').getContext('webgpu'); } catch { return false; } })(),
    uses2d: (() => { try { return !!document.getElementById('inkLayer').getContext('2d'); } catch { return false; } })(),
    inner: [innerWidth, innerHeight], dpr: devicePixelRatio,
    inkCanvas: (() => { const c = document.getElementById('inkLayer'); return [c.width, c.height]; })(),
    cores: navigator.hardwareConcurrency,
  })`);

  // 1. 描画中: ストロークを走らせながら記録
  await evalIn(cdp, sid, 'window.__bench.frames = []; window.__bench.rec = true; true');
  await evalIn(cdp, sid, STROKE(PHASE_MS), true);
  const drawFrames = await evalIn(cdp, sid, 'window.__bench.rec = false; JSON.stringify(window.__bench.frames)').then(JSON.parse);

  // 2. 滲み中: 入力なしで濡れた墨が拡散する間
  const settleFrames = await record(cdp, sid, PHASE_MS);
  const shot = await cdp.send('Page.captureScreenshot', { format: 'png' }, sid);
  writeFileSync(`shot-${scenario.renderer}-${scenario.viewport}-x${scenario.throttle}.png`, Buffer.from(shot.data, 'base64'));

  // 3. 水洗い中: Enter キーで開始
  await evalIn(cdp, sid, `document.getElementById('rinse').dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true, cancelable: true })); true`);
  await sleep(300);
  const rinseFrames = await record(cdp, sid, PHASE_MS);

  // 4. 洗い後: 水洗い終了から 6 秒後。紙はまだ濡れているので白紙の待機状態ではない。
  await sleep(6000);
  const idleFrames = await record(cdp, sid, 2000);

  await cdp.send('Target.closeTarget', { targetId });
  return {
    ...scenario, env,
    phases: { draw: stats(drawFrames), settle: stats(settleFrames), rinse: stats(rinseFrames), idle: stats(idleFrames) },
  };
}

const results = [];
for (const renderer of ['webgpu', 'canvas2d']) {
  const { proc, cdp } = await launchChrome(renderer);
  try {
    for (const scenario of SCENARIOS.filter((s) => s.renderer === renderer)) {
      process.stderr.write(`[${renderer}/${scenario.viewport}/x${scenario.throttle}] `);
      try {
        const r = await runScenario(cdp, scenario);
        results.push(r);
        process.stderr.write(`draw ${r.phases.draw?.fps} fps, settle ${r.phases.settle?.fps} fps, rinse ${r.phases.rinse?.fps} fps\n`);
      } catch (e) {
        process.stderr.write(`ERROR ${e.message}\n`);
        results.push({ ...scenario, error: e.message });
      }
    }
  } finally {
    proc.kill();
  }
}
writeFileSync(OUT, JSON.stringify(results, null, 2));
process.stderr.write(`wrote ${OUT}\n`);
process.exit(0);
