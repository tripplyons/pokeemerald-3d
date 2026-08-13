const HD2D_SURFACE_BITS = 3;
const HD2D_SURFACE_GROUND = 0;
export const HD2D_SURFACE_WATER = 1;
export const HD2D_SURFACE_DECK = 2;
export const HD2D_SURFACE_TERRAIN = 3;
export const HD2D_SURFACE_OBSTACLE = 4;
const HD2D_SURFACE_WALL = 5;
const HD2D_SURFACE_ROOF = 6;
export const HD2D_SURFACE_OPEN_DECK = 7;
export const HD2D_SURFACE_MASK = (1 << HD2D_SURFACE_BITS) - 1;
const HD2D_COMPONENT_SHIFT = HD2D_SURFACE_BITS;
const HD2D_RECEIVER_VALID = 0x8000;
const HD2D_RECEIVER_TERRAIN_FACE = 0x4000;
const HD2D_RECEIVER_TERRAIN_FACE_SOUTH = 0x20;
const HD2D_RECEIVER_TERRAIN_FACE_SELF = 0x40;
const HD2D_RECEIVER_OFFSET_BIAS = 16;
const HD2D_RECEIVER_OFFSET_MASK = 31;
const HD2D_RECEIVER_DX_SHIFT = HD2D_SURFACE_BITS;
const HD2D_RECEIVER_DY_SHIFT = 8;

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
  @location(4) shellAndBase: vec2f,
  @location(5) neutralColor: vec3f,
}
struct VertexOutput {
  @builtin(position) position: vec4f,
  @location(0) uv: vec2f,
  @location(1) normal: vec3f,
  @location(2) @interpolate(flat) material: u32,
  @location(3) shadowPosition: vec3f,
  @location(4) cameraDepth: f32,
  @location(5) @interpolate(flat) neutralColor: vec3f,
  @location(6) worldPosition: vec3f,
  @location(7) @interpolate(flat) structureBase: f32,
}
@group(0) @binding(0) var worldTexture: texture_2d<f32>;
@group(0) @binding(1) var pixelSampler: sampler;
@group(0) @binding(2) var<uniform> camera: Camera;
@group(0) @binding(3) var structuralShadowMap: texture_depth_2d;
@group(0) @binding(4) var structuralShadowSampler: sampler_comparison;
@group(0) @binding(5) var structuralAlphaTexture: texture_2d<f32>;

@vertex
fn vertexMain(input: VertexInput) -> VertexOutput {
  let angle = radians(45.384615 * camera.values.x);
  let sine = sin(angle);
  let cosine = cos(angle);
  let cameraHeight = camera.values.w;
  let zoom = camera.values.y;
  let zoomOut = 0.30 * zoom + 0.76923077 * zoom * zoom * (zoom - 0.35);
  let focal = cameraHeight / (1.0 + zoomOut);
  // Roofs, facades, and terrain must share one camera. Keeping facades aligned
  // in screen space creates a second projection and a visible seam at roofs.
  let viewY = input.position.y * sine - input.position.z * cosine;
  let depth = cameraHeight - input.position.y * cosine - input.position.z * sine;
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
  output.neutralColor = input.neutralColor;
  output.worldPosition = input.position;
  output.structureBase = input.shellAndBase.y;
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
const SURFACE_GROUND = 0u;
const SURFACE_WATER = 1u;
const SURFACE_ROOF = 6u;
const MATERIAL_NEUTRAL_BUILDING = 8u;

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
  @builtin(frag_depth) depth: f32,
}

@fragment
fn fragmentMain(input: VertexOutput) -> FragmentOutput {
  var base: vec3f;
  if (input.material == MATERIAL_NEUTRAL_BUILDING) {
    // Unauthored closure geometry uses a component-derived material. Do not
    // sample arbitrary atlas pixels that can contain paths, doors, or logos.
    base = input.neutralColor;
    let course = max(0.0, (input.worldPosition.y - input.structureBase) / 8.0);
    let seam = 1.0 - smoothstep(0.025, 0.095, fract(course));
    let tone = select(0.99, 1.01, fract(floor(course) * 0.5) >= 0.5);
    base *= tone * (1.0 - seam * 0.07);
  } else {
    let world = textureSampleLevel(worldTexture, pixelSampler, input.uv, 0.0);
    let structuralAlpha = textureSampleLevel(structuralAlphaTexture, pixelSampler, input.uv, 0.0).r;
    if (input.material == SURFACE_ROOF && structuralAlpha < 0.5) {
      discard;
    }
    if (input.material == 5u && structuralAlpha < 0.5) {
      discard;
    } else {
      base = world.rgb;
    }
  }
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
  // Flat receiver art uses the billboard shader's exact per-pixel BG
  // priority mask for foreground details such as flags. Keeping the opaque
  // receiver at its projected depth would also hide actors behind the nearby
  // ground-colored pixels that surround those details.
  output.depth = select(input.position.z, 0.99999, input.material == SURFACE_GROUND);
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
  @location(1) uv: vec2f,
  @location(3) material: f32,
}
struct VertexOutput {
  @builtin(position) position: vec4f,
  @location(0) uv: vec2f,
  @location(1) @interpolate(flat) material: u32,
}
@group(0) @binding(0) var<uniform> camera: Camera;
@group(0) @binding(1) var structuralAlphaTexture: texture_2d<f32>;

@vertex
fn vertexMain(input: VertexInput) -> VertexOutput {
  var output: VertexOutput;
  output.position = camera.lightTransform * vec4f(input.position, 1.0);
  output.uv = input.uv;
  output.material = u32(input.material);
  return output;
}

