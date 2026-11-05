// AIR-311: the How it works band, a pneumatic tube office rendered in Blender (web/public/media/tubes*.mp4; a 2.4:1 cut for wide screens and its
// own 4:5 composition for phones). It runs full bleed behind the section and tells the page which step it is showing, so the step under it
// lights at the same moment: the capsules ride in with their labels (step 1), pass through the AIRLOCK box (step 2), and only the allowed
// ones leave on PAY while the email capsule waits under the lit HELD lamp (step 3). The file loads only when the band comes near the
// viewport; under reduced motion the poster is shown and no step is lit. The description is the poster's alt text and a caption.
import { useEffect, useRef, useState } from 'react';
import { url } from '../static.ts';
import { useMedia } from './media.ts';

export const TUBES_ALT =
  'A pneumatic tube office: capsules banded for YOU, ADDRESS BOOK and EMAIL ride brass tubes into a junction box engraved AIRLOCK. The capsules from you and from the address book leave on the tube marked PAY; the striped email capsule, carrying $1,800.00, stops in the cradle marked HELD and the green lamp above it lights.';

/** The step the loop is showing at time t (seconds into the 6 s loop of tube_office.py). */
export function stepAt(t: number): 0 | 1 | 2 {
  const s = ((t % 6) + 6) % 6;
  return s < 1.6 ? 0 : s < 3.2 ? 1 : 2;
}

export function TubeBand({ onStep }: { onStep: (step: 0 | 1 | 2 | null) => void }) {
  const reduced = useMedia('(prefers-reduced-motion: reduce)');
  const tall = useMedia('(max-width: 719px)');
  const [near, setNear] = useState(false);
  const box = useRef<HTMLElement>(null);
  const cut = tall ? 'tubes-45' : 'tubes';
  const poster = url(`media/${cut}-poster.jpg`);

  useEffect(() => {
    if (near || reduced) return undefined;
    const el = box.current;
    if (el === null || typeof IntersectionObserver !== 'function') {
      setNear(true);
      return undefined;
    }
    const io = new IntersectionObserver((entries) => {
      if (entries.some((e) => e.isIntersecting)) {
        setNear(true);
        io.disconnect();
      }
    }, { rootMargin: '300px 0px' });
    io.observe(el);
    return () => io.disconnect();
  }, [near, reduced]);

  useEffect(() => {
    if (reduced) onStep(null);
  }, [reduced, onStep]);

  return (
    <figure ref={box} className="tube-band" data-testid="tube-band">
      {reduced ? (
        <img className="tube-band-media" src={poster} alt={TUBES_ALT} data-testid="tube-band-poster" />
      ) : (
        <>
          <video
            key={cut}
            className="tube-band-media"
            src={near ? url(`media/${cut}.mp4`) : undefined}
            poster={poster}
            autoPlay
            muted
            loop
            playsInline
            preload={near ? 'auto' : 'none'}
            aria-hidden="true"
            data-testid="tube-band-video"
            onTimeUpdate={(e) => onStep(stepAt(e.currentTarget.currentTime))}
          />
          <figcaption className="sr-only" data-audit-skip="">
            {TUBES_ALT}
          </figcaption>
        </>
      )}
    </figure>
  );
}
