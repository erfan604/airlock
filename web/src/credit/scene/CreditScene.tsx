// AIR-329: the 3D scene of /credit, loaded on demand (routes.ts lazy-imports this file, so no other page carries three.js). The vault is the pool:
// its liquid is the idle share of the assets and the band on its equator is the staked share. Each line is a card orbiting its chain world, with a
// tether back to the vault whose brightness is how much of the limit is drawn. A payment is a particle from a card through that chain's airlock
// ring to a merchant: it passes green, hangs amber while held, or breaks red on the ring. Repayment flows home with a gold fee spark. Every
// particle is made by an event of the `events` prop (a fixture event is marked fixture on the page); the scene draws nothing else that moves.
// No eval: three, react-three-fiber, postprocessing and gsap build no code from strings, and the scene loads no texture, font or worker.
import { Canvas, useFrame, useThree } from '@react-three/fiber';
import { Bloom, DepthOfField, EffectComposer, Noise, Vignette } from '@react-three/postprocessing';
import { gsap } from 'gsap';
import { BlendFunction } from 'postprocessing';
import { useEffect, useMemo, useRef } from 'react';
import type { MutableRefObject } from 'react';
import * as THREE from 'three';
import { manual } from '../../styles/tokens.ts';
import { CHAINS, bps } from '../model.ts';
import type { Chain, CreditEvent, PoolView } from '../model.ts';
import { CARD_ORBIT, CHAIN_COLOR, COLOR, CORE_RADIUS, cardPos, flightsOf, ringAxis, ringPos, rosterOf, settle, shatter, stepFlight, worldPos } from './choreo.ts';
import type { Flight, V3 } from './choreo.ts';

export type Quality = 'high' | 'low';

export type SceneProps = {
  pool: PoolView;
  events: readonly CreditEvent[];
  selected: string | null;
  onSelect(card: string | null): void;
  quality: Quality;
  onFps(fps: number): void;
  /** the DOM elements the scene moves to the screen position of a label, by key: `world-near` and `card` */
  labels: MutableRefObject<Map<string, HTMLElement>>;
};

const PAPER = new THREE.Color(manual.paper);
const hex = (c: number, boost = 1): THREE.Color => new THREE.Color(c).multiplyScalar(boost);
const CAPACITY = 1600;
const TRAIL = 9;
/** a visual ratio only (a bar length): the money itself stays BigInt */
const ratio = (part: string, whole: string): number => Math.min(1, Number(bps(part, whole)) / 10_000);

/** the camera's resting distance: far enough that the three rings and the merchants beyond them are all in frame */
const RADIUS = 24;

type Placement = { pos: V3; chain: Chain };

type Rig = { az: number; pol: number; radius: number; target: THREE.Vector3; follow: string | null; intro: number };

function useRig(selected: string | null): MutableRefObject<Rig> {
  const rig = useRef<Rig>({ az: 0.2, pol: 1.22, radius: 40, target: new THREE.Vector3(0, 0, 0), follow: null, intro: 0 });
  useEffect(() => {
    const r = rig.current;
    const tween = gsap.timeline();
    if (r.intro === 0) {
      r.intro = 1;
      tween.to(r, { radius: RADIUS, pol: 1.3, duration: 3.6, ease: 'power3.out' });
    }
    return () => {
      tween.kill();
    };
  }, []);
  useEffect(() => {
    const r = rig.current;
    r.follow = selected;
    const t = gsap.to(r, { radius: selected === null ? RADIUS : 6.4, pol: selected === null ? 1.3 : 1.25, duration: 1.9, ease: 'power3.inOut', overwrite: 'auto' });
    if (selected === null) gsap.to(r.target, { x: 0, y: 0, z: 0, duration: 1.9, ease: 'power3.inOut' });
    return () => {
      t.kill();
    };
  }, [selected]);
  return rig;
}

