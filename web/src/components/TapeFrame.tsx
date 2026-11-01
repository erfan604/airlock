// TapeFrame (DESIGN.md 2.5): the only user of the stripe. Stripes surround text, never sit behind it: the interior is flat
// paper or sunk with its own 2 px ink line. The stripe itself is the `.tape` class of the stylesheet.
import type { ReactNode } from 'react';

export type TapeFrameProps = {
  thickness?: 8 | 10 | 20;
  interior?: 'paper' | 'sunk';
  children?: ReactNode;
};

export function TapeFrame({ thickness = 10, interior = 'paper', children }: TapeFrameProps) {
  return (
    <div className={`tape-frame tape-frame-t${thickness}`} data-testid="tape-frame">
      <div className={`tape-frame-interior tape-frame-interior-${interior}`}>{children}</div>
    </div>
  );
}
