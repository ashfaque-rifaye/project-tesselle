import { useEffect, useRef } from "react";
import * as THREE from "three";

/** Immersive background: a breathing tessellated sphere (noise-displaced icosahedron rendered as a
 *  glowing wireframe + vertex points) inside a drifting particle field. Follows the pointer and the
 *  page scroll. Pure WebGL via three.js; pauses when the tab is hidden; respects reduced motion. */

const NOISE = /* glsl */ `
vec3 mod289(vec3 x){return x-floor(x*(1.0/289.0))*289.0;}
vec4 mod289(vec4 x){return x-floor(x*(1.0/289.0))*289.0;}
vec4 permute(vec4 x){return mod289(((x*34.0)+1.0)*x);}
vec4 taylorInvSqrt(vec4 r){return 1.79284291400159-0.85373472095314*r;}
float snoise(vec3 v){
  const vec2 C=vec2(1.0/6.0,1.0/3.0); const vec4 D=vec4(0.0,0.5,1.0,2.0);
  vec3 i=floor(v+dot(v,C.yyy)); vec3 x0=v-i+dot(i,C.xxx);
  vec3 g=step(x0.yzx,x0.xyz); vec3 l=1.0-g; vec3 i1=min(g.xyz,l.zxy); vec3 i2=max(g.xyz,l.zxy);
  vec3 x1=x0-i1+C.xxx; vec3 x2=x0-i2+C.yyy; vec3 x3=x0-D.yyy;
  i=mod289(i);
  vec4 p=permute(permute(permute(i.z+vec4(0.0,i1.z,i2.z,1.0))+i.y+vec4(0.0,i1.y,i2.y,1.0))+i.x+vec4(0.0,i1.x,i2.x,1.0));
  float n_=0.142857142857; vec3 ns=n_*D.wyz-D.xzx;
  vec4 j=p-49.0*floor(p*ns.z*ns.z); vec4 x_=floor(j*ns.z); vec4 y_=floor(j-7.0*x_);
  vec4 x=x_*ns.x+ns.yyyy; vec4 y=y_*ns.x+ns.yyyy; vec4 h=1.0-abs(x)-abs(y);
  vec4 b0=vec4(x.xy,y.xy); vec4 b1=vec4(x.zw,y.zw);
  vec4 s0=floor(b0)*2.0+1.0; vec4 s1=floor(b1)*2.0+1.0; vec4 sh=-step(h,vec4(0.0));
  vec4 a0=b0.xzyw+s0.xzyw*sh.xxyy; vec4 a1=b1.xzyw+s1.xzyw*sh.zzww;
  vec3 p0=vec3(a0.xy,h.x); vec3 p1=vec3(a0.zw,h.y); vec3 p2=vec3(a1.xy,h.z); vec3 p3=vec3(a1.zw,h.w);
  vec4 norm=taylorInvSqrt(vec4(dot(p0,p0),dot(p1,p1),dot(p2,p2),dot(p3,p3)));
  p0*=norm.x; p1*=norm.y; p2*=norm.z; p3*=norm.w;
  vec4 m=max(0.6-vec4(dot(x0,x0),dot(x1,x1),dot(x2,x2),dot(x3,x3)),0.0); m=m*m;
  return 42.0*dot(m*m,vec4(dot(p0,x0),dot(p1,x1),dot(p2,x2),dot(p3,x3)));
}`;

const VERT = /* glsl */ `
uniform float uTime; uniform float uAmp; uniform vec2 uPointer;
varying float vNoise; varying vec3 vPos;
${NOISE}
void main(){
  vec3 p = position;
  float n = snoise(normalize(p) * 1.6 + vec3(uTime * 0.12, uTime * 0.08, 0.0));
  float pull = 0.25 * smoothstep(0.6, 1.0, dot(normalize(p), normalize(vec3(uPointer, 0.9))));
  p += normalize(p) * (n * uAmp + pull);
  vNoise = n; vPos = p;
  vec4 mv = modelViewMatrix * vec4(p, 1.0);
  gl_PointSize = (2.2 + n * 1.6) * (5.0 / -mv.z);
  gl_Position = projectionMatrix * mv;
}`;

const FRAG = /* glsl */ `
uniform float uAlpha; varying float vNoise; varying vec3 vPos;
void main(){
  vec3 mint = vec3(0.18, 0.95, 0.82); vec3 cyan = vec3(0.28, 0.78, 1.0); vec3 violet = vec3(0.61, 0.48, 1.0);
  float t = clamp(vPos.y * 0.35 + 0.5 + vNoise * 0.25, 0.0, 1.0);
  vec3 col = mix(mix(mint, cyan, smoothstep(0.0, 0.55, t)), violet, smoothstep(0.5, 1.0, t));
  gl_FragColor = vec4(col * (1.05 + vNoise * 0.45), uAlpha);
}`;

