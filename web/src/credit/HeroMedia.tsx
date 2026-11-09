// AIR-329: the credit hero's media: a muted looping render of an agent card behind the headline. Same rules as landing/HeroMedia.tsx: under reduced
// motion only the poster is shown and the video is never loaded, the source is set after mount, the loop is decorative and has a pause button.
// Without the files (media.ts) it renders nothing and the hero is the plain gradient.
import { useEffect, useRef, useState } from 'react';
import { useMedia } from '../landing/media.ts';
import { url } from '../static.ts';
import { CREDIT_LOOP, CREDIT_MEDIA, CREDIT_MEDIA_ALT, CREDIT_POSTER } from './media.ts';

export function CreditHeroMedia({ enabled = CREDIT_MEDIA }: { enabled?: boolean }) {
  const reduced = useMedia('(prefers-reduced-motion: reduce)');
  const [paused, setPaused] = useState(false);
  const [mounted, setMounted] = useState(false);
  const [failed, setFailed] = useState(false);
  useEffect(() => setMounted(true), []);
  const video = useRef<HTMLVideoElement>(null);
  useEffect(() => {
    const v = video.current;
    if (v === null) return;
    if (paused) v.pause();
    else void v.play().catch(() => undefined);
  }, [paused, mounted]);
  if (!enabled || failed) return null;
  return (
    <div className="cr-media" data-testid="credit-media">
      {reduced ? (
        <img className="cr-media-el" src={url(CREDIT_POSTER)} alt={CREDIT_MEDIA_ALT} onError={() => setFailed(true)} />
      ) : (
        <>
          <video ref={video} className="cr-media-el" src={mounted ? url(CREDIT_LOOP) : undefined} poster={url(CREDIT_POSTER)} autoPlay muted loop playsInline preload="metadata" aria-hidden="true" onError={() => setFailed(true)} />
          <button type="button" className="cr-media-pause" aria-pressed={paused} onClick={() => setPaused((p) => !p)} data-testid="credit-media-pause">
            {paused ? 'Play the loop' : 'Pause the loop'}
          </button>
        </>
      )}
      <div className="cr-media-scrim" />
    </div>
  );
}
