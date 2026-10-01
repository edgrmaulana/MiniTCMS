"use client";

import { useEffect, useRef } from "react";

const VERTEX_SHADER = `#version 300 es
in vec2 aPosition;
void main() {
  gl_Position = vec4(aPosition, 0.0, 1.0);
}`;

const FRAGMENT_SHADER = `#version 300 es
precision highp float;

uniform vec2 uResolution;
uniform float uTime;
uniform vec2 uPointer;

out vec4 outColor;

float hash21(vec2 cell) {
  vec2 scrambled = fract(cell * vec2(123.34, 456.21));
  scrambled += dot(scrambled, scrambled + 45.32);
  return fract(scrambled.x * scrambled.y);
}

float valueNoise(vec2 point) {
  vec2 cell = floor(point);
  vec2 offset = fract(point);
  vec2 smoothed = offset * offset * (3.0 - 2.0 * offset);
  float bottomLeft = hash21(cell);
  float bottomRight = hash21(cell + vec2(1.0, 0.0));
  float topLeft = hash21(cell + vec2(0.0, 1.0));
  float topRight = hash21(cell + vec2(1.0, 1.0));
  return mix(
    mix(bottomLeft, bottomRight, smoothed.x),
    mix(topLeft, topRight, smoothed.x),
    smoothed.y
  );
}

float fbm(vec2 point) {
  float total = 0.0;
  float amplitude = 0.5;
  for (int octave = 0; octave < 5; octave++) {
    total += amplitude * valueNoise(point);
    point = point * 2.03 + vec2(17.1, 9.7);
    amplitude *= 0.5;
  }
  return total;
}

float starField(vec2 uv, float density, float seed) {
  vec2 grid = uv * density;
  vec2 cell = floor(grid);
  vec2 local = fract(grid) - 0.5;
  float presence = hash21(cell + seed);
  if (presence < 0.90) return 0.0;
  vec2 jitter = (vec2(hash21(cell + seed + 3.1), hash21(cell + seed + 7.7)) - 0.5) * 0.7;
  float distanceToStar = length(local - jitter);
  float twinkle = 0.55 + 0.45 * sin(uTime * 1.6 + presence * 48.0);
  return smoothstep(0.06, 0.0, distanceToStar) * twinkle;
}

vec3 lightCurtain(
  vec2 uv,
  float seed,
  float speed,
  float width,
  float swayScale,
  vec3 lowColor,
  vec3 highColor
) {
  float drift = uTime * speed;
  float warp = fbm(vec2(uv.y * 1.5 + drift * 0.3, seed * 13.0)) * 2.0 - 1.0;
  float sway = uPointer.x * swayScale;
  float across = uv.x - warp * 0.5 - sway;

  float ribbon = exp(-across * across * width);
  float filaments = fbm(vec2(uv.x * 9.0 + warp * 3.0, uv.y * 2.2 - drift * 0.8));
  ribbon *= 0.35 + 0.9 * filaments;

  float verticalFade = smoothstep(-0.55, 0.05, uv.y) * smoothstep(1.35, 0.25, uv.y);
  ribbon *= verticalFade;

  vec3 tint = mix(lowColor, highColor, clamp(uv.y * 0.75 + filaments * 0.4, 0.0, 1.0));
  return tint * ribbon;
}

void main() {
  vec2 uv = (gl_FragCoord.xy - 0.5 * uResolution) / uResolution.y;

  vec3 color = mix(
    vec3(0.012, 0.020, 0.047),
    vec3(0.035, 0.063, 0.125),
    smoothstep(-0.7, 0.7, uv.y)
  );

  vec2 parallax = uPointer * 0.015;
  float stars = starField(uv + parallax, 28.0, 1.0) * 0.9
              + starField(uv + parallax * 2.0, 52.0, 9.0) * 0.45;
  color += vec3(0.78, 0.84, 1.0) * stars;

  vec2 curtainUv = vec2(uv.x, uv.y + 0.30 + uPointer.y * 0.04);

  color += lightCurtain(
    curtainUv + vec2(0.34, 0.0), 0.0, 0.55, 7.0, 0.30,
    vec3(0.05, 0.92, 0.60), vec3(0.09, 0.42, 0.88)
  ) * 0.95;

  color += lightCurtain(
    curtainUv - vec2(0.18, 0.0), 1.0, 0.38, 11.0, 0.45,
    vec3(0.18, 0.78, 0.92), vec3(0.42, 0.26, 0.92)
  ) * 0.70;

  color += lightCurtain(
    curtainUv - vec2(0.62, 0.0), 2.0, 0.72, 16.0, 0.62,
    vec3(0.95, 0.32, 0.56), vec3(0.28, 0.52, 0.98)
  ) * 0.40;

  float horizonGlow = exp(-pow((uv.y + 0.42) * 3.2, 2.0));
  color += vec3(0.05, 0.22, 0.26) * horizonGlow;

  float vignette = 1.0 - 0.55 * dot(uv * vec2(0.85, 1.0), uv * vec2(0.85, 1.0));
  color *= clamp(vignette, 0.0, 1.0);

  // Ordered dither: 8-bit output bands badly across these very dark gradients.
  float dither = (hash21(gl_FragCoord.xy) - 0.5) / 255.0;
  outColor = vec4(pow(color, vec3(0.92)) + dither, 1.0);
}`;

function compile(gl: WebGL2RenderingContext, type: number, source: string): WebGLShader | null {
  const shader = gl.createShader(type);
  if (!shader) return null;
  gl.shaderSource(shader, source);
  gl.compileShader(shader);
  if (!gl.getShaderParameter(shader, gl.COMPILE_STATUS)) {
    gl.deleteShader(shader);
    return null;
  }
  return shader;
}

