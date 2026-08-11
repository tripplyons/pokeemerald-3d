const FULLSCREEN_VERTEX = /* wgsl */ `
struct VertexOutput {
  @builtin(position) position: vec4f,
  @location(0) uv: vec2f,
}

@vertex
fn vertexMain(@builtin(vertex_index) vertexIndex: u32) -> VertexOutput {
  var positions = array<vec2f, 3>(
    vec2f(-1.0, -1.0), vec2f(3.0, -1.0), vec2f(-1.0, 3.0),
  );
  var uvs = array<vec2f, 3>(
    vec2f(0.0, 1.0), vec2f(2.0, 1.0), vec2f(0.0, -1.0),
  );
  var output: VertexOutput;
  output.position = vec4f(positions[vertexIndex], 0.0, 1.0);
  output.uv = uvs[vertexIndex];
  return output;
}
`;

const PRESENT_SHADER = FULLSCREEN_VERTEX + /* wgsl */ `
@group(0) @binding(0) var sourceTexture: texture_2d<f32>;

@fragment
fn fragmentMain(input: VertexOutput) -> @location(0) vec4f {
  let size = vec2i(textureDimensions(sourceTexture));
  let uv = clamp(input.uv, vec2f(0.0), vec2f(0.99999));
  return textureLoad(sourceTexture, clamp(vec2i(uv * vec2f(size)), vec2i(0), size - 1), 0);
}
`;

const CINEMATIC_SHADER = FULLSCREEN_VERTEX + /* wgsl */ `
struct Camera {
  values: vec4f,
  viewport: vec4f,
  world: vec4f,
}
@group(0) @binding(0) var sceneTexture: texture_2d<f32>;
@group(0) @binding(1) var<uniform> camera: Camera;
@group(0) @binding(2) var focusDepthTexture: texture_2d<f32>;

fn loadScene(pixel: vec2i, size: vec2i) -> vec3f {
  return textureLoad(sceneTexture, clamp(pixel, vec2i(0), size - 1), 0).rgb;
}

fn luminance(color: vec3f) -> f32 {
  return dot(color, vec3f(0.2126, 0.7152, 0.0722));
}

fn highlight(color: vec3f) -> vec3f {
  let energy = smoothstep(0.57, 0.90, luminance(color));
  return color * energy;
}

struct FocusSamples {
  color: vec3f,
  bloom: vec3f,
  weight: f32,
}

fn focusSample(pixel: vec2i, centerDepth: f32, size: vec2i) -> FocusSamples {
  let clampedPixel = clamp(pixel, vec2i(0), size - 1);
  let color = textureLoad(sceneTexture, clampedPixel, 0).rgb;
  let depth = textureLoad(focusDepthTexture, clampedPixel, 0).r;
  // Nearby samples on the same projected surface remain eligible, while
  // geometry across a depth discontinuity cannot tint the center fragment.
  let weight = 1.0 - smoothstep(10.0, 34.0, abs(depth - centerDepth));
  return FocusSamples(color, highlight(color), weight);
}

@fragment
fn fragmentMain(input: VertexOutput) -> @location(0) vec4f {
  let size = vec2i(textureDimensions(sceneTexture));
  let uv = clamp(input.uv, vec2f(0.0), vec2f(0.99999));
  let pixel = clamp(vec2i(uv * vec2f(size)), vec2i(0), size - 1);
  let base = loadScene(pixel, size);
  let centerDepth = textureLoad(focusDepthTexture, pixel, 0).r;
  let renderScale = max(f32(size.x) / 240.0, 1.0);
  let centered = uv * 2.0 - vec2f(1.0);

  // Focus follows physical camera-space depth, not screen position or the
  // nonlinear depth buffer used for raster occlusion. The playable plane at
  // camera height remains crisp as geometry in front of and behind it falls
  // out of focus. Radius scales with output size, describing world detail.
  let focusDistance = abs(centerDepth - camera.values.w);
  let radialDistance = length(centered * vec2f(0.82, 1.0));
  let blurAmount = camera.world.z * max(
    smoothstep(30.0, 118.0, focusDistance),
    0.20 * smoothstep(0.78, 1.15, radialDistance)
  );
  let radius = max(1, i32(ceil(renderScale * (0.75 + 1.35 * blurAmount))));
  let horizontal = vec2i(radius, 0);
  let vertical = vec2i(0, radius);
  let diagonal = vec2i(radius, radius);
  let north = focusSample(pixel - vertical, centerDepth, size);
  let south = focusSample(pixel + vertical, centerDepth, size);
  let west = focusSample(pixel - horizontal, centerDepth, size);
  let east = focusSample(pixel + horizontal, centerDepth, size);
  let northwest = focusSample(pixel - diagonal, centerDepth, size);
  let southeast = focusSample(pixel + diagonal, centerDepth, size);
  let northeast = focusSample(pixel + vec2i(radius, -radius), centerDepth, size);
  let southwest = focusSample(pixel + vec2i(-radius, radius), centerDepth, size);
  let acceptedWeight = north.weight + south.weight + west.weight + east.weight
    + northwest.weight + southeast.weight + northeast.weight + southwest.weight;
  let acceptedColor = north.color * north.weight + south.color * south.weight
    + west.color * west.weight + east.color * east.weight
    + northwest.color * northwest.weight + southeast.color * southeast.weight
    + northeast.color * northeast.weight + southwest.color * southwest.weight;
  // Rejected taps become the center color, so silhouettes and roof lines
  // cannot bleed and the exact center texel always retains a dominant weight.
  let focused = (2.0 * base + acceptedColor + base * (8.0 - acceptedWeight)) / 10.0;
  var color = mix(base, focused, 0.82 * blurAmount);

  // Blur and bloom reuse the same eight accepted ring taps: including the
  // center, this post-process performs only nine scene-color loads.
  let bloom = (north.bloom * north.weight + south.bloom * south.weight
    + west.bloom * west.weight + east.bloom * east.weight
    + northwest.bloom * northwest.weight + southeast.bloom * southeast.weight
    + northeast.bloom * northeast.weight + southwest.bloom * southwest.weight) / 8.0;
  let optical = color;
  color += bloom * 0.23;

  // Soft optical falloff retains the miniature-diorama framing. No grading,
  // split tone, screen grain, or glow stacks on the world-space neutral key.
  let vignetteShape = dot(centered * vec2f(0.82, 1.03), centered * vec2f(0.82, 1.03));
  let vignette = smoothstep(0.30, 1.08, vignetteShape);
  color *= 1.0 - 0.31 * vignette;

  let lit = mix(optical, clamp(color, vec3f(0.0), vec3f(1.0)), camera.values.z);
  return vec4f(clamp(lit, vec3f(0.0), vec3f(1.0)), 1.0);
}
`;

const TERRAIN_SHADER = /* wgsl */ `
struct Camera {
  values: vec4f,
  viewport: vec4f,
  world: vec4f,
  lightTransform: mat4x4f,
}
struct VertexInput {
  @location(0) position: vec3f,
  @location(1) uv: vec2f,
  @location(2) normal: vec3f,
  @location(3) material: f32,
  @location(4) shell: vec2f,
}
struct VertexOutput {
  @builtin(position) position: vec4f,
  @location(0) uv: vec2f,
  @location(1) normal: vec3f,
  @location(2) @interpolate(flat) material: u32,
  @location(3) shadowPosition: vec3f,
  @location(4) cameraDepth: f32,
}
@group(0) @binding(0) var worldTexture: texture_2d<f32>;
@group(0) @binding(1) var pixelSampler: sampler;
@group(0) @binding(2) var<uniform> camera: Camera;
@group(0) @binding(3) var structuralShadowMap: texture_depth_2d;
@group(0) @binding(4) var structuralShadowSampler: sampler_comparison;

@vertex
fn vertexMain(input: VertexInput) -> VertexOutput {
  let angle = radians(45.384615 * camera.values.x);
  let sine = sin(angle);
  let cosine = cos(angle);
  let cameraHeight = camera.values.w;
  let zoom = camera.values.y;
  let zoomOut = 0.30 * zoom + 0.76923077 * zoom * zoom * (zoom - 0.35);
  let focal = cameraHeight / (1.0 + zoomOut);
  let shellBase = input.shell.y;
  let ordinaryViewY = input.position.y * sine - input.position.z * cosine;
  let shellViewY = shellBase * sine - input.position.z * cosine
    + input.position.y - shellBase;
  let viewY = select(ordinaryViewY, shellViewY, input.shell.x > 0.5);
  let ordinaryDepth = cameraHeight - input.position.y * cosine - input.position.z * sine;
  let shellDepth = cameraHeight - shellBase * cosine - input.position.z * sine;
  let depth = select(ordinaryDepth, shellDepth, input.shell.x > 0.5);
  let near = camera.viewport.z;
  let far = camera.viewport.w;
  var output: VertexOutput;
  output.position = vec4f(
    input.position.x * focal / (camera.viewport.x * 0.5),
    viewY * focal / (camera.viewport.y * 0.5),
    ((depth - near) / (far - near)) * depth,
    depth,
  );
  output.uv = input.uv;
  output.normal = input.normal;
  output.material = u32(input.material);
  let lightClip = camera.lightTransform * vec4f(input.position, 1.0);
  output.shadowPosition = vec3f(
    lightClip.x * 0.5 + 0.5,
    0.5 - lightClip.y * 0.5,
    lightClip.z,
  );
  output.cameraDepth = depth;
  return output;
}

const TO_KEY = normalize(vec3f(-0.45, 0.77, -0.45));
const SURFACE_WATER = 1u;

fn structuralVisibility(position: vec3f, normal: vec3f) -> f32 {
  if (any(position.xy <= vec2f(0.001)) || any(position.xy >= vec2f(0.999))
      || position.z <= 0.0 || position.z >= 1.0) {
    return 1.0;
  }
  let texel = 1.0 / vec2f(textureDimensions(structuralShadowMap));
  let slope = 1.0 - max(dot(normal, TO_KEY), 0.0);
  let reference = position.z - (0.00045 + 0.00115 * slope);
  var visibility = 0.0;
  for (var y = -1; y <= 1; y += 2) {
    for (var x = -1; x <= 1; x += 2) {
      visibility += textureSampleCompareLevel(
        structuralShadowMap, structuralShadowSampler,
        position.xy + vec2f(f32(x), f32(y)) * texel * 0.72,
        reference,
      );
    }
  }
  return visibility * 0.25;
}

struct FragmentOutput {
  @location(0) color: vec4f,
  @location(1) focusDepth: f32,
}

@fragment
fn fragmentMain(input: VertexOutput) -> FragmentOutput {
  let base = textureSample(worldTexture, pixelSampler, input.uv).rgb;
  let normal = normalize(input.normal);
  let direct = max(dot(normal, TO_KEY), 0.0);
  let faceLight = 0.70 + 0.39 * direct;
  let visibility = structuralVisibility(input.shadowPosition, normal);
  let receiverDensity = select(1.0, 0.44, input.material == SURFACE_WATER);
  let shadowLight = 1.0 - (1.0 - visibility) * 0.36 * receiverDensity;
  let illumination = faceLight * shadowLight;
  var output: FragmentOutput;
  output.color = vec4f(base * mix(1.0, illumination, camera.values.z), 1.0);
  output.focusDepth = input.cameraDepth;
  return output;
}
`;

const STRUCTURAL_SHADOW_SHADER = /* wgsl */ `
struct Camera {
  values: vec4f,
  viewport: vec4f,
  world: vec4f,
  lightTransform: mat4x4f,
}
struct VertexInput {
  @location(0) position: vec3f,
}
@group(0) @binding(0) var<uniform> camera: Camera;

@vertex
fn vertexMain(input: VertexInput) -> @builtin(position) vec4f {
  return camera.lightTransform * vec4f(input.position, 1.0);
}
`;

