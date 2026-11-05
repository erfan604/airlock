// AIR-311: the hero's muted scan loop (web/public/media). A phone-shaped screen gets the 1080x1350 cut and its own poster. Under reduced motion only the poster is
// shown and the video is never loaded. The loop is decorative (aria-hidden) and has a pause button, since it runs longer than five seconds.
import { useEffect, useRef, useState } from 'react';
import { url } from '../static.ts';

function useMedia(query: string): boolean {
  const get = (): boolean => typeof window !== 'undefined' && typeof window.matchMedia === 'function' && window.matchMedia(query).matches;
  const [on, setOn] = useState(get);
  useEffect(() => {
    if (typeof window.matchMedia !== 'function') return undefined;
    const m = window.matchMedia(query);
    const onChange = (): void => setOn(m.matches);
    m.addEventListener('change', onChange);
    setOn(m.matches);
    return () => m.removeEventListener('change', onChange);
  }, [query]);
  return on;
}

export function HeroMedia() {
  const reduced = useMedia('(prefers-reduced-motion: reduce)');
  const tall = useMedia('(max-aspect-ratio: 4/5)');
  const [paused, setPaused] = useState(false);
  const video = useRef<HTMLVideoElement>(null);
  const poster = url(tall ? 'media/hero-poster-916.jpg' : 'media/hero-poster.jpg');

  useEffect(() => {
    const v = video.current;
    if (v === null) return;
    if (paused) v.pause();
    else void v.play().catch(() => undefined);
  }, [paused, tall]);

  return (
    <div className="hero-media" aria-hidden={reduced ? 'true' : undefined}>
      {reduced ? (
        <img className="hero-video" src={poster} alt="" data-testid="hero-poster" />
      ) : (
        <>
          <video key={tall ? 'tall' : 'wide'} ref={video} className="hero-video" src={url(tall ? 'media/hero-loop-916.mp4' : 'media/hero-loop.mp4')} poster={poster} autoPlay muted loop playsInline preload="auto" aria-hidden="true" data-testid="hero-video" />
          <button type="button" className="hero-pause" data-testid="hero-pause" aria-pressed={paused} onClick={() => setPaused((p) => !p)}>
            {paused ? 'Play the loop' : 'Pause the loop'}
          </button>
        </>
      )}
      <div className="hero-scrim" />
    </div>
  );
}
