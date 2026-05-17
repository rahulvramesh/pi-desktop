import { useEffect, useMemo, useRef, useState } from 'react';

/**
 * "Soft Cells" loader — Conway's Game of Life that resolves into a π.
 *
 * From the Claude Design handoff (Pi Loader.html, "Soft" + "pi"). Adapted for a
 * small in-app indicator: the proportional seed in the prototype only reads as
 * π on a large grid, so here π is a hand-tuned bitmap. Each cycle the cells run
 * real Conway (B3/S23) for organic motion, then deterministically **assemble
 * into the π**, hold, and loop — so it visibly "turns into π" at small size.
 * Soft = rounded accent cells that fade in. Transparent (no tile). A faint
 * ghost-π shows the target. `prefers-reduced-motion` renders a static π.
 */

const FALLBACK_ACCENT = '#D97757';

// 9×8 π, hand-tuned so it stays legible at ~3px cells.
const PI_ART = [
  ' ####### ',
  ' ####### ',
  '  #   #  ',
  '  #   #  ',
  '  #   #  ',
  '  #   #  ',
  '  #   #  ',
  ' #    ## ',
];
const GRID_W = 11;
const GRID_H = 10;
const OFF_X = Math.floor((GRID_W - PI_ART[0]!.length) / 2);
const OFF_Y = Math.floor((GRID_H - PI_ART.length) / 2);

const STEP_MS = 110;
const FREE = 8; // Conway evolves from π (organic motion)
const ASSEMBLE = 12; // cells funnel back into π
const HOLD = 8; // π settled
const CYCLE = FREE + ASSEMBLE + HOLD;

function buildPi(): Set<string> {
  const s = new Set<string>();
  PI_ART.forEach((row, r) => {
    [...row].forEach((ch, c) => {
      if (ch === '#') s.add(`${r + OFF_Y},${c + OFF_X}`);
    });
  });
  return s;
}

/** Conway step (B3/S23), toroidal so a small grid keeps moving. */
function step(cells: Set<string>): Set<string> {
  const counts = new Map<string, number>();
  for (const k of cells) {
    const [r, c] = k.split(',').map(Number) as [number, number];
    for (let dr = -1; dr <= 1; dr++) {
      for (let dc = -1; dc <= 1; dc++) {
        if (!dr && !dc) continue;
        const nk = `${(r + dr + GRID_H) % GRID_H},${(c + dc + GRID_W) % GRID_W}`;
        counts.set(nk, (counts.get(nk) ?? 0) + 1);
      }
    }
  }
  const next = new Set<string>();
  for (const [k, n] of counts) {
    if (n === 3) next.add(k);
    else if (n === 2 && cells.has(k)) next.add(k);
  }
  return next;
}

interface Props {
  cell?: number;
  gap?: number;
}

export function SoftCells({ cell = 1, gap = 1 }: Props) {
  const pi = useMemo(() => buildPi(), []);
  // Assemble order: center-out, so π converges rather than wipes.
  const piOrder = useMemo(() => {
    const cy = OFF_Y + PI_ART.length / 2;
    const cx = OFF_X + PI_ART[0]!.length / 2;
    return [...pi].sort((a, b) => {
      const [ar, ac] = a.split(',').map(Number) as [number, number];
      const [br, bc] = b.split(',').map(Number) as [number, number];
      return Math.hypot(ar - cy, ac - cx) - Math.hypot(br - cy, bc - cx);
    });
  }, [pi]);

  const accent = useMemo(() => {
    if (typeof window === 'undefined') return FALLBACK_ACCENT;
    const v = getComputedStyle(document.documentElement).getPropertyValue('--accent').trim();
    return v || FALLBACK_ACCENT;
  }, []);
  const reduced = useMemo(
    () =>
      typeof window !== 'undefined' &&
      !!window.matchMedia?.('(prefers-reduced-motion: reduce)').matches,
    [],
  );

  const liveRef = useRef<Set<string>>(pi);
  const [gen, setGen] = useState(0);

  useEffect(() => {
    if (reduced) return undefined;
    liveRef.current = pi;
    setGen(0);
    const id = setInterval(() => {
      setGen((g) => {
        const ng = g + 1;
        const phase = ng % CYCLE;
        if (phase === 0) {
          liveRef.current = pi; // new cycle: start from π and let it evolve
        } else if (phase < FREE) {
          const next = step(liveRef.current);
          liveRef.current = next.size > 0 ? next : pi;
        }
        return ng;
      });
    }, STEP_MS);
    return () => clearInterval(id);
  }, [reduced, pi]);

  const phase = reduced ? FREE + ASSEMBLE : gen % CYCLE;
  let display: Iterable<string>;
  if (phase < FREE) {
    display = liveRef.current;
  } else if (phase < FREE + ASSEMBLE) {
    const k = Math.ceil(((phase - FREE + 1) / ASSEMBLE) * piOrder.length);
    display = piOrder.slice(0, k);
  } else {
    display = piOrder;
  }

  const w = GRID_W * cell + (GRID_W - 1) * gap;
  const h = GRID_H * cell + (GRID_H - 1) * gap;
  const rx = Math.min(1.5, cell / 2.5);
  const at = (k: string): [number, number] => {
    const [r, c] = k.split(',').map(Number) as [number, number];
    return [c * (cell + gap), r * (cell + gap)];
  };

  return (
    <svg
      width={w}
      height={h}
      viewBox={`0 0 ${w} ${h}`}
      style={{ display: 'block', flex: '0 0 auto', opacity: 0.7 }}
      shapeRendering="geometricPrecision"
      role="img"
      aria-label="loading"
    >
      {Array.from(pi).map((k) => {
        const [x, y] = at(k);
        return (
          <rect key={`g${k}`} x={x} y={y} width={cell} height={cell} rx={rx} fill={accent} opacity={0.1} />
        );
      })}
      {Array.from(display).map((k) => {
        const [x, y] = at(k);
        return (
          <rect key={k} x={x} y={y} width={cell} height={cell} rx={rx} fill={accent}>
            {!reduced && (
              <animate attributeName="opacity" from="0.15" to="1" dur="220ms" fill="freeze" />
            )}
          </rect>
        );
      })}
    </svg>
  );
}