const BILLBOARD_SHADER = /* wgsl */ `
struct VertexInput {
  @location(0) position: vec2f,
  @location(1) uv: vec2f,
  @location(2) depth: f32,
  @location(3) layer: f32,
  @location(4) sourceSize: vec2f,
  @location(5) drawSize: vec2f,
  @location(6) affine: f32,
  @location(7) matrix: vec4f,
  @location(8) screenOrigin: vec2f,
  @location(9) objectInfo: vec2f,
  @location(10) cameraDepth: f32,
}
struct VertexOutput {
  @builtin(position) position: vec4f,
  @location(0) uv: vec2f,
  @location(1) @interpolate(flat) layer: u32,
  @location(2) @interpolate(flat) sourceSize: vec2u,
  @location(3) @interpolate(flat) drawSize: vec2u,
  @location(4) @interpolate(flat) affine: u32,
  @location(5) @interpolate(flat) matrix: vec4i,
  @location(6) @interpolate(flat) screenOrigin: vec2i,
  @location(7) @interpolate(flat) objectInfo: vec2u,
  @location(8) @interpolate(flat) cameraDepth: f32,
}
@group(0) @binding(0) var objectTexture: texture_2d_array<f32>;
@group(0) @binding(1) var bgPriorityTexture: texture_2d<u32>;

@vertex
fn vertexMain(input: VertexInput) -> VertexOutput {
  var output: VertexOutput;
  output.position = vec4f(input.position.x / 120.0 - 1.0, 1.0 - input.position.y / 80.0, input.depth, 1.0);
  output.uv = input.uv;
  output.layer = u32(input.layer);
  output.sourceSize = vec2u(input.sourceSize);
  output.drawSize = vec2u(input.drawSize);
  output.affine = u32(input.affine);
  output.matrix = vec4i(input.matrix);
  output.screenOrigin = vec2i(input.screenOrigin);
  output.objectInfo = vec2u(input.objectInfo);
  output.cameraDepth = input.cameraDepth;
  return output;
}

struct FragmentOutput {
  @location(0) color: vec4f,
  @location(1) focusDepth: f32,
  @builtin(frag_depth) depth: f32,
}

struct SilhouetteOutput {
  @location(0) color: vec4f,
  @location(1) focusDepth: f32,
}

fn objectColor(input: VertexOutput) -> vec4f {
  let dest = vec2i(floor(input.uv));
  var source = dest;
  if (input.affine != 0u) {
    let delta = dest - vec2i(input.drawSize) / 2;
    source = vec2i(
      (input.matrix.x * delta.x + input.matrix.y * delta.y) >> 8,
      (input.matrix.z * delta.x + input.matrix.w * delta.y) >> 8
    ) + vec2i(input.sourceSize) / 2;
  }
  if (any(source < vec2i(0)) || any(source >= vec2i(input.sourceSize))) {
    return vec4f(0.0);
  }
  return textureLoad(objectTexture, source, i32(input.layer), 0);
}

@fragment
fn fragmentMain(input: VertexOutput) -> FragmentOutput {
  let screen = input.screenOrigin + vec2i(floor(input.uv));
  let prioritySize = vec2i(textureDimensions(bgPriorityTexture));
  let atlas = screen + (prioritySize - vec2i(240, 160)) / 2;
  let inAtlas = all(atlas >= vec2i(0)) && all(atlas < prioritySize);
  var occluded = false;
  if (inAtlas) {
    let bgPriority = textureLoad(bgPriorityTexture, atlas, 0).r;
    if (bgPriority == 255u) { discard; }
    occluded = bgPriority < input.objectInfo.y;
  }

  let color = objectColor(input);
  if (color.a <= 0.0) { discard; }
  var output: FragmentOutput;
  if (occluded) {
    // Preserve a readable whole-entity silhouette through overhead terrain
    // instead of slicing the billboard into disconnected visible fragments.
    output.color = vec4f(mix(color.rgb, vec3f(0.72, 0.88, 0.92), 0.24), color.a * 0.62);
  } else {
    output.color = color;
  }
  output.focusDepth = input.cameraDepth;
  output.depth = input.position.z;
  return output;
}

@fragment
fn fragmentSilhouette(input: VertexOutput) -> SilhouetteOutput {
  let color = objectColor(input);
  if (color.a <= 0.0) { discard; }
  var output: SilhouetteOutput;
  output.color = vec4f(mix(color.rgb, vec3f(0.72, 0.88, 0.92), 0.24), color.a * 0.62);
  output.focusDepth = input.cameraDepth;
  return output;
}
`;
const CAST_SHADOW_SHADER = /* wgsl */ `
struct Camera {
  values: vec4f,
  viewport: vec4f,
  world: vec4f,
}
struct VertexInput {
  @location(0) ground: vec3f,
  @location(1) uv: vec2f,
  @location(2) layer: f32,
  @location(3) sourceSize: vec2f,
  @location(4) drawSize: vec2f,
  @location(5) affine: f32,
  @location(6) matrix: vec4f,
  @location(7) priority: f32,
}
struct VertexOutput {
  @builtin(position) position: vec4f,
  @location(0) uv: vec2f,
  @location(1) @interpolate(flat) layer: u32,
  @location(2) @interpolate(flat) sourceSize: vec2u,
  @location(3) @interpolate(flat) drawSize: vec2u,
  @location(4) @interpolate(flat) affine: u32,
  @location(5) @interpolate(flat) matrix: vec4i,
  @location(6) ground: vec2f,
  @location(7) @interpolate(flat) priority: u32,
}
@group(0) @binding(0) var objectTexture: texture_2d_array<f32>;
@group(0) @binding(1) var<uniform> camera: Camera;
@group(0) @binding(2) var bgPriorityTexture: texture_2d<u32>;

@vertex
fn vertexMain(input: VertexInput) -> VertexOutput {
  let angle = radians(45.384615 * camera.values.x);
  let sine = sin(angle);
  let cosine = cos(angle);
  let cameraHeight = camera.values.w;
  let zoom = camera.values.y;
  let zoomOut = 0.30 * zoom + 0.76923077 * zoom * zoom * (zoom - 0.35);
  let focal = cameraHeight / (1.0 + zoomOut);
  let viewY = input.ground.y * sine - input.ground.z * cosine;
  let depth = cameraHeight - input.ground.y * cosine - input.ground.z * sine;
  let near = camera.viewport.z;
  let far = camera.viewport.w;
  var output: VertexOutput;
  output.position = vec4f(
    input.ground.x * focal / (camera.viewport.x * 0.5),
    viewY * focal / (camera.viewport.y * 0.5),
    (((depth - near) / (far - near)) - 0.00002) * depth,
    depth,
  );
  output.uv = input.uv;
  output.layer = u32(input.layer);
  output.sourceSize = vec2u(input.sourceSize);
  output.drawSize = vec2u(input.drawSize);
  output.affine = u32(input.affine);
  output.matrix = vec4i(input.matrix);
  output.ground = vec2f(input.ground.x, input.ground.z) + camera.viewport.xy * 0.5;
  output.priority = u32(input.priority);
  return output;
}

fn sourceCoordinate(dest: vec2i, input: VertexOutput) -> vec2i {
  if (input.affine == 0u) { return dest; }
  let delta = dest - vec2i(input.drawSize) / 2;
  return vec2i(
    (input.matrix.x * delta.x + input.matrix.y * delta.y) >> 8,
    (input.matrix.z * delta.x + input.matrix.w * delta.y) >> 8
  ) + vec2i(input.sourceSize) / 2;
}

fn objectAlpha(dest: vec2i, input: VertexOutput) -> f32 {
  // Match the billboard's exact visible destination mask before applying the
  // affine matrix. The padded shadow geometry can then soften the outline
  // without revealing source pixels that the real object does not draw.
  if (any(dest < vec2i(0)) || any(dest >= vec2i(input.drawSize))) { return 0.0; }
  let source = sourceCoordinate(dest, input);
  if (any(source < vec2i(0)) || any(source >= vec2i(input.sourceSize))) { return 0.0; }
  return textureLoad(objectTexture, source, i32(input.layer), 0).a;
}

@fragment
fn fragmentMain(input: VertexOutput) -> @location(0) vec4f {
  let prioritySize = vec2i(textureDimensions(bgPriorityTexture));
  let atlasOffset = (prioritySize - vec2i(camera.viewport.xy)) / 2;
  let atlasPixel = vec2i(floor(input.ground)) + atlasOffset;
  if (any(atlasPixel < vec2i(0)) || any(atlasPixel >= prioritySize)) { discard; }
  let receiverPriority = textureLoad(bgPriorityTexture, atlasPixel, 0).r;
  if (receiverPriority == 0xffu || receiverPriority < input.priority) { discard; }

  let dest = vec2i(floor(input.uv));
  let center = objectAlpha(dest, input);
  let cardinal = objectAlpha(dest + vec2i(-1, 0), input)
    + objectAlpha(dest + vec2i(1, 0), input)
    + objectAlpha(dest + vec2i(0, -1), input)
    + objectAlpha(dest + vec2i(0, 1), input);
  let diagonal = objectAlpha(dest + vec2i(-1, -1), input)
    + objectAlpha(dest + vec2i(1, -1), input)
    + objectAlpha(dest + vec2i(-1, 1), input)
    + objectAlpha(dest + vec2i(1, 1), input);
  let farCardinal = objectAlpha(dest + vec2i(-2, 0), input)
    + objectAlpha(dest + vec2i(2, 0), input)
    + objectAlpha(dest + vec2i(0, -2), input)
    + objectAlpha(dest + vec2i(0, 2), input);
  let farDiagonal = objectAlpha(dest + vec2i(-2, -2), input)
    + objectAlpha(dest + vec2i(2, -2), input)
    + objectAlpha(dest + vec2i(-2, 2), input)
    + objectAlpha(dest + vec2i(2, 2), input);
  let silhouette = clamp(center * 0.52 + cardinal * 0.055 + diagonal * 0.020
    + farCardinal * 0.025 + farDiagonal * 0.010, 0.0, 1.0);
  if (silhouette <= 0.005) { discard; }
  return vec4f(1.0, 1.0, 1.0, silhouette);
}
`;

const CAST_SHADOW_COMPOSITE_SHADER = FULLSCREEN_VERTEX + /* wgsl */ `
struct Camera {
  values: vec4f,
  viewport: vec4f,
  world: vec4f,
}
@group(0) @binding(0) var shadowMask: texture_2d<f32>;
@group(0) @binding(1) var<uniform> camera: Camera;

@fragment
fn fragmentMain(input: VertexOutput) -> @location(0) vec4f {
  let size = vec2i(textureDimensions(shadowMask));
  let pixel = clamp(vec2i(input.uv * vec2f(size)), vec2i(0), size - 1);
  let silhouette = textureLoad(shadowMask, pixel, 0).a;
  if (silhouette <= 0.005) { discard; }
  return vec4f(0.0, 0.0, 0.0, silhouette * 0.460 * camera.values.z);
}
`;

const UI_SHADER = FULLSCREEN_VERTEX + /* wgsl */ `
@group(0) @binding(0) var uiTexture: texture_2d<f32>;
@fragment
fn fragmentMain(input: VertexOutput) -> @location(0) vec4f {
  let size = vec2i(textureDimensions(uiTexture));
  let uv = clamp(input.uv, vec2f(0.0), vec2f(0.99999));
  let color = textureLoad(uiTexture, clamp(vec2i(uv * vec2f(size)), vec2i(0), size - 1), 0);
  if (color.a < 0.5) { discard; }
  return vec4f(color.rgb, 1.0);
}
`;

const TILE_SIZE = 8;
const CAMERA_HEIGHT = 480;
const CAMERA_TILT_DEGREES = 45.384615;
const CAMERA_NEAR = 32;
const CAMERA_FAR = 1024;
const VERTEX_FLOATS = 11;
const BILLBOARD_VERTEX_FLOATS = 20;
const CAST_SHADOW_VERTEX_FLOATS = 16;
const STRUCTURAL_SHADOW_SIZE = 1024;
const LIGHT_MAP_SPAN = 1280;
const LIGHT_DEPTH_SPAN = 1400;