function Camera({ rig, reduce, positions }: { rig: MutableRefObject<Rig>; reduce: boolean; positions: MutableRefObject<Map<string, Placement>> }) {
  const { camera, pointer, size } = useThree();
  // a phone stage is tall: a wider lens and a higher viewpoint fit the three worlds across it without standing a mile back
  useEffect(() => {
    const cam = camera as THREE.PerspectiveCamera;
    cam.fov = size.width >= 900 ? 36 : 60;
    cam.updateProjectionMatrix();
  }, [camera, size]);
  const smooth = useRef({ x: 0, y: 0 });
  useFrame((_, dt) => {
    const r = rig.current;
    const d = Math.min(dt, 0.05);
    r.az += d * (r.follow === null ? 0.045 : 0.02);
    smooth.current.x += (pointer.x - smooth.current.x) * Math.min(1, d * 2.5);
    smooth.current.y += (pointer.y - smooth.current.y) * Math.min(1, d * 2.5);
    if (r.follow !== null) {
      const p = positions.current.get(r.follow)?.pos;
      if (p !== undefined) r.target.lerp(new THREE.Vector3(p[0], p[1], p[2]), Math.min(1, d * 3.2));
    }
    const az = r.az + (reduce ? 0 : smooth.current.x * 0.1);
    const pol = r.pol - (size.width < 900 ? 0.3 : 0) - (reduce ? 0 : smooth.current.y * 0.05);
    // a tall, narrow stage has a narrow field of view: stand back until the three worlds fit across it
    const fit = Math.max(1, (r.follow === null ? 0.95 : 0.7) / (size.width / size.height));
    const dist = r.radius * fit;
    camera.position.set(r.target.x + dist * Math.sin(pol) * Math.cos(az), r.target.y + dist * Math.cos(pol), r.target.z + dist * Math.sin(pol) * Math.sin(az));
    camera.lookAt(r.target);
  });
  return null;
}

const GLASS_VERT = /* glsl */ `
varying vec3 vN;
varying vec3 vV;
void main() {
  vec4 mv = modelViewMatrix * vec4(position, 1.0);
  vN = normalize(normalMatrix * normal);
  vV = normalize(-mv.xyz);
  gl_Position = projectionMatrix * mv;
}`;
const GLASS_FRAG = /* glsl */ `
uniform vec3 uTint;
uniform vec3 uRim;
uniform float uBody;
uniform float uPow;
varying vec3 vN;
varying vec3 vV;
void main() {
  float f = pow(1.0 - clamp(dot(normalize(vN), normalize(vV)), 0.0, 1.0), uPow);
  vec3 c = mix(uTint, uRim, f);
  gl_FragColor = vec4(c, uBody + f * 0.55);
}`;

/** A solid glass look without lights or textures: a tinted body that thickens toward the rim (fresnel), so a sphere reads as a smooth glass ball. */
function glassMaterial(tint: THREE.Color, rim: THREE.Color, body: number, power = 2.4): THREE.ShaderMaterial {
  return new THREE.ShaderMaterial({ vertexShader: GLASS_VERT, fragmentShader: GLASS_FRAG, transparent: true, depthWrite: false, uniforms: { uTint: { value: tint }, uRim: { value: rim }, uBody: { value: body }, uPow: { value: power } } });
}

