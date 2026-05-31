import { useRef, useEffect } from 'react';

const HEX_R = 34;
const GAP = 3;
const DRAW_R = HEX_R - GAP;
const GLOW_DIST = 140;

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
        let raf: number;

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
        }

        function draw() {
            if (!ctx) return;

            const w = window.innerWidth;
            const h = window.innerHeight;
            ctx.clearRect(0, 0, w, h);

            const mx = mouse.current.x;
            const my = mouse.current.y;

            for (const { x, y } of hexes) {
                const dist = Math.hypot(x - mx, y - my);
                const t = Math.max(0, 1 - dist / GLOW_DIST);
                const ease = t * t * (3 - 2 * t);

                tracePath(ctx, x, y, DRAW_R);

                ctx.fillStyle = 'rgba(255,255,255,0.018)';
                ctx.fill();

                if (ease > 0) {
                    ctx.fillStyle = `rgba(72,148,255,${ease * 0.025})`;
                    ctx.fill();
                }

                ctx.strokeStyle = 'rgba(255,255,255,0.055)';
                ctx.lineWidth = 1;
                ctx.stroke();

                if (ease > 0) {
                    ctx.save();
                    ctx.shadowColor = `rgba(72,148,255,${ease * 0.2})`;
                    ctx.shadowBlur = 8 * ease;
                    ctx.strokeStyle = `rgba(120,180,255,${ease * 0.2})`;
                    ctx.lineWidth = 1 + ease * 0.4;
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
            style={{
                position: 'fixed',
                inset: 0,
                width: '100%',
                height: '100%',
                pointerEvents: 'none',
                zIndex: 0,
            }}
        />
    );
}