function webGpuUnavailableError() {
  if (globalThis.isSecureContext === false) {
    return new Error(
      'WebGPU requires a secure HTTPS connection; plain HTTP IP addresses are not supported. With Tailscale, run “tailscale serve --bg 8000” on the host and open the HTTPS URL it prints. localhost remains available for local development.',
    );
  }
  return new Error(
    'This browser or device does not provide WebGPU. Update the operating system and use a WebGPU-capable browser.',
  );
}

class WebGpuPresenter {
  static async create(canvas, width, height, worldWidth, worldHeight, scale, onFailure) {
    if (!navigator.gpu) throw webGpuUnavailableError();
    const adapter = await navigator.gpu.requestAdapter();
    if (!adapter) throw new Error('WebGPU is available, but no compatible graphics adapter was found.');
    const device = await adapter.requestDevice();
    try {
      return new WebGpuPresenter(canvas, width, height, worldWidth, worldHeight, scale, adapter, device, onFailure);
    } catch (error) {
      device.destroy();
      throw error;
    }
  }

  constructor(canvas, width, height, worldWidth, worldHeight, scale, adapter, device, onFailure) {
    Object.assign(this, { canvas, width, height, worldWidth, worldHeight, adapter, device });
    this.disposed = false;
    this.failure = null;
    this.onFailure = onFailure;
    this.uncapturedErrorHandler = (event) => {
      if (this.disposed) return;
      event.preventDefault();
      const detail = event.error?.message || String(event.error || 'unknown WebGPU error');
      this.reportFailure('uncaptured error', new Error(`WebGPU reported an uncaptured error: ${detail}`));
    };
    this.context = canvas.getContext('webgpu');
    if (!this.context) throw new Error('WebGPU canvas context is unavailable');
    this.format = navigator.gpu.getPreferredCanvasFormat();
    this.finalTexture = this.createTexture('canonical frame', 'rgba8unorm', GPUTextureUsage.TEXTURE_BINDING | GPUTextureUsage.COPY_DST);
    this.worldTexture = this.createTexture('overscan world atlas', 'rgba8unorm', GPUTextureUsage.TEXTURE_BINDING | GPUTextureUsage.COPY_DST, worldWidth, worldHeight);
    this.objectTexture = device.createTexture({
      label: 'independent OAM source layers', size: { width: 64, height: 64, depthOrArrayLayers: 128 },
      format: 'rgba8unorm', usage: GPUTextureUsage.TEXTURE_BINDING | GPUTextureUsage.COPY_DST,
    });
    this.bgPriorityTexture = this.createTexture('world BG priority', 'r8uint', GPUTextureUsage.TEXTURE_BINDING | GPUTextureUsage.COPY_DST, worldWidth, worldHeight);
    this.uiTexture = this.createTexture('flat BG0 interface', 'rgba8unorm', GPUTextureUsage.TEXTURE_BINDING | GPUTextureUsage.COPY_DST);
    this.sceneWidth = width * scale;
    this.sceneHeight = height * scale;
    this.sceneTexture = this.createTexture('high-resolution 3D scene', 'rgba8unorm', GPUTextureUsage.TEXTURE_BINDING | GPUTextureUsage.RENDER_ATTACHMENT | GPUTextureUsage.COPY_SRC, this.sceneWidth, this.sceneHeight);
    this.castShadowTexture = this.createTexture('unified projected shadow mask', 'rgba8unorm', GPUTextureUsage.TEXTURE_BINDING | GPUTextureUsage.RENDER_ATTACHMENT, this.sceneWidth, this.sceneHeight);
    this.gradedTexture = this.createTexture('cinematic graded scene', 'rgba8unorm', GPUTextureUsage.TEXTURE_BINDING | GPUTextureUsage.RENDER_ATTACHMENT | GPUTextureUsage.COPY_SRC, this.sceneWidth, this.sceneHeight);
    this.depthTexture = this.createTexture('high-resolution 3D depth', 'depth24plus', GPUTextureUsage.RENDER_ATTACHMENT, this.sceneWidth, this.sceneHeight);
    this.focusDepthTexture = this.createTexture('physical camera focus depth', 'r32float', GPUTextureUsage.TEXTURE_BINDING | GPUTextureUsage.RENDER_ATTACHMENT, this.sceneWidth, this.sceneHeight);
    this.structuralShadowTexture = this.createTexture(
      'world-anchored structural shadow map', 'depth32float',
      GPUTextureUsage.TEXTURE_BINDING | GPUTextureUsage.RENDER_ATTACHMENT,
      STRUCTURAL_SHADOW_SIZE, STRUCTURAL_SHADOW_SIZE,
    );
    this.cameraBuffer = device.createBuffer({ label: '3D camera, optics, and lighting', size: 112, usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST });
    this.vertexCapacity = 1024 * 1024;
    this.vertexBuffer = device.createBuffer({ label: 'projected terrain mesh', size: this.vertexCapacity, usage: GPUBufferUsage.VERTEX | GPUBufferUsage.COPY_DST });
    this.billboardVertexCapacity = 64 * 1024;
    this.billboardVertexBuffer = device.createBuffer({ label: 'high-resolution billboard quads', size: this.billboardVertexCapacity, usage: GPUBufferUsage.VERTEX | GPUBufferUsage.COPY_DST });
    this.castShadowVertexCapacity = 64 * 1024;
    this.castShadowVertexBuffer = device.createBuffer({ label: 'projected sprite shadow geometry', size: this.castShadowVertexCapacity, usage: GPUBufferUsage.VERTEX | GPUBufferUsage.COPY_DST });
    this.uiPixels = new Uint8Array(width * height * 4);
    this.objectPixels = Array.from({ length: 128 }, () => []);
    const terrainTileCapacity = (Math.ceil(worldWidth / TILE_SIZE) + 2) * (Math.ceil(worldHeight / TILE_SIZE) + 2);
    this.tileHeights = new Float32Array(terrainTileCapacity);
    this.tileGroundHeights = new Float32Array(terrainTileCapacity);
    this.tileGeometry = new Uint16Array(terrainTileCapacity);
    this.buildingComponents = [];
    this.terrainCols = 0;
    this.terrainRows = 0;
    this.terrainOriginX = 0;
    this.terrainOriginY = 0;
    this.terrainSignature = null;
    this.terrainVertexCount = 0;
    this.terrainRevision = 0;
    this.structuralShadowTerrainRevision = -1;
    this.structuralShadowLightTransform = null;
    this.sampler = device.createSampler({ magFilter: 'nearest', minFilter: 'nearest', mipmapFilter: 'nearest' });
    this.structuralShadowSampler = device.createSampler({
      compare: 'less-equal', magFilter: 'linear', minFilter: 'linear',
      addressModeU: 'clamp-to-edge', addressModeV: 'clamp-to-edge',
    });
    this.createPipelines();
    this.resize(scale);
    device.addEventListener('uncapturederror', this.uncapturedErrorHandler);
    device.lost.then((info) => {
      if (this.disposed) return;
      const reason = info.reason && info.reason !== 'unknown' ? ` (${info.reason})` : '';
      const detail = info.message ? `: ${info.message}` : '';
      this.reportFailure('device lost', new Error(`WebGPU device was lost${reason}${detail}`));
    });
  }

  reportFailure(kind, error) {
    if (this.failure || this.disposed) return;
    this.failure = { kind, error };
    this.onFailure?.(this, error, kind);
  }

  createTexture(label, format, usage, width = this.width, height = this.height) {
    return this.device.createTexture({ label, size: [width, height], format, usage });
  }

  createLightTransform(worldPixelOriginX, worldPixelOriginY) {
    // Light travels toward the southeast. Keeping the orthographic projection
    // square and snapping its center to whole shadow texels makes the map
    // world-anchored while the overscan atlas follows the camera.
    const length = Math.hypot(0.45, 0.77, 0.45);
    const forward = [0.45 / length, -0.77 / length, 0.45 / length];
    const right = [Math.SQRT1_2, 0, -Math.SQRT1_2];
    const up = [
      forward[1] * right[2] - forward[2] * right[1],
      forward[2] * right[0] - forward[0] * right[2],
      forward[0] * right[1] - forward[1] * right[0],
    ];
    const centerX = worldPixelOriginX + this.worldWidth / 2;
    const centerZ = worldPixelOriginY + this.worldHeight / 2;
    const texelWorldSize = LIGHT_MAP_SPAN / STRUCTURAL_SHADOW_SIZE;
    const centerU = right[0] * centerX + right[2] * centerZ;
    const centerV = up[0] * centerX + up[2] * centerZ;
    const snappedU = Math.round(centerU / texelWorldSize) * texelWorldSize;
    const snappedV = Math.round(centerV / texelWorldSize) * texelWorldSize;
    const xyScale = 2 / LIGHT_MAP_SPAN;
    const depthScale = 1 / LIGHT_DEPTH_SPAN;
    return new Float32Array([
      right[0] * xyScale, up[0] * xyScale, forward[0] * depthScale, 0,
      right[1] * xyScale, up[1] * xyScale, forward[1] * depthScale, 0,
      right[2] * xyScale, up[2] * xyScale, forward[2] * depthScale, 0,
      (centerU - snappedU) * xyScale,
      (centerV - snappedV) * xyScale,
      0.5,
      1,
    ]);
  }