function Vault({ pool }: { pool: PoolView }) {
  const liquid = useRef<THREE.Mesh>(null);
  const surface = useRef<THREE.Mesh>(null);
  const plane = useMemo(() => new THREE.Plane(new THREE.Vector3(0, -1, 0), 0), []);
  const level = useRef(0);
  const idleShare = ratio(pool.idle, pool.assets);
  const stakedShare = ratio(pool.staked, pool.assets);
  const shell = useMemo(() => glassMaterial(hex(COLOR.xray, 0.08), hex(COLOR.xray, 0.9), 0.1), []);
  const gl = useThree((s) => s.gl);
  useEffect(() => {
    gl.localClippingEnabled = true;
  }, [gl]);
  useFrame((state, dt) => {
    // ease the liquid to the pool's idle share: a deposit or a draw moves it
    level.current += (idleShare - level.current) * Math.min(1, dt * 1.6);
    const y = (level.current * 2 - 1) * CORE_RADIUS;
    plane.constant = y;
    if (surface.current) {
      const rr = Math.sqrt(Math.max(0, CORE_RADIUS * CORE_RADIUS - y * y));
      surface.current.position.y = y;
      surface.current.scale.setScalar(Math.max(0.001, rr));
    }
    if (liquid.current) liquid.current.rotation.y += dt * 0.12;
    const t = state.clock.elapsedTime;
    if (surface.current) (surface.current.material as THREE.MeshBasicMaterial).color.copy(hex(COLOR.xray, 0.95 + Math.sin(t * 1.3) * 0.1));
  });
  const arc = Math.max(0.02, stakedShare) * Math.PI * 2;
  return (
    <group>
      <mesh ref={liquid}>
        <sphereGeometry args={[CORE_RADIUS, 64, 48]} />
        <meshBasicMaterial color={hex(COLOR.xray, 0.42)} transparent opacity={0.8} clippingPlanes={[plane]} side={THREE.DoubleSide} toneMapped={false} />
      </mesh>
      <mesh ref={surface} rotation={[-Math.PI / 2, 0, 0]}>
        <circleGeometry args={[1, 64]} />
        <meshBasicMaterial color={hex(COLOR.xray, 2)} transparent opacity={0.9} toneMapped={false} />
      </mesh>
      <mesh material={shell} scale={1.12}>
        <sphereGeometry args={[CORE_RADIUS, 64, 48]} />
      </mesh>
      <mesh rotation={[Math.PI / 2, 0, 0.4]}>
        <torusGeometry args={[CORE_RADIUS * 1.42, 0.024, 10, 200, arc]} />
        <meshBasicMaterial color={hex(COLOR.clear, 1.5)} toneMapped={false} />
      </mesh>
      <mesh rotation={[Math.PI / 2, 0, 0]}>
        <torusGeometry args={[CORE_RADIUS * 1.42, 0.01, 6, 200]} />
        <meshBasicMaterial color={hex(COLOR.bone, 0.5)} transparent opacity={0.25} toneMapped={false} />
      </mesh>
    </group>
  );
}

function World({ chain, ringGlow }: { chain: Chain; ringGlow: MutableRefObject<Record<Chain, { c: THREE.Color; v: number }>> }) {
  const w = worldPos(chain);
  const ring = ringPos(chain);
  const axis = ringAxis(chain);
  const quat = useMemo(() => new THREE.Quaternion().setFromUnitVectors(new THREE.Vector3(0, 0, 1), new THREE.Vector3(axis[0], axis[1], axis[2])), [axis]);
  const planet = useMemo(() => glassMaterial(hex(CHAIN_COLOR[chain], 0.12), hex(CHAIN_COLOR[chain], 1.1), 0.22, 2.0), [chain]);
  const ringMat = useRef<THREE.MeshBasicMaterial>(null);
  const body = useRef<THREE.Group>(null);
  useFrame((state, dt) => {
    if (body.current) body.current.rotation.y += dt * 0.2;
    const g = ringGlow.current[chain];
    g.v = Math.max(0, g.v - dt * 1.4);
    if (ringMat.current) {
      ringMat.current.color.copy(g.c).multiplyScalar(0.55 + g.v * 3.2);
      ringMat.current.opacity = 0.55 + g.v * 0.45;
    }
    void state;
  });
  const color = CHAIN_COLOR[chain];
  return (
    <group>
      <group position={w} ref={body}>
        <mesh material={planet}>
          <sphereGeometry args={[0.66, 40, 28]} />
        </mesh>
        <mesh>
          <sphereGeometry args={[0.3, 24, 16]} />
          <meshBasicMaterial color={hex(color, 0.85)} toneMapped={false} />
        </mesh>
      </group>
      <mesh position={w} rotation={[Math.PI / 2 - 0.3, 0, 0]}>
        <torusGeometry args={[CARD_ORBIT, 0.006, 4, 160]} />
        <meshBasicMaterial color={hex(color, 0.5)} transparent opacity={0.3} toneMapped={false} />
      </mesh>
      <group position={ring} quaternion={quat}>
        <mesh>
          <torusGeometry args={[1.05, 0.045, 12, 96]} />
          <meshBasicMaterial ref={ringMat} color={hex(color, 0.55)} transparent opacity={0.55} toneMapped={false} />
        </mesh>
        <mesh position={[0, 0, 0.0]}>
          <ringGeometry args={[0.98, 1.0, 96]} />
          <meshBasicMaterial color={hex(COLOR.bone, 0.6)} transparent opacity={0.1} side={THREE.DoubleSide} toneMapped={false} />
        </mesh>
      </group>
    </group>
  );
}

