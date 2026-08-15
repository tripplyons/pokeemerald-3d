import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';

const TILE_SIZE = 8;
const VERTEX_FLOATS = 14;
const MATERIAL_NEUTRAL_BUILDING = 8;
const SURFACE_WALL = 5;
const SURFACE_ROOF = 6;

// WebGpuPresenter is intentionally private in production. Load the real source
// and add a test-only export so these regressions exercise buildTerrain itself
// without widening the browser module's public API.
const presenterSource = await readFile(new URL('../web/presenter.js', import.meta.url), 'utf8');
const presenterModule = await import(
  `data:text/javascript;base64,${Buffer.from(
    `${presenterSource}\nexport { WebGpuPresenter };\n`,
  ).toString('base64')}`,
);
const { WebGpuPresenter } = presenterModule;

function makeTerrainHarness(width, height) {
  const tileCapacity = (Math.ceil(width / TILE_SIZE) + 2)
    * (Math.ceil(height / TILE_SIZE) + 2);
  const pixelCount = width * height;
  const writes = [];
  const presenter = {
    worldWidth: width,
    worldHeight: height,
    tileHeights: new Float32Array(tileCapacity),
    tileGroundHeights: new Float32Array(tileCapacity),
    tileGeometry: new Uint16Array(tileCapacity),
    tileReceivers: new Uint16Array(tileCapacity),
    tileFacades: new Uint32Array(tileCapacity),
    tileBuildingMaterialPixels: new Uint8Array(tileCapacity * TILE_SIZE * TILE_SIZE * 5),
    terrainCols: 0,
    terrainRows: 0,
    terrainOriginX: 0,
    terrainOriginY: 0,
    terrainSignature: null,
    terrainMaterialSnapshotValid: false,
    terrainVertexCount: 0,
    terrainRevision: 0,
    vertexCapacity: 1 << 24,
    vertexBuffer: { destroy() {} },
    device: {
      queue: {
        writeBuffer(_buffer, _offset, data) {
          writes.push(new Float32Array(data));
        },
      },
      createBuffer() {
        throw new Error('synthetic terrain unexpectedly outgrew its vertex buffer');
      },
    },
  };
  const worldHeights = new Int8Array(pixelCount);
  const worldGroundHeights = new Int8Array(pixelCount);
  const worldGeometry = new Uint16Array(pixelCount);
  const worldReceivers = new Uint16Array(pixelCount);
  const worldFacades = new Uint32Array(pixelCount);
  const worldPixels = new Uint8Array(pixelCount * 4);
  const worldStructuralAlphaPixels = new Uint8Array(pixelCount);

  const setPixel = (x, y, red, green, blue, alpha, structuralAlpha) => {
    const pixel = y * width + x;
    const rgba = pixel * 4;
    worldPixels[rgba] = red;
    worldPixels[rgba + 1] = green;
    worldPixels[rgba + 2] = blue;
    worldPixels[rgba + 3] = alpha;
    worldStructuralAlphaPixels[pixel] = structuralAlpha;
  };

  const fillPixels = (red, green, blue, alpha = 255, structuralAlpha = 255) => {
    for (let y = 0; y < height; y++) {
      for (let x = 0; x < width; x++)
        setPixel(x, y, red, green, blue, alpha, structuralAlpha);
    }
  };

  const setTile = (tx, ty, surface, component, tileHeight, facade = 0) => {
    for (let y = ty * TILE_SIZE; y < (ty + 1) * TILE_SIZE; y++) {
      for (let x = tx * TILE_SIZE; x < (tx + 1) * TILE_SIZE; x++) {
        const pixel = y * width + x;
        worldGeometry[pixel] = (component << 3) | surface;
        worldHeights[pixel] = tileHeight;
        worldFacades[pixel] = facade;
      }
    }
  };

  const render = () => WebGpuPresenter.prototype.buildTerrain.call(
    presenter,
    worldHeights,
    worldGroundHeights,
    worldGeometry,
    worldReceivers,
    worldFacades,
    worldPixels,
    worldStructuralAlphaPixels,
    TILE_SIZE,
    TILE_SIZE,
  );

  return {
    width,
    presenter,
    writes,
    worldPixels,
    worldStructuralAlphaPixels,
    setPixel,
    fillPixels,
    setTile,
    render,
  };
}

