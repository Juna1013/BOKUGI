(() => {
  'use strict';

  const paper = document.getElementById('paper');
  const inkCv = document.getElementById('inkLayer');
  const hint = document.getElementById('hint');
  const dpr = Math.min(window.devicePixelRatio || 1, 2);
  const reduceMotion = matchMedia('(prefers-reduced-motion: reduce)').matches;

  const pctx = paper.getContext('2d');
  const ictx = inkCv.getContext('2d');

  // 定数
  const CS = 3; // 1セル = 3css px
  const DIFF = 0.22; // 毛細血管の拡散
  const CAP = 0.004; // 毛細管のしきい値
  const EVAP = 0.99972; // 蒸発
  const SUB = 2; // 拡散サブステップ / フレーム
  const VDAMP = 0.995; // 速度の減衰
  const AMB = 0.085; // 環流（漂い）の強さ

  // 顔料の吸収係数
  // [R, G, B]: 墨、朱（バーミリオン）、藍（インディゴ）
  const ABS = [
    [2.55, 2.55, 2.30],
    [0.28, 2.70, 2.95],
    [2.75, 1.70, 0.50],
  ];

  let W, H, gw, gh, N;
  let w, w2;
  let p = [], p2 = [], d = [];
  let u, v, ambU, ambV;
  let perm, grain;
  let img, gridCv, gctx;
  let curColor = 0;

  // 値ノイズ
  function makeNoise(nx, ny) {
    const g = new Float32Array((nx + 1) * (ny + 1));
    for (let i = 0; i < g.length; i++) {
      g[i] = Math.random();
    }
    return (x, y) => {
      // 格子の外を読むと undefined→NaN が生まれ流体全体を汚染するため、サンプリング座標を必ず格子内に収める
      if (x < 0) x = 0;
      else if (x > nx - 0.001) x = nx - 0.001;
      if (y < 0) y = 0;
      else if (y > ny - 0.001) y = ny - 0.001;
      const xi = x | 0, yi = y | 0;
      const fx = x - xi, fy = y - yi;
      const sx = fx * fx * (3 - 2 * fx), sy = fy * fy * (3 - 2 * fy);
      const i0 = yi * (nx + 1) + xi;
      const a = g[i0], b = g[i0 + 1], c = g[i0 + nx + 1], e = g[i0 + nx + 2];
      return a + (b - a) * sx + (c - a) * sy + (a - b - c + e) * sx * sy;
    };
  }

  function buildFields() {
    // 紙の繊維（浸透率）
    const n1 = makeNoise(24, 60), s1x = 24 / gw, s1y = 60 / gh;
    const n2 = makeNoise(70, 160), s2x = 70 / gw, s2y = 160 / gh;
    const n3 = makeNoise(200, 400), s3x = 200 / gw, s3y = 400 / gh;
    for (let y = 0; y < gh; y++) {
      for (let x = 0; x < gw; x++) {
        const i = y * gw + x;
        let val = n1(x * s1x, y * s1y) * .45 + n2(x * s2x, y * s2y) * .35 + n3(x * s3x, y * s3y) * .20;
        val = Math.pow(val, 1.6) * 1.9 + 0.12;
        perm[i] = Math.min(1.4, val);
        grain[i] = .82 + Math.random() * .36;
      }
    }

    // 紙面を漂う環流：ノイズのカール（発散ゼロ＝渦だけ）
    const nf = makeNoise(14, 14), sx = 14 / gw, sy = 14 / gh, eps = 1.5;
    for (let y = 0; y < gh; y++) {
      for (let x = 0; x < gw; x++) {
        const i = y * gw + x;
        const dndy = nf(x * sx, (y + eps) * sy) - nf(x * sx, (y - eps < 0 ? 0 : y - eps) * sy);
        const dndx = nf((x + eps) * sx, y * sy) - nf((x - eps < 0 ? 0 : x - eps) * sx, y * sy);
        ambU[i] = dndy * AMB / eps;
        ambV[i] = -dndx * AMB / eps;
      }
    }
  }

  // 初期化
  function setup() {
    W = innerWidth; H = innerHeight;
    gw = Math.ceil(W / CS); gh = Math.ceil(H / CS); N = gw * gh;

    w = new Float32Array(N); w2 = new Float32Array(N);
    for (let c = 0; c < 3; c++) {
      p[c] = new Float32Array(N);
      p2[c] = new Float32Array(N);
      d[c] = new Float32Array(N);
    }
    u = new Float32Array(N); v = new Float32Array(N);
    ambU = new Float32Array(N); ambV = new Float32Array(N);
    perm = new Float32Array(N); grain = new Float32Array(N);
    buildFields();

    gridCv = document.createElement('canvas');
    gridCv.width = gw; gridCv.height = gh;
    gctx = gridCv.getContext('2d');
    img = gctx.createImageData(gw, gh);
    const px = img.data;
    for (let i = 0; i < N; i++) {
      px[i * 4] = 255;
      px[i * 4 + 1] = 255;
      px[i * 4 + 2] = 255;
      px[i * 4 + 3] = 255;
    }

    for (const c of [paper, inkCv]) {
      c.width = W * dpr; c.height = H * dpr;
      c.getContext('2d').setTransform(dpr, 0, 0, dpr, 0, 0);
    }
    ictx.imageSmoothingEnabled = true;
    ictx.imageSmoothingQuality = 'high';
    drawPaperTexture();
  }

  function drawPaperTexture() {
    pctx.fillStyle = '#f2ede1';
    pctx.fillRect(0, 0, W, H);
    const g = pctx.createRadialGradient(W * .5, H * .42, 0, W * .5, H * .5, Math.max(W, H) * .75);
    g.addColorStop(0, 'rgba(255,252,244,.55)');
    g.addColorStop(1, 'rgba(214,206,188,.5)');
    pctx.fillStyle = g; pctx.fillRect(0, 0, W, H);
    pctx.strokeStyle = 'rgba(120,110,90,.05)'; pctx.lineWidth = .6;
    for (let i = 0; i < Math.floor(W * H / 2600); i++) {
      const x = Math.random() * W, y = Math.random() * H;
      const a = Math.random() * Math.PI, l = 4 + Math.random() * 14;
      pctx.beginPath(); pctx.moveTo(x, y);
      pctx.lineTo(x + Math.cos(a) * l, y + Math.sin(a) * l); pctx.stroke();
    }
    for (let i = 0; i < Math.floor(W * H / 1400); i++) {
      pctx.fillStyle = `rgba(110,100,80,${.02 + Math.random() * .04})`;
      pctx.fillRect(Math.random() * W, Math.random() * H, 1, 1);
    }
  }

  setup();
  let resizeT;
  addEventListener('resize', () => {
    clearTimeout(resizeT);
    resizeT = setTimeout(setup, 200);
  });

  // 毛細管血管 + 蒸発・定着
  let wet = 0;
  function simStep() {
    w2.set(w);
    for (let c = 0; c < 3; c++) p2[c].set(p[c]);
    const p0 = p[0], p1 = p[1], pB = p[2];
    const q0 = p2[0], q1 = p2[1], qB = p2[2];
    wet = 0;

    for (let y = 0; y < gh; y++) {
      const row = y * gw;
      for (let x = 0; x < gw; x++) {
        const i = row + x;
        const wi = w[i];
        if (wi <= CAP) continue;
        wet++;
        const inv = 1 / wi;
        const r0 = p0[i] * inv, r1 = p1[i] * inv, rB = pB[i] * inv;

        const give = (j) => {
          const dw = wi - w[j];
          if (dw <= 0) return;
          let f = DIFF * perm[j] * dw * (.6 + Math.random() * .8);
          if (f > wi * .18) f = wi * .18;
          w2[j] += f; w2[i] -= f;
          q0[j] += f * r0; q0[i] -= f * r0;
          q1[j] += f * r1; q1[i] -= f * r1;
          qB[j] += f * rB; qB[i] -= f * rB;
        };
        if (x > 0) give(i - 1);
        if (x < gw - 1) give(i + 1);
        if (y > 0) give(i - gw);
        if (y < gh - 1) give(i + gw);
      }
    }

    for (let i = 0; i < N; i++) {
      let wi = w2[i] * EVAP;
      if (wi < 0.0008) wi = 0;
      const dry = 1 - Math.min(wi * 6, 1);
      const rate = 0.003 + 0.05 * dry * dry;
      for (let c = 0; c < 3; c++) {
        const pv = p2[c][i];
        if (pv > 0) {
          const dep = pv * rate;
          d[c][i] += dep;
          p[c][i] = pv - dep;
        } else {
          p[c][i] = pv;
        }
      }
      w[i] = wi;
      u[i] *= VDAMP; v[i] *= VDAMP;
    }
  }

  // 移流：濡れた墨は流れに乗る
  function advect() {
    w2.set(w);
    for (let c = 0; c < 3; c++) p2[c].set(p[c]);
    const s0 = p[0], s1 = p[1], sB = p[2];

    for (let y = 0; y < gh; y++) {
      const row = y * gw;
      for (let x = 0; x < gw; x++) {
        const i = row + x;
        const wi = w[i];
        // 濡れているほど流れる。乾いた沈着(d)は動かない=痕が残る
        const g = Math.min(wi * 3.5, 1);
        if (g < .02) continue;
        const vx = (u[i] + ambU[i]) * g;
        const vy = (v[i] + ambV[i]) * g;
        // 万一の非有限値はその場で握りつぶす(NaNは比較を素通りして伝播するため)
        if (!Number.isFinite(vx) || !Number.isFinite(vy)) {
          u[i] = 0; v[i] = 0; continue;
        }
        if (vx * vx + vy * vy < 1e-6) continue;

        // セミラグランジュ法:流れの上流から値を汲んでくる
        let sx = x - vx, sy2 = y - vy;
        if (sx < 0) sx = 0; else if (sx > gw - 1.001) sx = gw - 1.001;
        if (sy2 < 0) sy2 = 0; else if (sy2 > gh - 1.001) sy2 = gh - 1.001;
        const x0 = sx | 0, y0 = sy2 | 0;
        const fx = sx - x0, fy = sy2 - y0;
        const j00 = y0 * gw + x0, j10 = j00 + 1, j01 = j00 + gw, j11 = j01 + 1;
        const a00 = (1 - fx) * (1 - fy), a10 = fx * (1 - fy), a01 = (1 - fx) * fy, a11 = fx * fy;

        const bl = (arr) => arr[j00] * a00 + arr[j10] * a10 + arr[j01] * a01 + arr[j11] * a11;
        w2[i] = wi + (bl(w) - wi) * g;
        p2[0][i] = s0[i] + (bl(s0) - s0[i]) * g;
        p2[1][i] = s1[i] + (bl(s1) - s1[i]) * g;
        p2[2][i] = sB[i] + (bl(sB) - sB[i]) * g;
      }
    }
    [w, w2] = [w2, w];
    for (let c = 0; c < 3; c++) [p[c], p2[c]] = [p2[c], p[c]];
  }

  // 描画：減法混色
  const A0 = ABS[0], A1 = ABS[1], A2 = ABS[2];
  function render() {
    const px = img.data;
    const d0 = d[0], d1 = d[1], dB = d[2];
    const p0 = p[0], p1 = p[1], pB = p[2];
    for (let i = 0; i < N; i++) {
      const c0 = d0[i] * 1.15 + p0[i] * .55;
      const c1 = d1[i] * 1.15 + p1[i] * .55;
      const cB = dB[i] * 1.15 + pB[i] * .55;
      const o = i * 4;
      if (c0 + c1 + cB < .0004 && w[i] < .01) {
        px[o] = 255; px[o + 1] = 255; px[o + 2] = 255;
        continue;
      }
      const gn = grain[i];
      const sheen = w[i] * .05; // 濡れ面のごく薄い翳り
      px[o] = 255 * Math.exp(-(c0 * A0[0] + c1 * A1[0] + cB * A2[0] + sheen) * gn);
      px[o + 1] = 255 * Math.exp(-(c0 * A0[1] + c1 * A1[1] + cB * A2[1] + sheen) * gn);
      px[o + 2] = 255 * Math.exp(-(c0 * A0[2] + c1 * A1[2] + cB * A2[2] + sheen) * gn);
    }
    gctx.putImageData(img, 0, 0);
    ictx.clearRect(0, 0, W, H);
    ictx.drawImage(gridCv, 0, 0, W, H);
  }

  // 落墨と勢い
  function drop(cx, cy, amount, radius) {
    hint.classList.add('gone');
    const gx = cx / CS, gy = cy / CS;
    const r2 = radius * radius;
    const x0 = Math.max(0, (gx - radius) | 0), x1 = Math.min(gw - 1, Math.ceil(gx + radius));
    const y0 = Math.max(0, (gy - radius) | 0), y1 = Math.min(gh - 1, Math.ceil(gy + radius));
    const pc = p[curColor];
    for (let y = y0; y <= y1; y++) {
      for (let x = x0; x <= x1; x++) {
        const dx = x - gx, dy = y - gy, q = dx * dx + dy * dy;
        if (q > r2) continue;
        const fall = Math.exp(-q / (r2 * .35));
        const i = y * gw + x;
        w[i] = Math.min(w[i] + amount * fall, 2.4);
        pc[i] = Math.min(pc[i] + amount * fall * .55, 1.5);
      }
    }
    if (reduceMotion) {
      for (let k = 0; k < 260; k++) simStep();
      render();
    }
  }

  function addVel(cx, cy, vx, vy, radius) {
    const gx = cx / CS, gy = cy / CS;
    const r2 = radius * radius;
    const x0 = Math.max(0, (gx - radius) | 0), x1 = Math.min(gw - 1, Math.ceil(gx + radius));
    const y0 = Math.max(0, (gy - radius) | 0), y1 = Math.min(gh - 1, Math.ceil(gy + radius));
    for (let y = y0; y <= y1; y++) {
      for (let x = x0; x <= x1; x++) {
        const dx = x - gx, dy = y - gy, q = dx * dx + dy * dy;
        if (q > r2) continue;
        const fall = Math.exp(-q / (r2 * .4));
        const i = y * gw + x;
        u[i] += vx * fall; v[i] += vy * fall;
      }
    }
  }

  // タップだけでも墨が緩く渦を巻いて広がるように
  function swirl(cx, cy) {
    const gx = cx / CS, gy = cy / CS, R = 9;
    const dir = Math.random() < .5 ? 1 : -1;
    const x0 = Math.max(0, (gx - R) | 0), x1 = Math.min(gw - 1, Math.ceil(gx + R));
    const y0 = Math.max(0, (gy - R) | 0), y1 = Math.min(gh - 1, Math.ceil(gy + R));
    for (let y = y0; y <= y1; y++) {
      for (let x = x0; x <= x1; x++) {
        const dx = x - gx, dy = y - gy, q = Math.sqrt(dx * dx + dy * dy);
        if (q > R || q < .5) continue;
        const s = dir * .9 * Math.exp(-q * q / (R * R * .3)) / q;
        const i = y * gw + x;
        u[i] += -dy * s; v[i] += dx * s;
      }
    }
  }

  // 色の選択
  const swatches = document.querySelectorAll('.palette button');
  swatches.forEach(b => b.addEventListener('click', () => {
    curColor = +b.dataset.c;
    swatches.forEach(s => s.classList.toggle('on', s === b));
  }));

  // 洗い流す
  const R_SWEEP = 70; // 前線が下端に達するまでのフレーム数
  const R_TOTAL = 290; // 洗い全体の長さ
  let rinsing = 0;
  document.getElementById('rinse').addEventListener('click', () => {
    if (reduceMotion) {
      w.fill(0);
      for (let c = 0; c < 3; c++) { p[c].fill(0); d[c].fill(0); }
      render();
    } else if (!rinsing) rinsing = 1;
  });
  function rinseStep() {
    if (!rinsing) return;
    const t = rinsing;
    const frontRow = Math.min(gh, ((gh * t / R_SWEEP) | 0) + 2);
    const pouring = t < R_TOTAL - 100;
    const d0 = d[0], d1 = d[1], dB = d[2];
    const p0 = p[0], p1 = p[1], pB = p[2];

    // 前線より上:注水しつつ下向きの流れを与える
    for (let y = 0; y < frontRow; y++) {
      const row = y * gw;
      for (let x = 0; x < gw; x++) {
        const i = row + x;
        if (pouring && w[i] < 2.2) w[i] += .13;
        if (v[i] < 1.4) v[i] += .13; // 下へ流れる
        u[i] += (Math.random() - .5) * .07 + ambU[i] * .5; // わずかに蛇行
        // 濡れた場所では沈着した墨が再び溶け出し、流れに乗る
        const dis = Math.min(w[i], 1.2) * .05;
        if (dis > 0) {
          const m0 = d0[i] * dis, m1 = d1[i] * dis, mB = dB[i] * dis;
          d0[i] -= m0; p0[i] += m0;
          d1[i] -= m1; p1[i] += m1;
          dB[i] -= mB; pB[i] += mB;
        }
      }
    }
    // 下端の排水:流れ着いた墨と水が紙の外へ抜ける
    for (let y = gh - 3; y < gh; y++) {
      const row = y * gw;
      for (let x = 0; x < gw; x++) {
        const i = row + x;
        w[i] *= .55;
        p0[i] *= .5; p1[i] *= .5; pB[i] *= .5;
        d0[i] *= .9; d1[i] *= .9; dB[i] *= .9;
      }
    }
    // 終盤:水が引き、洗い残しも薄れて消える
    if (!pouring) {
      for (let i = 0; i < N; i++) {
        w[i] *= .95;
        d0[i] *= .94; d1[i] *= .94; dB[i] *= .94;
        p0[i] *= .94; p1[i] *= .94; pB[i] *= .94;
      }
    }
    if (++rinsing > R_TOTAL) {
      w.fill(0); u.fill(0); v.fill(0);
      for (let c = 0; c < 3; c++) { p[c].fill(0); d[c].fill(0); }
      rinsing = 0;
    }
  }

  // 入力
  let down = false, lastX = 0, lastY = 0, lastT = 0, holdT = 0;
  inkCv.addEventListener('pointerdown', e => {
    down = true; holdT = 0;
    lastX = e.clientX; lastY = e.clientY; lastT = performance.now();
    drop(e.clientX, e.clientY, 1.6, 4.5);
    swirl(e.clientX, e.clientY);
  });
  inkCv.addEventListener('pointermove', e => {
    if (!down) return;
    const now = performance.now();
    const dx = e.clientX - lastX, dy = e.clientY - lastY;
    const dist = Math.hypot(dx, dy);
    if (dist > CS) {
      const dt = Math.max(now - lastT, 8);
      // 指の勢いを水流として与える(速いほど強く引きずる)
      const gain = Math.min(dist / dt * 10, 3.5);
      addVel(e.clientX, e.clientY, dx / dist * gain, dy / dist * gain, 6);

      const n = Math.ceil(dist / CS);
      const a = Math.max(.25, 1.1 - dist * .02);
      for (let k = 1; k <= n; k++)
        drop(lastX + dx * k / n, lastY + dy * k / n, a * .45, 3.2);
      lastX = e.clientX; lastY = e.clientY; lastT = now;
    }
  });
  const up = () => down = false;
  addEventListener('pointerup', up);
  addEventListener('pointercancel', up);

  // ループ
  function loop() {
    if (!reduceMotion) {
      if (down && ++holdT > 20 && holdT % 6 === 0)
        drop(lastX, lastY, .5, 4);
      for (let s = 0; s < SUB; s++) simStep();
      advect();
      rinseStep();
      if (wet > 0 || rinsing || down) render();
    }
    requestAnimationFrame(loop);
  }
  render();
  loop();
})();