const VERT = /* glsl */ `
uniform float uScale;
attribute float aSize;
attribute vec4 aColor;
varying vec4 vColor;
void main() {
  vColor = aColor;
  vec4 mv = modelViewMatrix * vec4(position, 1.0);
  gl_PointSize = aSize * uScale / max(0.1, -mv.z);
  gl_Position = projectionMatrix * mv;
}`;
const FRAG = /* glsl */ `
varying vec4 vColor;
void main() {
  float d = length(gl_PointCoord - 0.5);
  float core = smoothstep(0.5, 0.0, d);
  float a = pow(core, 1.7) * vColor.a;
  if (a < 0.004) discard;
  gl_FragColor = vec4(vColor.rgb * (1.0 + 2.2 * core), a);
}`;

type Live = { flight: Flight; trail: V3[]; prevT: number; ringed: boolean };

/** The particle field: one Points object that the event queue feeds. The queue releases an event at most every 0.38 s so a burst stays readable. */
function Flights({
  events,
  pool,
  ringGlow,
  positions,
}: {
  events: readonly CreditEvent[];
  pool: PoolView;
  ringGlow: MutableRefObject<Record<Chain, { c: THREE.Color; v: number }>>;
  positions: MutableRefObject<Map<string, Placement>>;
}) {
  const geo = useMemo(() => {
    const g = new THREE.BufferGeometry();
    g.setAttribute('position', new THREE.BufferAttribute(new Float32Array(CAPACITY * 3), 3));
    g.setAttribute('aSize', new THREE.BufferAttribute(new Float32Array(CAPACITY), 1));
    g.setAttribute('aColor', new THREE.BufferAttribute(new Float32Array(CAPACITY * 4), 4));
    g.setDrawRange(0, 0);
    return g;
  }, []);
  const mat = useMemo(
    () => new THREE.ShaderMaterial({ vertexShader: VERT, fragmentShader: FRAG, transparent: true, depthWrite: false, blending: THREE.AdditiveBlending, uniforms: { uScale: { value: 300 } } }),
    [],
  );
  const live = useRef<Live[]>([]);
  const queue = useRef<CreditEvent[]>([]);
  const seen = useRef<Set<string>>(new Set());
  const nextAt = useRef(0);
  const first = useRef(true);
  const roster = useRef(rosterOf([], new Map()));
  const paidOn = useRef<Map<string, Chain>>(new Map());

  useEffect(() => {
    for (const e of events) if (e.chain !== null && (e.kind === 'card_paid' || e.kind === 'card_held' || e.kind === 'card_refused')) paidOn.current.set(e.who, e.chain);
    roster.current = rosterOf(
      pool.lines.map((l) => l.card),
      paidOn.current,
    );
    const fresh = events.filter((e) => !seen.current.has(e.id));
    for (const e of fresh) seen.current.add(e.id);
    // a fresh page replays the last few events, so the scene is alive in the first seconds; later events queue as they come
    queue.current.push(...(first.current ? fresh.slice(-8) : fresh));
    first.current = false;
  }, [events, pool]);

  const { size, gl } = useThree();
  useFrame((state) => {
    const now = state.clock.elapsedTime;
    mat.uniforms['uScale']!.value = (size.height * gl.getPixelRatio()) / 2.2;
    // card places this frame, for the roster and for the camera to follow
    const where = (card: string): { chain: Chain; pos: V3 } | null => {
      const r = roster.current.get(card);
      return r === undefined ? null : { chain: r.chain, pos: cardPos(r.chain, r.slot, r.slots, now) };
    };
    for (const [card, r] of roster.current) positions.current.set(card, { chain: r.chain, pos: cardPos(r.chain, r.slot, r.slots, now) });
    while (queue.current.length > 0 && now >= nextAt.current) {
      const e = queue.current.shift();
      if (e === undefined) break;
      nextAt.current = now + 0.38;
      settle(live.current.map((l) => l.flight), e, now);
      for (const f of flightsOf(e, now, where)) {
        if (live.current.length < 140) live.current.push({ flight: f, trail: [], prevT: now, ringed: false });
      }
    }
    const pos = geo.getAttribute('position') as THREE.BufferAttribute;
    const sz = geo.getAttribute('aSize') as THREE.BufferAttribute;
    const col = geo.getAttribute('aColor') as THREE.BufferAttribute;
    let n = 0;
    const next: Live[] = [];
    const spawn: Flight[] = [];
    const c = new THREE.Color();
    for (const l of live.current) {
      const s = stepFlight(l.flight, now, l.prevT);
      l.prevT = now;
      if (s.hitRing) {
        if (l.flight.chain !== null) {
          const g = ringGlow.current[l.flight.chain];
          g.c.copy(hex(l.flight.color));
          g.v = 1;
        }
      }
      if (s.broke) spawn.push(...shatter(l.flight, s.pos, now));
      if (s.done) continue;
      next.push(l);
      if (l.flight.kind !== 'shard' && s.alpha > 0.01) {
        l.trail.unshift(s.pos);
        if (l.trail.length > TRAIL) l.trail.pop();
      } else if (l.trail.length > 0) l.trail.pop();
      c.set(l.flight.color);
      const draw = (p: V3, a: number, size2: number): void => {
        if (n >= CAPACITY) return;
        pos.setXYZ(n, p[0], p[1], p[2]);
        sz.setX(n, size2);
        col.setXYZW(n, c.r, c.g, c.b, a);
        n += 1;
      };
      if (s.alpha > 0.01) draw(s.pos, s.alpha, s.size * 0.55);
      l.trail.forEach((p, i) => {
        if (i === 0) return;
        const k = 1 - i / TRAIL;
        draw(p, s.alpha * k * 0.5, s.size * 0.34 * (0.4 + k));
      });
    }
    for (const f of spawn) next.push({ flight: f, trail: [], prevT: now, ringed: true });
    live.current = next;
    geo.setDrawRange(0, n);
    pos.needsUpdate = true;
    sz.needsUpdate = true;
    col.needsUpdate = true;
  });
  return <points geometry={geo} material={mat} frustumCulled={false} />;
}

