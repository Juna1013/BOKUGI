// 墨減法混色描画
export class PaperRenderer {
    constructor(canvas) {
        this.canvas = canvas;
        this.ctx = canvas.getContext('2d');
    }

    render(W, H) {
        const { ctx } = this;
        ctx.fillStyle = '#f2ede1';
        ctx.fillRect(0, 0, W, H);
        const g = ctx.createRadialGradient(W * .5, H * .42, 0, W * .5, H * .5, Math.max(W, H) * .75);
        g.addColorStop(0, 'rgba(255,252,244,.55)');
        g.addColorStop(1, 'rgba(214,206,188,.5)');
        ctx.fillStyle = g; ctx.fillRect(0, 0, W, H);
        ctx.strokeStyle = 'rgba(120,110,90,.05)'; ctx.lineWidth = .6;

        for (let i = 0; i < Math.floor(W * H / 2600); i++) {
            const x = Math.random() * W, y = Math.random() * H;
            const a = Math.random() * Math.PI, l = 4 + Math.random() * 14;
            ctx.beginPath(); ctx.moveTo(x, y);
            ctx.lineTo(x + Math.cos(a) * l, y + Math.sin(a) * l); ctx.stroke();
        }
        for (let i = 0; i < Math.floor(W * H / 1400); i++) {
            ctx.fillStyle = `rgba(110,100,80,${.02 + Math.random() * .04})`;
            ctx.fillRect(Math.random() * W, Math.random() * H, 1, 1);
        }
    }
}