export default function TessellationField({ className = "home-canvas" }: { className?: string }) {
  const ref = useRef<HTMLCanvasElement>(null);

  useEffect(() => {
    const canvas = ref.current!;
    const reduced = window.matchMedia("(prefers-reduced-motion: reduce)").matches;
    let renderer: THREE.WebGLRenderer;
    try {
      renderer = new THREE.WebGLRenderer({ canvas, antialias: true, alpha: true, powerPreference: "high-performance" });
    } catch {
      return; // no WebGL: the CSS aurora background remains
    }
    renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
    const scene = new THREE.Scene();
    const camera = new THREE.PerspectiveCamera(45, 1, 0.1, 100);
    camera.position.set(0, 0, 6.2);

    const uniforms = {
      uTime: { value: 0 },
      uAmp: { value: 0.32 },
      uPointer: { value: new THREE.Vector2(0, 0) },
      uAlpha: { value: 0.42 },
    };
    const geo = new THREE.IcosahedronGeometry(1.75, 6);
    const wire = new THREE.LineSegments(
      new THREE.WireframeGeometry(geo),
      new THREE.ShaderMaterial({ vertexShader: VERT, fragmentShader: FRAG, uniforms, transparent: true, depthWrite: false, blending: THREE.AdditiveBlending }),
    );
    const pointUniforms = { ...uniforms, uAlpha: { value: 0.95 } };
    const points = new THREE.Points(
      geo,
      new THREE.ShaderMaterial({ vertexShader: VERT, fragmentShader: FRAG, uniforms: pointUniforms, transparent: true, depthWrite: false, blending: THREE.AdditiveBlending }),
    );
    const orb = new THREE.Group();
    orb.add(wire, points);
    scene.add(orb);

    // Drifting star / dust field
    const N = 1400;
    const pos = new Float32Array(N * 3);
    for (let i = 0; i < N; i++) {
      const r = 6 + Math.random() * 18;
      const th = Math.random() * Math.PI * 2;
      const ph = Math.acos(2 * Math.random() - 1);
      pos[i * 3] = r * Math.sin(ph) * Math.cos(th);
      pos[i * 3 + 1] = r * Math.sin(ph) * Math.sin(th);
      pos[i * 3 + 2] = r * Math.cos(ph) - 8;
    }
    const dustGeo = new THREE.BufferGeometry();
    dustGeo.setAttribute("position", new THREE.BufferAttribute(pos, 3));
    const dust = new THREE.Points(dustGeo, new THREE.PointsMaterial({ color: 0x9fdcff, size: 0.035, transparent: true, opacity: 0.55, depthWrite: false }));
    scene.add(dust);

    // Orbiting ring
    const ring = new THREE.Mesh(
      new THREE.TorusGeometry(2.55, 0.006, 8, 220),
      new THREE.MeshBasicMaterial({ color: 0x48c6ff, transparent: true, opacity: 0.35 }),
    );
    ring.rotation.x = Math.PI / 2.4;
    scene.add(ring);

    const pointer = new THREE.Vector2();
    const target = new THREE.Vector2();
    const onMove = (e: PointerEvent) => {
      target.set((e.clientX / window.innerWidth) * 2 - 1, -(e.clientY / window.innerHeight) * 2 + 1);
    };
    window.addEventListener("pointermove", onMove);

    const resize = () => {
      const w = canvas.clientWidth || window.innerWidth;
      const h = canvas.clientHeight || window.innerHeight;
      renderer.setSize(w, h, false);
      camera.aspect = w / h;
      camera.updateProjectionMatrix();
    };
    resize();
    window.addEventListener("resize", resize);

    let raf = 0;
    const clock = new THREE.Clock();
    const tick = () => {
      const t = clock.getElapsedTime();
      const scroll = Math.min(window.scrollY / window.innerHeight, 2.5);
      pointer.lerp(target, 0.05);
      uniforms.uTime.value = t;
      pointUniforms.uTime.value = t;
      uniforms.uPointer.value.copy(pointer);
      pointUniforms.uPointer.value.copy(pointer);
      const amp = 0.28 + Math.sin(t * 0.6) * 0.06 + scroll * 0.12;
      uniforms.uAmp.value = amp;
      pointUniforms.uAmp.value = amp;
      const wide = window.innerWidth > 1020;
      const fade = 1 - Math.min(scroll, 1) * 0.72;
      uniforms.uAlpha.value = 0.42 * fade;
      pointUniforms.uAlpha.value = 0.95 * fade;
      orb.position.x = (wide ? 2.75 : 0) + scroll * (wide ? 1.1 : 0);
      orb.position.y = (wide ? 0 : 1.4) + scroll * 0.6;
      orb.scale.setScalar((wide ? 0.95 : 0.8) + scroll * 0.2);
      orb.rotation.y = t * 0.08 + pointer.x * 0.35;
      orb.rotation.x = pointer.y * 0.25;
      ring.position.copy(orb.position);
      ring.rotation.z = t * 0.15;
      dust.rotation.y = t * 0.01;
      renderer.render(scene, camera);
      if (!reduced) raf = requestAnimationFrame(tick);
    };
    tick();
    const onVis = () => {
      cancelAnimationFrame(raf);
      if (!document.hidden && !reduced) raf = requestAnimationFrame(tick);
    };
    document.addEventListener("visibilitychange", onVis);

    return () => {
      cancelAnimationFrame(raf);
      window.removeEventListener("pointermove", onMove);
      window.removeEventListener("resize", resize);
      document.removeEventListener("visibilitychange", onVis);
      geo.dispose();
      dustGeo.dispose();
      renderer.dispose();
    };
  }, []);

  return <canvas ref={ref} className={className} style={{ width: "100%", height: "100%" }} aria-hidden="true" />;
}