function Cards({ pool, selected, onSelect, positions, labels }: { pool: PoolView; selected: string | null; onSelect(c: string | null): void; positions: MutableRefObject<Map<string, Placement>>; labels: SceneProps['labels'] }) {
  const group = useRef<THREE.Group>(null);
  const tethers = useRef<THREE.LineSegments>(null);
  const tetherGeo = useMemo(() => {
    const g = new THREE.BufferGeometry();
    g.setAttribute('position', new THREE.BufferAttribute(new Float32Array(64 * 6), 3));
    g.setAttribute('color', new THREE.BufferAttribute(new Float32Array(64 * 6), 3));
    return g;
  }, []);
  const edge = useMemo(() => new THREE.EdgesGeometry(new THREE.BoxGeometry(0.72, 0.46, 0.03)), []);
  const cards = pool.lines.slice(0, 64);
  const camera = useThree((s) => s.camera);
  const size = useThree((s) => s.size);
  const v = useMemo(() => new THREE.Vector3(), []);
  useFrame(() => {
    const g = group.current;
    if (g === null) return;
    const tp = tetherGeo.getAttribute('position') as THREE.BufferAttribute;
    const tc = tetherGeo.getAttribute('color') as THREE.BufferAttribute;
    cards.forEach((line, i) => {
      const obj = g.children[i];
      const placed = positions.current.get(line.card);
      if (obj === undefined || placed === undefined) return;
      const p = placed.pos;
      obj.position.set(p[0], p[1], p[2]);
      // a card faces the viewer, so its face reads from any side of the orbit
      obj.lookAt(camera.position);
      const used = ratio(line.drawn, line.limit);
      const dim = line.state === 'repaid' ? 0.25 : 1;
      const col = line.state === 'defaulted' ? hex(COLOR.refused) : hex(CHAIN_COLOR[placed.chain]);
      tp.setXYZ(i * 2, 0, 0, 0);
      tp.setXYZ(i * 2 + 1, p[0], p[1], p[2]);
      const k = (0.1 + used * 0.5) * dim;
      tc.setXYZ(i * 2, col.r * k * 0.2, col.g * k * 0.2, col.b * k * 0.2);
      tc.setXYZ(i * 2 + 1, col.r * k, col.g * k, col.b * k);
    });
    tp.needsUpdate = true;
    tc.needsUpdate = true;
    tetherGeo.setDrawRange(0, cards.length * 2);
    // the selected card's label follows it on screen
    const el = labels.current.get('card');
    if (el !== undefined) {
      const p = selected === null ? undefined : positions.current.get(selected)?.pos;
      if (p === undefined) el.style.opacity = '0';
      else {
        v.set(p[0], p[1] + 0.55, p[2]).project(camera);
        el.style.opacity = '1';
        el.style.transform = `translate(${((v.x * 0.5 + 0.5) * size.width).toFixed(1)}px, ${((-v.y * 0.5 + 0.5) * size.height).toFixed(1)}px) translate(-50%, -100%)`;
      }
    }
    for (const chain of CHAINS) {
      const w = worldPos(chain);
      const lab = labels.current.get(`world-${chain}`);
      if (lab === undefined) continue;
      v.set(w[0], w[1] - 1.05, w[2]).project(camera);
      lab.style.transform = `translate(${((v.x * 0.5 + 0.5) * size.width).toFixed(1)}px, ${((-v.y * 0.5 + 0.5) * size.height).toFixed(1)}px) translate(-50%, 0)`;
    }
  });
  return (
    <>
      <lineSegments ref={tethers} geometry={tetherGeo} frustumCulled={false}>
        <lineBasicMaterial vertexColors transparent opacity={0.9} toneMapped={false} blending={THREE.AdditiveBlending} depthWrite={false} />
      </lineSegments>
      <group ref={group}>
        {cards.map((line) => {
          const on = selected === line.card;
          const col = line.state === 'defaulted' ? COLOR.refused : COLOR.bone;
          return (
            <group
              key={line.card}
              onClick={(e) => {
                e.stopPropagation();
                onSelect(on ? null : line.card);
              }}
              onPointerOver={(e) => {
                e.stopPropagation();
                document.body.style.cursor = 'pointer';
              }}
              onPointerOut={() => {
                document.body.style.cursor = '';
              }}
              scale={on ? 1.35 : 1}
            >
              <mesh>
                <boxGeometry args={[0.72, 0.46, 0.03]} />
                <meshBasicMaterial color={manual.sunk} toneMapped={false} />
              </mesh>
              <lineSegments geometry={edge}>
                <lineBasicMaterial color={hex(col, on ? 2.4 : 1.1)} toneMapped={false} />
              </lineSegments>
              <mesh position={[-0.2, 0.1, 0.02]}>
                <planeGeometry args={[0.12, 0.09]} />
                <meshBasicMaterial color={hex(COLOR.fee, 1.6)} toneMapped={false} />
              </mesh>
              <mesh position={[(ratio(line.drawn, line.limit) - 1) * 0.28, -0.14, 0.02]} scale={[Math.max(0.01, ratio(line.drawn, line.limit)), 1, 1]}>
                <planeGeometry args={[0.56, 0.035]} />
                <meshBasicMaterial color={hex(COLOR.clear, 1.6)} toneMapped={false} />
              </mesh>
            </group>
          );
        })}
      </group>
    </>
  );
}

