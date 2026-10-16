import { useEffect, useRef } from "react";
import * as THREE from "three";
import { RoomEnvironment } from "three/examples/jsm/environments/RoomEnvironment.js";

/** Cinematic hero: the Gemini-generated misty studio photo, with a faceted liquid-glass gem (the
 *  Tesselle mark) floating in the fog and refracting the scene behind it. Real transmission via
 *  three.js MeshPhysicalMaterial; parallax follows the pointer; pauses off-screen and when hidden. */
export default function HeroScene({ src = "/media/hero.jpg", onReady }: { src?: string; onReady?: () => void }) {
  const ref = useRef<HTMLCanvasElement>(null);

  useEffect(() => {
    const canvas = ref.current!;
    const reduced = window.matchMedia("(prefers-reduced-motion: reduce)").matches;
    let renderer: THREE.WebGLRenderer;
    try {
      renderer = new THREE.WebGLRenderer({ canvas, antialias: true, alpha: true, powerPreference: "high-performance" });
    } catch {
      return; // no WebGL: the CSS photo underneath remains
    }
    renderer.setPixelRatio(Math.min(window.devicePixelRatio, 1.75));
    renderer.toneMapping = THREE.ACESFilmicToneMapping;
    renderer.toneMappingExposure = 1.05;
    renderer.outputColorSpace = THREE.SRGBColorSpace;

    const scene = new THREE.Scene();
    const camera = new THREE.PerspectiveCamera(35, 1, 0.1, 100);
    camera.position.set(0, 0, 8);
    const pmrem = new THREE.PMREMGenerator(renderer);
    const env = pmrem.fromScene(new RoomEnvironment(), 0.04).texture;
    let sceneEnv: THREE.Texture | null = null;
    scene.environment = env;

    // Photo backdrop (cover-fit plane, rendered untoned so it matches the CSS fallback exactly).
    const PLANE_Z = -6;
    const tex = new THREE.TextureLoader().load(src, () => {
      fit();
      // Reflections come from the scene itself, so the glass picks up fog-teal and ember light.
      const eq = tex.clone();
      eq.mapping = THREE.EquirectangularReflectionMapping;
      eq.needsUpdate = true;
      sceneEnv = pmrem.fromEquirectangular(eq).texture;
      scene.environment = sceneEnv;
      eq.dispose();
      canvas.style.opacity = "1";
      onReady?.();
    });
    tex.colorSpace = THREE.SRGBColorSpace;
    tex.anisotropy = 4;
    const backdrop = new THREE.Mesh(new THREE.PlaneGeometry(1, 1), new THREE.MeshBasicMaterial({ map: tex, toneMapped: false }));
    backdrop.position.z = PLANE_Z;
    scene.add(backdrop);

    // The gem: a faceted icosahedron in thick, slightly iridescent glass.
    const glass = new THREE.MeshPhysicalMaterial({
      color: 0xffffff,
      metalness: 0,
      roughness: 0.02,
      transmission: 1,
      thickness: 1.1,
      ior: 1.48,
      iridescence: 0.45,
      iridescenceIOR: 1.3,
      clearcoat: 1,
      clearcoatRoughness: 0.02,
      attenuationColor: new THREE.Color(0xf4ffd6),
      attenuationDistance: 6,
      envMapIntensity: 2.4,
      specularColor: new THREE.Color(0xffffff),
      specularIntensity: 1,
      flatShading: true,
    });
    const gem = new THREE.Mesh(new THREE.IcosahedronGeometry(0.9, 0), glass);
    const rim = new THREE.LineSegments(
      new THREE.EdgesGeometry(new THREE.IcosahedronGeometry(0.903, 0)),
      new THREE.LineBasicMaterial({ color: 0xf2ffd0, transparent: true, opacity: 0.55 }),
    );
    const group = new THREE.Group();
    group.add(gem, rim);
    scene.add(group);

    const shards = [0.2, 0.13, 0.09].map((s, i) => {
      const m = new THREE.Mesh(i === 1 ? new THREE.OctahedronGeometry(s, 0) : new THREE.IcosahedronGeometry(s, 0), glass);
      scene.add(m);
      return m;
    });

    const warm = new THREE.PointLight(0xffb35c, 16, 14);
    warm.position.set(3, -1, 2);
    const cool = new THREE.DirectionalLight(0xd8f2ff, 2.4);
    cool.position.set(-4, 5, 3);
    const glint = new THREE.PointLight(0xffffff, 10, 10);
    glint.position.set(-1.5, 2, 4);
    scene.add(warm, cool, glint);

    const pointer = new THREE.Vector2();
    const target = new THREE.Vector2();
    const onMove = (e: PointerEvent) => target.set((e.clientX / window.innerWidth) * 2 - 1, -(e.clientY / window.innerHeight) * 2 + 1);
    window.addEventListener("pointermove", onMove, { passive: true });

    let anchor = new THREE.Vector3();
    function fit() {
      const w = canvas.clientWidth || 1;
      const h = canvas.clientHeight || 1;
      renderer.setSize(w, h, false);
      camera.aspect = w / h;
      camera.updateProjectionMatrix();
      const dist = camera.position.z - PLANE_Z;
      const vh = 2 * Math.tan(THREE.MathUtils.degToRad(camera.fov / 2)) * dist * 1.08;
      const vw = vh * camera.aspect;
      const img = tex.image as HTMLImageElement | undefined;
      const ia = img && img.width ? img.width / img.height : 16 / 9;
      if (vw / vh > ia) backdrop.scale.set(vw, vw / ia, 1);
      else backdrop.scale.set(vh * ia, vh, 1);
      // Place the gem in the fog: left-of-centre on wide screens, upper right on narrow ones.
      const hh = Math.tan(THREE.MathUtils.degToRad(camera.fov / 2)) * camera.position.z;
      const hw = hh * camera.aspect;
      const wide = w > 1100;
      anchor = wide ? new THREE.Vector3(-0.07 * hw, -0.2 * hh, 0) : new THREE.Vector3(0.5 * hw, 0.42 * hh, 0);
      group.scale.setScalar(wide ? 0.74 : 0.55);
      // On phones the copy fills the frame; the photo alone carries the scene there.
      const show = w >= 700;
      group.visible = show;
      shards.forEach((m) => (m.visible = show));
    }
    fit();
    window.addEventListener("resize", fit);

    let visible = true;
    const io = new IntersectionObserver(([e]) => {
      visible = e.isIntersecting;
      if (visible && !reduced) loop();
    });
    io.observe(canvas);

    let raf = 0;
    const clock = new THREE.Clock();
    const frame = () => {
      const t = clock.getElapsedTime();
      pointer.lerp(target, 0.045);
      backdrop.position.x = -pointer.x * 0.18;
      backdrop.position.y = -pointer.y * 0.1;
      group.position.set(anchor.x + pointer.x * 0.22, anchor.y + Math.sin(t * 0.9) * 0.09 + pointer.y * 0.14, 0);
      group.rotation.set(t * 0.13 + pointer.y * 0.35, t * 0.21 + pointer.x * 0.5, t * 0.05);
      shards.forEach((s, i) => {
        const a = t * (0.32 + i * 0.11) + i * 2.1;
        const rad = (1.45 + i * 0.32) * group.scale.x;
        s.position.set(group.position.x + Math.cos(a) * rad, group.position.y + Math.sin(a * 1.3) * 0.45 * group.scale.x, Math.sin(a) * rad * 0.6);
        s.rotation.set(t * 0.6 + i, t * 0.4, 0);
        s.scale.setScalar(group.scale.x);
      });
      renderer.render(scene, camera);
    };
    const loop = () => {
      cancelAnimationFrame(raf);
      const step = () => {
        if (!visible || document.hidden) return;
        frame();
        raf = requestAnimationFrame(step);
      };
      raf = requestAnimationFrame(step);
    };
    frame();
    if (!reduced) loop();
    const onVis = () => !document.hidden && !reduced && loop();
    document.addEventListener("visibilitychange", onVis);

    return () => {
      cancelAnimationFrame(raf);
      io.disconnect();
      window.removeEventListener("pointermove", onMove);
      window.removeEventListener("resize", fit);
      document.removeEventListener("visibilitychange", onVis);
      scene.traverse((o) => {
        const m = o as THREE.Mesh;
        m.geometry?.dispose?.();
      });
      glass.dispose();
      tex.dispose();
      env.dispose();
      sceneEnv?.dispose();
      pmrem.dispose();
      renderer.dispose();
    };
  }, [src]); // eslint-disable-line

  return <canvas ref={ref} className="hero-canvas" style={{ opacity: 0, transition: "opacity 1.2s ease" }} aria-hidden="true" />;
}