  createPipelines() {
    const { device } = this;
    const terrainModule = device.createShaderModule({ label: 'projected terrain shader', code: TERRAIN_SHADER });
    this.terrainPipeline = device.createRenderPipeline({
      label: 'depth-tested projected terrain', layout: 'auto',
      vertex: {
        module: terrainModule, entryPoint: 'vertexMain',
        buffers: [{ arrayStride: VERTEX_FLOATS * 4, attributes: [
          { shaderLocation: 0, offset: 0, format: 'float32x3' },
          { shaderLocation: 1, offset: 12, format: 'float32x2' },
          { shaderLocation: 2, offset: 20, format: 'float32x3' },
          { shaderLocation: 3, offset: 32, format: 'float32' },
          { shaderLocation: 4, offset: 36, format: 'float32x2' },
        ] }],
      },
      fragment: { module: terrainModule, entryPoint: 'fragmentMain', targets: [
        { format: 'rgba8unorm' }, { format: 'r32float' },
      ] },
      primitive: { topology: 'triangle-list', cullMode: 'none' },
      depthStencil: { format: 'depth24plus', depthWriteEnabled: true, depthCompare: 'less' },
    });
    this.terrainBindGroup = device.createBindGroup({
      layout: this.terrainPipeline.getBindGroupLayout(0), entries: [
        { binding: 0, resource: this.worldTexture.createView() },
        { binding: 1, resource: this.sampler },
        { binding: 2, resource: { buffer: this.cameraBuffer } },
        { binding: 3, resource: this.structuralShadowTexture.createView() },
        { binding: 4, resource: this.structuralShadowSampler },
      ],
    });

    const structuralShadowModule = device.createShaderModule({
      label: 'structural shadow map shader', code: STRUCTURAL_SHADOW_SHADER,
    });
    this.structuralShadowPipeline = device.createRenderPipeline({
      label: 'terrain and building structural shadow map', layout: 'auto',
      vertex: {
        module: structuralShadowModule, entryPoint: 'vertexMain',
        buffers: [{ arrayStride: VERTEX_FLOATS * 4, attributes: [
          { shaderLocation: 0, offset: 0, format: 'float32x3' },
        ] }],
      },
      primitive: { topology: 'triangle-list', cullMode: 'none' },
      depthStencil: { format: 'depth32float', depthWriteEnabled: true, depthCompare: 'less' },
    });
    this.structuralShadowBindGroup = device.createBindGroup({
      layout: this.structuralShadowPipeline.getBindGroupLayout(0),
      entries: [{ binding: 0, resource: { buffer: this.cameraBuffer } }],
    });

    const castShadowModule = device.createShaderModule({ label: 'projected sprite shadow shader', code: CAST_SHADOW_SHADER });
    this.castShadowPipeline = device.createRenderPipeline({
      label: 'receiver-masked projected sprite shadows', layout: 'auto',
      vertex: {
        module: castShadowModule, entryPoint: 'vertexMain',
        buffers: [{ arrayStride: CAST_SHADOW_VERTEX_FLOATS * 4, attributes: [
          { shaderLocation: 0, offset: 0, format: 'float32x3' },
          { shaderLocation: 1, offset: 12, format: 'float32x2' },
          { shaderLocation: 2, offset: 20, format: 'float32' },
          { shaderLocation: 3, offset: 24, format: 'float32x2' },
          { shaderLocation: 4, offset: 32, format: 'float32x2' },
          { shaderLocation: 5, offset: 40, format: 'float32' },
          { shaderLocation: 6, offset: 44, format: 'float32x4' },
          { shaderLocation: 7, offset: 60, format: 'float32' },
        ] }],
      },
      fragment: { module: castShadowModule, entryPoint: 'fragmentMain', targets: [{
        format: 'rgba8unorm',
        blend: {
          color: { srcFactor: 'one', dstFactor: 'one', operation: 'max' },
          alpha: { srcFactor: 'one', dstFactor: 'one', operation: 'max' },
        },
      }] },
      primitive: { topology: 'triangle-list' },
    });
    this.castShadowBindGroup = device.createBindGroup({
      layout: this.castShadowPipeline.getBindGroupLayout(0), entries: [
        { binding: 0, resource: this.objectTexture.createView({ dimension: '2d-array' }) },
        { binding: 1, resource: { buffer: this.cameraBuffer } },
        { binding: 2, resource: this.bgPriorityTexture.createView() },
      ],
    });

    const castShadowCompositeModule = device.createShaderModule({ label: 'projected shadow composite shader', code: CAST_SHADOW_COMPOSITE_SHADER });
    this.castShadowCompositePipeline = device.createRenderPipeline({
      label: 'unified projected shadow composite', layout: 'auto',
      vertex: { module: castShadowCompositeModule, entryPoint: 'vertexMain' },
      fragment: { module: castShadowCompositeModule, entryPoint: 'fragmentMain', targets: [{
        format: 'rgba8unorm',
        blend: {
          color: { srcFactor: 'src-alpha', dstFactor: 'one-minus-src-alpha', operation: 'add' },
          alpha: { srcFactor: 'one', dstFactor: 'one-minus-src-alpha', operation: 'add' },
        },
      }] },
      primitive: { topology: 'triangle-list' },
    });

    const billboardModule = device.createShaderModule({ label: 'entity billboard shader', code: BILLBOARD_SHADER });
    const billboardVertex = {
      module: billboardModule, entryPoint: 'vertexMain',
      buffers: [{ arrayStride: BILLBOARD_VERTEX_FLOATS * 4, attributes: [
        { shaderLocation: 0, offset: 0, format: 'float32x2' },
        { shaderLocation: 1, offset: 8, format: 'float32x2' },
        { shaderLocation: 2, offset: 16, format: 'float32' },
        { shaderLocation: 3, offset: 20, format: 'float32' },
        { shaderLocation: 4, offset: 24, format: 'float32x2' },
        { shaderLocation: 5, offset: 32, format: 'float32x2' },
        { shaderLocation: 6, offset: 40, format: 'float32' },
        { shaderLocation: 7, offset: 44, format: 'float32x4' },
        { shaderLocation: 8, offset: 60, format: 'float32x2' },
        { shaderLocation: 9, offset: 68, format: 'float32x2' },
        { shaderLocation: 10, offset: 76, format: 'float32' },
      ] }],
    };
    const billboardBlend = {
      color: { srcFactor: 'src-alpha', dstFactor: 'one-minus-src-alpha', operation: 'add' },
      alpha: { srcFactor: 'one', dstFactor: 'one-minus-src-alpha', operation: 'add' },
    };
    this.billboardPipeline = device.createRenderPipeline({
      label: 'depth-tested upright entity billboards', layout: 'auto',
      vertex: billboardVertex,
      fragment: { module: billboardModule, entryPoint: 'fragmentMain', targets: [{
        format: 'rgba8unorm', blend: billboardBlend,
      }, { format: 'r32float' }] },
      primitive: { topology: 'triangle-list' },
      depthStencil: { format: 'depth24plus', depthWriteEnabled: true, depthCompare: 'less-equal' },
    });
    this.billboardBindGroup = device.createBindGroup({
      layout: this.billboardPipeline.getBindGroupLayout(0), entries: [
        { binding: 0, resource: this.objectTexture.createView({ dimension: '2d-array' }) },
        { binding: 1, resource: this.bgPriorityTexture.createView() },
      ],
    });
    this.actorSilhouettePipeline = device.createRenderPipeline({
      label: 'whole-actor building occlusion silhouettes', layout: 'auto',
      vertex: billboardVertex,
      fragment: { module: billboardModule, entryPoint: 'fragmentSilhouette', targets: [{
        format: 'rgba8unorm', blend: billboardBlend,
      }, { format: 'r32float' }] },
      primitive: { topology: 'triangle-list' },
    });
    this.actorSilhouetteBindGroup = device.createBindGroup({
      layout: this.actorSilhouettePipeline.getBindGroupLayout(0), entries: [
        { binding: 0, resource: this.objectTexture.createView({ dimension: '2d-array' }) },
      ],
    });

    const cinematicModule = device.createShaderModule({ label: 'cinematic HD-2D shader', code: CINEMATIC_SHADER });
    this.cinematicPipeline = device.createRenderPipeline({
      label: 'cinematic bloom, focus, and vignette', layout: 'auto',
      vertex: { module: cinematicModule, entryPoint: 'vertexMain' },
      fragment: { module: cinematicModule, entryPoint: 'fragmentMain', targets: [{ format: 'rgba8unorm' }] },
      primitive: { topology: 'triangle-list' },
    });

    const uiModule = device.createShaderModule({ label: 'flat interface shader', code: UI_SHADER });
    this.uiPipeline = device.createRenderPipeline({
      label: 'flat BG0 interface overlay', layout: 'auto',
      vertex: { module: uiModule, entryPoint: 'vertexMain' },
      fragment: { module: uiModule, entryPoint: 'fragmentMain', targets: [{ format: 'rgba8unorm' }] },
      primitive: { topology: 'triangle-list' },
    });
    this.uiBindGroup = device.createBindGroup({ layout: this.uiPipeline.getBindGroupLayout(0), entries: [{ binding: 0, resource: this.uiTexture.createView() }] });

    const presentModule = device.createShaderModule({ label: 'nearest presentation shader', code: PRESENT_SHADER });
    this.presentPipeline = device.createRenderPipeline({
      label: 'nearest presentation pipeline', layout: 'auto',
      vertex: { module: presentModule, entryPoint: 'vertexMain' },
      fragment: { module: presentModule, entryPoint: 'fragmentMain', targets: [{ format: this.format }] },
      primitive: { topology: 'triangle-list' },
    });
    const layout = this.presentPipeline.getBindGroupLayout(0);
    this.presentLayout = layout;
    this.finalBindGroup = device.createBindGroup({ layout, entries: [{ binding: 0, resource: this.finalTexture.createView() }] });
    this.rebuildSceneBindGroups();
  }

  rebuildSceneBindGroups() {
    this.castShadowCompositeBindGroup = this.device.createBindGroup({
      layout: this.castShadowCompositePipeline.getBindGroupLayout(0), entries: [
        { binding: 0, resource: this.castShadowTexture.createView() },
        { binding: 1, resource: { buffer: this.cameraBuffer } },
      ],
    });
    this.cinematicBindGroup = this.device.createBindGroup({
      layout: this.cinematicPipeline.getBindGroupLayout(0), entries: [
        { binding: 0, resource: this.sceneTexture.createView() },
        { binding: 1, resource: { buffer: this.cameraBuffer } },
        { binding: 2, resource: this.focusDepthTexture.createView() },
      ],
    });
    this.scenePresentBindGroup = this.device.createBindGroup({
      layout: this.presentLayout, entries: [{ binding: 0, resource: this.gradedTexture.createView() }],
    });
  }

  get kind() { return 'webgpu-3d'; }

  resize(scale) {
    if (this.disposed) return;
    this.scale = scale;
    const width = this.width * scale;
    const height = this.height * scale;
    this.canvas.width = width;
    this.canvas.height = height;
    if (this.sceneWidth !== width || this.sceneHeight !== height) {
      this.sceneTexture.destroy();
      this.castShadowTexture.destroy();
      this.gradedTexture.destroy();
      this.depthTexture.destroy();
      this.focusDepthTexture.destroy();
      this.sceneWidth = width;
      this.sceneHeight = height;
      this.sceneTexture = this.createTexture('high-resolution 3D scene', 'rgba8unorm', GPUTextureUsage.TEXTURE_BINDING | GPUTextureUsage.RENDER_ATTACHMENT | GPUTextureUsage.COPY_SRC, width, height);
      this.castShadowTexture = this.createTexture('unified projected shadow mask', 'rgba8unorm', GPUTextureUsage.TEXTURE_BINDING | GPUTextureUsage.RENDER_ATTACHMENT, width, height);
      this.gradedTexture = this.createTexture('cinematic graded scene', 'rgba8unorm', GPUTextureUsage.TEXTURE_BINDING | GPUTextureUsage.RENDER_ATTACHMENT | GPUTextureUsage.COPY_SRC, width, height);
      this.depthTexture = this.createTexture('high-resolution 3D depth', 'depth24plus', GPUTextureUsage.RENDER_ATTACHMENT, width, height);
      this.focusDepthTexture = this.createTexture('physical camera focus depth', 'r32float', GPUTextureUsage.TEXTURE_BINDING | GPUTextureUsage.RENDER_ATTACHMENT, width, height);
      this.rebuildSceneBindGroups();
    }
    this.context.configure({ device: this.device, format: this.format, alphaMode: 'opaque', usage: GPUTextureUsage.RENDER_ATTACHMENT | GPUTextureUsage.COPY_SRC });
  }