function Frame({ onFps }: { onFps(fps: number): void }) {
  const acc = useRef({ t: 0, n: 0 });
  useFrame((_, dt) => {
    const a = acc.current;
    a.t += dt;
    a.n += 1;
    if (a.t >= 2.5) {
      onFps(a.n / a.t);
      a.t = 0;
      a.n = 0;
    }
  });
  return null;
}

function Post({ quality, rig }: { quality: Quality; rig: MutableRefObject<Rig> }) {
  const dof = useRef<{ target: THREE.Vector3 | null } | null>(null);
  useEffect(() => {
    if (dof.current) dof.current.target = rig.current.target;
  });
  const wide = useThree((st) => st.size.width >= 900);
  // depth of field only where the camera stands at the tuned distance: a tall phone stage stands much further back and would blur the vault away
  const high = quality === 'high' && wide;
  return (
    <EffectComposer multisampling={0}>
      <Bloom mipmapBlur intensity={quality === 'high' ? 0.62 : 0.45} luminanceThreshold={0.55} luminanceSmoothing={0.4} radius={0.85} />
      {high ? <DepthOfField ref={dof as never} focusRange={0.035} bokehScale={3.2} resolutionScale={0.5} /> : <></>}
      <Noise premultiply blendFunction={BlendFunction.SOFT_LIGHT} opacity={0.28} />
      <Vignette eskil={false} offset={0.22} darkness={0.78} />
    </EffectComposer>
  );
}