export default function Aurora() {
  const canvasRef = useRef<HTMLCanvasElement>(null);

  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;

    const reducedMotion = window.matchMedia("(prefers-reduced-motion: reduce)").matches;
    // The hero is display:none below lg, but React still mounts this and runs
    // the effect: without the gate a phone holds a WebGL2 context, a rAF loop
    // and a pointermove listener for a canvas nobody can see.
    const wideEnough = window.matchMedia("(min-width: 64rem)");
    let stop = () => {};

    const start = () => {
      const gl = canvas.getContext("webgl2", { antialias: false, alpha: false });
      // No WebGL2: the CSS gradient underneath stays visible and nothing breaks.
      if (!gl) return () => {};

      const vertexShader = compile(gl, gl.VERTEX_SHADER, VERTEX_SHADER);
      const fragmentShader = compile(gl, gl.FRAGMENT_SHADER, FRAGMENT_SHADER);
      const program = gl.createProgram();

      // Every early return below has to clean up after itself: a context
      // restore re-runs start(), so anything abandoned accumulates.
      const discard = () => {
        if (vertexShader) gl.deleteShader(vertexShader);
        if (fragmentShader) gl.deleteShader(fragmentShader);
        if (program) gl.deleteProgram(program);
        return () => {};
      };

      if (!vertexShader || !fragmentShader || !program) return discard();

      gl.attachShader(program, vertexShader);
      gl.attachShader(program, fragmentShader);
      gl.linkProgram(program);
      if (!gl.getProgramParameter(program, gl.LINK_STATUS)) return discard();
      gl.useProgram(program);

      // Linked: the program holds what it needs and the shaders can go.
      gl.deleteShader(vertexShader);
      gl.deleteShader(fragmentShader);

      const buffer = gl.createBuffer();
      gl.bindBuffer(gl.ARRAY_BUFFER, buffer);
      // One oversized triangle covers the clip volume with no index buffer.
      gl.bufferData(
        gl.ARRAY_BUFFER,
        new Float32Array([-1, -1, 3, -1, -1, 3]),
        gl.STATIC_DRAW,
      );
      const positionLocation = gl.getAttribLocation(program, "aPosition");
      gl.enableVertexAttribArray(positionLocation);
      gl.vertexAttribPointer(positionLocation, 2, gl.FLOAT, false, 0, 0);

      const resolutionUniform = gl.getUniformLocation(program, "uResolution");
      const timeUniform = gl.getUniformLocation(program, "uTime");
      const pointerUniform = gl.getUniformLocation(program, "uPointer");

      const targetPointer = { x: 0, y: 0 };
      const smoothedPointer = { x: 0, y: 0 };

      const resize = () => {
        const scale = Math.min(window.devicePixelRatio || 1, 1.75);
        const width = Math.max(1, Math.floor(canvas.clientWidth * scale));
        const height = Math.max(1, Math.floor(canvas.clientHeight * scale));
        if (canvas.width === width && canvas.height === height) return;
        canvas.width = width;
        canvas.height = height;
        gl.viewport(0, 0, width, height);
      };

      const onPointerMove = (event: PointerEvent) => {
        targetPointer.x = (event.clientX / window.innerWidth) * 2 - 1;
        targetPointer.y = 1 - (event.clientY / window.innerHeight) * 2;
      };

      const draw = (seconds: number) => {
        resize();
        smoothedPointer.x += (targetPointer.x - smoothedPointer.x) * 0.045;
        smoothedPointer.y += (targetPointer.y - smoothedPointer.y) * 0.045;
        gl.uniform2f(resolutionUniform, canvas.width, canvas.height);
        gl.uniform1f(timeUniform, seconds);
        gl.uniform2f(pointerUniform, smoothedPointer.x, smoothedPointer.y);
        gl.drawArrays(gl.TRIANGLES, 0, 3);
      };

      if (reducedMotion) {
        draw(8.0);
        const onResize = () => draw(8.0);
        window.addEventListener("resize", onResize);
        return () => {
          window.removeEventListener("resize", onResize);
          gl.deleteProgram(program);
          gl.deleteBuffer(buffer);
        };
      }

      let frame = 0;
      const startedAt = performance.now();
      const loop = () => {
        draw((performance.now() - startedAt) / 1000);
        frame = requestAnimationFrame(loop);
      };
      frame = requestAnimationFrame(loop);
      window.addEventListener("pointermove", onPointerMove, { passive: true });

      return () => {
        cancelAnimationFrame(frame);
        window.removeEventListener("pointermove", onPointerMove);
        gl.deleteProgram(program);
        gl.deleteBuffer(buffer);
      };
    };

    const onContextLost = (event: Event) => {
      event.preventDefault();
      stop();
      stop = () => {};
    };
    const onContextRestored = () => {
      stop = start();
    };

    const onWidthChange = () => {
      stop();
      stop = wideEnough.matches ? start() : () => {};
    };

    canvas.addEventListener("webglcontextlost", onContextLost);
    canvas.addEventListener("webglcontextrestored", onContextRestored);
    wideEnough.addEventListener("change", onWidthChange);
    if (wideEnough.matches) stop = start();

    return () => {
      canvas.removeEventListener("webglcontextlost", onContextLost);
      canvas.removeEventListener("webglcontextrestored", onContextRestored);
      wideEnough.removeEventListener("change", onWidthChange);
      stop();
    };
  }, []);

  return <canvas ref={canvasRef} aria-hidden className="absolute inset-0 h-full w-full" />;
}
