// AIR-311: the hero's muted scan loop (web/public/media). A phone-shaped screen gets the 1080x1350 cut and its own poster. Under reduced motion only the poster is
// shown and the video is never loaded. The loop is decorative (aria-hidden) and has a pause button, since it runs longer than five seconds.
import { useEffect, useRef, useState } from 'react';
import { url } from '../static.ts';
import { useMedia } from './media.ts';

export const HERO_ALT = 'A rendered loop: suitcases ride a baggage belt through a glass scanner labelled AIRLOCK, and the scanner looks inside each one.';

export function HeroMedia() {
  const reduced = useMedia('(prefers-reduced-motion: reduce)');
  const tall = useMedia('(max-aspect-ratio: 4/5)');
  const [paused, setPaused] = useState(false);
  // the source is set after mount: the prerendered page cannot know the screen's shape, and a phone should not start on the wide file
  const [mounted, setMounted] = useState(false);
  useEffect(() => setMounted(true), []);
  const video = useRef<HTMLVideoElement>(null);
  const poster = url(tall ? 'media/hero-poster-916.jpg' : 'media/hero-poster.jpg');

  useEffect(() => {
    const v = video.current;
    if (v === null) return;
    if (paused) v.pause();
    else void v.play().catch(() => undefined);
  }, [paused, tall, mounted]);

  return (
    <div className="hero-media">
      {reduced ? (
        <img className="hero-video" src={poster} alt={HERO_ALT} data-testid="hero-poster" />
      ) : (
        <>
          <video key={tall ? 'tall' : 'wide'} ref={video} className="hero-video" src={mounted ? url(tall ? 'media/hero-loop-916.mp4' : 'media/hero-loop.mp4') : undefined} poster={poster} autoPlay muted loop playsInline preload="auto" aria-hidden="true" data-testid="hero-video" />
          <button type="button" className="hero-pause" data-testid="hero-pause" aria-pressed={paused} onClick={() => setPaused((p) => !p)}>
            {paused ? 'Play the loop' : 'Pause the loop'}
          </button>
        </>
      )}
      {reduced ? null : (
        <p className="sr-only" data-audit-skip="">
          {HERO_ALT}
        </p>
      )}
      <div className="hero-scrim" />
    </div>
  );
}
