import type { CSSProperties } from 'react';
import styles from './PiGlyph.module.css';

interface Props {
  size?: number;
  className?: string;
  style?: CSSProperties;
}

/** Square accent tile with an italic π. Used in the title bar, sidebar, and avatar slots. */
export function PiGlyph({ size = 22, className, style }: Props) {
  const computed: CSSProperties = {
    width: size,
    height: size,
    fontSize: Math.round(size * 0.73),
    borderRadius: Math.max(4, Math.round(size * 0.27)),
    ...style,
  };
  return (
    <span className={`${styles.glyph} ${className ?? ''}`.trim()} style={computed} aria-hidden>
      π
    </span>
  );
}
