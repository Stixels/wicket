/**
 * An animated halftone field: a grid of dots whose size and brightness follow a slowly
 * flowing pattern, tinted with the brand color. Draws only while visible.
 */
export class Halftone {
  private ctx: CanvasRenderingContext2D;
  private rgb: [number, number, number] = [79, 70, 229];
  private light = false;
  private frame = 0;
  private running = false;
  private start = performance.now();
  private reduced = window.matchMedia?.("(prefers-reduced-motion: reduce)").matches ?? false;

  constructor(private canvas: HTMLCanvasElement) {
    this.ctx = canvas.getContext("2d")!;
  }

  /** Any CSS color. `light` picks a darker highlight so the pattern reads on a light background. */
  setColor(color: string, light: boolean) {
    this.ctx.fillStyle = "#000";
    this.ctx.fillStyle = color; // the canvas normalizes any valid CSS color to #rrggbb or rgba()
    const v = String(this.ctx.fillStyle);
    const hex = /^#([0-9a-f]{6})$/i.exec(v);
    const rgba = /rgba?\((\d+),\s*(\d+),\s*(\d+)/.exec(v);
    if (hex) {
      const n = parseInt(hex[1], 16);
      this.rgb = [(n >> 16) & 255, (n >> 8) & 255, n & 255];
    } else if (rgba) {
      this.rgb = [Number(rgba[1]), Number(rgba[2]), Number(rgba[3])];
    }
    this.light = light;
    this.draw();
  }

  play() {
    if (this.running) return;
    this.running = true;
    if (this.reduced) return this.draw();
    const tick = () => {
      if (!this.running) return;
      this.draw();
      this.frame = requestAnimationFrame(tick);
    };
    this.frame = requestAnimationFrame(tick);
  }

  pause() {
    this.running = false;
    cancelAnimationFrame(this.frame);
  }

  private draw() {
    const { canvas, ctx } = this;
    const dpr = Math.min(window.devicePixelRatio || 1, 2);
    const w = canvas.clientWidth;
    const h = canvas.clientHeight;
    if (!w || !h) return;
    if (canvas.width !== Math.round(w * dpr) || canvas.height !== Math.round(h * dpr)) {
      canvas.width = Math.round(w * dpr);
      canvas.height = Math.round(h * dpr);
    }
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.clearRect(0, 0, w, h);

    const t = this.reduced ? 4 : (performance.now() - this.start) / 1000;
    const [r, g, b] = this.rgb;
    // Highlight: toward white on dark backgrounds, toward a deeper shade on light ones.
    const hi = this.light ? [r * 0.55, g * 0.55, b * 0.55] : [255, 255, 255];
    const step = 5;
    const maxR = step * 0.42;
    const peak = this.light ? 0.5 : 0.7; // overall strength, kept low enough for text on top to stay readable

    for (let y = step / 2; y < h; y += step) {
      for (let x = step / 2; x < w; x += step) {
        // A ribbon that sweeps across the top and slowly bends.
        const u = x / w;
        const v = y / h;
        const curve = 0.32 + 0.22 * Math.sin(u * 3.1 + t * 0.35) + 0.08 * Math.sin(u * 7.3 - t * 0.6);
        const band = Math.exp(-(((v - curve) / 0.2) ** 2));
        const swirl = 0.5 + 0.5 * Math.sin(u * 9 + v * 6 - t * 0.9 + Math.sin(v * 5 + t * 0.4) * 2);
        const glow = 0.3 * Math.exp(-(((u - 0.85 - 0.08 * Math.sin(t * 0.2)) / 0.3) ** 2) - ((v / 0.55) ** 2));
        // Strongest toward the top right, quieter behind the heading on the left.
        const side = 0.35 + 0.65 * Math.min(1, Math.max(0, (u - 0.1) / 0.6));
        const f = Math.min(1, (band * (0.55 + 0.45 * swirl) + glow) * side);
        if (f < 0.04) continue;

        const k = Math.max(0, (f - 0.65) / 0.35) * (this.light ? 0.6 : 0.85); // highlight amount
        const cr = Math.round(r + (hi[0] - r) * k);
        const cg = Math.round(g + (hi[1] - g) * k);
        const cb = Math.round(b + (hi[2] - b) * k);
        ctx.fillStyle = `rgba(${cr},${cg},${cb},${((0.2 + 0.8 * f) * peak).toFixed(2)})`;
        ctx.beginPath();
        ctx.arc(x, y, Math.max(0.5, maxR * Math.sqrt(f)), 0, Math.PI * 2);
        ctx.fill();
      }
    }
  }
}
