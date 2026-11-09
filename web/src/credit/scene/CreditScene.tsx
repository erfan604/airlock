// AIR-329: the 3D scene of /credit, loaded on demand (routes.ts lazy-imports this file, so no other page carries three.js). The vault is the pool:
// its liquid is the idle share of the assets and the band on its equator is the staked share. Each line is a card orbiting its chain world, with a
// tether back to the vault whose brightness is how much of the limit is drawn. A payment is a particle from a card through that chain's airlock
// ring to a merchant: it passes green, hangs amber while held, or breaks red on the ring. Repayment flows home with a gold fee spark. Every
// particle is made by an event of the `events` prop (a fixture event is marked fixture on the page); apart from the ambient flow along the lanes
// (which carries no data and stops under reduced motion) the scene draws nothing else that moves.
// 2026-11-09 look pass: metal and glass nodes lit by a procedural studio environment (RoomEnvironment, no file), the titanium card of the
// hero render as each line's face (media/credit-card-face.jpg, the only texture), a beveled metal gate ring with an emissive inner edge,
// glowing lane tubes. No eval: three, react-three-fiber, postprocessing and gsap build no code from strings; the scene loads no font or worker.
import { Canvas, useFrame, useLoader, useThree } from '@react-three/fiber';
import { Bloom, DepthOfField, EffectComposer, Noise, Vignette } from '@react-three/postprocessing';
import { gsap } from 'gsap';
import { BlendFunction } from 'postprocessing';
import { useEffect, useMemo, useRef } from 'react';
import type { MutableRefObject } from 'react';
import * as THREE from 'three';
import { RoomEnvironment } from 'three/examples/jsm/environments/RoomEnvironment.js';
import { url } from '../../static.ts';
import { manual } from '../../styles/tokens.ts';
import { CHAINS, bps } from '../model.ts';
import type { Chain, CreditEvent, PoolView } from '../model.ts';
import { CHAIN_COLOR, COLOR, CORE_RADIUS, cardPos, flightsOf, ringAxis, ringPos, rosterOf, settle, shatter, stepFlight, worldPos } from './choreo.ts';
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
const TRAIL = 16;
/** a visual ratio only (a bar length): the money itself stays BigInt */
const ratio = (part: string, whole: string): number => Math.min(1, Number(bps(part, whole)) / 10_000);

/** the camera's resting distance: far enough that the three rings and the merchants beyond them are all in frame */
const RADIUS = 18.5;

type Placement = { pos: V3; chain: Chain };

type Rig = { az: number; pol: number; radius: number; target: THREE.Vector3; follow: string | null; intro: number };