  buildTerrain(worldHeights, worldGroundHeights, worldGeometry, gridOffsetX, gridOffsetY) {
    const originX = gridOffsetX - TILE_SIZE;
    const originY = gridOffsetY - TILE_SIZE;
    const cols = Math.ceil((this.worldWidth - originX) / TILE_SIZE);
    const rows = Math.ceil((this.worldHeight - originY) / TILE_SIZE);
    let unchanged = this.terrainSignature !== null
      && this.terrainCols === cols && this.terrainRows === rows
      && this.terrainOriginX === originX && this.terrainOriginY === originY;
    this.terrainCols = cols;
    this.terrainRows = rows;
    this.terrainOriginX = originX;
    this.terrainOriginY = originY;
    const heights = this.tileHeights;
    const groundHeights = this.tileGroundHeights;
    const geometry = this.tileGeometry;
    let signature = 2166136261;
    for (let ty = 0; ty < rows; ty++) {
      for (let tx = 0; tx < cols; tx++) {
        const pixelX = Math.max(0, Math.min(this.worldWidth - 1, originX + tx * TILE_SIZE + TILE_SIZE / 2));
        const pixelY = Math.max(0, Math.min(this.worldHeight - 1, originY + ty * TILE_SIZE + TILE_SIZE / 2));
        const source = Math.floor(pixelY) * this.worldWidth + Math.floor(pixelX);
        const tile = ty * cols + tx;
        const height = worldHeights[source];
        const groundHeight = worldGroundHeights[source];
        const geometryWord = worldGeometry[source];
        if (unchanged && (heights[tile] !== height
            || groundHeights[tile] !== groundHeight || geometry[tile] !== geometryWord))
          unchanged = false;
        heights[tile] = height;
        groundHeights[tile] = groundHeight;
        geometry[tile] = geometryWord;
        signature = Math.imul(signature ^ (height & 0xff), 16777619);
        signature = Math.imul(signature ^ (groundHeight & 0xff), 16777619);
        signature = Math.imul(signature ^ geometryWord, 16777619);
      }
    }
    signature >>>= 0;
    // Exact sampled-value comparisons make hash collisions harmless. Reusing
    // this mesh also preserves the matching component/facade bounds.
    if (unchanged && signature === this.terrainSignature) return this.terrainVertexCount;

    const vertices = [];
    const pushVertex = (x, y, z, u, v, normal, material, shell, base) =>
      vertices.push(x, y, z, u, v, ...normal, material, shell, base);
    const quad = (a, b, c, d, normal, material, shell = 0, base = 0) => {
      for (const point of [a, b, c, a, c, d])
        pushVertex(point[0], point[1], point[2], point[3], point[4], normal, material, shell, base);
    };
    const halfW = this.worldWidth / 2;
    const halfH = this.worldHeight / 2;
    const inGrid = (x, y) => x >= 0 && y >= 0 && x < cols && y < rows;
    const heightAt = (x, y) => inGrid(x, y) ? heights[y * cols + x] : 0;
    const geometryAt = (x, y) => inGrid(x, y) ? geometry[y * cols + x] : 0;
    const surfaceAt = (x, y) => geometryAt(x, y) & 7;
    const componentAt = (x, y) => geometryAt(x, y) >> 3;
    const worldX = (x) => originX + x * TILE_SIZE - halfW;
    const worldZ = (y) => originY + y * TILE_SIZE - halfH;
    const textureU = (x) => Math.max(0, Math.min(this.worldWidth, originX + x * TILE_SIZE)) / this.worldWidth;
    const textureV = (y) => Math.max(0, Math.min(this.worldHeight, originY + y * TILE_SIZE)) / this.worldHeight;
    const pixelU = (pixel) => (Math.max(0, Math.min(this.worldWidth - 1, pixel)) + 0.5) / this.worldWidth;
    const pixelV = (pixel) => (Math.max(0, Math.min(this.worldHeight - 1, pixel)) + 0.5) / this.worldHeight;
    const SURFACE_WALL = 5;
    const SURFACE_ROOF = 6;

    // A vertical face is an extrusion of one authored source tile, not a
    // stretched edge texel. Keep each course within that tile and align its
    // top edge with the corresponding source edge so neighboring faces do not
    // develop a UV seam. The source tile is deliberately supplied by the
    // caller: ordinary terrain uses its exposed tile, while building closure
    // uses the nearest authored roof boundary tile.
    const verticalSide = (tx, ty, bottom, height, sourceX, sourceY, dx, dy,
                          normal, material, shell = 0, base = 0) => {
      if (bottom >= height) return;
      const u0 = pixelU(originX + sourceX * TILE_SIZE);
      const u1 = pixelU(originX + sourceX * TILE_SIZE + TILE_SIZE - 1);
      const v0 = pixelV(originY + sourceY * TILE_SIZE);
      const v1 = pixelV(originY + sourceY * TILE_SIZE + TILE_SIZE - 1);
      for (let courseBottom = bottom; courseBottom < height; courseBottom += TILE_SIZE) {
        const courseTop = Math.min(height, courseBottom + TILE_SIZE);
        if (dy < 0) {
          const z = worldZ(ty);
          quad([worldX(tx + 1),courseBottom,z,u1,v1],
               [worldX(tx),courseBottom,z,u0,v1],
               [worldX(tx),courseTop,z,u0,v0],
               [worldX(tx + 1),courseTop,z,u1,v0],
               normal, material, shell, base);
        } else if (dy > 0) {
          const z = worldZ(ty + 1);
          quad([worldX(tx),courseBottom,z,u0,v0],
               [worldX(tx + 1),courseBottom,z,u1,v0],
               [worldX(tx + 1),courseTop,z,u1,v1],
               [worldX(tx),courseTop,z,u0,v1],
               normal, material, shell, base);
        } else if (dx < 0) {
          const x = worldX(tx);
          quad([x,courseBottom,worldZ(ty),u1,v0],
               [x,courseBottom,worldZ(ty + 1),u1,v1],
               [x,courseTop,worldZ(ty + 1),u0,v1],
               [x,courseTop,worldZ(ty),u0,v0],
               normal, material, shell, base);
        } else {
          const x = worldX(tx + 1);
          quad([x,courseBottom,worldZ(ty + 1),u0,v1],
               [x,courseBottom,worldZ(ty),u0,v0],
               [x,courseTop,worldZ(ty),u1,v0],
               [x,courseTop,worldZ(ty + 1),u1,v1],
               normal, material, shell, base);
        }
      }
    };

    // Merge source-aligned horizontal courses. Roofs merge only when C says
    // they have the same frame-local owner; facade source is never a floor.
    const visited = new Uint8Array(cols * rows);
    for (let ty = 0; ty < rows; ty++) {
      for (let tx = 0; tx < cols; tx++) {
        const start = ty * cols + tx;
        if (visited[start]) continue;
        visited[start] = 1;
        if (surfaceAt(tx, ty) === SURFACE_WALL) {
          let sourceY = ty + 1;
          while (sourceY < rows && surfaceAt(tx, sourceY) === SURFACE_WALL
              && componentAt(tx, sourceY) === componentAt(tx, ty)) sourceY++;
          sourceY = Math.min(rows - 1, sourceY);
          const ground = groundHeights[start];
          // Replace the removed wall footprint with the first authored ground
          // course in front. No WALL source texel is ever laid horizontally.
          quad(
            [worldX(tx),ground,worldZ(ty),textureU(tx),textureV(sourceY)],
            [worldX(tx + 1),ground,worldZ(ty),textureU(tx + 1),textureV(sourceY)],
            [worldX(tx + 1),ground,worldZ(ty + 1),textureU(tx + 1),textureV(sourceY + 1)],
            [worldX(tx),ground,worldZ(ty + 1),textureU(tx),textureV(sourceY + 1)],
            [0, 1, 0], surfaceAt(tx, sourceY),
          );
          continue;
        }

        const word = geometry[start];
        const height = heights[start];
        let width = 1;
        while (tx + width < cols) {
          const tile = ty * cols + tx + width;
          if (visited[tile] || geometry[tile] !== word || heights[tile] !== height) break;
          width++;
        }
        let depth = 1;
        depthLoop: while (ty + depth < rows) {
          for (let x = 0; x < width; x++) {
            const tile = (ty + depth) * cols + tx + x;
            if (visited[tile] || geometry[tile] !== word || heights[tile] !== height)
              break depthLoop;
          }
          depth++;
        }
        for (let y = 0; y < depth; y++) {
          for (let x = 0; x < width; x++)
            visited[(ty + y) * cols + tx + x] = 1;
        }
        const shell = surfaceAt(tx, ty) === SURFACE_ROOF && componentAt(tx, ty) !== 0;
        quad(
          [worldX(tx), height, worldZ(ty), textureU(tx), textureV(ty)],
          [worldX(tx + width), height, worldZ(ty), textureU(tx + width), textureV(ty)],
          [worldX(tx + width), height, worldZ(ty + depth), textureU(tx + width), textureV(ty + depth)],
          [worldX(tx), height, worldZ(ty + depth), textureU(tx), textureV(ty + depth)],
          [0, 1, 0], surfaceAt(tx, ty), shell ? 1 : 0, shell ? groundHeights[start] : 0,
        );
      }
    }

    // Component membership is decoded, never inferred. Every maximal wall
    // rectangle retains its complete authored X/Y range and maps one source
    // texel to one world unit on the south-facing plane.
    const components = new Map();
    for (let ty = 0; ty < rows; ty++) {
      for (let tx = 0; tx < cols; tx++) {
        const id = componentAt(tx, ty);
        if (!id) continue;
        let component = components.get(id);
        if (!component) {
          component = {
            id,
            base: groundHeights[ty * cols + tx],
            roofHeight: -Infinity,
            roofCells: [],
            wallCells: [],
            wallRects: [],
            x0: Infinity,
            x1: -Infinity,
            minZ: Infinity,
            maxZ: -Infinity,
            occlusionZ: -Infinity,
            frontZ: -Infinity,
          };
          components.set(id, component);
        }
        component.base = Math.min(component.base, groundHeights[ty * cols + tx]);
        if (surfaceAt(tx, ty) === SURFACE_ROOF) {
          component.roofHeight = Math.max(component.roofHeight, heightAt(tx, ty));
          component.roofCells.push([tx, ty]);
          component.x0 = Math.min(component.x0, worldX(tx));
          component.x1 = Math.max(component.x1, worldX(tx + 1));
          component.minZ = Math.min(component.minZ, worldZ(ty));
          component.maxZ = Math.max(component.maxZ, worldZ(ty + 1));
        }
      }
    }

    const facadeVisited = new Uint8Array(cols * rows);
    for (let ty = 0; ty < rows; ty++) {
      for (let tx = 0; tx < cols; tx++) {
        const start = ty * cols + tx;
        const id = componentAt(tx, ty);
        if (!id || surfaceAt(tx, ty) !== SURFACE_WALL || facadeVisited[start]) continue;
        let width = 1;
        while (tx + width < cols) {
          const tile = ty * cols + tx + width;
          if (facadeVisited[tile] || componentAt(tx + width, ty) !== id
              || surfaceAt(tx + width, ty) !== SURFACE_WALL) break;
          width++;
        }
        let depth = 1;
        depthLoop: while (ty + depth < rows) {
          for (let x = 0; x < width; x++) {
            const tile = (ty + depth) * cols + tx + x;
            if (facadeVisited[tile] || componentAt(tx + x, ty + depth) !== id
                || surfaceAt(tx + x, ty + depth) !== SURFACE_WALL) break depthLoop;
          }
          depth++;
        }
        for (let y = 0; y < depth; y++) {
          for (let x = 0; x < width; x++)
            facadeVisited[(ty + y) * cols + tx + x] = 1;
        }

        const component = components.get(id);
        const sourceHeight = depth * TILE_SIZE;
        const top = component.base + sourceHeight;
        const x0 = worldX(tx);
        const x1 = worldX(tx + width);
        // The authored wall rectangle is vertical source art, so its physical
        // south/front edge is after all of its 8px courses rather than at the
        // rectangle's north edge.
        const z = worldZ(ty + depth);
        quad(
          [x0, component.base, z, textureU(tx), textureV(ty + depth)],
          [x1, component.base, z, textureU(tx + width), textureV(ty + depth)],
          [x1, top, z, textureU(tx + width), textureV(ty)],
          [x0, top, z, textureU(tx), textureV(ty)],
          [0, 0, 1], SURFACE_WALL, 1, component.base,
        );
        component.x0 = Math.min(component.x0, x0);
        component.x1 = Math.max(component.x1, x1);
        component.minZ = Math.min(component.minZ, worldZ(ty));
        component.maxZ = Math.max(component.maxZ, z);
        component.occlusionZ = Math.max(component.occlusionZ, worldZ(ty));
        component.frontZ = Math.max(component.frontZ, z);
        component.roofHeight = Math.max(component.roofHeight, top);
        component.wallRects.push([tx, ty, width, depth, top]);
        for (let y = 0; y < depth; y++) {
          for (let x = 0; x < width; x++)
            component.wallCells.push([tx + x, ty + y, top, ty - 1]);
        }
      }
    }
    this.buildingComponents = Array.from(components.values()).filter((component) =>
      Number.isFinite(component.x0) && Number.isFinite(component.x1)
        && Number.isFinite(component.minZ) && Number.isFinite(component.frontZ));

    // Fill the footprint represented by vertical facade source courses with
    // the adjacent roof boundary course. This extends the authored top mass to
    // the relocated front without ever laying facade pixels horizontally.
    const sameRoof = (x, y, id) => inGrid(x, y)
      && surfaceAt(x, y) === SURFACE_ROOF && componentAt(x, y) === id;
    for (const component of components.values()) {
      const localRoofSource = (tx, ty) => {
        let sourceX = tx;
        let sourceY = ty - 1;
        if (!sameRoof(sourceX, sourceY, component.id)) {
          let nearest = null;
          let distance = Infinity;
          for (const [roofX, roofY] of component.roofCells) {
            const candidateDistance = Math.abs(roofX - tx) + Math.abs(roofY - ty);
            if (candidateDistance < distance) {
              nearest = [roofX, roofY];
              distance = candidateDistance;
            }
          }
          if (!nearest) return null;
          [sourceX, sourceY] = nearest;
        }
        return [sourceX, sourceY];
      };
      for (const [tx, ty, width, depth, top] of component.wallRects) {
        // Stretch each adjacent boundary course once through the complete
        // authored facade depth. Repeating it per wall course would invent
        // roof bands, while sampling the wall rectangle would lay facade art
        // horizontally.
        for (let x = 0; x < width; x++) {
          const source = localRoofSource(tx + x, ty);
          if (!source) continue;
          const [sourceX, sourceY] = source;
          quad(
            [worldX(tx + x),top,worldZ(ty),textureU(sourceX),textureV(sourceY)],
            [worldX(tx + x + 1),top,worldZ(ty),textureU(sourceX + 1),textureV(sourceY)],
            [worldX(tx + x + 1),top,worldZ(ty + depth),textureU(sourceX + 1),textureV(sourceY + 1)],
            [worldX(tx + x),top,worldZ(ty + depth),textureU(sourceX),textureV(sourceY + 1)],
            [0, 1, 0], SURFACE_ROOF, 1, component.base,
          );
        }
      }

      for (const [tx, ty, top] of component.wallCells) {
        const source = localRoofSource(tx, ty);
        if (!source) continue;
        const [sourceX, sourceY] = source;

        // Continue exposed side/rear closure through the new top footprint.
        // Its UVs use the same local roof boundary material; the exposed south
        // edge is the facade itself and must not receive a second skin.
        for (const dx of [-1, 1]) {
          const neighborIsShell = sameRoof(tx + dx, ty, component.id)
            || (inGrid(tx + dx, ty) && surfaceAt(tx + dx, ty) === SURFACE_WALL
              && componentAt(tx + dx, ty) === component.id);
          if (neighborIsShell) continue;
          const bottom = Math.max(component.base, heightAt(tx + dx, ty));
          if (bottom >= top) continue;
          verticalSide(tx, ty, bottom, top, sourceX, sourceY, dx, 0,
                       [dx < 0 ? -1 : 1, 0, 0], SURFACE_WALL, 1, component.base);
        }
        const northIsShell = sameRoof(tx, ty - 1, component.id)
          || (inGrid(tx, ty - 1) && surfaceAt(tx, ty - 1) === SURFACE_WALL
            && componentAt(tx, ty - 1) === component.id);
        if (!northIsShell) {
          const bottom = Math.max(component.base, heightAt(tx, ty - 1));
          if (bottom < top) {
            verticalSide(tx, ty, bottom, top, sourceX, sourceY, 0, -1,
                         [0, 0, -1], SURFACE_WALL, 1, component.base);
          }
        }
      }

      // Close only exposed building perimeter. Side/rear UVs come from the
      // local roof boundary course, not a facade column stretched through roof
      // depth. Wall top cells above make the former roof/facade seam internal.
      for (const [tx, ty] of component.roofCells) {
        const height = heightAt(tx, ty);
        for (const dx of [-1, 1]) {
          if (sameRoof(tx + dx, ty, component.id)) continue;
          const bottom = Math.max(component.base, heightAt(tx + dx, ty));
          if (bottom >= height) continue;
          verticalSide(tx, ty, bottom, height, tx, ty, dx, 0,
                       [dx < 0 ? -1 : 1, 0, 0], SURFACE_WALL, 1, component.base);
        }
        for (const dy of [-1, 1]) {
          if (sameRoof(tx, ty + dy, component.id)) continue;
          if (dy > 0 && componentAt(tx, ty + 1) === component.id
              && surfaceAt(tx, ty + 1) === SURFACE_WALL) continue;
          const bottom = Math.max(component.base, heightAt(tx, ty + dy));
          if (bottom >= height) continue;
          verticalSide(tx, ty, bottom, height, tx, ty, 0, dy,
                       [0, 0, dy < 0 ? -1 : 1], SURFACE_WALL, 1, component.base);
        }
      }
    }

    // Preserve the existing atlas-edge extrusion for non-building materials.
    const ordinaryEdge = (tx, ty, dx, dy) => {
      const surface = surfaceAt(tx, ty);
      const height = heightAt(tx, ty);
      const bottom = heightAt(tx + dx, ty + dy);
      return surface !== SURFACE_ROOF && surface !== SURFACE_WALL && bottom < height
        ? { height, bottom } : null;
    };
    for (const dy of [-1, 1]) {
      for (let ty = 0; ty < rows; ty++) {
        for (let tx = 0; tx < cols; tx++) {
          const edge = ordinaryEdge(tx, ty, 0, dy);
          if (!edge) continue;
          verticalSide(tx, ty, edge.bottom, edge.height, tx, ty, 0, dy,
                       [0, 0, dy < 0 ? -1 : 1], surfaceAt(tx, ty));
        }
      }
    }
    for (const dx of [-1, 1]) {
      for (let tx = 0; tx < cols; tx++) {
        for (let ty = 0; ty < rows; ty++) {
          const edge = ordinaryEdge(tx, ty, dx, 0);
          if (!edge) continue;
          verticalSide(tx, ty, edge.bottom, edge.height, tx, ty, dx, 0,
                       [dx < 0 ? -1 : 1, 0, 0], surfaceAt(tx, ty));
        }
      }
    }

    const data = new Float32Array(vertices);
    if (data.byteLength > this.vertexCapacity) {
      this.vertexBuffer.destroy();
      this.vertexCapacity = 2 ** Math.ceil(Math.log2(data.byteLength));
      this.vertexBuffer = this.device.createBuffer({ label: 'projected terrain mesh', size: this.vertexCapacity, usage: GPUBufferUsage.VERTEX | GPUBufferUsage.COPY_DST });
    }
    this.device.queue.writeBuffer(this.vertexBuffer, 0, data);
    this.terrainSignature = signature;
    this.terrainVertexCount = data.length / VERTEX_FLOATS;
    this.terrainRevision++;
    return this.terrainVertexCount;
  }