@fragment
fn fragmentMain(input: VertexOutput) {
  if (input.material == 6u) {
    let size = vec2i(textureDimensions(structuralAlphaTexture));
    let pixel = clamp(vec2i(input.uv * vec2f(size)), vec2i(0), size - 1);
    if (textureLoad(structuralAlphaTexture, pixel, 0).r < 0.5) { discard; }
  }
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
  @location(8) maskAtlas: vec2f,
  @location(9) objectInfo: vec2f,
  @location(10) cameraDepth: f32,
  @location(11) screenOrigin: vec2f,
}
struct VertexOutput {
  @builtin(position) position: vec4f,
  @location(0) uv: vec2f,
  @location(1) @interpolate(flat) layer: u32,
  @location(2) @interpolate(flat) sourceSize: vec2u,
  @location(3) @interpolate(flat) drawSize: vec2u,
  @location(4) @interpolate(flat) affine: u32,
  @location(5) @interpolate(flat) matrix: vec4i,
  @location(6) maskAtlas: vec2f,
  @location(7) @interpolate(flat) objectInfo: vec2u,
  @location(8) @interpolate(flat) cameraDepth: f32,
  @location(9) @interpolate(flat) screenOrigin: vec2i,
}
@group(0) @binding(0) var objectTexture: texture_2d_array<f32>;
@group(0) @binding(1) var bgPriorityTexture: texture_2d<u32>;
@group(0) @binding(2) var structuralAlphaTexture: texture_2d<f32>;

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
  output.maskAtlas = input.maskAtlas;
  output.objectInfo = vec2u(input.objectInfo);
  output.cameraDepth = input.cameraDepth;
  output.screenOrigin = vec2i(input.screenOrigin);
  return output;
}

struct FragmentOutput {
  @location(0) color: vec4f,
  @location(1) focusDepth: f32,
  @builtin(frag_depth) depth: f32,
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
  // Elevated structural art (roofs, gate spans) is extruded, so it keeps the
  // exact flat GBA-space overlap mask. Flat receiver details (flags) render
  // foreshortened on the ground plane, so their mask uses the CPU-inverted
  // ground-plane projection: the receiver pixel actually rendered at this
  // screen location. Mixing them up either bares actors under gate roofs or
  // occludes actors above a flag's drawn art.
  let prioritySize = vec2i(textureDimensions(bgPriorityTexture));
  let flatAtlas = input.screenOrigin + vec2i(floor(input.uv))
    + (prioritySize - vec2i(240, 160)) / 2;
  let flatIn = all(flatAtlas >= vec2i(0)) && all(flatAtlas < prioritySize);
  let structural = flatIn
    && textureLoad(structuralAlphaTexture, flatAtlas, 0).r >= 0.5;
  let atlas = select(vec2i(floor(input.maskAtlas)), flatAtlas, structural);
  let inAtlas = all(atlas >= vec2i(0)) && all(atlas < prioritySize);
  var occluded = false;
  if (inAtlas) {
    let bgPriority = textureLoad(bgPriorityTexture, atlas, 0).r;
    if (bgPriority == 255u) { discard; }
    occluded = bgPriority < input.objectInfo.y;
  }