function useRig(selected: string | null): MutableRefObject<Rig> {
  const rig = useRef<Rig>({ az: 0.2, pol: 1.22, radius: 30, target: new THREE.Vector3(0, 0, 0), follow: null, intro: 0 });
  useEffect(() => {
    const r = rig.current;
    const tween = gsap.timeline();
    if (r.intro === 0) {
      r.intro = 1;
      tween.to(r, { radius: RADIUS, pol: 0.98, duration: 3.6, ease: 'power3.out' });
    }
    return () => {
      tween.kill();
    };
  }, []);
  useEffect(() => {
    const r = rig.current;
    r.follow = selected;
    const t = gsap.to(r, { radius: selected === null ? RADIUS : 3.6, pol: selected === null ? 0.98 : 1.25, duration: 1.9, ease: 'power3.inOut', overwrite: 'auto' });
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
    const pol = r.pol - (size.width < 900 ? 0.25 : 0) - (reduce ? 0 : smooth.current.y * 0.05);
    // a tall, narrow stage has a narrow field of view: stand back until the three worlds fit across it
    const fit = Math.max(1, (r.follow === null ? 0.95 : 0.7) / (size.width / size.height));
    const dist = r.radius * fit;
    const orbit = new THREE.Vector3(r.target.x + dist * Math.sin(pol) * Math.cos(az), r.target.y + dist * Math.cos(pol), r.target.z + dist * Math.sin(pol) * Math.sin(az));
    // following a card: stand outside its orbit, on the far side from its world, so the world and its gate never cover the card
    const placed = r.follow === null ? undefined : positions.current.get(r.follow);
    if (placed !== undefined) {
      const w = worldPos(placed.chain);
      const out = new THREE.Vector3(placed.pos[0] - w[0], 0, placed.pos[2] - w[2]).normalize().add(new THREE.Vector3(w[0], 0, w[2]).normalize().multiplyScalar(0.6)).normalize();
      const near = r.target.clone().add(out.multiplyScalar(dist * 0.94)).add(new THREE.Vector3(0, dist * 0.32, 0));
      const k = Math.min(1, Math.max(0, (RADIUS - r.radius) / (RADIUS - 3.6)));
      orbit.lerp(near, k * k * (3 - 2 * k));
    }
    // the overview aims a little below the pool, so the world nearest the camera sits in frame instead of off the bottom edge
    const wide = Math.min(1, Math.max(0, (r.radius - 3.6) / (RADIUS - 3.6)));
    const drop = new THREE.Vector3(0, -2.2 * wide, 0);
    camera.position.copy(orbit.add(drop));
    camera.lookAt(r.target.clone().add(drop));
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

/** A procedural studio environment for the metal and glass (no file is loaded). */
function Studio() {
  const gl = useThree((st) => st.gl);
  const scene = useThree((st) => st.scene);
  useEffect(() => {
    const pm = new THREE.PMREMGenerator(gl);
    const env = pm.fromScene(new RoomEnvironment(), 0.04).texture;
    scene.environment = env;
    scene.environmentIntensity = 0.55;
    return () => {
      scene.environment = null;
      env.dispose();
      pm.dispose();
    };
  }, [gl, scene]);
  return null;
}

const metal = (color: number, rough = 0.28, boost = 1): THREE.MeshStandardMaterial => new THREE.MeshStandardMaterial({ color: hex(color, boost), metalness: 1, roughness: rough });

/** The pool: a glass vault whose gold liquid is the idle share of the assets, held in two turning metal rings; the green band is the staked share. */
function Vault({ pool, reduce }: { pool: PoolView; reduce: boolean }) {
  const liquid = useRef<THREE.Mesh>(null);
  const surface = useRef<THREE.Mesh>(null);
  const gimbal = useRef<THREE.Group>(null);
  const plane = useMemo(() => new THREE.Plane(new THREE.Vector3(0, -1, 0), 0), []);
  const level = useRef(0);
  const idleShare = ratio(pool.idle, pool.assets);
  const stakedShare = ratio(pool.staked, pool.assets);
  const shell = useMemo(() => glassMaterial(hex(COLOR.fee, 0.05), hex(COLOR.bone, 0.95), 0.06, 3.0), []);
  const steel = useMemo(() => metal(0xb8bcc4, 0.22), []);
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
    if (!reduce) {
      if (liquid.current) liquid.current.rotation.y += dt * 0.12;
      if (gimbal.current) {
        gimbal.current.rotation.y += dt * 0.16;
        const inner = gimbal.current.children[1];
        if (inner !== undefined) inner.rotation.x += dt * 0.22;
      }
    }
    const t = state.clock.elapsedTime;
    if (surface.current) (surface.current.material as THREE.MeshBasicMaterial).color.copy(hex(COLOR.fee, 1.1 + Math.sin(t * 1.3) * 0.08));
  });
  const arc = Math.max(0.02, stakedShare) * Math.PI * 2;
  return (
    <group>
      <mesh ref={liquid}>
        <sphereGeometry args={[CORE_RADIUS, 64, 48]} />
        <meshStandardMaterial color={hex(COLOR.fee, 0.9)} metalness={0.9} roughness={0.32} emissive={hex(COLOR.fee, 0.18)} clippingPlanes={[plane]} side={THREE.DoubleSide} />
      </mesh>
      <mesh ref={surface} rotation={[-Math.PI / 2, 0, 0]}>
        <circleGeometry args={[1, 64]} />
        <meshBasicMaterial color={hex(COLOR.fee, 1.1)} transparent opacity={0.85} toneMapped={false} />
      </mesh>
      <mesh material={shell} scale={1.08}>
        <sphereGeometry args={[CORE_RADIUS, 64, 48]} />
      </mesh>
      <group ref={gimbal}>
        <mesh material={steel} rotation={[Math.PI / 2, 0, 0]}>
          <torusGeometry args={[CORE_RADIUS * 1.24, 0.05, 20, 160]} />
        </mesh>
        <group>
          <mesh material={steel} rotation={[0, Math.PI / 2, 0]}>
            <torusGeometry args={[CORE_RADIUS * 1.32, 0.04, 20, 160]} />
          </mesh>
        </group>
      </group>
      <mesh rotation={[Math.PI / 2, 0, 0.4]}>
        <torusGeometry args={[CORE_RADIUS * 1.5, 0.03, 10, 200, arc]} />
        <meshBasicMaterial color={hex(COLOR.clear, 1.6)} toneMapped={false} />
      </mesh>
      <mesh rotation={[Math.PI / 2, 0, 0]}>
        <torusGeometry args={[CORE_RADIUS * 1.5, 0.008, 6, 200]} />
        <meshBasicMaterial color={hex(COLOR.bone, 0.5)} transparent opacity={0.22} toneMapped={false} />
      </mesh>
    </group>
  );
}

function World({ chain, ringGlow, reduce }: { chain: Chain; ringGlow: MutableRefObject<Record<Chain, { c: THREE.Color; v: number }>>; reduce: boolean }) {
  const w = worldPos(chain);
  const ring = ringPos(chain);
  const axis = ringAxis(chain);
  const quat = useMemo(() => new THREE.Quaternion().setFromUnitVectors(new THREE.Vector3(0, 0, 1), new THREE.Vector3(axis[0], axis[1], axis[2])), [axis]);
  const color = CHAIN_COLOR[chain];
  const shell = useMemo(() => glassMaterial(hex(color, 0.04), hex(color, 1.25), 0.05, 2.8), [color]);
  const core = useMemo(() => new THREE.MeshStandardMaterial({ color: hex(color, 0.32), metalness: 0.85, roughness: 0.3, emissive: hex(color, 0.08) }), [color]);
  const steel = useMemo(() => metal(0xa9aeb6, 0.24), []);
  const edge = useRef<THREE.MeshBasicMaterial>(null);
  const body = useRef<THREE.Group>(null);
  useFrame((_, dt) => {
    if (body.current && !reduce) body.current.rotation.y += dt * 0.2;
    const g = ringGlow.current[chain];
    g.v = Math.max(0, g.v - dt * 1.2);
    // the inner edge rests a dim pass green and flashes the colour of what crossed it: green passed, amber held, red refused
    if (edge.current) edge.current.color.copy(hex(COLOR.clear, 0.35)).lerp(g.c.clone().multiplyScalar(3.4), Math.min(1, g.v));
  });
  return (
    <group>
      <group position={w} ref={body}>
        <mesh material={core}>
          <sphereGeometry args={[0.78, 48, 32]} />
        </mesh>
        <mesh material={shell}>
          <sphereGeometry args={[0.98, 48, 32]} />
        </mesh>
        <mesh rotation={[Math.PI / 2 - 0.3, 0, 0]}>
          <torusGeometry args={[1.12, 0.012, 8, 160]} />
          <meshBasicMaterial color={hex(color, 1.4)} transparent opacity={0.7} toneMapped={false} />
        </mesh>
      </group>
      <group position={ring} quaternion={quat}>
        <mesh material={steel}>
          <torusGeometry args={[1.22, 0.12, 28, 128]} />
        </mesh>
        <mesh position={[0, 0, 0.02]}>
          <torusGeometry args={[1.08, 0.028, 12, 128]} />
          <meshBasicMaterial ref={edge} color={hex(COLOR.clear, 0.35)} toneMapped={false} />
        </mesh>
      </group>
    </group>
  );
}

/** The lanes: a glowing tube from the pool to each chain and on through its gate, with a slow flow of light along it (no data, off under reduced motion). */
function lanePath(chain: Chain): THREE.CurvePath<THREE.Vector3> {
  const w = new THREE.Vector3(...worldPos(chain));
  const r = new THREE.Vector3(...ringPos(chain));
  const out = w.clone().normalize();
  const mid = w.clone().multiplyScalar(0.5).add(new THREE.Vector3(0, 1.4, 0));
  const path = new THREE.CurvePath<THREE.Vector3>();
  path.add(new THREE.QuadraticBezierCurve3(out.clone().multiplyScalar(CORE_RADIUS * 1.15), mid, w.clone().sub(out.clone().multiplyScalar(1.0))));
  path.add(new THREE.LineCurve3(w.clone().add(out.clone().multiplyScalar(1.0)), r.clone().add(out.clone().multiplyScalar(1.6))));
  return path;
}

const FLOW = 46;
function Lanes({ reduce }: { reduce: boolean }) {
  const paths = useMemo(() => CHAINS.map((c) => ({ chain: c, path: lanePath(c) })), []);
  const tubes = useMemo(() => paths.map(({ path }) => path.curves.map((c) => new THREE.TubeGeometry(c as THREE.Curve<THREE.Vector3>, 64, 0.035, 8, false))), [paths]);
  const geo = useMemo(() => {
    const g = new THREE.BufferGeometry();
    const n = FLOW * CHAINS.length;
    g.setAttribute('position', new THREE.BufferAttribute(new Float32Array(n * 3), 3));
    const size = new Float32Array(n);
    const col = new Float32Array(n * 4);
    paths.forEach(({ chain }, k) => {
      const c = new THREE.Color(CHAIN_COLOR[chain]);
      for (let i = 0; i < FLOW; i += 1) {
        const j = k * FLOW + i;
        size[j] = 0.09 + ((i * 37) % 11) * 0.006;
        col.set([c.r, c.g, c.b, 0.55], j * 4);
      }
    });
    g.setAttribute('aSize', new THREE.BufferAttribute(size, 1));
    g.setAttribute('aColor', new THREE.BufferAttribute(col, 4));
    return g;
  }, [paths]);
  const mat = useMemo(() => new THREE.ShaderMaterial({ vertexShader: VERT, fragmentShader: FRAG, transparent: true, depthWrite: false, blending: THREE.AdditiveBlending, uniforms: { uScale: { value: 300 } } }), []);
  const { size, gl } = useThree();
  const v = useMemo(() => new THREE.Vector3(), []);
  useFrame((state) => {
    mat.uniforms['uScale']!.value = (size.height * gl.getPixelRatio()) / 2.2;
    const t = reduce ? 0 : state.clock.elapsedTime;
    const pos = geo.getAttribute('position') as THREE.BufferAttribute;
    paths.forEach(({ path }, k) => {
      for (let i = 0; i < FLOW; i += 1) {
        const u = (i / FLOW + t * 0.045) % 1;
        path.getPointAt(u, v);
        pos.setXYZ(k * FLOW + i, v.x, v.y, v.z);
      }
    });
    pos.needsUpdate = true;
  });
  return (
    <group>
      {paths.map(({ chain }, k) =>
        (tubes[k] ?? []).map((t, j) => (
          <mesh key={`${chain}-${String(j)}`} geometry={t}>
            <meshBasicMaterial color={hex(CHAIN_COLOR[chain], 0.9)} transparent opacity={0.28} blending={THREE.AdditiveBlending} depthWrite={false} toneMapped={false} />
          </mesh>
        )),
      )}
      <points geometry={geo} material={mat} frustumCulled={false} />
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
  const face = useLoader(THREE.TextureLoader, url('media/credit-card-face.jpg'));
  const card = useMemo(() => {
    // ID-1 proportions at scene scale, rounded corners, a thin metal slab with a small bevel
    const w = 0.92, h = 0.58, r = 0.05;
    const sh = new THREE.Shape();
    sh.moveTo(-w / 2 + r, -h / 2);
    sh.lineTo(w / 2 - r, -h / 2);
    sh.quadraticCurveTo(w / 2, -h / 2, w / 2, -h / 2 + r);
    sh.lineTo(w / 2, h / 2 - r);
    sh.quadraticCurveTo(w / 2, h / 2, w / 2 - r, h / 2);
    sh.lineTo(-w / 2 + r, h / 2);
    sh.quadraticCurveTo(-w / 2, h / 2, -w / 2, h / 2 - r);
    sh.lineTo(-w / 2, -h / 2 + r);
    sh.quadraticCurveTo(-w / 2, -h / 2, -w / 2 + r, -h / 2);
    const g = new THREE.ExtrudeGeometry(sh, { depth: 0.014, bevelEnabled: true, bevelThickness: 0.004, bevelSize: 0.004, bevelSegments: 2, curveSegments: 10 });
    g.translate(0, 0, -0.007);
    face.colorSpace = THREE.SRGBColorSpace;
    face.anisotropy = 4;
    // the caps' UVs are the shape's own coordinates: map them onto the 0..1 texture
    face.repeat.set(1 / w, 1 / h);
    face.offset.set(0.5, 0.5);
    const faceMat = new THREE.MeshStandardMaterial({ map: face, metalness: 0.75, roughness: 0.32, color: hex(0xffffff, 0.9) });
    const edgeMat = new THREE.MeshStandardMaterial({ color: hex(0xc9ccd2), metalness: 1, roughness: 0.18 });
    return { g, shape: sh, mats: [faceMat, edgeMat] };
  }, [face]);
  const halo = useMemo(() => {
    const g = new THREE.ShapeGeometry(card.shape, 10);
    g.scale(1.07, 1.11, 1);
    return g;
  }, [card]);
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
      // the tether stops short of the card, so it never draws across the card's face
      const len = Math.hypot(p[0], p[1], p[2]) || 1;
      const cut = Math.max(0, 1 - 0.75 / len);
      tp.setXYZ(i * 2 + 1, p[0] * cut, p[1] * cut, p[2] * cut);
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
        v.set(p[0], p[1] + 0.62, p[2]).project(camera);
        el.style.opacity = '1';
        el.style.transform = `translate(${((v.x * 0.5 + 0.5) * size.width).toFixed(1)}px, ${((-v.y * 0.5 + 0.5) * size.height).toFixed(1)}px) translate(-50%, -100%)`;
      }
    }
    const poolLab = labels.current.get('world-pool');
    if (poolLab !== undefined) {
      poolLab.style.opacity = selected === null ? '1' : '0';
      v.set(0, -CORE_RADIUS * 1.62, 0).project(camera);
      poolLab.style.transform = `translate(${((v.x * 0.5 + 0.5) * size.width).toFixed(1)}px, ${((-v.y * 0.5 + 0.5) * size.height).toFixed(1)}px) translate(-50%, 0)`;
    }
    for (const chain of CHAINS) {
      const w = worldPos(chain);
      const lab = labels.current.get(`world-${chain}`);
      if (lab === undefined) continue;
      // the chain names step aside while the camera follows a card
      lab.style.opacity = selected === null ? '1' : '0';
      v.set(w[0], w[1] - 1.3, w[2]).project(camera);
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
              scale={on ? 1.25 : 1}
            >
              <mesh geometry={card.g} material={card.mats} />
              {line.state === 'defaulted' || on ? (
                <mesh geometry={halo} position={[0, 0, -0.02]}>
                  <meshBasicMaterial color={hex(line.state === 'defaulted' ? COLOR.refused : COLOR.clear, on ? 1.2 : 0.7)} transparent opacity={0.22} blending={THREE.AdditiveBlending} depthWrite={false} toneMapped={false} />
                </mesh>
              ) : null}
              <mesh position={[(ratio(line.drawn, line.limit) - 1) * 0.42, -0.36, 0]} scale={[Math.max(0.01, ratio(line.drawn, line.limit)), 1, 1]}>
                <planeGeometry args={[0.84, 0.022]} />
                <meshBasicMaterial color={hex(line.state === 'defaulted' ? COLOR.refused : COLOR.clear, 1.4)} toneMapped={false} />
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

function Post({ quality, rig, following }: { quality: Quality; rig: MutableRefObject<Rig>; following: boolean }) {
  const dof = useRef<{ target: THREE.Vector3 | null } | null>(null);
  // the effect gets its own vector, refreshed every frame: handing it the rig's target lets the effect's math move the camera's aim
  const focus = useMemo(() => new THREE.Vector3(), []);
  useFrame(() => {
    focus.copy(rig.current.target);
    if (dof.current) dof.current.target = focus;
  });
  const wide = useThree((st) => st.size.width >= 900);
  // depth of field only where the camera stands at the tuned distance: a tall phone stage stands much further back and would blur the vault away
  // and not while following a card: the card is the subject and must stay sharp
  const high = quality === 'high' && wide && !following;
  return (
    <EffectComposer multisampling={0}>
      <Bloom mipmapBlur intensity={quality === 'high' ? 0.7 : 0.5} luminanceThreshold={0.62} luminanceSmoothing={0.3} radius={0.8} />
      {high ? <DepthOfField ref={dof as never} focusRange={0.035} bokehScale={3.2} resolutionScale={0.5} /> : <></>}
      <Noise premultiply blendFunction={BlendFunction.SOFT_LIGHT} opacity={0.12} />
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
  const reduce = useMemo(() => typeof window !== 'undefined' && window.matchMedia('(prefers-reduced-motion: reduce)').matches, []);
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
      <fog attach="fog" args={[PAPER.getHex(), 22, 52]} />
      <Camera rig={rig} reduce={reduce} positions={positions} />
      <Studio />
      <ambientLight intensity={0.25} />
      <directionalLight position={[6, 10, 8]} intensity={1.6} />
      <directionalLight position={[-8, 3, -6]} intensity={0.6} color={hex(COLOR.xray)} />
      <Vault pool={pool} reduce={reduce} />
      <Lanes reduce={reduce} />
      {CHAINS.map((c) => (
        <World key={c} chain={c} ringGlow={ringGlow} reduce={reduce} />
      ))}
      <Cards pool={pool} selected={selected} onSelect={onSelect} positions={positions} labels={labels} />
      <Flights events={events} pool={pool} ringGlow={ringGlow} positions={positions} />
      <Frame onFps={onFps} />
      <Post quality={quality} rig={rig} following={selected !== null} />
    </Canvas>
  );
}