  terrainHeightAt(x, z) {
    const atlasX = x + this.worldWidth / 2;
    const atlasZ = z + this.worldHeight / 2;
    const tileX = Math.floor((atlasX - this.terrainOriginX) / TILE_SIZE);
    const tileZ = Math.floor((atlasZ - this.terrainOriginY) / TILE_SIZE);
    if (tileX < 0 || tileZ < 0 || tileX >= this.terrainCols || tileZ >= this.terrainRows) return 0;
    return this.tileHeights[tileZ * this.terrainCols + tileX];
  }

  terrainGroundHeightAt(x, z) {
    const atlasX = x + this.worldWidth / 2;
    const atlasZ = z + this.worldHeight / 2;
    const tileX = Math.floor((atlasX - this.terrainOriginX) / TILE_SIZE);
    const tileZ = Math.floor((atlasZ - this.terrainOriginY) / TILE_SIZE);
    if (tileX < 0 || tileZ < 0 || tileX >= this.terrainCols || tileZ >= this.terrainRows) return 0;
    return this.tileGroundHeights[tileZ * this.terrainCols + tileX];
  }

  cameraProjection(x, y, z, tilt, zoom) {
    const angle = CAMERA_TILT_DEGREES * tilt * Math.PI / 180;
    const sine = Math.sin(angle);
    const cosine = Math.cos(angle);
    const zoomOut = 0.30 * zoom + 0.76923077 * zoom * zoom * (zoom - 0.35);
    const focal = CAMERA_HEIGHT / (1 + zoomOut);
    const viewY = y * sine - z * cosine;
    const depth = CAMERA_HEIGHT - y * cosine - z * sine;
    return {
      x: this.width / 2 + x * focal / depth,
      y: this.height / 2 - viewY * focal / depth,
      scale: focal / depth,
      depth: (depth - CAMERA_NEAR) / (CAMERA_FAR - CAMERA_NEAR),
      cameraDepth: depth,
    };
  }

  shellProjection(x, y, z, base, tilt, zoom) {
    const angle = CAMERA_TILT_DEGREES * tilt * Math.PI / 180;
    const sine = Math.sin(angle);
    const cosine = Math.cos(angle);
    const zoomOut = 0.30 * zoom + 0.76923077 * zoom * zoom * (zoom - 0.35);
    const focal = CAMERA_HEIGHT / (1 + zoomOut);
    const viewY = base * sine - z * cosine + y - base;
    const cameraDepth = CAMERA_HEIGHT - base * cosine - z * sine;
    return {
      x: this.width / 2 + x * focal / cameraDepth,
      y: this.height / 2 - viewY * focal / cameraDepth,
      cameraDepth,
    };
  }

  actorOccludedByShell(actor, tilt, zoom) {
    // Route the complete owning actor only when its grouped projected cards
    // actually cover a shell. World X/Z alone made separated cards become
    // false whole-body silhouettes near a building's footprint.
    for (const component of this.buildingComponents) {
      const overlapsWorldX = actor.worldX1 > component.x0 && actor.worldX0 < component.x1;
      // The facade's source footprint remains its doorway/front transition
      // zone even though the physical plane is now at its south boundary.
      // Only actors north of that footprint are genuinely under/behind roof.
      const behindRoof = actor.footZ < component.occlusionZ - 0.5;
      if (!overlapsWorldX || !behindRoof) continue;

      const bounds = {
        x0: Infinity, x1: -Infinity, y0: Infinity, y1: -Infinity,
        nearDepth: Infinity,
      };
      for (const x of [component.x0, component.x1]) {
        for (const y of [component.base, component.roofHeight]) {
          for (const z of [component.minZ, component.frontZ]) {
            const point = this.shellProjection(x, y, z, component.base, tilt, zoom);
            bounds.x0 = Math.min(bounds.x0, point.x);
            bounds.x1 = Math.max(bounds.x1, point.x);
            bounds.y0 = Math.min(bounds.y0, point.y);
            bounds.y1 = Math.max(bounds.y1, point.y);
            bounds.nearDepth = Math.min(bounds.nearDepth, point.cameraDepth);
          }
        }
      }
      const overlapsProjection = actor.screenX1 > bounds.x0 && actor.screenX0 < bounds.x1
        && actor.screenY1 > bounds.y0 && actor.screenY0 < bounds.y1;
      const shellIsInFront = actor.cameraDepth > bounds.nearDepth + 0.5;
      if (!overlapsProjection || !shellIsInFront) continue;
      return true;
    }
    return false;
  }

  measureObjectFootRows(objectDescriptors, objectSourceCount, objectEventSpriteFlags,
                        objectSourcePixels) {
    const footRows = new Float32Array(objectEventSpriteFlags.length);
    footRows.fill(-32768);
    for (let layer = 0; layer < objectSourceCount; layer++) {
      const o = layer * 16;
      const spriteId = objectDescriptors[o + 10];
      if (spriteId < 0 || spriteId >= footRows.length || !objectEventSpriteFlags[spriteId]) continue;
      const screenY = objectDescriptors[o + 2];
      const sourceW = objectDescriptors[o + 5], sourceH = objectDescriptors[o + 6];
      const drawW = objectDescriptors[o + 7], drawH = objectDescriptors[o + 8];
      const affine = objectDescriptors[o + 11];
      const pa = objectDescriptors[o + 12], pb = objectDescriptors[o + 13];
      const pc = objectDescriptors[o + 14], pd = objectDescriptors[o + 15];
      for (let destY = drawH - 1; destY >= 0; destY--) {
        let rowVisible = false;
        for (let destX = 0; destX < drawW; destX++) {
          let sourceX = destX, sourceY = destY;
          if (affine) {
            const deltaX = destX - Math.floor(drawW / 2);
            const deltaY = destY - Math.floor(drawH / 2);
            sourceX = ((pa * deltaX + pb * deltaY) >> 8) + Math.floor(sourceW / 2);
            sourceY = ((pc * deltaX + pd * deltaY) >> 8) + Math.floor(sourceH / 2);
          }
          if (sourceX < 0 || sourceY < 0 || sourceX >= sourceW || sourceY >= sourceH) continue;
          const alpha = objectSourcePixels[((layer * 64 * 64 + sourceY * 64 + sourceX) * 4) + 3];
          if (alpha) { rowVisible = true; break; }
        }
        if (rowVisible) {
          footRows[spriteId] = Math.max(footRows[spriteId], screenY + destY + 1);
          break;
        }
      }
    }
    return footRows;
  }

