// AIR-311: a short Blender loop from the baggage-hall world that explains one thing on the page (web/public/media/<name>.mp4 with its poster
// <name>-poster.jpg). Muted, looping, inline, no controls. The file is fetched only when the loop comes near the viewport (or at once with
// `eager`, for a loop at the top of a page); under reduced motion only the poster is shown and the video is never loaded. The description is
// the poster's alt text, and for the moving loop it is a caption that screen readers and text-only readers get.
import { useEffect, useRef, useState } from 'react';
import { url } from '../static.ts';
import { useMedia } from './media.ts';

export function SiteLoop({ name, alt, className, eager = false }: { name: string; alt: string; className?: string; eager?: boolean }) {
  const reduced = useMedia('(prefers-reduced-motion: reduce)');
  const [near, setNear] = useState(eager);
  const box = useRef<HTMLElement>(null);
  const poster = url(`media/${name}-poster.jpg`);

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
    }, { rootMargin: '400px 0px' });
    io.observe(el);
    return () => io.disconnect();
  }, [near, reduced]);

  return (
    <figure ref={box} className={`site-loop${className === undefined ? '' : ` ${className}`}`} data-testid={`loop-${name}`}>
      {reduced ? (
        <img className="site-loop-media" src={poster} alt={alt} width={1280} height={720} data-testid={`loop-${name}-poster`} />
      ) : (
        <>
          <video className="site-loop-media" src={near ? url(`media/${name}.mp4`) : undefined} poster={poster} width={1280} height={720} autoPlay muted loop playsInline preload={near ? 'auto' : 'none'} aria-hidden="true" data-testid={`loop-${name}-video`} />
          <figcaption className="sr-only" data-audit-skip="">
            {alt}
          </figcaption>
        </>
      )}
    </figure>
  );
}
