import {
  ACESFilmicToneMapping,
  Color,
  DirectionalLight,
  Group,
  Mesh,
  MeshPhysicalMaterial,
  MeshStandardMaterial,
  PerspectiveCamera,
  PMREMGenerator,
  PointLight,
  Scene,
  SphereGeometry,
  SRGBColorSpace,
  WebGLRenderer,
} from 'three';
import { RoomEnvironment } from 'three/examples/jsm/environments/RoomEnvironment.js';
import { RoundedBoxGeometry } from 'three/examples/jsm/geometries/RoundedBoxGeometry.js';

const SHEET_COLORS = [0x17191e, 0x121418, 0x0c0d10] as const;
const LINE_WIDTHS = [1.5, 1.2, 1.6, 0.9] as const;
const LIVE_CORAL = 0xff5e62;
const WARM_ORANGE = 0xff9966;
const RIM_WHITE = 0xdfe6ee;

function sheets(): Group {
  const stack = new Group();
  const geometry = new RoundedBoxGeometry(2.4, 3, 0.16, 6, 0.16);
  SHEET_COLORS.forEach((color, index) => {
    const material = new MeshPhysicalMaterial({
      color,
      metalness: 0.75,
      roughness: 0.26,
      clearcoat: 1,
      clearcoatRoughness: 0.12,
    });
    const sheet = new Mesh(geometry, material);
    sheet.position.set(index * 0.5 - 0.5, index * 0.5 - 0.5, -index * 0.7);
    stack.add(sheet);
  });
  const lineMaterial = new MeshPhysicalMaterial({ color: 0x8a8f9c, metalness: 0.2, roughness: 0.35 });
  LINE_WIDTHS.forEach((width, index) => {
    const line = new Mesh(new RoundedBoxGeometry(width, 0.13, 0.04, 2, 0.06), lineMaterial);
    line.position.set(-1.36 + width / 2, 0.55 - index * 0.36, 0.1);
    stack.add(line);
  });
  const dot = new Mesh(
    new SphereGeometry(0.42, 48, 48),
    new MeshStandardMaterial({
      color: 0xd93a3f,
      emissive: LIVE_CORAL,
      emissiveIntensity: 0.8,
      roughness: 0.18,
      metalness: 0.1,
    }),
  );
  dot.position.set(0.95, -1.55, 0.45);
  stack.add(dot);
  const glow = new PointLight(WARM_ORANGE, 6, 6, 1.6);
  glow.position.set(0.95, -1.55, 1.1);
  stack.add(glow);
  return stack;
}

function lights(scene: Scene): void {
  const key = new DirectionalLight(0xffffff, 1.6);
  key.position.set(-4, 5, 6);
  const rim = new DirectionalLight(new Color(RIM_WHITE), 0.8);
  rim.position.set(5, -2, -4);
  scene.add(key, rim);
}

/**
 * Renders the workspacekit mark in 3D inside `host` and returns a function that stops and frees it. The
 * stack drifts slowly, turns as the page scrolls and leans towards the pointer while it is over the model;
 * with reduced motion it renders one still frame.
 *
 * @example
 * const stop = mountHeroScene(element);
 */
export function mountHeroScene(host: HTMLElement): () => void {
  const renderer = new WebGLRenderer({ antialias: true, alpha: true });
  renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
  renderer.outputColorSpace = SRGBColorSpace;
  renderer.toneMapping = ACESFilmicToneMapping;
  host.appendChild(renderer.domElement);
  const scene = new Scene();
  const environment = new PMREMGenerator(renderer).fromScene(new RoomEnvironment(), 0.04);
  scene.environment = environment.texture;
  scene.environmentIntensity = 0.9;
  const camera = new PerspectiveCamera(32, 1, 0.1, 100);
  camera.position.set(0, 0, 11);
  const stack = sheets();
  stack.rotation.set(-0.38, 0.78, 0.08);
  scene.add(stack);
  lights(scene);

  const target = { x: 0, y: 0 };
  const pointer = { x: 0, y: 0 };
  const reducedMotion = window.matchMedia('(prefers-reduced-motion: reduce)').matches;
  let frame = 0;
  let isOnScreen = true;
  const resize = (): void => {
    const { width, height } = host.getBoundingClientRect();
    renderer.setSize(width, height, false);
    camera.aspect = width / Math.max(height, 1);
    camera.updateProjectionMatrix();
    renderer.render(scene, camera);
  };
  const tick = (time: number): void => {
    frame = requestAnimationFrame(tick);
    if (!isOnScreen) return;
    pointer.x += (target.x - pointer.x) * 0.06;
    pointer.y += (target.y - pointer.y) * 0.06;
    const scrolled = Math.min(window.scrollY / window.innerHeight, 1);
    stack.rotation.y = 0.78 + Math.sin(time / 2600) * 0.22 + pointer.x * 0.35 + scrolled * 0.6;
    stack.rotation.x = -0.38 + Math.cos(time / 3100) * 0.08 + pointer.y * 0.2 - scrolled * 0.25;
    stack.position.y = Math.sin(time / 1900) * 0.12 + scrolled * 0.8;
    renderer.render(scene, camera);
  };
  const follow = (event: PointerEvent): void => {
    const bounds = host.getBoundingClientRect();
    target.x = ((event.clientX - bounds.left) / bounds.width) * 2 - 1;
    target.y = ((event.clientY - bounds.top) / bounds.height) * 2 - 1;
  };
  const rest = (): void => {
    target.x = 0;
    target.y = 0;
  };
  const sizeObserver = new ResizeObserver(resize);
  sizeObserver.observe(host);
  const visibility = new IntersectionObserver(([entry]) => {
    isOnScreen = entry?.isIntersecting ?? false;
  });
  visibility.observe(host);
  resize();
  if (!reducedMotion) {
    host.addEventListener('pointermove', follow);
    host.addEventListener('pointerleave', rest);
    frame = requestAnimationFrame(tick);
  }

  return () => {
    cancelAnimationFrame(frame);
    host.removeEventListener('pointermove', follow);
    host.removeEventListener('pointerleave', rest);
    sizeObserver.disconnect();
    visibility.disconnect();
    environment.dispose();
    renderer.dispose();
    renderer.domElement.remove();
  };
}