  buildProjectedShadows(objectDescriptors, objectSourceCount, objectEventSpriteFlags,
                        objectFootRows) {
    const groups = new Map();
    for (let layer = 0; layer < objectSourceCount; layer++) {
      const o = layer * 16;
      const spriteId = objectDescriptors[o + 10];
      if (spriteId < 0 || spriteId >= objectEventSpriteFlags.length || !objectEventSpriteFlags[spriteId]) continue;
      const footY = objectFootRows[spriteId];
      if (footY <= -32768) continue;
      const descriptorAnchorY = objectDescriptors[o + 4];
      let group = groups.get(spriteId);
      if (!group) {
        group = { anchorX: objectDescriptors[o + 3], anchorY: footY, descriptorAnchorY,
          priority: objectDescriptors[o + 9] };
        groups.set(spriteId, group);
      } else {
        if (descriptorAnchorY > group.descriptorAnchorY) {
          group.anchorX = objectDescriptors[o + 3];
          group.descriptorAnchorY = descriptorAnchorY;
        }
        group.priority = Math.min(group.priority, objectDescriptors[o + 9]);
      }
    }

    const vertices = [];
    const vertex = (ground, u, v, layer, sourceW, sourceH, drawW, drawH, affine, pa, pb, pc, pd, priority) =>
      vertices.push(ground.x, ground.y, ground.z, u, v, layer, sourceW, sourceH, drawW, drawH,
                    affine, pa, pb, pc, pd, priority);
    for (let layer = 0; layer < objectSourceCount; layer++) {
      const o = layer * 16;
      const spriteId = objectDescriptors[o + 10];
      const group = groups.get(spriteId);
      if (!group) continue;
      const screenX = objectDescriptors[o + 1], screenY = objectDescriptors[o + 2];
      const sourceW = objectDescriptors[o + 5], sourceH = objectDescriptors[o + 6];
      const drawW = objectDescriptors[o + 7], drawH = objectDescriptors[o + 8];
      const affine = objectDescriptors[o + 11];
      const pa = objectDescriptors[o + 12], pb = objectDescriptors[o + 13];
      const pc = objectDescriptors[o + 14], pd = objectDescriptors[o + 15];
      const project = (u, v) => {
        // Sink the lowest opaque sprite row into the receiver plane so the
        // silhouette begins under the entity instead of after a raster gap.
        const height = Math.max(0, group.anchorY - (screenY + v) - 1);
        // Match the structural northwest key: elevated sprite pixels project
        // along the same southeast light ray as roofs and cliffs.
        const x = group.anchorX - this.width / 2 + (screenX - group.anchorX + u) + height * 0.584;
        const z = group.anchorY - this.height / 2 + height * 0.584;
        return { x, y: this.terrainGroundHeightAt(x, z), z };
      };
      // Leave a three-source-pixel apron around every projected component so
      // the wide alpha penumbra can cross tile and subsprite boundaries instead
      // of being clipped to each OAM rectangle.
      const u0 = -3, v0 = -3, u1 = drawW + 3;
      // Stop the component that owns the feet exactly at the shared foot row.
      // Extending its padded quad past that row would make interpolation lift
      // the last opaque sprite pixels away from the cast-shadow base.
      const footV = Math.max(0, group.anchorY - screenY);
      const v1 = Math.min(drawH + 3, footV);
      if (v1 <= v0) continue;
      const p00 = project(u0, v0), p10 = project(u1, v0);
      const p11 = project(u1, v1), p01 = project(u0, v1);
      for (const point of [
        [p00,u0,v0], [p10,u1,v0], [p11,u1,v1],
        [p00,u0,v0], [p11,u1,v1], [p01,u0,v1],
      ]) vertex(point[0], point[1], point[2], layer, sourceW, sourceH, drawW, drawH, affine, pa, pb, pc, pd, group.priority);
    }

    const data = new Float32Array(vertices);
    if (data.byteLength > this.castShadowVertexCapacity) {
      this.castShadowVertexBuffer.destroy();
      this.castShadowVertexCapacity = 2 ** Math.ceil(Math.log2(data.byteLength));
      this.castShadowVertexBuffer = this.device.createBuffer({ label: 'projected sprite shadow geometry', size: this.castShadowVertexCapacity, usage: GPUBufferUsage.VERTEX | GPUBufferUsage.COPY_DST });
    }
    if (data.byteLength) this.device.queue.writeBuffer(this.castShadowVertexBuffer, 0, data);
    return data.length / CAST_SHADOW_VERTEX_FLOATS;
  }

  buildFrameLayers(finalPixels, layerPixels, objectIds, objectPixels, objectPriorities,
                   objectDescriptors, objectEventSpriteFlags, objectSourceCount, tilt, zoom) {
    this.uiPixels.fill(0);
    for (const pixels of this.objectPixels) pixels.length = 0;
    for (let index = 0; index < layerPixels.length; index++) {
      if ((layerPixels[index] & 0x01) !== 0) {
        const o = index * 4;
        this.uiPixels[o] = finalPixels[o];
        this.uiPixels[o + 1] = finalPixels[o + 1];
        this.uiPixels[o + 2] = finalPixels[o + 2];
        this.uiPixels[o + 3] = 255;
      }
      const id = objectIds[index];
      if (id < 128) this.objectPixels[id].push(index);
    }

    const hasUiPlane = layerPixels.some((mask) => (mask & 0x01) !== 0);
    const objectTouchesUi = (x, y, width, height) => {
      const x0 = Math.max(0, x), y0 = Math.max(0, y);
      const x1 = Math.min(this.width, x + width), y1 = Math.min(this.height, y + height);
      for (let py = y0; py < y1; py++) for (let px = x0; px < x1; px++)
        if (layerPixels[py * this.width + px] & 0x01) return true;
      return false;
    };
    if (hasUiPlane) {
      for (let id = 0; id < 128; id++) {
        if (objectPriorities[id] !== 0) continue;
        for (const source of this.objectPixels[id]) {
          const src = source * 4;
          this.uiPixels[src] = objectPixels[src];
          this.uiPixels[src + 1] = objectPixels[src + 1];
          this.uiPixels[src + 2] = objectPixels[src + 2];
          this.uiPixels[src + 3] = objectPixels[src + 3];
        }
      }
    }

    // The engine exports the owning Sprite slot for each OAM entry. All
    // subsprites from one engine sprite share a foot-row projection without
    // accidentally joining touching actors or weather tiles.
    const groupAnchorY = new Int32Array(objectEventSpriteFlags.length);
    const groupX0 = new Float32Array(objectEventSpriteFlags.length);
    const groupX1 = new Float32Array(objectEventSpriteFlags.length);
    const groupScreenX0 = new Float32Array(objectEventSpriteFlags.length);
    const groupScreenX1 = new Float32Array(objectEventSpriteFlags.length);
    const groupScreenY0 = new Float32Array(objectEventSpriteFlags.length);
    const groupScreenY1 = new Float32Array(objectEventSpriteFlags.length);
    const groupCameraDepth = new Float32Array(objectEventSpriteFlags.length);
    groupAnchorY.fill(-32768);
    groupX0.fill(Infinity);
    groupX1.fill(-Infinity);
    groupScreenX0.fill(Infinity);
    groupScreenX1.fill(-Infinity);
    groupScreenY0.fill(Infinity);
    groupScreenY1.fill(-Infinity);
    for (let index = 0; index < objectSourceCount; index++) {
      const o = index * 16;
      const spriteId = objectDescriptors[o + 10];
      if (spriteId < 0 || spriteId >= groupAnchorY.length) continue;
      groupAnchorY[spriteId] = Math.max(groupAnchorY[spriteId], objectDescriptors[o + 4]);
      groupX0[spriteId] = Math.min(groupX0[spriteId], objectDescriptors[o + 1] - this.width / 2);
      groupX1[spriteId] = Math.max(
        groupX1[spriteId], objectDescriptors[o + 1] + objectDescriptors[o + 7] - this.width / 2,
      );
    }
    // Project every card with its owning group's shared foot so the occlusion
    // decision uses the same complete billboard bounds that will be emitted.
    for (let index = 0; index < objectSourceCount; index++) {
      const o = index * 16;
      const spriteId = objectDescriptors[o + 10];
      if (spriteId < 0 || spriteId >= groupAnchorY.length || !objectEventSpriteFlags[spriteId]
          || groupAnchorY[spriteId] <= -32768) continue;
      const anchorX = objectDescriptors[o + 3];
      const anchorY = groupAnchorY[spriteId];
      const groundX = anchorX - this.width / 2;
      const groundZ = anchorY - this.height / 2;
      const projected = this.cameraProjection(
        groundX, this.terrainGroundHeightAt(groundX, groundZ), groundZ, tilt, zoom,
      );
      const x0 = projected.x + (objectDescriptors[o + 1] - anchorX) * projected.scale;
      const y0 = projected.y + (objectDescriptors[o + 2] - anchorY) * projected.scale;
      groupScreenX0[spriteId] = Math.min(groupScreenX0[spriteId], x0);
      groupScreenX1[spriteId] = Math.max(
        groupScreenX1[spriteId], x0 + objectDescriptors[o + 7] * projected.scale,
      );
      groupScreenY0[spriteId] = Math.min(groupScreenY0[spriteId], y0);
      groupScreenY1[spriteId] = Math.max(
        groupScreenY1[spriteId], y0 + objectDescriptors[o + 8] * projected.scale,
      );
      groupCameraDepth[spriteId] = Math.max(groupCameraDepth[spriteId], projected.cameraDepth);
    }
    const shellOccludedGroups = new Uint8Array(objectEventSpriteFlags.length);
    for (let spriteId = 0; spriteId < shellOccludedGroups.length; spriteId++) {
      if (!objectEventSpriteFlags[spriteId] || groupAnchorY[spriteId] <= -32768) continue;
      shellOccludedGroups[spriteId] = this.actorOccludedByShell(
        {
          worldX0: groupX0[spriteId], worldX1: groupX1[spriteId],
          footZ: groupAnchorY[spriteId] - this.height / 2,
          screenX0: groupScreenX0[spriteId], screenX1: groupScreenX1[spriteId],
          screenY0: groupScreenY0[spriteId], screenY1: groupScreenY1[spriteId],
          cameraDepth: groupCameraDepth[spriteId],
        },
        tilt, zoom,
      );
    }

    const order = Array.from({ length: objectSourceCount }, (_, index) => index);
    order.sort((a, b) => {
      const ao = a * 16, bo = b * 16;
      return objectDescriptors[bo + 9] - objectDescriptors[ao + 9]
        || objectDescriptors[bo] - objectDescriptors[ao];
    });
    const normalVertices = [];
    const silhouetteVertices = [];
    const vertex = (vertices, x, y, u, v, depth, layer, sourceW, sourceH, drawW, drawH,
                    affine, pa, pb, pc, pd, screenX, screenY, oamId, priority, cameraDepth) =>
      vertices.push(x, y, u, v, depth, layer, sourceW, sourceH, drawW, drawH,
                    affine, pa, pb, pc, pd, screenX, screenY, oamId, priority, cameraDepth);
    for (const layer of order) {
      const o = layer * 16;
      const oamId = objectDescriptors[o];
      const screenX = objectDescriptors[o + 1];
      const screenY = objectDescriptors[o + 2];
      const anchorX = objectDescriptors[o + 3];
      const spriteId = objectDescriptors[o + 10];
      const anchorY = spriteId < groupAnchorY.length ? groupAnchorY[spriteId] : objectDescriptors[o + 4];
      const sourceW = objectDescriptors[o + 5];
      const sourceH = objectDescriptors[o + 6];
      const drawW = objectDescriptors[o + 7];
      const drawH = objectDescriptors[o + 8];
      const priority = objectDescriptors[o + 9];
      const affine = objectDescriptors[o + 11];
      const pa = objectDescriptors[o + 12], pb = objectDescriptors[o + 13];
      const pc = objectDescriptors[o + 14], pd = objectDescriptors[o + 15];
      if (hasUiPlane && priority === 0 && objectTouchesUi(screenX, screenY, drawW, drawH)) continue;

      const groundX = anchorX - this.width / 2;
      const groundZ = anchorY - this.height / 2;
      const projected = this.cameraProjection(
        groundX, this.terrainGroundHeightAt(groundX, groundZ), groundZ, tilt, zoom,
      );
      const x0 = projected.x + (screenX - anchorX) * projected.scale;
      const x1 = x0 + drawW * projected.scale;
      const y0 = projected.y + (screenY - anchorY) * projected.scale;
      const y1 = y0 + drawH * projected.scale;
      const isActor = spriteId >= 0 && spriteId < objectEventSpriteFlags.length
        && objectEventSpriteFlags[spriteId];
      // Shell-occluded actors move as complete owning groups to the silhouette
      // pass. All other cards retain native per-pixel BG priority behavior.
      const vertices = isActor && shellOccludedGroups[spriteId]
        ? silhouetteVertices : normalVertices;
      const extra = [0, layer, sourceW, sourceH, drawW, drawH, affine, pa, pb, pc, pd,
                     screenX, screenY, oamId, priority, projected.cameraDepth];
      for (const point of [
        [x0,y0,0,0], [x1,y0,drawW,0], [x1,y1,drawW,drawH],
        [x0,y0,0,0], [x1,y1,drawW,drawH], [x0,y1,0,drawH],
      ]) vertex(vertices, point[0], point[1], point[2], point[3], ...extra);
    }

    const data = new Float32Array([...normalVertices, ...silhouetteVertices]);
    if (data.byteLength > this.billboardVertexCapacity) {
      this.billboardVertexBuffer.destroy();
      this.billboardVertexCapacity = 2 ** Math.ceil(Math.log2(data.byteLength));
      this.billboardVertexBuffer = this.device.createBuffer({ label: 'high-resolution billboard quads', size: this.billboardVertexCapacity, usage: GPUBufferUsage.VERTEX | GPUBufferUsage.COPY_DST });
    }
    if (data.byteLength) this.device.queue.writeBuffer(this.billboardVertexBuffer, 0, data);
    return {
      normal: normalVertices.length / BILLBOARD_VERTEX_FLOATS,
      silhouette: silhouetteVertices.length / BILLBOARD_VERTEX_FLOATS,
    };
  }

