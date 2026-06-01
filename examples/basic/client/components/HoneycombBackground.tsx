import { useRef, useEffect } from 'react';

const HEX_R = 34;
const GAP = 3;
const DRAW_R = HEX_R - GAP;
const GLOW_DIST = 140;
const LOGO_SRC = '/images/logo.svg';

function tracePath(ctx: CanvasRenderingContext2D, cx: number, cy: number, r: number) {
    ctx.beginPath();

    for (let i = 0; i < 6; i++) {
        const a = (Math.PI / 3) * i - Math.PI / 6;
        const x = cx + r * Math.cos(a);
        const y = cy + r * Math.sin(a);

        if (i === 0) {
            ctx.moveTo(x, y);
        } else {
            ctx.lineTo(x, y);
        }
    }

    ctx.closePath();
}

function buildGrid(w: number, h: number): Array<{ x: number; y: number }> {
    const colW = Math.sqrt(3) * HEX_R;

    const rowH = HEX_R * 1.5;
    const cols = Math.ceil(w / colW) + 2;
    const rows = Math.ceil(h / rowH) + 2;
    const hexes: Array<{ x: number; y: number }> = [];

    for (let row = -1; row < rows; row++) {
        for (let col = -1; col < cols; col++) {
            hexes.push({
                x: col * colW + (row % 2 !== 0 ? colW / 2 : 0),
                y: row * rowH,
            });
        }
    }

    return hexes;
}

/** Samples logo colours per hex centre for use in border glow. */
function buildLogoColors(
    img: HTMLImageElement,
    hexes: Array<{ x: number; y: number }>,
    w: number,
    h: number,
): Array<[number, number, number]> | null {
    const lc = document.createElement('canvas');

    lc.width = w;
    lc.height = h;

    const lctx = lc.getContext('2d');

    if (!lctx) return null;

    // Draw logo large + blurred, roughly where the hero logo sits in the viewport
    const size = 700;
    const cx = w / 2;
    const cy = h * 0.42;

    lctx.filter = 'blur(90px)';
    lctx.drawImage(img, cx - size / 2, cy - size / 2, size, size);
    lctx.filter = 'none';

    // Sample one pixel per hex centre so we can use logo colours for border glow
    return hexes.map(({ x, y }) => {
        const px = Math.round(Math.max(0, Math.min(w - 1, x)));
        const py = Math.round(Math.max(0, Math.min(h - 1, y)));
        const d = lctx.getImageData(px, py, 1, 1).data;

        return [d[0], d[1], d[2]] as [number, number, number];
    });
}

export default function HoneycombBackground() {
    const canvasRef = useRef<HTMLCanvasElement>(null);
    const mouse = useRef({ x: -9999, y: -9999 });

    useEffect(() => {
        const canvas = canvasRef.current;

        if (!canvas) return;

        const ctx = canvas.getContext('2d');

        if (!ctx) return;

        const dpr = window.devicePixelRatio || 1;
        let hexes: Array<{ x: number; y: number }> = [];
        let hexColors: Array<[number, number, number]> = [];
        let raf: number;

        const img = new Image();

        img.onload = () => {
            const colors = buildLogoColors(img, hexes, window.innerWidth, window.innerHeight);

            if (colors) {
                hexColors = colors;
            }
        };

        img.src = LOGO_SRC;

        function resize() {
            if (!canvas || !ctx) return;

            const w = window.innerWidth;
            const h = window.innerHeight;

            canvas.width = w * dpr;
            canvas.height = h * dpr;
            canvas.style.width = `${w}px`;
            canvas.style.height = `${h}px`;
            ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
            hexes = buildGrid(w, h);

            // Rebuild logo colours if image is already loaded
            if (img.complete && img.naturalWidth > 0) {
                const colors = buildLogoColors(img, hexes, w, h);

                if (colors) {
                    hexColors = colors;
                }
            }
        }

        function draw() {
            if (!ctx) return;

            const w = window.innerWidth;
            const h = window.innerHeight;

            ctx.clearRect(0, 0, w, h);

            const mx = mouse.current.x;
            const my = mouse.current.y;

            for (let i = 0; i < hexes.length; i++) {
                const hex = hexes[i];

                if (!hex) continue;

                const { x, y } = hex;
                const dist = Math.hypot(x - mx, y - my);
                const t = Math.max(0, 1 - dist / GLOW_DIST);
                const ease = t * t * (3 - 2 * t);

                // Base fill
                tracePath(ctx, x, y, DRAW_R);
                ctx.fillStyle = 'rgba(255,255,255,0.018)';
                ctx.fill();



                // Base border
                tracePath(ctx, x, y, DRAW_R);
                ctx.strokeStyle = 'rgba(255,255,255,0.055)';
                ctx.lineWidth = 1;
                ctx.stroke();

                // Glow border using logo-sampled colour
                if (ease > 0) {
                    const col = hexColors[i];
                    const r = col ? col[0] : 120;
                    const g = col ? col[1] : 180;
                    const b = col ? col[2] : 255;

                    // If the logo has colour here, use it; otherwise fall back to a soft white
                    const bright = r + g + b;
                    const fr = bright > 30 ? r : 120;
                    const fg = bright > 30 ? g : 180;
                    const fb = bright > 30 ? b : 255;

                    ctx.save();
                    ctx.shadowColor = `rgba(${fr},${fg},${fb},${ease * 0.25})`;
                    ctx.shadowBlur = 8 * ease;
                    ctx.strokeStyle = `rgba(${fr},${fg},${fb},${ease * 0.18})`;
                    ctx.lineWidth = 1 + ease * 0.5;
                    ctx.stroke();
                    ctx.restore();
                }
            }

            raf = requestAnimationFrame(draw);
        }

        resize();
        draw();

        const onResize = () => {
            cancelAnimationFrame(raf);
            resize();
            draw();
        };

        const onMove = (e: MouseEvent) => {
            mouse.current = { x: e.clientX, y: e.clientY };
        };

        const onLeave = () => {
            mouse.current = { x: -9999, y: -9999 };
        };

        window.addEventListener('resize', onResize);
        window.addEventListener('mousemove', onMove);
        document.addEventListener('mouseleave', onLeave);

        return () => {
            cancelAnimationFrame(raf);
            window.removeEventListener('resize', onResize);
            window.removeEventListener('mousemove', onMove);
            document.removeEventListener('mouseleave', onLeave);
        };
    }, []);

    return (
        <canvas
            ref={canvasRef}
            className="honeycomb-canvas"
        />
    );
}
