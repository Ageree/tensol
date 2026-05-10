import { useEffect, useRef } from 'react';

/**
 * Pixel-wave canvas background — sum of three sines, threshold to red pixels.
 * Ported 1:1 from tensol-platform-design/project/Tensol Platform.html (PixelWaveBg).
 */
export const PixelWaveBg = () => {
  const ref = useRef<HTMLCanvasElement | null>(null);

  useEffect(() => {
    const cvs = ref.current;
    if (!cvs) return;
    const ctx = cvs.getContext('2d');
    if (!ctx) return;

    const CELL = 14;
    let cols = 0;
    let rows = 0;
    let w = 0;
    let h = 0;
    let raf = 0;
    const dpr = Math.min(window.devicePixelRatio || 1, 2);

    const resize = () => {
      const rect = cvs.getBoundingClientRect();
      w = rect.width;
      h = rect.height;
      cvs.width = Math.floor(w * dpr);
      cvs.height = Math.floor(h * dpr);
      ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
      cols = Math.ceil(w / CELL) + 2;
      rows = Math.ceil(h / CELL) + 2;
    };
    resize();
    window.addEventListener('resize', resize);

    const start = performance.now();
    const draw = (now: number) => {
      const tt = (now - start) / 1000;
      ctx.clearRect(0, 0, w, h);
      for (let y = 0; y < rows; y++) {
        for (let x = 0; x < cols; x++) {
          const v =
            Math.sin(x * 0.22 + tt * 0.9) +
            Math.sin(y * 0.3 - tt * 0.7) +
            Math.sin(x * 0.1 + y * 0.14 + tt * 0.4);
          const n = v / 3;
          if (n > 0.18) {
            const a = Math.min(0.85, (n - 0.18) * 1.6);
            ctx.fillStyle = `rgba(224, 0, 27, ${a.toFixed(3)})`;
            ctx.fillRect(x * CELL, y * CELL, CELL - 1, CELL - 1);
          }
        }
      }
      raf = requestAnimationFrame(draw);
    };
    raf = requestAnimationFrame(draw);

    return () => {
      cancelAnimationFrame(raf);
      window.removeEventListener('resize', resize);
    };
  }, []);

  return (
    <canvas
      ref={ref}
      aria-hidden="true"
      style={{
        position: 'fixed',
        inset: 0,
        width: '100%',
        height: '100%',
        pointerEvents: 'none',
        zIndex: 0,
        opacity: 0.55,
        mixBlendMode: 'multiply',
        maskImage:
          'radial-gradient(ellipse 80% 60% at 70% 40%, black 0%, rgba(0,0,0,.3) 60%, transparent 100%)',
        WebkitMaskImage:
          'radial-gradient(ellipse 80% 60% at 70% 40%, black 0%, rgba(0,0,0,.3) 60%, transparent 100%)',
      }}
    />
  );
};

/**
 * AuthWave — same wave but contained in the auth left panel,
 * paper pixels on dark bg with elliptical mask. Used inside <AuthShell>.
 */
export const AuthWave = () => {
  const ref = useRef<HTMLCanvasElement | null>(null);

  useEffect(() => {
    const cvs = ref.current;
    if (!cvs) return;
    const ctx = cvs.getContext('2d');
    if (!ctx) return;

    const CELL = 14;
    let cols = 0;
    let rows = 0;
    let w = 0;
    let h = 0;
    let raf = 0;
    const dpr = Math.min(window.devicePixelRatio || 1, 2);

    const resize = () => {
      const rect = cvs.getBoundingClientRect();
      w = rect.width;
      h = rect.height;
      cvs.width = Math.floor(w * dpr);
      cvs.height = Math.floor(h * dpr);
      ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
      cols = Math.ceil(w / CELL) + 2;
      rows = Math.ceil(h / CELL) + 2;
    };
    resize();
    const ro = new ResizeObserver(resize);
    ro.observe(cvs);

    const start = performance.now();
    const draw = (now: number) => {
      const tt = (now - start) / 1000;
      ctx.clearRect(0, 0, w, h);
      for (let y = 0; y < rows; y++) {
        for (let x = 0; x < cols; x++) {
          const v =
            Math.sin(x * 0.22 + tt * 0.9) +
            Math.sin(y * 0.3 - tt * 0.7) +
            Math.sin(x * 0.1 + y * 0.14 + tt * 0.4);
          const n = v / 3;
          if (n > 0.18) {
            const a = Math.min(0.9, (n - 0.18) * 1.7);
            ctx.fillStyle = `rgba(250, 249, 246, ${a.toFixed(3)})`;
            ctx.fillRect(x * CELL, y * CELL, CELL - 1, CELL - 1);
          }
        }
      }
      raf = requestAnimationFrame(draw);
    };
    raf = requestAnimationFrame(draw);

    return () => {
      cancelAnimationFrame(raf);
      ro.disconnect();
    };
  }, []);

  return (
    <canvas
      ref={ref}
      aria-hidden="true"
      style={{
        position: 'absolute',
        inset: 0,
        width: '100%',
        height: '100%',
        pointerEvents: 'none',
        maskImage:
          'radial-gradient(ellipse 70% 55% at 50% 50%, black 0%, rgba(0,0,0,.4) 60%, transparent 100%)',
        WebkitMaskImage:
          'radial-gradient(ellipse 70% 55% at 50% 50%, black 0%, rgba(0,0,0,.4) 60%, transparent 100%)',
      }}
    />
  );
};