  writeTexture(texture, pixels, width = this.width, height = this.height, bytesPerPixel = 4) {
    this.device.queue.writeTexture({ texture }, pixels, { bytesPerRow: width * bytesPerPixel, rowsPerImage: height }, { width, height });
  }

  writeObjectSources(pixels, count) {
    if (!count) return;
    const bytes = count * 64 * 64 * 4;
    this.device.queue.writeTexture(
      { texture: this.objectTexture }, pixels.subarray(0, bytes),
      { bytesPerRow: 64 * 4, rowsPerImage: 64 },
      { width: 64, height: 64, depthOrArrayLayers: count },
    );
  }

  present({ finalPixels, worldPixels, worldHeightPixels, worldGroundHeightPixels, worldGeometryPixels, worldGridOffsetX, worldGridOffsetY, worldPixelOriginX, worldPixelOriginY, layerPixels, objectIds, bgPriorities, objectSourcePixels, objectDescriptors, objectEventSpriteFlags, objectSourceCount, objectPixels, objectPriorities, enhanced, shading, perspective, zoom, optics }) {
    const encoder = this.device.createCommandEncoder({ label: 'pokeemerald frame encoder' });
    let presentBindGroup = this.finalBindGroup;
    if (enhanced) {
      this.writeTexture(this.worldTexture, worldPixels, this.worldWidth, this.worldHeight);
      const vertexCount = this.buildTerrain(
        worldHeightPixels, worldGroundHeightPixels, worldGeometryPixels,
        worldGridOffsetX, worldGridOffsetY,
      );
      const billboardVertexCounts = this.buildFrameLayers(
        finalPixels, layerPixels, objectIds, objectPixels, objectPriorities,
        objectDescriptors, objectEventSpriteFlags, objectSourceCount, perspective, zoom,
      );
      const objectFootRows = this.measureObjectFootRows(objectDescriptors, objectSourceCount, objectEventSpriteFlags, objectSourcePixels);
      const castShadowVertexCount = this.buildProjectedShadows(objectDescriptors, objectSourceCount, objectEventSpriteFlags, objectFootRows);
      this.writeObjectSources(objectSourcePixels, objectSourceCount);
      this.writeTexture(this.bgPriorityTexture, bgPriorities, this.worldWidth, this.worldHeight, 1);
      this.writeTexture(this.uiTexture, this.uiPixels);
      const lightTransform = this.createLightTransform(worldPixelOriginX, worldPixelOriginY);
      const cameraValues = new Float32Array(28);
      cameraValues.set([
        perspective, zoom, shading, CAMERA_HEIGHT,
        this.width, this.height, CAMERA_NEAR, CAMERA_FAR,
        worldPixelOriginX, worldPixelOriginY, optics, 0,
      ]);
      cameraValues.set(lightTransform, 12);
      this.device.queue.writeBuffer(this.cameraBuffer, 0, cameraValues);

      const lightTransformUnchanged = this.structuralShadowLightTransform
        && lightTransform.every((value, index) => value === this.structuralShadowLightTransform[index]);
      if (this.structuralShadowTerrainRevision !== this.terrainRevision || !lightTransformUnchanged) {
        const structuralShadowPass = encoder.beginRenderPass({
          label: 'world-anchored structural shadow map pass',
          colorAttachments: [],
          depthStencilAttachment: {
            view: this.structuralShadowTexture.createView(),
            depthClearValue: 1, depthLoadOp: 'clear', depthStoreOp: 'store',
          },
        });
        structuralShadowPass.setPipeline(this.structuralShadowPipeline);
        structuralShadowPass.setBindGroup(0, this.structuralShadowBindGroup);
        structuralShadowPass.setVertexBuffer(0, this.vertexBuffer);
        structuralShadowPass.draw(vertexCount);
        structuralShadowPass.end();
        this.structuralShadowTerrainRevision = this.terrainRevision;
        this.structuralShadowLightTransform = lightTransform;
      }

      const terrainPass = encoder.beginRenderPass({
        label: 'depth-tested projected terrain pass',
        colorAttachments: [
          { view: this.sceneTexture.createView(), clearValue: { r: 0.08, g: 0.15, b: 0.18, a: 1 }, loadOp: 'clear', storeOp: 'store' },
          { view: this.focusDepthTexture.createView(), clearValue: { r: CAMERA_FAR, g: 0, b: 0, a: 0 }, loadOp: 'clear', storeOp: 'store' },
        ],
        depthStencilAttachment: { view: this.depthTexture.createView(), depthClearValue: 1, depthLoadOp: 'clear', depthStoreOp: 'store' },
      });
      terrainPass.setPipeline(this.terrainPipeline); terrainPass.setBindGroup(0, this.terrainBindGroup); terrainPass.setVertexBuffer(0, this.vertexBuffer); terrainPass.draw(vertexCount); terrainPass.end();

      const castShadowPass = encoder.beginRenderPass({
        label: 'unified projected shadow mask pass',
        colorAttachments: [{ view: this.castShadowTexture.createView(), clearValue: { r: 0, g: 0, b: 0, a: 0 }, loadOp: 'clear', storeOp: 'store' }],
      });
      castShadowPass.setPipeline(this.castShadowPipeline); castShadowPass.setBindGroup(0, this.castShadowBindGroup); castShadowPass.setVertexBuffer(0, this.castShadowVertexBuffer); castShadowPass.draw(castShadowVertexCount); castShadowPass.end();

      const castShadowCompositePass = encoder.beginRenderPass({
        label: 'unified projected shadow composite pass',
        colorAttachments: [{ view: this.sceneTexture.createView(), loadOp: 'load', storeOp: 'store' }],
      });
      castShadowCompositePass.setPipeline(this.castShadowCompositePipeline); castShadowCompositePass.setBindGroup(0, this.castShadowCompositeBindGroup); castShadowCompositePass.draw(3); castShadowCompositePass.end();

      if (billboardVertexCounts.silhouette) {
        const actorSilhouettePass = encoder.beginRenderPass({
          label: 'whole-actor building occlusion silhouette pass',
          colorAttachments: [
            { view: this.sceneTexture.createView(), loadOp: 'load', storeOp: 'store' },
            { view: this.focusDepthTexture.createView(), loadOp: 'load', storeOp: 'store' },
          ],
        });
        actorSilhouettePass.setPipeline(this.actorSilhouettePipeline); actorSilhouettePass.setBindGroup(0, this.actorSilhouetteBindGroup); actorSilhouettePass.setVertexBuffer(0, this.billboardVertexBuffer); actorSilhouettePass.draw(billboardVertexCounts.silhouette, 1, billboardVertexCounts.normal); actorSilhouettePass.end();
      }

      const billboardPass = encoder.beginRenderPass({
        label: 'upright billboard pass',
        colorAttachments: [
          { view: this.sceneTexture.createView(), loadOp: 'load', storeOp: 'store' },
          { view: this.focusDepthTexture.createView(), loadOp: 'load', storeOp: 'store' },
        ],
        depthStencilAttachment: { view: this.depthTexture.createView(), depthLoadOp: 'load', depthStoreOp: 'store' },
      });
      billboardPass.setPipeline(this.billboardPipeline); billboardPass.setBindGroup(0, this.billboardBindGroup); billboardPass.setVertexBuffer(0, this.billboardVertexBuffer); billboardPass.draw(billboardVertexCounts.normal); billboardPass.end();

      // Apply shared focus-depth optics to the complete world scene so actors
      // integrate with terrain instead of appearing pasted over the diorama.
      const cinematicPass = encoder.beginRenderPass({
        label: 'cinematic HD-2D scene post-process',
        colorAttachments: [{ view: this.gradedTexture.createView(), clearValue: { r: 0, g: 0, b: 0, a: 1 }, loadOp: 'clear', storeOp: 'store' }],
      });
      cinematicPass.setPipeline(this.cinematicPipeline); cinematicPass.setBindGroup(0, this.cinematicBindGroup); cinematicPass.draw(3); cinematicPass.end();

      const uiPass = encoder.beginRenderPass({ label: 'flat interface pass', colorAttachments: [{ view: this.gradedTexture.createView(), loadOp: 'load', storeOp: 'store' }] });
      uiPass.setPipeline(this.uiPipeline); uiPass.setBindGroup(0, this.uiBindGroup); uiPass.draw(3); uiPass.end();
      presentBindGroup = this.scenePresentBindGroup;
    } else {
      this.writeTexture(this.finalTexture, finalPixels);
    }

    const pass = encoder.beginRenderPass({ colorAttachments: [{ view: this.context.getCurrentTexture().createView(), clearValue: { r: 0, g: 0, b: 0, a: 1 }, loadOp: 'clear', storeOp: 'store' }] });
    pass.setPipeline(this.presentPipeline); pass.setBindGroup(0, presentBindGroup); pass.draw(3); pass.end();
    this.device.queue.submit([encoder.finish()]);
  }

  async ready() { await this.device.queue.onSubmittedWorkDone(); }

  destroy() {
    if (this.disposed) return;
    this.disposed = true;
    this.device.removeEventListener('uncapturederror', this.uncapturedErrorHandler);
    this.context.unconfigure();
    for (const resource of [this.finalTexture,this.worldTexture,this.objectTexture,this.bgPriorityTexture,this.uiTexture,this.sceneTexture,this.castShadowTexture,this.gradedTexture,this.depthTexture,this.focusDepthTexture,this.structuralShadowTexture,this.vertexBuffer,this.billboardVertexBuffer,this.castShadowVertexBuffer,this.cameraBuffer]) resource.destroy();
    this.device.destroy();
  }

  simulateDeviceLoss() {
    if (this.disposed) throw new Error('cannot lose a disposed WebGPU presenter');
    this.device.destroy();
    return this.device.lost;
  }
}

export async function createPresenter({ canvas, width, height, worldWidth, worldHeight, scale, onFailure }) {
  return WebGpuPresenter.create(canvas, width, height, worldWidth, worldHeight, scale, onFailure);
}