  let color = objectColor(input);
  if (color.a <= 0.0) { discard; }
  if (occluded) { discard; }
  var output: FragmentOutput;
  output.color = color;
  output.focusDepth = input.cameraDepth;
  output.depth = input.position.z;
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
const VERTEX_FLOATS = 14;
const BILLBOARD_VERTEX_FLOATS = 22;
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
    this.structuralAlphaTexture = this.createTexture('authored structural alpha', 'r8unorm', GPUTextureUsage.TEXTURE_BINDING | GPUTextureUsage.COPY_DST, worldWidth, worldHeight);
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
    this.tileReceivers = new Uint16Array(terrainTileCapacity);
    this.tileFacades = new Uint32Array(terrainTileCapacity);
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
          { shaderLocation: 5, offset: 44, format: 'float32x3' },
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
        { binding: 5, resource: this.structuralAlphaTexture.createView() },
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
          { shaderLocation: 1, offset: 12, format: 'float32x2' },
          { shaderLocation: 3, offset: 32, format: 'float32' },
        ] }],
      },
      fragment: { module: structuralShadowModule, entryPoint: 'fragmentMain', targets: [] },
      primitive: { topology: 'triangle-list', cullMode: 'none' },
      depthStencil: { format: 'depth32float', depthWriteEnabled: true, depthCompare: 'less' },
    });
    this.structuralShadowBindGroup = device.createBindGroup({
      layout: this.structuralShadowPipeline.getBindGroupLayout(0),
      entries: [
        { binding: 0, resource: { buffer: this.cameraBuffer } },
        { binding: 1, resource: this.structuralAlphaTexture.createView() },
      ],
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
      // A projected silhouette lands on its receiver plane. Testing against the
      // structural depth buffer keeps silhouettes whose ground landing point is
      // hidden behind extruded geometry from printing onto roofs and facades.
      depthStencil: { format: 'depth24plus', depthWriteEnabled: false, depthCompare: 'less-equal' },
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
        { shaderLocation: 11, offset: 80, format: 'float32x2' },
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
        { binding: 2, resource: this.structuralAlphaTexture.createView() },
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

  buildTerrain(worldHeights, worldGroundHeights, worldGeometry, worldReceivers, worldFacades, worldPixels,
               worldStructuralAlphaPixels,
               gridOffsetX, gridOffsetY) {
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
    const receivers = this.tileReceivers;
    const facades = this.tileFacades;
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
        const receiverWord = worldReceivers[source];
        const facadeWord = worldFacades[source];
        if (unchanged && (heights[tile] !== height
            || groundHeights[tile] !== groundHeight || geometry[tile] !== geometryWord
            || receivers[tile] !== receiverWord || facades[tile] !== facadeWord))
          unchanged = false;
        heights[tile] = height;
        groundHeights[tile] = groundHeight;
        geometry[tile] = geometryWord;
        receivers[tile] = receiverWord;
        facades[tile] = facadeWord;
        signature = Math.imul(signature ^ (height & 0xff), 16777619);
        signature = Math.imul(signature ^ (groundHeight & 0xff), 16777619);
        signature = Math.imul(signature ^ geometryWord, 16777619);
        signature = Math.imul(signature ^ receiverWord, 16777619);
        signature = Math.imul(signature ^ facadeWord, 16777619);
      }
    }
    signature >>>= 0;
    // Exact sampled-value comparisons make hash collisions harmless. Reusing
    // this mesh also preserves the matching component/facade bounds.
    if (unchanged && signature === this.terrainSignature) return this.terrainVertexCount;

    const vertices = [];
    const pushVertex = (x, y, z, u, v, normal, material, shell, base, neutralColor) =>
      vertices.push(x, y, z, u, v, ...normal, material, shell, base, ...neutralColor);
    const quad = (a, b, c, d, normal, material, shell = 0, base = 0,
                  neutralColor = [0, 0, 0]) => {
      for (const point of [a, b, c, a, c, d])
        pushVertex(point[0], point[1], point[2], point[3], point[4], normal,
                   material, shell, base, neutralColor);
    };
    const halfW = this.worldWidth / 2;
    const halfH = this.worldHeight / 2;
    const inGrid = (x, y) => x >= 0 && y >= 0 && x < cols && y < rows;
    const heightAt = (x, y) => inGrid(x, y) ? heights[y * cols + x] : 0;
    const geometryAt = (x, y) => inGrid(x, y) ? geometry[y * cols + x] : 0;
    const receiverAt = (x, y) => inGrid(x, y) ? receivers[y * cols + x] : 0;
    const facadeAt = (x, y) => inGrid(x, y) ? facades[y * cols + x] : 0;
    const surfaceAt = (x, y) => geometryAt(x, y) & HD2D_SURFACE_MASK;
    const componentAt = (x, y) => geometryAt(x, y) >> HD2D_COMPONENT_SHIFT;
    const worldX = (x) => originX + x * TILE_SIZE - halfW;
    const worldZ = (y) => originY + y * TILE_SIZE - halfH;
    const textureU = (x) => Math.max(0, Math.min(this.worldWidth, originX + x * TILE_SIZE)) / this.worldWidth;
    const textureV = (y) => Math.max(0, Math.min(this.worldHeight, originY + y * TILE_SIZE)) / this.worldHeight;
    const pixelU = (pixel) => (Math.max(0, Math.min(this.worldWidth - 1, pixel)) + 0.5) / this.worldWidth;
    const pixelV = (pixel) => (Math.max(0, Math.min(this.worldHeight - 1, pixel)) + 0.5) / this.worldHeight;
    const MATERIAL_NEUTRAL_BUILDING = 8;
    const openDeckReceiver = (tx, ty) => {
      const word = receiverAt(tx, ty);
      if ((word & HD2D_RECEIVER_VALID) === 0) return null;
      const sourceX = tx + (((word >> HD2D_RECEIVER_DX_SHIFT) & HD2D_RECEIVER_OFFSET_MASK) - HD2D_RECEIVER_OFFSET_BIAS);
      const sourceY = ty + (((word >> HD2D_RECEIVER_DY_SHIFT) & HD2D_RECEIVER_OFFSET_MASK) - HD2D_RECEIVER_OFFSET_BIAS);
      if (!inGrid(sourceX, sourceY)) return null;
      return [sourceX, sourceY, heightAt(sourceX, sourceY), word & HD2D_SURFACE_MASK];
    };

    // A vertical face is an extrusion of the authored lower surface beside an
    // edge, not a repetition of the elevated top tile. Each physical course
    // consumes the next map tile in the exposed direction. This keeps a cliff
    // or shell perimeter tied to the same source material that is visible at
    // its foot, while retaining one nearest-sampled source tile per 8-unit
    // course. Ordinary terrain follows that source contract; unauthored
    // building closure instead carries a filtered component color and never
    // samples these atlas coordinates.
    const verticalSide = (tx, ty, bottom, height, sourceX, sourceY, dx, dy,
                          normal, material, shell = 0, base = 0,
                          neutralColor = [0, 0, 0]) => {
      if (bottom >= height) return;
      for (let courseBottom = bottom; courseBottom < height; courseBottom += TILE_SIZE) {
        const courseTop = Math.min(height, courseBottom + TILE_SIZE);
        const course = Math.floor((courseBottom - bottom) / TILE_SIZE);
        let courseSourceX = Math.max(0, Math.min(cols - 1, sourceX + dx * (course + 1)));
        let courseSourceY = Math.max(0, Math.min(rows - 1, sourceY + dy * (course + 1)));
        if (surfaceAt(courseSourceX, courseSourceY) === HD2D_SURFACE_WATER) {
          courseSourceX = sourceX;
          courseSourceY = sourceY;
        }
        const u0 = pixelU(originX + courseSourceX * TILE_SIZE);
        const u1 = pixelU(originX + courseSourceX * TILE_SIZE + TILE_SIZE - 1);
        const v0 = pixelV(originY + courseSourceY * TILE_SIZE);
        const v1 = pixelV(originY + courseSourceY * TILE_SIZE + TILE_SIZE - 1);
        if (dy < 0) {
          const z = worldZ(ty);
          quad([worldX(tx + 1),courseBottom,z,u1,v1],
               [worldX(tx),courseBottom,z,u0,v1],
               [worldX(tx),courseTop,z,u0,v0],
               [worldX(tx + 1),courseTop,z,u1,v0],
               normal, material, shell, base, neutralColor);
        } else if (dy > 0) {
          const z = worldZ(ty + 1);
          quad([worldX(tx),courseBottom,z,u0,v0],
               [worldX(tx + 1),courseBottom,z,u1,v0],
               [worldX(tx + 1),courseTop,z,u1,v1],
               [worldX(tx),courseTop,z,u0,v1],
               normal, material, shell, base, neutralColor);
        } else if (dx < 0) {
          const x = worldX(tx);
          quad([x,courseBottom,worldZ(ty),u1,v0],
               [x,courseBottom,worldZ(ty + 1),u1,v1],
               [x,courseTop,worldZ(ty + 1),u0,v1],
               [x,courseTop,worldZ(ty),u0,v0],
               normal, material, shell, base, neutralColor);
        } else {
          const x = worldX(tx + 1);
          quad([x,courseBottom,worldZ(ty + 1),u0,v1],
               [x,courseBottom,worldZ(ty),u0,v0],
               [x,courseTop,worldZ(ty),u1,v0],
               [x,courseTop,worldZ(ty + 1),u1,v1],
               normal, material, shell, base, neutralColor);
        }
      }
    };

    // Semantic terrain caps own height. Without an unambiguous face contract,
    // exposed edges use a continuous cap-edge skirt; neighboring map courses
    // may be buildings, signs, or decorative ground and must not be sampled.
    const terrainSide = (tx, ty, bottom, height, dx, dy, normal, material) => {
      if (bottom >= height) return;
      let faceSourceY = ty;
      let faceWord = receiverAt(tx, ty);
      if (material === HD2D_SURFACE_TERRAIN && dy > 0
          && !(faceWord & HD2D_RECEIVER_TERRAIN_FACE)) {
        while (faceSourceY > 0 && surfaceAt(tx, faceSourceY - 1) === material
            && heightAt(tx, faceSourceY - 1) === height) {
          faceSourceY--;
          faceWord = receiverAt(tx, faceSourceY);
          if (faceWord & HD2D_RECEIVER_TERRAIN_FACE) break;
        }
      }
      const faceDepth = material === HD2D_SURFACE_TERRAIN && dy > 0
        && (faceWord & HD2D_RECEIVER_TERRAIN_FACE)
          ? faceWord & HD2D_RECEIVER_OFFSET_MASK : 0;
      const physicalCourses = Math.ceil((height - bottom) / TILE_SIZE);
      for (let courseTop = height, course = 0; courseTop > bottom;
           courseTop -= TILE_SIZE, course++) {
        const courseBottom = Math.max(bottom, courseTop - TILE_SIZE);
        let u0, u1, v0, v1;
        if (faceDepth && course < faceDepth) {
          const sourceY = faceWord & HD2D_RECEIVER_TERRAIN_FACE_SELF
            ? faceSourceY - faceDepth + 1 + course
            : faceWord & HD2D_RECEIVER_TERRAIN_FACE_SOUTH
              ? faceSourceY + 1 + course
              : faceSourceY - Math.min(faceDepth, physicalCourses) + course;
          if (sourceY < 0 || sourceY >= rows
              || surfaceAt(tx, sourceY) === HD2D_SURFACE_WATER) {
            u0 = textureU(tx); u1 = textureU(tx + 1);
            v0 = textureV(ty); v1 = textureV(ty + 1);
          } else {
            u0 = textureU(tx); u1 = textureU(tx + 1);
            v0 = textureV(sourceY); v1 = textureV(sourceY + 1);
          }
        } else {
          u0 = textureU(tx); u1 = textureU(tx + 1);
          v0 = textureV(ty); v1 = textureV(ty + 1);
        }
        if (dy < 0) {
          const z = worldZ(ty);
          quad([worldX(tx + 1),courseBottom,z,u1,v1],
               [worldX(tx),courseBottom,z,u0,v1],
               [worldX(tx),courseTop,z,u0,v0],
               [worldX(tx + 1),courseTop,z,u1,v0], normal, material);
        } else if (dy > 0) {
          const z = worldZ(ty + 1);
          quad([worldX(tx),courseBottom,z,u0,v1],
               [worldX(tx + 1),courseBottom,z,u1,v1],
               [worldX(tx + 1),courseTop,z,u1,v0],
               [worldX(tx),courseTop,z,u0,v0], normal, material);
        } else if (dx < 0) {
          const x = worldX(tx);
          quad([x,courseBottom,worldZ(ty),u0,v1],
               [x,courseBottom,worldZ(ty + 1),u1,v1],
               [x,courseTop,worldZ(ty + 1),u1,v0],
               [x,courseTop,worldZ(ty),u0,v0], normal, material);
        } else {
          const x = worldX(tx + 1);
          quad([x,courseBottom,worldZ(ty + 1),u0,v1],
               [x,courseBottom,worldZ(ty),u1,v1],
               [x,courseTop,worldZ(ty),u1,v0],
               [x,courseTop,worldZ(ty + 1),u0,v0], normal, material);
        }
      }
    };

    // Merge source-aligned horizontal courses. Roofs merge only when C says
    // they have the same frame-local owner; facade source is never a floor.
    // Wall source rows are removed from the floor, and roof pixels use an
    // authored alpha mask. Put the real receiver beneath EVERY structural
    // tile — merged roof rectangles must not skip theirs, or discarded
    // facade pixels over the footprint reveal the scene clear color as
    // black speckle instead of the ground below the building.
    for (let ty = 0; ty < rows; ty++) {
      for (let tx = 0; tx < cols; tx++) {
        if (surfaceAt(tx, ty) !== HD2D_SURFACE_WALL
            && surfaceAt(tx, ty) !== HD2D_SURFACE_ROOF) continue;
        let sourceY = ty + 1;
        while (sourceY < rows
            && (surfaceAt(tx, sourceY) === HD2D_SURFACE_WALL
             || surfaceAt(tx, sourceY) === HD2D_SURFACE_ROOF)
            && (surfaceAt(tx, sourceY) !== HD2D_SURFACE_WALL
             || componentAt(tx, sourceY) === componentAt(tx, ty))) sourceY++;
        sourceY = Math.min(rows - 1, sourceY);
        const ground = groundHeights[ty * cols + tx];
        quad(
          [worldX(tx),ground,worldZ(ty),textureU(tx),textureV(sourceY)],
          [worldX(tx + 1),ground,worldZ(ty),textureU(tx + 1),textureV(sourceY)],
          [worldX(tx + 1),ground,worldZ(ty + 1),textureU(tx + 1),textureV(sourceY + 1)],
          [worldX(tx),ground,worldZ(ty + 1),textureU(tx),textureV(sourceY + 1)],
          [0, 1, 0], surfaceAt(tx, sourceY),
        );
      }
    }

    // Component membership is decoded, never inferred. Every wall source
    // course maps to one physical course on the component's shared front
    // plane. The source mask may be stepped, but it never creates another
    // physical facade plane.
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
          };
          components.set(id, component);
        }
        component.base = Math.min(component.base, groundHeights[ty * cols + tx]);
        if (surfaceAt(tx, ty) === HD2D_SURFACE_ROOF) {
          component.roofHeight = Math.max(component.roofHeight, heightAt(tx, ty));
          component.roofCells.push([tx, ty]);
        } else if (surfaceAt(tx, ty) === HD2D_SURFACE_WALL) {
          component.wallCells.push([tx, ty]);
        }
      }
    }

    // A roofed component's slab slides south by the depth of its wall
    // source rows so the single authored roof meets the facade at the
    // walkable front line — no repeated or synthesized courses. The box is
    // correspondingly shallower at its back: the vacated rows show the
    // ground receiver and sit mostly hidden behind the slab at play tilts.
    for (const component of components.values()) {
      component.frontShift = 0;
      if (!Number.isFinite(component.roofHeight)) continue;
      const groups = new Map();
      for (const [tx, ty] of component.wallCells) {
        const word = facadeAt(tx, ty);
        const id = word & 0xffff;
        if (!id) continue;
        let group = groups.get(id);
        if (!group) {
          group = { maxTy: ty, topByColumn: new Map() };
          groups.set(id, group);
        }
        group.maxTy = Math.max(group.maxTy, ty);
        const topTy = group.topByColumn.get(tx);
        if (topTy === undefined || ty < topTy) group.topByColumn.set(tx, ty);
      }
      for (const group of groups.values()) {
        for (const topTy of group.topByColumn.values())
          component.frontShift = Math.max(component.frontShift,
                                          group.maxTy + 1 - topTy);
      }
    }
    const roofShiftAt = (x, y) => {
      const component = components.get(componentAt(x, y));
      return component ? component.frontShift : 0;
    };

    const visited = new Uint8Array(cols * rows);
    for (let ty = 0; ty < rows; ty++) {
      for (let tx = 0; tx < cols; tx++) {
        const start = ty * cols + tx;
        if (visited[start]) continue;
        visited[start] = 1;
        if (surfaceAt(tx, ty) === HD2D_SURFACE_WALL) continue;

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
        const shell = surfaceAt(tx, ty) === HD2D_SURFACE_ROOF && componentAt(tx, ty) !== 0;
        if (surfaceAt(tx, ty) === HD2D_SURFACE_OPEN_DECK) {
          for (let y = 0; y < depth; y++) {
            for (let x = 0; x < width; x++) {
              const source = openDeckReceiver(tx + x, ty + y);
              if (!source) continue;
              const [sourceX, sourceY, receiverHeight, receiverSurface] = source;
              quad(
                [worldX(tx + x), receiverHeight, worldZ(ty + y), textureU(sourceX), textureV(sourceY)],
                [worldX(tx + x + 1), receiverHeight, worldZ(ty + y), textureU(sourceX + 1), textureV(sourceY)],
                [worldX(tx + x + 1), receiverHeight, worldZ(ty + y + 1), textureU(sourceX + 1), textureV(sourceY + 1)],
                [worldX(tx + x), receiverHeight, worldZ(ty + y + 1), textureU(sourceX), textureV(sourceY + 1)],
                [0, 1, 0], receiverSurface,
              );
            }
          }
        }
        let topV0 = textureV(ty);
        let topV1 = textureV(ty + depth);
        // Cliff sheets keep their authored face rows on the vertical drop.
        // Sampling those same rows across the plateau top reprints the wall
        // as horizontal stripes.
        if (surfaceAt(tx, ty) === HD2D_SURFACE_TERRAIN) {
          let capY = ty;
          while (capY > 0 && surfaceAt(tx, capY - 1) === HD2D_SURFACE_TERRAIN
              && heightAt(tx, capY - 1) === height) capY--;
          topV0 = textureV(capY);
          topV1 = textureV(capY + 1);
        }
        const roofShift = shell ? roofShiftAt(tx, ty) : 0;
        quad(
          [worldX(tx), height, worldZ(ty + roofShift), textureU(tx), topV0],
          [worldX(tx + width), height, worldZ(ty + roofShift), textureU(tx + width), topV0],
          [worldX(tx + width), height, worldZ(ty + depth + roofShift), textureU(tx + width), topV1],
          [worldX(tx), height, worldZ(ty + depth + roofShift), textureU(tx), topV1],
          [0, 1, 0], surfaceAt(tx, ty), shell ? 1 : 0, shell ? groundHeights[start] : 0,
        );
      }
    }

    const sameRoof = (x, y, id) => inGrid(x, y)
      && surfaceAt(x, y) === HD2D_SURFACE_ROOF && componentAt(x, y) === id;

    // Build structural colors from pixels recurring across the component's
    // authored tiles. One-off markings cannot enter generated treatment merely
    // by occupying many pixels in a door, logo, or sign tile.
    const recurringColorBuckets = (cells) => {
      const buckets = new Map();
      for (let cellIndex = 0; cellIndex < cells.length; cellIndex++) {
        const [tx, ty] = cells[cellIndex];
        const seenInCell = new Set();
        const x0 = Math.max(0, Math.min(this.worldWidth - 1, originX + tx * TILE_SIZE));
        const y0 = Math.max(0, Math.min(this.worldHeight - 1, originY + ty * TILE_SIZE));
        const x1 = Math.min(this.worldWidth, x0 + TILE_SIZE);
        const y1 = Math.min(this.worldHeight, y0 + TILE_SIZE);
        for (let py = y0; py < y1; py++) {
          for (let px = x0; px < x1; px++) {
            const offset = (py * this.worldWidth + px) * 4;
            if (worldPixels[offset + 3] < 128) continue;
            if (surfaceAt(tx, ty) === HD2D_SURFACE_WALL
                && worldStructuralAlphaPixels[py * this.worldWidth + px] < 128) continue;
            const red = worldPixels[offset];
            const green = worldPixels[offset + 1];
            const blue = worldPixels[offset + 2];
            const key = (red >> 4) << 8 | (green >> 4) << 4 | (blue >> 4);
            let bucket = buckets.get(key);
            if (!bucket) {
              bucket = { count: 0, cells: 0, red: 0, green: 0, blue: 0 };
              buckets.set(key, bucket);
            }
            if (!seenInCell.has(key)) {
              seenInCell.add(key);
              bucket.cells++;
            }
            bucket.count++;
            bucket.red += red;
            bucket.green += green;
            bucket.blue += blue;
          }
        }
      }
      const minimumCells = Math.max(1, Math.ceil(cells.length * 0.55));
      return Array.from(buckets.values())
        .filter((bucket) => bucket.cells >= minimumCells)
        .map((bucket) => {
          const red = bucket.red / bucket.count;
          const green = bucket.green / bucket.count;
          const blue = bucket.blue / bucket.count;
          const maximum = Math.max(red, green, blue);
          const minimum = Math.min(red, green, blue);
          const luminance = red * 0.2126 + green * 0.7152 + blue * 0.0722;
          return {
            ...bucket,
            red,
            green,
            blue,
            luminance,
            chroma: maximum - minimum,
            saturation: maximum > 0 ? (maximum - minimum) / maximum : 0,
          };
        });
    };
    const bucketColor = (bucket) => [bucket.red / 255, bucket.green / 255, bucket.blue / 255];
    const mixColor = (a, b, amount) => a.map((channel, index) => channel * (1 - amount) + b[index] * amount);
    const colorLuminance = (color) => color[0] * 0.2126 + color[1] * 0.7152 + color[2] * 0.0722;
    const liftColorToLuminance = (color, floor) => {
      const luminance = colorLuminance(color);
      if (luminance >= floor || luminance <= 0) return color;
      const scale = floor / luminance;
      return color.map((channel) => Math.min(1, channel * scale));
    };
    const selectRoofColor = (cells, fallback) => {
      const candidates = recurringColorBuckets(cells)
        .filter((bucket) => bucket.count >= 8)
        .sort((a, b) => {
          const scoreA = a.chroma * Math.min(1.25, Math.max(0.35, a.luminance / 112))
            + a.saturation * 24 + Math.log2(a.count + 1) * 3;
          const scoreB = b.chroma * Math.min(1.25, Math.max(0.35, b.luminance / 112))
            + b.saturation * 24 + Math.log2(b.count + 1) * 3;
          return scoreB - scoreA || b.count - a.count || b.cells - a.cells;
        });
      if (!candidates.length) return fallback;
      return liftColorToLuminance(bucketColor(candidates[0]), 0.32);
    };
    const selectSideColor = (cells, roofColor, fallback) => {
      const candidates = recurringColorBuckets(cells)
        // Black outlines and transparent-underlay artifacts recur across many
        // facade courses, but they are edge ink, not the building material.
        // Generated closure sides should follow the recurring body color and
        // roof tint instead of expanding those dark pixels into full slabs.
        .filter((bucket) => bucket.luminance >= 58 || bucket.saturation >= 0.28)
        .sort((a, b) => {
          const scoreA = a.count + a.cells * 18 - Math.abs(a.luminance - 128) * 2
            + a.saturation * 16;
          const scoreB = b.count + b.cells * 18 - Math.abs(b.luminance - 128) * 2
            + b.saturation * 16;
          return scoreB - scoreA;
        });
      if (!candidates.length) return fallback;
      const selected = candidates[0];
      let color = bucketColor(selected);
      color = mixColor(color, roofColor, selected.luminance < 82 ? 0.22 : 0.12);
      return liftColorToLuminance(color, 0.38);
    };
    // 2D facade holes are missing wall surface, not generated sides. Fill them
    // with the wall's most common non-dark field color; do not prefer the
    // mid-tone / roof-tinted closure mix.
    const selectWallBodyColor = (cells, fallback) => {
      const candidates = recurringColorBuckets(cells)
        .filter((bucket) => bucket.luminance >= 90)
        .sort((a, b) => b.count - a.count || b.cells - a.cells);
      if (!candidates.length) return fallback;
      return bucketColor(candidates[0]);
    };
    for (const component of components.values()) {
      const wallCells = component.wallCells.map(([tx, ty]) => [tx, ty]);
      const roofColor = selectRoofColor(component.roofCells, [0.45, 0.45, 0.48]);
      component.sideMaterial = selectSideColor(wallCells, roofColor, roofColor);
      component.wallBody = selectWallBodyColor(wallCells, component.sideMaterial);
    }
    for (const component of components.values()) {
      const groups = new Map();
      for (const [tx, ty] of component.wallCells) {
        // C preserves the facade candidate that authored this course. A
        // component can contain several candidates after roof unioning, and
        // transparent art can disconnect one candidate's source cells, so
        // browser-side connectivity cannot recover the physical wall plane.
        const word = facadeAt(tx, ty);
        const id = word & 0xffff;
        const offset = word >>> 16;
        if (!id) continue;
        let group = groups.get(id);
        if (!group) {
          group = { anchorY: ty - offset, cells: [] };
          groups.set(id, group);
        }
        group.cells.push([tx, ty, offset]);
      }
      let top = component.roofHeight;
      if (!Number.isFinite(top)) top = component.base + TILE_SIZE;
      const side = component.wallBody || component.sideMaterial || [0, 0, 0];
      for (const group of groups.values()) {
        const maxOffset = Math.max(...group.cells.map(([, , offset]) => offset));
        if (!Number.isFinite(component.roofHeight))
          top = Math.max(top, component.base + (maxOffset + 1) * TILE_SIZE);
        // The wall art's base line is the south edge of the group's bottom
        // source row — where the 2D building meets walkable ground. For a
        // roofed box the physical plane stands there; anchoring it at the
        // top course's north edge instead recesses the front by the whole
        // wall footprint depth. Unroofed sheets (fronts embedded in flat
        // obstacle art like Fortree tree houses) stay at their anchor so
        // they remain attached to the authored art around them.
        const roofed = Number.isFinite(component.roofHeight);
        const frontTy = roofed
          ? Math.max(...group.cells.map(([, ty]) => ty)) + 1
          : group.anchorY;
        const z = worldZ(frontTy);
        for (const [tx, ty, offset] of group.cells) {
          const courseTop = top - offset * TILE_SIZE;
          const courseBottom = courseTop - TILE_SIZE;
          quad(
            [worldX(tx),courseBottom,z,textureU(tx),textureV(ty + 1)],
            [worldX(tx + 1),courseBottom,z,textureU(tx + 1),textureV(ty + 1)],
            [worldX(tx + 1),courseTop,z,textureU(tx + 1),textureV(ty)],
            [worldX(tx),courseTop,z,textureU(tx),textureV(ty)],
            [0, 0, 1], HD2D_SURFACE_WALL, 1, component.base, side,
          );
        }
      }
      component.roofHeight = Math.max(component.roofHeight, top);
    }

    // Only authored roof cells render horizontally. Copying a roof-edge tile
    // behind every facade rectangle duplicates logos and stretches one strip
    // across stepped or gapped landmark silhouettes.
    for (const component of components.values()) {
      // Close only exposed building perimeter with the same component-derived
      // side treatment. Wall source rows are vertical art, not horizontal
      // footprint, so they must never generate a second closure skin.
      // Closure faces follow the slab's shifted footprint, while interior
      // edges are still decided by source adjacency — the shift is rigid,
      // so roof-roof seams stay interior and the south edge lands on the
      // facade plane wherever wall source sits below.
      const shift = component.frontShift || 0;
      for (const [tx, ty] of component.roofCells) {
        const height = heightAt(tx, ty);
        for (const dx of [-1, 1]) {
          if (sameRoof(tx + dx, ty, component.id)) continue;
          if (inGrid(tx + dx, ty) && surfaceAt(tx + dx, ty) === HD2D_SURFACE_WALL
              && componentAt(tx + dx, ty) === component.id) continue;
          const bottom = Math.max(component.base, heightAt(tx + dx, ty + shift));
          if (bottom >= height) continue;
          verticalSide(tx, ty + shift, bottom, height, tx, ty, dx, 0,
                       [dx < 0 ? -1 : 1, 0, 0], MATERIAL_NEUTRAL_BUILDING,
                       1, component.base, component.sideMaterial);
        }
        for (const dy of [-1, 1]) {
          if (sameRoof(tx, ty + dy, component.id)) continue;
          if (inGrid(tx, ty + dy) && componentAt(tx, ty + dy) === component.id
              && surfaceAt(tx, ty + dy) === HD2D_SURFACE_WALL) continue;
          const bottom = Math.max(component.base, heightAt(tx, ty + dy + shift));
          if (bottom >= height) continue;
          verticalSide(tx, ty + shift, bottom, height, tx, ty, 0, dy,
                       [0, 0, dy < 0 ? -1 : 1], MATERIAL_NEUTRAL_BUILDING,
                       1, component.base, component.sideMaterial);
        }
      }
    }

    // Preserve atlas-edge extrusion for solid non-building materials. Open
    // bridge decks use the lower receiver generated above, not a vertical
    // curtain sampled from water or bridge pixels.
    const ordinaryEdge = (tx, ty, dx, dy) => {
      const surface = surfaceAt(tx, ty);
      const height = heightAt(tx, ty);
      const bottom = heightAt(tx + dx, ty + dy);
      return surface !== HD2D_SURFACE_ROOF && surface !== HD2D_SURFACE_WALL
        && surface !== HD2D_SURFACE_OPEN_DECK && bottom < height
        ? { height, bottom } : null;
    };
    for (const dy of [-1, 1]) {
      for (let ty = 0; ty < rows; ty++) {
        for (let tx = 0; tx < cols; tx++) {
          const edge = ordinaryEdge(tx, ty, 0, dy);
          if (!edge) continue;
          terrainSide(tx, ty, edge.bottom, edge.height, 0, dy,
                      [0, 0, dy < 0 ? -1 : 1], surfaceAt(tx, ty));
        }
      }
    }
    for (const dx of [-1, 1]) {
      for (let tx = 0; tx < cols; tx++) {
        for (let ty = 0; ty < rows; ty++) {
          const edge = ordinaryEdge(tx, ty, dx, 0);
          if (!edge) continue;
          terrainSide(tx, ty, edge.bottom, edge.height, dx, 0,
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
    groupAnchorY.fill(-32768);
    for (let index = 0; index < objectSourceCount; index++) {
      const o = index * 16;
      const spriteId = objectDescriptors[o + 10];
      if (spriteId < 0 || spriteId >= groupAnchorY.length) continue;
      groupAnchorY[spriteId] = Math.max(groupAnchorY[spriteId], objectDescriptors[o + 4]);
    }

    const order = Array.from({ length: objectSourceCount }, (_, index) => index);
    order.sort((a, b) => {
      const ao = a * 16, bo = b * 16;
      return objectDescriptors[bo + 9] - objectDescriptors[ao + 9]
        || objectDescriptors[bo] - objectDescriptors[ao];
    });
    const normalVertices = [];
    const vertex = (vertices, x, y, u, v, depth, layer, sourceW, sourceH, drawW, drawH,
                    affine, pa, pb, pc, pd, atlasX, atlasY, oamId, priority, cameraDepth,
                    screenX, screenY) =>
      vertices.push(x, y, u, v, depth, layer, sourceW, sourceH, drawW, drawH,
                    affine, pa, pb, pc, pd, atlasX, atlasY, oamId, priority, cameraDepth,
                    screenX, screenY);
    const angle = CAMERA_TILT_DEGREES * tilt * Math.PI / 180;
    const sine = Math.sin(angle);
    const cosine = Math.cos(angle);
    const zoomOut = 0.30 * zoom + 0.76923077 * zoom * zoom * (zoom - 0.35);
    const focal = CAMERA_HEIGHT / (1 + zoomOut);
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
      const groundHeight = this.terrainGroundHeightAt(groundX, groundZ);
      const projected = this.cameraProjection(groundX, groundHeight, groundZ, tilt, zoom);
      const x0 = projected.x + (screenX - anchorX) * projected.scale;
      const x1 = x0 + drawW * projected.scale;
      const y0 = projected.y + (screenY - anchorY) * projected.scale;
      const y1 = y0 + drawH * projected.scale;
      // Invert the ground-plane projection at each corner: the BG priority
      // mask must test the receiver pixel rendered at the corner's screen
      // position, not the flat GBA overlap, or foreground details such as
      // flags occlude actors above their foreshortened art.
      const maskPoint = (px, py) => {
        const vy = this.height / 2 - py;
        const denominator = vy * sine - cosine * focal;
        if (Math.abs(denominator) < 1e-6)
          return [px - this.width / 2 + this.worldWidth / 2, py - this.height / 2 + this.worldHeight / 2];
        const z = (vy * (CAMERA_HEIGHT - groundHeight * cosine) - groundHeight * sine * focal) / denominator;
        const depth = CAMERA_HEIGHT - groundHeight * cosine - z * sine;
        return [(px - this.width / 2) * depth / focal + this.worldWidth / 2, z + this.worldHeight / 2];
      };
      const extra = [0, layer, sourceW, sourceH, drawW, drawH, affine, pa, pb, pc, pd];
      const tail = [oamId, priority, projected.cameraDepth, screenX, screenY];
      for (const point of [
        [x0,y0,0,0], [x1,y0,drawW,0], [x1,y1,drawW,drawH],
        [x0,y0,0,0], [x1,y1,drawW,drawH], [x0,y1,0,drawH],
      ]) vertex(normalVertices, point[0], point[1], point[2], point[3], ...extra,
                ...maskPoint(point[0], point[1]), ...tail);
    }

    const data = new Float32Array(normalVertices);
    if (data.byteLength > this.billboardVertexCapacity) {
      this.billboardVertexBuffer.destroy();
      this.billboardVertexCapacity = 2 ** Math.ceil(Math.log2(data.byteLength));
      this.billboardVertexBuffer = this.device.createBuffer({ label: 'high-resolution billboard quads', size: this.billboardVertexCapacity, usage: GPUBufferUsage.VERTEX | GPUBufferUsage.COPY_DST });
    }
    if (data.byteLength) this.device.queue.writeBuffer(this.billboardVertexBuffer, 0, data);
    return normalVertices.length / BILLBOARD_VERTEX_FLOATS;
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

  present({ finalPixels, worldPixels, worldStructuralAlphaPixels, worldHeightPixels, worldGroundHeightPixels, worldGeometryPixels, worldReceiverPixels, worldFacadePixels, worldGridOffsetX, worldGridOffsetY, worldPixelOriginX, worldPixelOriginY, layerPixels, objectIds, bgPriorities, objectSourcePixels, objectDescriptors, objectEventSpriteFlags, objectSourceCount, objectPixels, objectPriorities, enhanced, shading, perspective, zoom, optics }) {
    const encoder = this.device.createCommandEncoder({ label: 'pokeemerald frame encoder' });
    let presentBindGroup = this.finalBindGroup;
    if (enhanced) {
      this.writeTexture(this.worldTexture, worldPixels, this.worldWidth, this.worldHeight);
      this.writeTexture(this.structuralAlphaTexture, worldStructuralAlphaPixels, this.worldWidth, this.worldHeight, 1);
      const vertexCount = this.buildTerrain(
        worldHeightPixels, worldGroundHeightPixels, worldGeometryPixels, worldReceiverPixels, worldFacadePixels, worldPixels,
        worldStructuralAlphaPixels,
        worldGridOffsetX, worldGridOffsetY,
      );
      const billboardVertexCount = this.buildFrameLayers(
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
        depthStencilAttachment: { view: this.depthTexture.createView(), depthReadOnly: true },
      });
      castShadowPass.setPipeline(this.castShadowPipeline); castShadowPass.setBindGroup(0, this.castShadowBindGroup); castShadowPass.setVertexBuffer(0, this.castShadowVertexBuffer); castShadowPass.draw(castShadowVertexCount); castShadowPass.end();

      const castShadowCompositePass = encoder.beginRenderPass({
        label: 'unified projected shadow composite pass',
        colorAttachments: [{ view: this.sceneTexture.createView(), loadOp: 'load', storeOp: 'store' }],
      });
      castShadowCompositePass.setPipeline(this.castShadowCompositePipeline); castShadowCompositePass.setBindGroup(0, this.castShadowCompositeBindGroup); castShadowCompositePass.draw(3); castShadowCompositePass.end();

      const billboardPass = encoder.beginRenderPass({
        label: 'upright billboard pass',
        colorAttachments: [
          { view: this.sceneTexture.createView(), loadOp: 'load', storeOp: 'store' },
          { view: this.focusDepthTexture.createView(), loadOp: 'load', storeOp: 'store' },
        ],
        depthStencilAttachment: { view: this.depthTexture.createView(), depthLoadOp: 'load', depthStoreOp: 'store' },
      });
      billboardPass.setPipeline(this.billboardPipeline); billboardPass.setBindGroup(0, this.billboardBindGroup); billboardPass.setVertexBuffer(0, this.billboardVertexBuffer); billboardPass.draw(billboardVertexCount); billboardPass.end();

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
    for (const resource of [this.finalTexture,this.worldTexture,this.structuralAlphaTexture,this.objectTexture,this.bgPriorityTexture,this.uiTexture,this.sceneTexture,this.castShadowTexture,this.gradedTexture,this.depthTexture,this.focusDepthTexture,this.structuralShadowTexture,this.vertexBuffer,this.billboardVertexBuffer,this.castShadowVertexBuffer,this.cameraBuffer]) resource.destroy();
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
