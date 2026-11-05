// AIR-311: a one-shot Blender clip that plays once and holds its last frame (the stamp coming down on the Try page, a wagon reaching its
// track on the Replay page). `name` is the clip: media/<name>.mp4 for wide screens and media/<name>-phone.mp4, its own phone composition, for
// phones; media/<name>-end.jpg and <name>-phone-end.jpg are the last frames, -start.jpg the first. Under reduced motion only the last frame is shown. The clip
// restarts whenever `name` or `run` changes (a new verdict, a new act). The description is the image's alt text and a caption.
import { useEffect, useRef, useState } from 'react';
import { url } from '../static.ts';
import { useMedia } from './media.ts';

export function OneShot({ name, run, alt, className, testId }: { name: string; run: string; alt: string; className?: string; testId: string }) {
  const reduced = useMedia('(prefers-reduced-motion: reduce)');
  const tall = useMedia('(max-width: 719px)');
  const [mounted, setMounted] = useState(false);
  const video = useRef<HTMLVideoElement>(null);
  useEffect(() => setMounted(true), []);
  const cut = tall ? `${name}-phone` : name;
  useEffect(() => {
    const v = video.current;
    if (v === null) return;
    v.currentTime = 0;
    void v.play().catch(() => undefined);
  }, [cut, run, mounted]);
  return (
    <figure className={`one-shot${className === undefined ? '' : ` ${className}`}`} data-testid={testId} data-clip={name}>
      {reduced || !mounted ? (
        <img className="one-shot-media" src={url(`media/${cut}-end.jpg`)} alt={alt} data-testid={`${testId}-end`} />
      ) : (
        <>
          <video key={cut} ref={video} className="one-shot-media" src={url(`media/${cut}.mp4`)} poster={url(`media/${cut}-start.jpg`)} autoPlay muted playsInline preload="auto" aria-hidden="true" data-testid={`${testId}-video`} />
          <figcaption className="sr-only" data-audit-skip="">
            {alt}
          </figcaption>
        </>
      )}
    </figure>
  );
}