export default function CreditScene({ pool, events, selected, onSelect, quality, onFps, labels }: SceneProps) {
  const rig = useRig(selected);
  const positions = useRef<Map<string, Placement>>(new Map());
  const ringGlow = useRef<Record<Chain, { c: THREE.Color; v: number }>>({
    near: { c: hex(COLOR.clear), v: 0 },
    base: { c: hex(COLOR.xray), v: 0 },
    solana: { c: hex(COLOR.purple), v: 0 },
  });
  const reduce = false;
  return (
    <Canvas
      dpr={quality === 'high' ? [1, 1.75] : 1}
      camera={{ fov: 36, near: 0.1, far: 120, position: [0, 6, 30] }}
      gl={{ antialias: false, powerPreference: 'high-performance', alpha: false, stencil: false }}
      onPointerMissed={() => onSelect(null)}
      aria-hidden="true"
      data-testid="credit-canvas"
    >
      <color attach="background" args={[PAPER.getHex()]} />
      <fog attach="fog" args={[PAPER.getHex(), 24, 58]} />
      <Camera rig={rig} reduce={reduce} positions={positions} />
      <Vault pool={pool} />
      {CHAINS.map((c) => (
        <World key={c} chain={c} ringGlow={ringGlow} />
      ))}
      <Cards pool={pool} selected={selected} onSelect={onSelect} positions={positions} labels={labels} />
      <Flights events={events} pool={pool} ringGlow={ringGlow} positions={positions} />
      <Frame onFps={onFps} />
      <Post quality={quality} rig={rig} />
    </Canvas>
  );
}