function neutralBuildingColors(vertexData) {
  const colors = [];
  for (let offset = 0; offset < vertexData.length; offset += VERTEX_FLOATS) {
    if (vertexData[offset + 8] !== MATERIAL_NEUTRAL_BUILDING) continue;
    colors.push(Array.from(vertexData.slice(offset + 11, offset + 14)));
  }
  return colors;
}

function testBuildingMaterialCacheInvalidation() {
  const harness = makeTerrainHarness(40, 40);
  harness.fillPixels(70, 130, 70);
  for (let ty = 1; ty <= 2; ty++) {
    for (let tx = 1; tx <= 3; tx++)
      harness.setTile(tx, ty, SURFACE_ROOF, 1, 24);
  }
  for (let tx = 1; tx <= 3; tx++)
    harness.setTile(tx, 3, SURFACE_WALL, 1, 0, 1);

  harness.render();
  assert.equal(harness.writes.length, 1);
  harness.render();
  assert.equal(harness.writes.length, 1, 'identical material inputs should reuse the mesh');

  harness.worldPixels[0] = 99;
  harness.render();
  assert.equal(
    harness.writes.length,
    1,
    'pixels outside building source tiles should not invalidate the terrain mesh',
  );

  const buildingPixel = 8 * harness.width + 8;
  harness.worldPixels[buildingPixel * 4] = 200;
  harness.render();
  assert.equal(
    harness.writes.length,
    2,
    'building RGBA changes must rebuild generated building materials',
  );
  harness.render();
  assert.equal(harness.writes.length, 2, 'the refreshed material snapshot should be reusable');

  harness.worldStructuralAlphaPixels[buildingPixel] = 0;
  harness.render();
  assert.equal(
    harness.writes.length,
    3,
    'building structural-alpha changes must rebuild generated building materials',
  );
}

function testRoofMaterialIgnoresDiscardedUnderlay() {
  const harness = makeTerrainHarness(32, 32);
  harness.fillPixels(30, 180, 40, 255, 0);
  harness.setTile(1, 1, SURFACE_ROOF, 1, 16);
  harness.setTile(1, 2, SURFACE_WALL, 1, 0, 1);

  // The roof tile is mostly opaque green underlay that the structural shader
  // discards. Only this red row is authored roof material.
  for (let x = 8; x < 16; x++)
    harness.setPixel(x, 8, 220, 30, 30, 255, 255);

  harness.render();
  const colors = neutralBuildingColors(harness.writes.at(-1));
  assert(colors.length > 0, 'synthetic roof should generate neutral closure geometry');
  assert(
    colors.some(([red, green, blue]) => red > 0.9 && green < 0.25 && blue < 0.25),
    'generated roof closure should use authored red roof pixels, not discarded green underlay',
  );
}

function testTransparentCoursesDoNotDiluteMaterialRecurrence() {
  const harness = makeTerrainHarness(48, 32);
  harness.fillPixels(20, 20, 180, 255, 0);
  for (let tx = 1; tx <= 3; tx++) {
    harness.setTile(tx, 1, SURFACE_ROOF, 1, 16);
    harness.setTile(tx, 2, SURFACE_WALL, 1, 0, 1);
  }

  // All roof cells contribute blue roof material.
  for (let y = 8; y < 16; y++) {
    for (let x = 8; x < 32; x++)
      harness.worldStructuralAlphaPixels[y * harness.width + x] = 255;
  }
  // Only one of the three facade courses contributes authored wall material.
  for (let y = 16; y < 24; y++) {
    for (let x = 8; x < 16; x++)
      harness.setPixel(x, y, 220, 100, 100, 255, 255);
  }

  harness.render();
  const colors = neutralBuildingColors(harness.writes.at(-1));
  assert(colors.length > 0, 'synthetic facade should generate neutral closure geometry');
  assert(
    colors.some(([red, _green, blue]) => red > 0.7 && red - blue > 0.2),
    'transparent facade courses should not force closure material to the blue roof fallback',
  );
}

testBuildingMaterialCacheInvalidation();
testRoofMaterialIgnoresDiscardedUnderlay();
testTransparentCoursesDoNotDiluteMaterialRecurrence();
console.log('building renderer regressions: ok');
