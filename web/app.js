import {
  HD2D_SURFACE_DECK,
  HD2D_SURFACE_MASK,
  HD2D_SURFACE_OBSTACLE,
  HD2D_SURFACE_OPEN_DECK,
  HD2D_SURFACE_TERRAIN,
  HD2D_SURFACE_WATER,
  createPresenter,
} from './presenter.js';

const WIDTH = 240;
const HEIGHT = 160;
const REG = 0x04000000;
const KEYINPUT = 0x04000130;
const KEY_MASK = 0x03ff;
const FLASH_BASE = 0x0e000000;
const FLASH_SIZE = 128 * 1024;
const FLASH_SECTOR_SIZE = 4096;
const REG_OFFSET_WIN0H = 0x40;
const REG_OFFSET_WIN0V = 0x44;
const REG_OFFSET_WININ = 0x48;
const REG_OFFSET_WINOUT = 0x4a;
const REG_OFFSET_DMA0 = 0xb0;
const DMA_DEST_FIXED = 0x0040;
const DMA_DEST_RELOAD = 0x0060;
const DMA_REPEAT = 0x0200;
const DMA_START_HBLANK = 0x2000;
const DMA_ENABLE = 0x8000;
const SAVE_SECTORS_PER_SLOT = 14;
const SAVE_SECTOR_SIGNATURE = 0x08012025;
const SAVE_SECTOR_DATA_SIZES = [
  0x0f2c,
  0x0f80, 0x0f80, 0x0f80, 0x0f0c,
  0x0f80, 0x0f80, 0x0f80, 0x0f80, 0x0f80, 0x0f80, 0x0f80, 0x0f80, 0x07d0,
];
const VANILLA_SAVE_SECTOR_DATA_SIZES = [
  0x0f2c,
  0x0f80, 0x0f80, 0x0f80, 0x0f08,
  0x0f80, 0x0f80, 0x0f80, 0x0f80, 0x0f80, 0x0f80, 0x0f80, 0x0f80, 0x07d0,
];
const LEGACY_WASM_SAVE_SECTOR_DATA_SIZES = [
  0x0f08,
  0x0f80, 0x0f80, 0x0f80, 0x0dc4,
  0x0f80, 0x0f80, 0x0f80, 0x0f80, 0x0f80, 0x0f80, 0x0f80, 0x0f80, 0x07d0,
];
const LEGACY_WASM_FRONTEND_SAVE_SECTOR_DATA_SIZES = [
  0x0f08,
  0x0f80, 0x0f80, 0x0f80, 0x0dc0,
  0x0f80, 0x0f80, 0x0f80, 0x0f80, 0x0f80, 0x0f80, 0x0f80, 0x0f80, 0x07d0,
];
const SAVE_BLOCK2_SIZE = 0x0f2c;
const SAVE_BLOCK1_SIZE = 0x3d8c;
const LEGACY_SAVE_BLOCK2_SIZE = 0x0f08;
const LEGACY_SAVE_BLOCK1_SIZE = 0x3c44;
const SAVE_BLOCK2_ENCRYPTION_KEY_OFFSET = 0x0ac;
const SAVE_BLOCK2_TRAINER_ID_OFFSET = 0x00a;
const SAVE_BLOCK1_COINS_OFFSET = 0x494;
const RUNNING_SHOES_FLAG = 0x8c0;
const BATTLE_TRANSITION_COUNT = 42;
const SAVE_BAG_POCKETS = [
  [0x560, 30, 99],
  [0x5d8, 30, 99],
  [0x650, 16, 99],
  [0x690, 64, 99],
  [0x790, 46, 999],
];
const SAVE_STORAGE_KEY = 'pokeemerald.wasm.flash.v1';
const SAVE_FLUSH_INTERVAL_MS = 1000;
const searchParams = new URLSearchParams(location.search);
const speedParam = searchParams.get('speed');
const renderScaleParam = searchParams.get('renderScale');
const visualModeParam = searchParams.get('view');
const shadingParam = searchParams.get('shading');
const perspectiveParam = searchParams.get('perspective');
const zoomParam = searchParams.get('zoom');
const opticsParam = searchParams.get('optics');
const automate = searchParams.get('automate') === '1';
const RENDER_SCALE_STORAGE_KEY = 'pokeemerald.wasm.renderScale.v1';
const VISUAL_SETTINGS_STORAGE_KEY = 'pokeemerald.wasm.visualSettings.v1';
const DEFAULT_RENDER_SCALE = 4;
const DEFAULT_SHADING_STRENGTH = 0.50;
const DEFAULT_PERSPECTIVE_STRENGTH = 0.50;
const DEFAULT_ZOOM_STRENGTH = 1.00;
const DEFAULT_OPTICS_STRENGTH = 0.50;
const RENDER_SCALES = [1, 2, 3, 4, 6, 8];
const MIN_SPEED = 0.1;
const MAX_SPEED = 1000;
const FAST_FRAME_BUDGET_MS = 16;

const buttons = {
  a: 1 << 0,
  b: 1 << 1,
  select: 1 << 2,
  start: 1 << 3,
  right: 1 << 4,
  left: 1 << 5,
  up: 1 << 6,
  down: 1 << 7,
  r: 1 << 8,
  l: 1 << 9,
};

const keyMap = new Map([
  ['KeyZ', 'a'], ['KeyX', 'b'], ['ShiftLeft', 'select'], ['ShiftRight', 'select'], ['Enter', 'start'],
  ['ArrowRight', 'right'], ['ArrowLeft', 'left'], ['ArrowUp', 'up'], ['ArrowDown', 'down'],
  ['KeyS', 'r'], ['KeyA', 'l'],
]);

const canvas = document.querySelector('#screen');
const statusEl = document.querySelector('#status');
const speedButtons = document.querySelectorAll('[data-speed]');
const speedValue = document.querySelector('#speed-value');
const renderScaleSelect = document.querySelector('#render-scale');
const visualModeSelect = document.querySelector('#visual-mode');
const shadingInput = document.querySelector('#shading-strength');
const shadingValue = document.querySelector('#shading-value');
const depthInput = document.querySelector('#depth-strength');
const depthValue = document.querySelector('#depth-value');
const zoomInput = document.querySelector('#zoom-out');
const zoomValue = document.querySelector('#zoom-value');
const opticsInput = document.querySelector('#optics-strength');
const opticsValue = document.querySelector('#optics-value');
const fullscreenButton = document.querySelector('#fullscreen');
const shell = document.querySelector('.shell');
const downloadSaveButton = document.querySelector('#download-save');
const uploadSaveInput = document.querySelector('#upload-save');
let presenter;
let presenterRecoveryPromise = null;
let presenterRecreationCount = 0;
let runtimeStopped = false;
let renderScale = DEFAULT_RENDER_SCALE;
const VISUAL_MODE_TRANSITION_MS = 4000;
const reducedMotionQuery = matchMedia('(prefers-reduced-motion: reduce)');
let visualMode = 'hd2d';
let activeVisualMode = 'hd2d';
let shadingStrength = DEFAULT_SHADING_STRENGTH;
let perspectiveStrength = DEFAULT_PERSPECTIVE_STRENGTH;
let zoomStrength = DEFAULT_ZOOM_STRENGTH;
let opticsStrength = DEFAULT_OPTICS_STRENGTH;
let renderedShadingStrength = shadingStrength;
let renderedOpticsStrength = opticsStrength;
let visualModeTransition = null;
let image;
let worldPixels;
let worldStructuralAlphaPixels;
let worldHeightPixels;
let worldGroundHeightPixels;
let worldGeometryPixels;
let worldReceiverPixels;
let worldFacadePixels;
let layerPixels;
let objectIds;
let bgPriorities;
let objectSourcePixels;
let objectDescriptors;
let objectPixels;
let objectPriorities;
let screenEffectPixels;
let screenEffectSources;
let lastSceneKind = 0;
const pressed = new Set();
const pendingPresses = new Map();
const objectEventSpriteFlags = new Uint8Array(128);

function showFatalError(error, prefix) {
  const message = error instanceof Error ? error.message : String(error);
  statusEl.textContent = `${prefix}: ${message}`;
  statusEl.classList.add('error');
  statusEl.setAttribute('role', 'alert');
}

function stopRuntime(error, prefix) {
  if (runtimeStopped) return;
  runtimeStopped = true;
  bootId++;
  saveFlashIfChanged(true);
  presenter?.destroy();
  presenter = undefined;
  showFatalError(error, prefix);
}

let instance;
let memory;
let u8;
let u16;
let u32;
let statusText = 'loading wasm…';
let lastFpsUpdate = performance.now();
let lastTick = performance.now();
let renderedFrames = 0;
let emulatedFrames = 0;
let gameFrameAccumulator = 0;
let speed = 1;
let lastFiniteSpeed = 1;
let currentFrame = 0;
let lastSavedFlashHash = 0;
let lastSaveFlushTime = performance.now();
let wasmModulePromise;
let bootId = 0;
let automationReady;
let resolveAutomationReady;
if (automate) {
  automationReady = new Promise((resolve) => { resolveAutomationReady = resolve; });
}

function storedRenderScale() {
  const requested = Number(renderScaleParam);
  if (RENDER_SCALES.includes(requested)) return requested;

  try {
    const stored = Number(localStorage.getItem(RENDER_SCALE_STORAGE_KEY));
    if (RENDER_SCALES.includes(stored)) return stored;
  } catch {
    // Storage may be disabled; use the default render scale.
  }
  return DEFAULT_RENDER_SCALE;
}

function setRenderScale(value, persist = true) {
  const parsed = Number(value);
  renderScale = RENDER_SCALES.includes(parsed) ? parsed : DEFAULT_RENDER_SCALE;
  canvas.width = WIDTH * renderScale;
  canvas.height = HEIGHT * renderScale;
  if (!presenterRecoveryPromise) presenter?.resize(renderScale);
  renderScaleSelect.value = String(renderScale);

  if (persist) {
    try {
      localStorage.setItem(RENDER_SCALE_STORAGE_KEY, String(renderScale));
    } catch {
      // Keep the setting for this session when storage is unavailable.
    }
  }
  if (image) render();
}

setRenderScale(storedRenderScale(), false);

function clampSetting(value, fallback) {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? Math.min(1, Math.max(0, parsed)) : fallback;
}

function storedVisualSettings() {
  let stored = {};
  try {
    stored = JSON.parse(localStorage.getItem(VISUAL_SETTINGS_STORAGE_KEY) || '{}');
  } catch {
    // Ignore corrupt or unavailable browser storage.
  }
  return {
    mode: visualModeParam === 'classic' || visualModeParam === 'hd2d'
      ? visualModeParam
      : (stored.mode === 'classic' ? 'classic' : 'hd2d'),
    shading: clampSetting(shadingParam ?? stored.shading, DEFAULT_SHADING_STRENGTH),
    perspective: clampSetting(perspectiveParam ?? stored.perspective, DEFAULT_PERSPECTIVE_STRENGTH),
    zoom: clampSetting(zoomParam ?? stored.zoom, DEFAULT_ZOOM_STRENGTH),
    optics: clampSetting(opticsParam ?? stored.optics, DEFAULT_OPTICS_STRENGTH),
  };
}

function setActiveVisualMode(mode) {
  if (activeVisualMode === mode) return;
  activeVisualMode = mode;
  if (!instance) return;
  instance.exports.WasmSetHd2dEnabled(activeVisualMode === 'hd2d' ? 1 : 0);
  instance.exports.WasmRefreshHd2dObjectEvents();
}

function visualModeTransitionNow() {
  return automate ? currentFrame * 1000 / 60 : performance.now();
}

function updateVisualModeTransition(now = visualModeTransitionNow()) {
  if (!visualModeTransition) return;
  if (visualModeTransition.startedAt === null) {
    visualModeTransition.startedAt = now;
  }
  const durationMs = visualModeTransition.durationMs;
  const progress = durationMs <= 0 ? 1 : Math.min(1, Math.max(0,
    (now - visualModeTransition.startedAt) / durationMs));
  const blend = progress * progress * (3 - 2 * progress);
  renderedShadingStrength = visualModeTransition.fromShading
    + (visualModeTransition.toShading - visualModeTransition.fromShading) * blend;
  renderedOpticsStrength = visualModeTransition.fromOptics
    + (visualModeTransition.toOptics - visualModeTransition.fromOptics) * blend;
  if (progress < 1) return;

  renderedShadingStrength = visualModeTransition.toShading;
  renderedOpticsStrength = visualModeTransition.toOptics;
  visualModeTransition = null;
}

function beginVisualModeTransition(mode, now = visualModeTransitionNow()) {
  updateVisualModeTransition(now);
  if (mode === 'classic') {
    visualModeTransition = null;
    renderedShadingStrength = 0;
    renderedOpticsStrength = 0;
    setActiveVisualMode('classic');
    return;
  }
  if (activeVisualMode === 'classic') {
    renderedShadingStrength = 0;
    renderedOpticsStrength = 0;
    setActiveVisualMode('hd2d');
  }
  if (reducedMotionQuery.matches) {
    visualModeTransition = null;
    renderedShadingStrength = shadingStrength;
    renderedOpticsStrength = opticsStrength;
    return;
  }
  visualModeTransition = {
    startedAt: null,
    durationMs: VISUAL_MODE_TRANSITION_MS,
    fromShading: renderedShadingStrength,
    fromOptics: renderedOpticsStrength,
    toShading: shadingStrength,
    toOptics: opticsStrength,
  };
}

function setVisualSettings(settings, persist = true, animate = true) {
  const now = visualModeTransitionNow();
  updateVisualModeTransition(now);
  const nextVisualMode = settings.mode === 'classic' ? 'classic' : 'hd2d';
  const modeChanged = visualMode !== nextVisualMode;
  visualMode = nextVisualMode;
  shadingStrength = clampSetting(settings.shading, shadingStrength);
  perspectiveStrength = clampSetting(settings.perspective, perspectiveStrength);
  zoomStrength = clampSetting(settings.zoom, zoomStrength);
  opticsStrength = clampSetting(settings.optics, opticsStrength);

  if (!instance) {
    activeVisualMode = visualMode;
    visualModeTransition = null;
    renderedShadingStrength = visualMode === 'hd2d' ? shadingStrength : 0;
    renderedOpticsStrength = visualMode === 'hd2d' ? opticsStrength : 0;
  } else if (modeChanged && animate) {
    beginVisualModeTransition(visualMode, now);
  } else if (modeChanged) {
    visualModeTransition = null;
    if (visualMode === 'hd2d' && activeVisualMode === 'classic') {
      renderedShadingStrength = 0;
      renderedOpticsStrength = 0;
      setActiveVisualMode('hd2d');
    }
    renderedShadingStrength = visualMode === 'hd2d' ? shadingStrength : 0;
    renderedOpticsStrength = visualMode === 'hd2d' ? opticsStrength : 0;
    setActiveVisualMode(visualMode);
  } else if (!visualModeTransition && activeVisualMode === 'hd2d') {
    renderedShadingStrength = shadingStrength;
    renderedOpticsStrength = opticsStrength;
  } else if (visualModeTransition) {
    const previousTransition = visualModeTransition;
    const endsAt = previousTransition.startedAt === null
      ? now + previousTransition.durationMs
      : previousTransition.startedAt + previousTransition.durationMs;
    visualModeTransition = {
      startedAt: now,
      durationMs: Math.max(0, endsAt - now),
      fromShading: renderedShadingStrength,
      fromOptics: renderedOpticsStrength,
      toShading: shadingStrength,
      toOptics: opticsStrength,
    };
  } else if (activeVisualMode === 'classic') {
    renderedShadingStrength = 0;
    renderedOpticsStrength = 0;
  }

  visualModeSelect.value = visualMode;
  shadingInput.value = String(Math.round(shadingStrength * 100));
  depthInput.value = String(Math.round(perspectiveStrength * 100));
  zoomInput.value = String(Math.round(zoomStrength * 100));
  opticsInput.value = String(Math.round(opticsStrength * 100));
  shadingValue.textContent = `${Math.round(shadingStrength * 100)}%`;
  depthValue.textContent = `${Math.round(perspectiveStrength * 100)}%`;
  zoomValue.textContent = `${Math.round(zoomStrength * 100)}%`;
  opticsValue.textContent = `${Math.round(opticsStrength * 100)}%`;
  if (persist) {
    try {
      localStorage.setItem(VISUAL_SETTINGS_STORAGE_KEY, JSON.stringify({
        mode: visualMode,
        shading: shadingStrength,
        perspective: perspectiveStrength,
        zoom: zoomStrength,
        optics: opticsStrength,
      }));
    } catch {
      // Keep settings for this session when storage is unavailable.
    }
  }
  if (image && presenter) render();
}

setVisualSettings(storedVisualSettings(), false);

function refreshViews() {
  u8 = new Uint8Array(memory.buffer);
  u16 = new Uint16Array(memory.buffer);
  u32 = new Uint32Array(memory.buffer);
}

function bytesToBase64(bytes) {
  let binary = '';
  for (let i = 0; i < bytes.length; i += 0x8000) {
    const chunk = bytes.subarray(i, i + 0x8000);
    binary += String.fromCharCode(...chunk);
  }
  return btoa(binary);
}

function base64ToBytes(base64) {
  const binary = atob(base64);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
  return bytes;
}

function flashBytes() {
  return u8.subarray(FLASH_BASE, FLASH_BASE + FLASH_SIZE);
}

function hashBytes(bytes) {
  let hash = 2166136261;
  for (const byte of bytes) {
    hash ^= byte;
    hash = Math.imul(hash, 16777619);
  }
  return hash >>> 0;
}

function loadFlashSave(sourceBytes) {
  const flash = flashBytes();
  flash.fill(0xFF);

  if (sourceBytes?.length === FLASH_SIZE) {
    flash.set(normalizeSaveForCurrentBuild(sourceBytes) ?? sourceBytes);
  } else {
    try {
      const stored = localStorage.getItem(SAVE_STORAGE_KEY);
      if (stored) {
        const saved = base64ToBytes(stored);
        if (saved.length === FLASH_SIZE) {
          const normalized = normalizeSaveForCurrentBuild(saved);
          flash.set(normalized ?? saved);
          if (normalized && normalized !== saved) localStorage.setItem(SAVE_STORAGE_KEY, bytesToBase64(normalized));
        }
      }
    } catch {
      // Storage may be disabled; the game can still run with volatile flash.
    }
  }

  lastSavedFlashHash = hashBytes(flash);
}

function saveFlashIfChanged(force = false) {
  if (!u8) return;
  const now = performance.now();
  if (!force && now - lastSaveFlushTime < SAVE_FLUSH_INTERVAL_MS) return;
  lastSaveFlushTime = now;

  const flash = flashBytes();
  const hash = hashBytes(flash);
  if (!force && hash === lastSavedFlashHash) return;

  try {
    localStorage.setItem(SAVE_STORAGE_KEY, bytesToBase64(flash));
    lastSavedFlashHash = hash;
  } catch {
    // Keep running even if the browser refuses persistent storage.
  }
}

function downloadSave() {
  if (!u8) return;
  saveFlashIfChanged(true);
  const blob = new Blob([new Uint8Array(flashBytes())], { type: 'application/octet-stream' });
  const url = URL.createObjectURL(blob);
  const link = document.createElement('a');
  link.href = url;
  link.download = 'pokeemerald.sav';
  document.body.append(link);
  link.click();
  link.remove();
  URL.revokeObjectURL(url);
}

function readSaveU16(bytes, offset) {
  return bytes[offset] | (bytes[offset + 1] << 8);
}

function readSaveU32(bytes, offset) {
  return (bytes[offset]
    | (bytes[offset + 1] << 8)
    | (bytes[offset + 2] << 16)
    | (bytes[offset + 3] << 24)) >>> 0;
}

function writeSaveU16(bytes, offset, value) {
  bytes[offset] = value & 0xff;
  bytes[offset + 1] = (value >> 8) & 0xff;
}

function saveSectorChecksum(bytes, offset, size) {
  let sum = 0;
  let i = 0;
  for (; i + 3 < size; i += 4) sum = (sum + readSaveU32(bytes, offset + i)) >>> 0;
  for (; i < size; i++) sum = (sum + (bytes[offset + i] << ((i & 3) * 8))) >>> 0;
  return ((sum >>> 16) + (sum & 0xffff)) & 0xffff;
}

function hasValidEmeraldSaveSlot(bytes, slot, sectorDataSizes) {
  let validSectorFlags = 0;
  const firstSector = slot * SAVE_SECTORS_PER_SLOT;

  for (let i = 0; i < SAVE_SECTORS_PER_SLOT; i++) {
    const sectorOffset = (firstSector + i) * FLASH_SECTOR_SIZE;
    const id = readSaveU16(bytes, sectorOffset + 0x0ff4);
    const checksum = readSaveU16(bytes, sectorOffset + 0x0ff6);
    const signature = readSaveU32(bytes, sectorOffset + 0x0ff8);
    const dataSize = sectorDataSizes[id];

    if (signature === SAVE_SECTOR_SIGNATURE
      && dataSize !== undefined
      && checksum === saveSectorChecksum(bytes, sectorOffset, dataSize)) {
      validSectorFlags |= 1 << id;
    }
  }

  return validSectorFlags === (1 << SAVE_SECTORS_PER_SLOT) - 1;
}

function isValidEmeraldSave(bytes, sectorDataSizes) {
  return hasValidEmeraldSaveSlot(bytes, 0, sectorDataSizes)
    || hasValidEmeraldSaveSlot(bytes, 1, sectorDataSizes);
}

function isValidCurrentBuildSave(bytes) {
  return isValidEmeraldSave(bytes, SAVE_SECTOR_DATA_SIZES)
    || isValidEmeraldSave(bytes, VANILLA_SAVE_SECTOR_DATA_SIZES);
}

function copyRange(dst, dstOffset, src, srcOffset, size) {
  dst.set(src.subarray(srcOffset, srcOffset + size), dstOffset);
}

function copyLegacyArray(dst, dstOffset, dstElementSize, src, srcOffset, srcElementSize, count) {
  for (let i = 0; i < count; i++) {
    copyRange(dst, dstOffset + i * dstElementSize, src, srcOffset + i * srcElementSize, srcElementSize);
  }
}

function readSlotSaveBlocks(bytes, slot, sectorDataSizes, saveBlock2Size, saveBlock1Size) {
  const saveBlock2 = new Uint8Array(saveBlock2Size);
  const saveBlock1 = new Uint8Array(saveBlock1Size);
  const firstSector = slot * SAVE_SECTORS_PER_SLOT;

  for (let i = 0; i < SAVE_SECTORS_PER_SLOT; i++) {
    const sectorOffset = (firstSector + i) * FLASH_SECTOR_SIZE;
    const id = readSaveU16(bytes, sectorOffset + 0x0ff4);
    const size = sectorDataSizes[id];
    if (size === undefined) continue;

    if (id === 0) {
      copyRange(saveBlock2, 0, bytes, sectorOffset, Math.min(size, saveBlock2.length));
    } else if (id >= 1 && id <= 4) {
      copyRange(saveBlock1, (id - 1) * 0x0f80, bytes, sectorOffset, Math.min(size, saveBlock1.length - (id - 1) * 0x0f80));
    }
  }

  return { saveBlock1, saveBlock2 };
}

function saveKeyScore(saveBlock1, key) {
  let score = (readSaveU32(saveBlock1, 0x490) ^ key) <= 999999 ? 20 : -20;

  for (const [offset, count, maxQuantity] of SAVE_BAG_POCKETS) {
    for (let i = 0; i < count; i++) {
      const itemOffset = offset + i * 4;
      const itemId = readSaveU16(saveBlock1, itemOffset);
      const quantity = (readSaveU16(saveBlock1, itemOffset + 2) ^ key) & 0xffff;
      if (itemId === 0) score += quantity === 0 ? 1 : -1;
      else if (itemId < 377 && quantity > 0 && quantity <= maxQuantity) score += 3;
      else score -= 3;
    }
  }

  return score;
}

function isLikelyLegacyWasmSaveBlock(blocks) {
  const legacyKey = readSaveU32(blocks.saveBlock2, 0x0a8);
  const currentKey = readSaveU32(blocks.saveBlock2, SAVE_BLOCK2_ENCRYPTION_KEY_OFFSET);
  if (legacyKey === currentKey) return false;
  return saveKeyScore(blocks.saveBlock1, legacyKey) > saveKeyScore(blocks.saveBlock1, currentKey) + 20;
}

function isPlausibleBagQuantity(itemId, quantity, maxQuantity) {
  if (itemId === 0) return quantity === 0;
  return itemId < 377 && quantity > 0 && quantity <= maxQuantity;
}

function bagQuantityKeyScore(saveBlock1, key) {
  let score = 0;
  const keyLow = key & 0xffff;

  for (const [offset, count, maxQuantity] of SAVE_BAG_POCKETS) {
    for (let i = 0; i < count; i++) {
      const itemOffset = offset + i * 4;
      const itemId = readSaveU16(saveBlock1, itemOffset);
      const quantity = (readSaveU16(saveBlock1, itemOffset + 2) ^ keyLow) & 0xffff;
      if (isPlausibleBagQuantity(itemId, quantity, maxQuantity)) score += itemId === 0 ? 2 : 5;
      else score += itemId === 0 ? -2 : -5;
    }
  }

  return score;
}

function staleBagQuantityKey(saveBlock1, currentKey) {
  const currentKeyLow = currentKey & 0xffff;
  const candidates = new Set();

  for (const [offset, count] of SAVE_BAG_POCKETS) {
    for (let i = 0; i < count; i++) {
      const itemOffset = offset + i * 4;
      if (readSaveU16(saveBlock1, itemOffset) === 0) {
        const rawQuantity = readSaveU16(saveBlock1, itemOffset + 2);
        if (rawQuantity !== currentKeyLow) candidates.add(rawQuantity);
      }
    }
  }

  const currentScore = bagQuantityKeyScore(saveBlock1, currentKeyLow);
  let bestKey = currentKeyLow;
  let bestScore = currentScore;
  for (const candidate of candidates) {
    const score = bagQuantityKeyScore(saveBlock1, candidate);
    if (score > bestScore) {
      bestKey = candidate;
      bestScore = score;
    }
  }

  return bestKey !== currentKeyLow && bestScore > currentScore + 100 && bestScore > 100 ? bestKey : null;
}

function reencryptSaveBlock1Hword(saveBlock1, offset, oldKey, newKey) {
  const value = (readSaveU16(saveBlock1, offset) ^ oldKey) & 0xffff;
  writeSaveU16(saveBlock1, offset, value ^ newKey);
}

function repairStaleBagEncryption(blocks) {
  const currentKey = readSaveU32(blocks.saveBlock2, SAVE_BLOCK2_ENCRYPTION_KEY_OFFSET);
  const currentKeyLow = currentKey & 0xffff;
  const oldKey = staleBagQuantityKey(blocks.saveBlock1, currentKey);
  if (oldKey === null) return null;

  const saveBlock1 = new Uint8Array(blocks.saveBlock1);
  let didRepair = false;
  for (const [offset, count, maxQuantity] of SAVE_BAG_POCKETS) {
    for (let i = 0; i < count; i++) {
      const quantityOffset = offset + i * 4 + 2;
      const itemId = readSaveU16(saveBlock1, quantityOffset - 2);
      const rawQuantity = readSaveU16(saveBlock1, quantityOffset);
      const currentQuantity = (rawQuantity ^ currentKeyLow) & 0xffff;
      const oldQuantity = (rawQuantity ^ oldKey) & 0xffff;
      if (isPlausibleBagQuantity(itemId, currentQuantity, maxQuantity)
          || !isPlausibleBagQuantity(itemId, oldQuantity, maxQuantity)) {
        continue;
      }

      reencryptSaveBlock1Hword(saveBlock1, quantityOffset, oldKey, currentKeyLow);
      didRepair = true;
    }
  }

  const rawCoins = readSaveU16(saveBlock1, SAVE_BLOCK1_COINS_OFFSET);
  const currentCoins = (rawCoins ^ currentKeyLow) & 0xffff;
  const oldCoins = (rawCoins ^ oldKey) & 0xffff;
  if (oldCoins <= 9999 && (currentCoins > 9999 || rawCoins === oldKey)) {
    writeSaveU16(saveBlock1, SAVE_BLOCK1_COINS_OFFSET, oldCoins ^ currentKeyLow);
    didRepair = true;
  }

  return didRepair ? { saveBlock1, saveBlock2: blocks.saveBlock2 } : null;
}

function migrateLegacySaveBlock2(src) {
  const dst = new Uint8Array(0x0f2c);
  copyRange(dst, 0, src, 0, 0x98);
  copyRange(dst, 0x98, src, 0x98, 5);
  copyRange(dst, 0xa0, src, 0x9e, 5);
  copyRange(dst, 0xa8, src, 0xa4, 0xe64);
  return dst;
}

function migrateLegacySaveBlock1(src) {
  const dst = new Uint8Array(0x3d8c);
  copyRange(dst, 0, src, 0, 0x848);
  copyLegacyArray(dst, 0x848, 8, src, 0x848, 7, 40);
  copyRange(dst, 0x988, src, 0x960, 0x166c - 0x960);
  copyLegacyArray(dst, 0x169c, 8, src, 0x1674, 6, 128);
  copyRange(dst, 0x1a9c, src, 0x1974, 0x2be0 - 0x1974);
  copyLegacyArray(dst, 0x2be0, 36, src, 0x2ab8, 34, 16);
  copyRange(dst, 0x2e20, src, 0x2cd8, 0x3150 - 0x2cd8);
  copyRange(dst, 0x3150, src, 0x3008, 85);
  copyRange(dst, 0x31a8, src, 0x305e, 11);
  copyRange(dst, 0x31b4, src, 0x306c, 20);
  copyRange(dst, 0x31c8, src, 0x3080, 21);
  copyRange(dst, 0x31e0, src, 0x3098, 0x3c44 - 0x3098);
  return dst;
}

function writeCurrentSaveSlot(out, source, slot, currentBlocks) {
  const firstSector = slot * SAVE_SECTORS_PER_SLOT;

  for (let i = 0; i < SAVE_SECTORS_PER_SLOT; i++) {
    const sectorOffset = (firstSector + i) * FLASH_SECTOR_SIZE;
    const id = readSaveU16(source, sectorOffset + 0x0ff4);
    const size = SAVE_SECTOR_DATA_SIZES[id];
    if (size === undefined) continue;

    out.fill(0, sectorOffset, sectorOffset + 0x0ff4);
    if (id === 0) {
      copyRange(out, sectorOffset, currentBlocks.saveBlock2, 0, size);
    } else if (id >= 1 && id <= 4) {
      copyRange(out, sectorOffset, currentBlocks.saveBlock1, (id - 1) * 0x0f80, size);
    } else {
      copyRange(out, sectorOffset, source, sectorOffset, size);
    }
    writeSaveU16(out, sectorOffset + 0x0ff6, saveSectorChecksum(out, sectorOffset, size));
  }
}

function writeMigratedSaveSlot(out, source, slot, blocks) {
  writeCurrentSaveSlot(out, source, slot, {
    saveBlock2: migrateLegacySaveBlock2(blocks.saveBlock2),
    saveBlock1: migrateLegacySaveBlock1(blocks.saveBlock1),
  });
}

function migrateLegacyWasmSave(bytes) {
  const out = new Uint8Array(bytes);
  let didMigrate = false;

  for (let slot = 0; slot < 2; slot++) {
    for (const legacySizes of [LEGACY_WASM_SAVE_SECTOR_DATA_SIZES, LEGACY_WASM_FRONTEND_SAVE_SECTOR_DATA_SIZES]) {
      if (!hasValidEmeraldSaveSlot(bytes, slot, legacySizes)) continue;
      const blocks = readSlotSaveBlocks(bytes, slot, legacySizes, LEGACY_SAVE_BLOCK2_SIZE, LEGACY_SAVE_BLOCK1_SIZE);
      if (!isLikelyLegacyWasmSaveBlock(blocks)) continue;
      writeMigratedSaveSlot(out, bytes, slot, blocks);
      didMigrate = true;
      break;
    }
  }

  return didMigrate ? out : null;
}

function repairStaleBagEncryptionSave(bytes) {
  const out = new Uint8Array(bytes);
  let didRepair = false;

  for (let slot = 0; slot < 2; slot++) {
    let sectorDataSizes = null;
    if (hasValidEmeraldSaveSlot(bytes, slot, SAVE_SECTOR_DATA_SIZES)) sectorDataSizes = SAVE_SECTOR_DATA_SIZES;
    else if (hasValidEmeraldSaveSlot(bytes, slot, VANILLA_SAVE_SECTOR_DATA_SIZES)) sectorDataSizes = VANILLA_SAVE_SECTOR_DATA_SIZES;
    if (!sectorDataSizes) continue;

    const blocks = readSlotSaveBlocks(bytes, slot, sectorDataSizes, SAVE_BLOCK2_SIZE, SAVE_BLOCK1_SIZE);
    const repaired = repairStaleBagEncryption(blocks);
    if (!repaired) continue;

    writeCurrentSaveSlot(out, bytes, slot, repaired);
    didRepair = true;
  }

  return didRepair ? out : null;
}

function normalizeSaveForCurrentBuild(bytes) {
  const migrated = migrateLegacyWasmSave(bytes);
  if (migrated) return repairStaleBagEncryptionSave(migrated) ?? migrated;

  const repaired = repairStaleBagEncryptionSave(bytes);
  if (repaired) return repaired;

  return isValidCurrentBuildSave(bytes) ? bytes : null;
}

async function wasmModule() {
  wasmModulePromise ??= fetch('/build/wasm/pokeemerald.wasm', { cache: 'no-store' })
    .then((res) => res.arrayBuffer())
    .then(async (bytes) => ({ bytes, module: await WebAssembly.compile(bytes) }));
  return wasmModulePromise;
}

async function restartWithSave(bytes) {
  statusText = 'restarting with uploaded save...';
  statusEl.textContent = statusText;
  pressed.clear();
  pendingPresses.clear();
  await boot(bytes);
}

async function uploadSave(file) {
  if (!file || !u8) return;
  const bytes = new Uint8Array(await file.arrayBuffer());
  if (bytes.length !== FLASH_SIZE) {
    statusEl.textContent = `expected a ${FLASH_SIZE} byte Emerald .sav file, got ${bytes.length} bytes`;
    return;
  }
  const normalized = normalizeSaveForCurrentBuild(bytes);
  if (!normalized) {
    statusEl.textContent = 'save file does not contain a valid Emerald save slot';
    return;
  }

  lastSavedFlashHash = hashBytes(normalized);
  localStorage.setItem(SAVE_STORAGE_KEY, bytesToBase64(normalized));
  await restartWithSave(normalized);
}

function clamp(value, min, max) {
  return Math.min(max, Math.max(min, value));
}

function formatSpeed(value) {
  if (value === Infinity) return 'unlimited';
  if (value < 1) return `${value.toFixed(1)}x`;
  if (value < 100) return `${value.toFixed(value < 10 ? 1 : 0)}x`;
  return `${Math.round(value)}x`;
}

function setSpeed(value) {
  speed = value === Infinity ? Infinity : clamp(value, MIN_SPEED, MAX_SPEED);
  if (speed !== Infinity) lastFiniteSpeed = speed;
  speedValue.textContent = formatSpeed(speed);
  speedButtons.forEach((button) => {
    button.classList.toggle('active',
      (button.dataset.speed === '1' && speed === 1) || (button.dataset.speed === 'unlimited' && speed === Infinity));
  });
}

function adjustSpeed(multiplier) {
  setSpeed((speed === Infinity ? lastFiniteSpeed : speed) * multiplier);
}

function toggleUnlimitedSpeed() {
  setSpeed(speed === Infinity ? lastFiniteSpeed : Infinity);
}

function resetFpsCounters() {
  lastFpsUpdate = performance.now();
  renderedFrames = 0;
  emulatedFrames = 0;
  gameFrameAccumulator = 0;
}

function initialSpeed() {
  if (speedParam === '0') return Infinity;
  const parsed = Number(speedParam);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : 1;
}

function updateFullscreenButton() {
  const isFullscreen = document.fullscreenElement === shell;
  fullscreenButton.textContent = isFullscreen ? 'Exit Big Picture' : 'Big Picture';
  fullscreenButton.classList.toggle('active', isFullscreen);
}

async function toggleFullscreen() {
  if (document.fullscreenElement) {
    await document.exitFullscreen();
  } else {
    await shell.requestFullscreen();
  }
}

function refreshFrameImage() {
  const ptr = instance.exports.WasmDisplayBuffer();
  const size = instance.exports.WasmDisplayBufferSize();
  image = new ImageData(new Uint8ClampedArray(memory.buffer, ptr, size), WIDTH, HEIGHT);
  worldPixels = new Uint8ClampedArray(
    memory.buffer,
    instance.exports.WasmWorldBuffer(),
    instance.exports.WasmWorldBufferSize(),
  );
  worldStructuralAlphaPixels = new Uint8Array(
    memory.buffer,
    instance.exports.WasmWorldStructuralAlphaBuffer(),
    instance.exports.WasmWorldStructuralAlphaBufferSize(),
  );
  worldHeightPixels = new Int16Array(
    memory.buffer,
    instance.exports.WasmWorldHeightBuffer(),
    instance.exports.WasmWorldHeightBufferSize() / 2,
  );
  worldGroundHeightPixels = new Int16Array(
    memory.buffer,
    instance.exports.WasmWorldGroundHeightBuffer(),
    instance.exports.WasmWorldGroundHeightBufferSize() / 2,
  );
  worldGeometryPixels = new Uint16Array(
    memory.buffer,
    instance.exports.WasmWorldGeometryBuffer(),
    instance.exports.WasmWorldGeometryBufferSize() / 2,
  );
  worldReceiverPixels = new Uint16Array(
    memory.buffer,
    instance.exports.WasmWorldReceiverBuffer(),
    instance.exports.WasmWorldReceiverBufferSize() / 2,
  );
  worldFacadePixels = new Uint32Array(
    memory.buffer,
    instance.exports.WasmWorldFacadeBuffer(),
    instance.exports.WasmWorldFacadeBufferSize() / 4,
  );
  layerPixels = new Uint8Array(
    memory.buffer,
    instance.exports.WasmDisplayLayerBuffer(),
    instance.exports.WasmDisplayLayerBufferSize(),
  );
  objectIds = new Uint8Array(
    memory.buffer,
    instance.exports.WasmDisplayObjectIdBuffer(),
    instance.exports.WasmDisplayObjectIdBufferSize(),
  );
  bgPriorities = new Uint8Array(
    memory.buffer,
    instance.exports.WasmDisplayBgPriorityBuffer(),
    instance.exports.WasmDisplayBgPriorityBufferSize(),
  );
  objectSourcePixels = new Uint8Array(
    memory.buffer,
    instance.exports.WasmDisplayObjectSourceBuffer(),
    instance.exports.WasmDisplayObjectSourceBufferSize(),
  );
  objectDescriptors = new Int32Array(
    memory.buffer,
    instance.exports.WasmDisplayObjectDescriptorBuffer(),
    instance.exports.WasmDisplayObjectDescriptorBufferSize() / 4,
  );
  objectPixels = new Uint8ClampedArray(
    memory.buffer,
    instance.exports.WasmDisplayObjectBuffer(),
    instance.exports.WasmDisplayObjectBufferSize(),
  );
  objectPriorities = new Uint8Array(
    memory.buffer,
    instance.exports.WasmDisplayObjectPriorities(),
    instance.exports.WasmDisplayObjectPrioritiesSize(),
  );
  screenEffectPixels = new Uint8Array(
    memory.buffer,
    instance.exports.WasmDisplayScreenEffectBuffer(),
    instance.exports.WasmDisplayScreenEffectBufferSize(),
  );
  screenEffectSources = new Int16Array(
    memory.buffer,
    instance.exports.WasmDisplayScreenEffectSourceBuffer(),
    instance.exports.WasmDisplayScreenEffectSourceBufferSize() / 2,
  );
}

function refreshObjectEventSpriteFlags() {
  objectEventSpriteFlags.fill(0);
  const base = instance.exports.gObjectEvents.value;
  for (let id = 0; id < 16; id++) {
    const event = base + id * 0x24;
    if (u8[event] & 1) objectEventSpriteFlags[u8[event + 4]] = 1;
  }
}

function render() {
  if (!presenter || presenterRecoveryPromise || runtimeStopped) return;
  updateVisualModeTransition();
  lastSceneKind = instance.exports.WasmDisplaySceneKind();
  const enhanced = activeVisualMode === 'hd2d' && lastSceneKind !== 0;
  // Scene kind 2 keeps the projected world under screen-space transition
  // effects, which the engine exports as a per-pixel composite.
  const screenEffects = enhanced && lastSceneKind === 2;
  if (enhanced) {
    instance.exports.WasmRenderHd2dFrame(screenEffects ? 1 : 0);
    refreshObjectEventSpriteFlags();
  } else instance.exports.WasmRenderFrame();
  presenter.present({
    finalPixels: image.data,
    worldPixels,
    worldStructuralAlphaPixels,
    worldHeightPixels,
    worldGroundHeightPixels,
    worldGeometryPixels,
    worldReceiverPixels,
    worldFacadePixels,
    worldGridOffsetX: instance.exports.WasmWorldGridOffsetX(),
    worldGridOffsetY: instance.exports.WasmWorldGridOffsetY(),
    worldPixelOriginX: instance.exports.WasmWorldPixelOriginX(),
    worldPixelOriginY: instance.exports.WasmWorldPixelOriginY(),
    layerPixels,
    objectIds,
    bgPriorities,
    objectSourcePixels,
    objectDescriptors,
    objectEventSpriteFlags,
    objectSourceCount: instance.exports.WasmDisplayObjectSourceCount(),
    objectPixels,
    objectPriorities,
    screenEffectPixels,
    screenEffectSources,
    enhanced,
    screenEffects,
    shading: renderedShadingStrength,
    perspective: activeVisualMode === 'hd2d' ? perspectiveStrength : 0,
    zoom: activeVisualMode === 'hd2d' ? zoomStrength : 0,
    optics: renderedOpticsStrength,
  });
}

function copy(src, dst, count, size, fill) {
  for (let i = 0; i < count; i++) {
    const from = fill ? src : src + i * size;
    u8.set(u8.subarray(from, from + size), dst + i * size);
  }
}

function lz77(src, dst) {
  const size = u8[src + 1] | (u8[src + 2] << 8) | (u8[src + 3] << 16);
  let s = src + 4;
  let d = dst;
  const end = dst + size;
  while (d < end) {
    const flags = u8[s++];
    for (let bit = 7; bit >= 0 && d < end; bit--) {
      if (flags & (1 << bit)) {
        const pair = (u8[s] << 8) | u8[s + 1];
        s += 2;
        let length = (pair >> 12) + 3;
        const disp = (pair & 0xfff) + 1;
        while (length-- && d < end) {
          u8[d] = u8[d - disp];
          d++;
        }
      } else {
        u8[d++] = u8[s++];
      }
    }
  }
}

function rl(src, dst) {
  const size = u8[src + 1] | (u8[src + 2] << 8) | (u8[src + 3] << 16);
  let s = src + 4;
  let d = dst;
  const end = dst + size;
  while (d < end) {
    const flag = u8[s++];
    if (flag & 0x80) {
      let count = (flag & 0x7f) + 3;
      const value = u8[s++];
      while (count-- && d < end) u8[d++] = value;
    } else {
      let count = (flag & 0x7f) + 1;
      while (count-- && d < end) u8[d++] = u8[s++];
    }
  }
}

function readCString(ptr) {
  let out = '';
  while (u8[ptr]) out += String.fromCharCode(u8[ptr++]);
  return out;
}

function readS16(ptr) {
  return u16[ptr >> 1] << 16 >> 16;
}

function readS32(ptr) {
  return (u16[ptr >> 1] | (u16[(ptr + 2) >> 1] << 16)) | 0;
}

function writeS16(ptr, value) {
  u16[ptr >> 1] = value & 0xffff;
}

function writeS32(ptr, value) {
  u16[ptr >> 1] = value & 0xffff;
  u16[(ptr + 2) >> 1] = (value >> 16) & 0xffff;
}

function affineTerms(xScale, yScale, rotation) {
  const angle = rotation * Math.PI * 2 / 0x10000;
  const sin = Math.sin(angle) * 256;
  const cos = Math.cos(angle) * 256;
  return {
    pa: cos * xScale / 256,
    pb: -sin * xScale / 256,
    pc: sin * yScale / 256,
    pd: cos * yScale / 256,
  };
}

function bgAffineSet(src, dest, count) {
  for (let i = 0; i < count; i++) {
    const s = src + i * 20;
    const d = dest + i * 16;
    const texX = readS32(s);
    const texY = readS32(s + 4);
    const scrX = readS16(s + 8);
    const scrY = readS16(s + 10);
    const { pa, pb, pc, pd } = affineTerms(readS16(s + 12), readS16(s + 14), u16[(s + 16) >> 1]);
    const a = pa | 0;
    const b = pb | 0;
    const c = pc | 0;
    const e = pd | 0;
    writeS16(d, a);
    writeS16(d + 2, b);
    writeS16(d + 4, c);
    writeS16(d + 6, e);
    writeS32(d + 8, (texX - scrX * a - scrY * b) | 0);
    writeS32(d + 12, (texY - scrX * c - scrY * e) | 0);
  }
}

function objAffineSet(src, dest, count, offset) {
  for (let i = 0; i < count; i++) {
    const s = src + i * 6;
    const d = dest + i * offset * 4;
    const { pa, pb, pc, pd } = affineTerms(readS16(s), readS16(s + 2), u16[(s + 4) >> 1]);
    writeS16(d, pa | 0);
    writeS16(d + offset, pb | 0);
    writeS16(d + offset * 2, pc | 0);
    writeS16(d + offset * 3, pd | 0);
  }
}

function copyOamMatrices(src, dest, dummy, oamCount, oamLimit) {
  const dummyWord0 = u32[dummy >> 2];
  const dummyWord1 = u32[(dummy + 4) >> 2];
  for (let entry = oamCount; entry < oamLimit; entry++) {
    const output = (dest + entry * 8) >> 2;
    u32[output] = dummyWord0;
    u32[output + 1] = dummyWord1;
  }
  for (let matrix = 0; matrix < 32; matrix++) {
    const source = (src + matrix * 8) >> 1;
    const output = (dest + matrix * 32 + 6) >> 1;
    u16[output] = u16[source];
    u16[output + 4] = u16[source + 1];
    u16[output + 8] = u16[source + 2];
    u16[output + 12] = u16[source + 3];
  }
}

function importsFor(module) {
  const env = {};
  for (const item of WebAssembly.Module.imports(module)) {
    if (item.kind !== 'function') continue;
    env[item.name] = (...args) => {
      switch (item.name) {
        case 'CpuSet': return copy(args[0], args[1], args[2] & 0x1fffff, (args[2] >>> 26) & 1 ? 4 : 2, (args[2] >>> 24) & 1);
        case 'CpuFastSet': return copy(args[0], args[1], args[2] & 0x1fffff, 4, (args[2] >>> 24) & 1);
        case 'LZ77UnCompWram':
        case 'LZ77UnCompVram': return lz77(args[0], args[1]);
        case 'RLUnCompWram':
        case 'RLUnCompVram': return rl(args[0], args[1]);
        case 'BgAffineSet': return bgAffineSet(args[0], args[1], args[2]);
        case 'ObjAffineSet': return objAffineSet(args[0], args[1], args[2], args[3]);
        case 'WasmCopyOamMatrices': return copyOamMatrices(args[0], args[1], args[2], args[3], args[4]);
        case 'Div': return args[1] ? (args[0] / args[1]) | 0 : 0;
        case 'Sqrt': return Math.sqrt(args[0]) | 0;
        case 'strcmp': return readCString(args[0]).localeCompare(readCString(args[1]));
        default: return 0;
      }
    };
  }
  return { env };
}

function writeKeys() {
  let held = 0;
  for (const key of pressed) held |= buttons[key] || 0;
  for (const key of pendingPresses.keys()) held |= buttons[key] || 0;
  u16[KEYINPUT >> 1] = KEY_MASK ^ held;
}

function stepPendingPresses() {
  for (const [key, frames] of pendingPresses) {
    if (frames <= 1) pendingPresses.delete(key);
    else pendingPresses.set(key, frames - 1);
  }
}

function setPressed(name, isPressed) {
  if (isPressed) {
    pressed.add(name);
    pendingPresses.set(name, 1);
  } else {
    pressed.delete(name);
  }
  document.querySelectorAll(`[data-key='${name}']`).forEach((el) => el.classList.toggle('pressed', isPressed));
  if (u16) writeKeys();
}

window.addEventListener('keydown', (event) => {
  const name = keyMap.get(event.code);
  if (!name) return;
  event.preventDefault();
  setPressed(name, true);
});

window.addEventListener('keyup', (event) => {
  const name = keyMap.get(event.code);
  if (!name) return;
  event.preventDefault();
  setPressed(name, false);
});

window.addEventListener('beforeunload', () => saveFlashIfChanged(true));
window.addEventListener('pagehide', () => saveFlashIfChanged(true));
window.addEventListener('visibilitychange', () => {
  if (document.visibilityState === 'hidden') saveFlashIfChanged(true);
});

document.querySelectorAll('[data-key]').forEach((button) => {
  const name = button.dataset.key;
  button.addEventListener('pointerdown', (event) => { event.preventDefault(); setPressed(name, true); });
  button.addEventListener('pointerup', () => setPressed(name, false));
  button.addEventListener('pointercancel', () => setPressed(name, false));
  button.addEventListener('pointerleave', () => setPressed(name, false));
});

speedButtons.forEach((button) => {
  button.addEventListener('click', () => {
    if (button.dataset.speed === 'unlimited') toggleUnlimitedSpeed();
    else if (button.dataset.speed === '1') setSpeed(1);
    else adjustSpeed(Number(button.dataset.speed));
    resetFpsCounters();
  });
});

renderScaleSelect.addEventListener('change', () => setRenderScale(renderScaleSelect.value));
visualModeSelect.addEventListener('change', () => setVisualSettings({
  mode: visualModeSelect.value,
  shading: shadingStrength,
  perspective: perspectiveStrength,
  zoom: zoomStrength,
  optics: opticsStrength,
}));
shadingInput.addEventListener('input', () => setVisualSettings({
  mode: visualMode,
  shading: Number(shadingInput.value) / 100,
  perspective: perspectiveStrength,
  zoom: zoomStrength,
  optics: opticsStrength,
}));
depthInput.addEventListener('input', () => setVisualSettings({
  mode: visualMode,
  shading: shadingStrength,
  perspective: Number(depthInput.value) / 100,
  zoom: zoomStrength,
  optics: opticsStrength,
}));
zoomInput.addEventListener('input', () => setVisualSettings({
  mode: visualMode,
  shading: shadingStrength,
  perspective: perspectiveStrength,
  zoom: Number(zoomInput.value) / 100,
  optics: opticsStrength,
}));
opticsInput.addEventListener('input', () => setVisualSettings({
  mode: visualMode,
  shading: shadingStrength,
  perspective: perspectiveStrength,
  zoom: zoomStrength,
  optics: Number(opticsInput.value) / 100,
}));

fullscreenButton.addEventListener('click', async () => {
  try {
    await toggleFullscreen();
  } catch (error) {
    console.error(error);
    statusEl.textContent = error.stack || String(error);
  }
});

document.addEventListener('fullscreenchange', updateFullscreenButton);
updateFullscreenButton();

downloadSaveButton.addEventListener('click', downloadSave);

uploadSaveInput.addEventListener('change', async () => {
  try {
    await uploadSave(uploadSaveInput.files[0]);
  } catch (error) {
    console.error(error);
    statusEl.textContent = error.stack || String(error);
  } finally {
    uploadSaveInput.value = '';
  }
});

function fpsStatus(displayFps, gameFps) {
  return `${statusText} — Display FPS: ${displayFps}, Game FPS: ${gameFps} (${(gameFps / 60).toFixed(1)}x)`;
}

function presenterOptions() {
  return {
    canvas,
    width: WIDTH,
    height: HEIGHT,
    worldWidth: instance.exports.WasmWorldWidth(),
    worldHeight: instance.exports.WasmWorldHeight(),
    scale: renderScale,
    onFailure: handlePresenterFailure,
  };
}

async function recoverPresenter(failedPresenter, error, kind) {
  const previousStatus = statusText;
  statusText = `recovering WebGPU after ${kind}…`;
  statusEl.textContent = statusText;
  failedPresenter.destroy();

  let replacement;
  try {
    replacement = await createPresenter(presenterOptions());
    if (replacement.failure) throw replacement.failure.error;
    if (runtimeStopped) {
      replacement.destroy();
      return;
    }
    presenter = replacement;
    statusText = previousStatus;
    statusEl.classList.remove('error');
    statusEl.removeAttribute('role');
    statusEl.textContent = `${statusText} — WebGPU recovered`;
  } catch (replacementError) {
    replacement?.destroy();
    const detail = replacementError instanceof Error ? replacementError.message : String(replacementError);
    stopRuntime(
      new Error(`${error.message} Presenter recreation failed: ${detail}. Reload the page; if this repeats, update the browser or graphics driver.`),
      'WebGPU recovery failed',
    );
  }
}

function handlePresenterFailure(failedPresenter, error, kind) {
  if (failedPresenter !== presenter || runtimeStopped) return presenterRecoveryPromise;
  console.error(error);
  if (presenterRecoveryPromise) return presenterRecoveryPromise;
  if (kind !== 'device lost') {
    stopRuntime(
      new Error(`${error.message} Reload the page; if this repeats, update the browser or graphics driver.`),
      'WebGPU error',
    );
    return null;
  }
  if (presenterRecreationCount >= 1) {
    stopRuntime(
      new Error(`${error.message} The replacement presenter also failed. Reload the page; if this repeats, update the browser or graphics driver.`),
      'WebGPU stopped',
    );
    return null;
  }

  presenterRecreationCount++;
  const recovery = recoverPresenter(failedPresenter, error, kind);
  presenterRecoveryPromise = recovery;
  void recovery.finally(() => {
    if (presenterRecoveryPromise === recovery) presenterRecoveryPromise = null;
  });
  return recovery;
}

async function boot(saveBytes) {
  const thisBootId = ++bootId;
  const { bytes, module } = await wasmModule();
  instance = await WebAssembly.instantiate(module, importsFor(module));
  memory = instance.exports.memory;
  if (!presenter) {
    presenter = await createPresenter(presenterOptions());
    if (presenter.failure) throw presenter.failure.error;
  }
  runtimeStopped = false;
  window.pokeemerald = { instance, memory, runFrames };
  instance.exports.WasmSetHd2dEnabled(activeVisualMode === 'hd2d' ? 1 : 0);
  if (automate) window.pokeemerald.automation = automationApi();
  refreshViews();
  refreshFrameImage();
  loadFlashSave(saveBytes);
  writeKeys();
  instance.exports.AgbMain();
  currentFrame = 0;
  gameFrameAccumulator = 0;
  resetFpsCounters();
  statusText = `running — WebGPU — ${(bytes.byteLength / 1024 / 1024).toFixed(1)} MiB wasm`;
  setSpeed(initialSpeed());
  statusEl.textContent = fpsStatus(0, 0);
  if (automate) {
    render();
    resolveAutomationReady();
  } else {
    lastTick = performance.now();
    requestAnimationFrame((now) => tick(thisBootId, now));
  }
}

function updateFps(frameCount) {
  renderedFrames++;
  emulatedFrames += frameCount;

  const now = performance.now();
  const elapsed = now - lastFpsUpdate;
  if (elapsed < 1000) return;

  const fps = Math.round(renderedFrames * 1000 / elapsed);
  const gameFps = Math.round(emulatedFrames * 1000 / elapsed);
  statusEl.textContent = fpsStatus(fps, gameFps);
  lastFpsUpdate = now;
  renderedFrames = 0;
  emulatedFrames = 0;
}

function runFrames(frameCount, keyMask = 0) {
  for (let i = 0; i < frameCount; i++) {
    if (keyMask) u16[KEYINPUT >> 1] = KEY_MASK ^ keyMask;
    else writeKeys();
    instance.exports.WasmRunFrame();
    currentFrame++;
    stepPendingPresses();
  }
  u16[KEYINPUT >> 1] = KEY_MASK;
  saveFlashIfChanged();
}

function setAutomationButton(name, isPressed) {
  if (!Object.hasOwn(buttons, name)) throw new Error(`unknown button: ${name}`);
  pendingPresses.delete(name);
  if (isPressed) pressed.add(name);
  else pressed.delete(name);
  document.querySelectorAll(`[data-key='${name}']`).forEach((el) => el.classList.toggle('pressed', isPressed));
  writeKeys();
}

function runToFrame(targetFrame) {
  if (!Number.isInteger(targetFrame) || targetFrame < currentFrame) {
    throw new Error(`cannot run from frame ${currentFrame} to ${targetFrame}`);
  }
  runFrames(targetFrame - currentFrame);
  render();
  return currentFrame;
}

function readU32(ptr) {
  return (u16[ptr >> 1] | (u16[(ptr + 2) >> 1] << 16)) >>> 0;
}

function hblankDmaWin0HProbe() {
  const src = 0x0203ff00;
  const dma = REG + REG_OFFSET_DMA0;
  const callDmaStop0 = () => {
    if (typeof instance.exports.WasmDmaStop0 !== 'function') throw new Error('WasmDmaStop0 export unavailable');
    instance.exports.WasmDmaStop0();
  };
  const probeMode = (destMode) => {
    writeS32(dma, src);
    writeS32(dma + 4, REG + REG_OFFSET_WIN0H);
    writeS32(dma + 8, 1 | ((DMA_ENABLE | DMA_START_HBLANK | DMA_REPEAT | destMode) << 16));

    instance.exports.WasmRefreshHblankDmaGpuRegs();
    const activeLine0 = instance.exports.WasmWindowMask(5, 0);
    const activeLine1 = instance.exports.WasmWindowMask(5, 1);
    const activeLine2 = instance.exports.WasmWindowMask(5, 2);
    const activeCached = Boolean(instance.exports.WasmHblankDmaGpuRegActive(REG_OFFSET_WIN0H));

    callDmaStop0();
    const stoppedControl = u16[(dma + 10) >> 1];
    instance.exports.WasmRefreshHblankDmaGpuRegs();
    const stoppedLine0 = instance.exports.WasmWindowMask(5, 0);
    const stoppedLine1 = instance.exports.WasmWindowMask(5, 1);
    const stoppedLine2 = instance.exports.WasmWindowMask(5, 2);

    return {
      activeLine0,
      activeLine1,
      activeLine2,
      activeCached,
      stoppedControl,
      stoppedLine0,
      stoppedLine1,
      stoppedLine2,
      stoppedCached: Boolean(instance.exports.WasmHblankDmaGpuRegActive(REG_OFFSET_WIN0H)),
    };
  };
  const saved = {
    dispcnt: u16[REG >> 1],
    win0h: u16[(REG + REG_OFFSET_WIN0H) >> 1],
    win0v: u16[(REG + REG_OFFSET_WIN0V) >> 1],
    winin: u16[(REG + REG_OFFSET_WININ) >> 1],
    winout: u16[(REG + REG_OFFSET_WINOUT) >> 1],
    src0: u16[src >> 1],
    src1: u16[(src + 2) >> 1],
    dmaSrc: readU32(dma),
    dmaDest: readU32(dma + 4),
    dmaControl: readU32(dma + 8),
  };
  let result;

  try {
    u16[REG >> 1] = 0x2000;
    u16[(REG + REG_OFFSET_WIN0H) >> 1] = (20 << 8) | 30;
    u16[(REG + REG_OFFSET_WIN0V) >> 1] = HEIGHT;
    u16[(REG + REG_OFFSET_WININ) >> 1] = 0x3f;
    u16[(REG + REG_OFFSET_WINOUT) >> 1] = 0;
    u16[src >> 1] = 10;
    u16[(src + 2) >> 1] = (20 << 8) | 30;

    result = {
      fixed: probeMode(DMA_DEST_FIXED),
      reload: probeMode(DMA_DEST_RELOAD),
    };
  } finally {
    u16[REG >> 1] = saved.dispcnt;
    u16[(REG + REG_OFFSET_WIN0H) >> 1] = saved.win0h;
    u16[(REG + REG_OFFSET_WIN0V) >> 1] = saved.win0v;
    u16[(REG + REG_OFFSET_WININ) >> 1] = saved.winin;
    u16[(REG + REG_OFFSET_WINOUT) >> 1] = saved.winout;
    u16[src >> 1] = saved.src0;
    u16[(src + 2) >> 1] = saved.src1;
    writeS32(dma, saved.dmaSrc);
    writeS32(dma + 4, saved.dmaDest);
    writeS32(dma + 8, saved.dmaControl);
    instance.exports.WasmRefreshHblankDmaGpuRegs();
  }

  return result;
}

function automationState() {
  const saveBlock1 = readU32(instance.exports.gSaveBlock1Ptr.value);
  const saveBlock2 = readU32(instance.exports.gSaveBlock2Ptr.value);
  const playerAvatar = instance.exports.gPlayerAvatar.value;
  const objectEventId = u8[playerAvatar + 5];
  const objectEvent = instance.exports.gObjectEvents.value + objectEventId * 0x24;
  return {
    frame: currentFrame,
    presenter: presenter?.kind ?? null,
    presenterRecreations: presenterRecreationCount,
    presenterRecovering: Boolean(presenterRecoveryPromise),
    runtimeStopped,
    visualMode,
    activeVisualMode,
    shadingStrength,
    perspectiveStrength,
    zoomStrength,
    opticsStrength,
    renderedShadingStrength,
    renderedPerspectiveStrength: activeVisualMode === 'hd2d' ? perspectiveStrength : 0,
    renderedZoomStrength: activeVisualMode === 'hd2d' ? zoomStrength : 0,
    renderedOpticsStrength,
    visualModeTransition: visualModeTransition ? 'hd2d' : null,
    sceneKind: lastSceneKind,
    blendControl: u16[(REG + 0x50) >> 1],
    renderScale,
    outputWidth: canvas.width,
    outputHeight: canvas.height,
    trainerId: u16[(saveBlock2 + SAVE_BLOCK2_TRAINER_ID_OFFSET) >> 1],
    runningShoes: Boolean(instance.exports.FlagGet(RUNNING_SHOES_FLAG)),
    avatarFlags: u8[instance.exports.gPlayerAvatar.value],
    avatarTransitionFlags: u8[instance.exports.gPlayerAvatar.value + 1],
    avatarRunningState: u8[instance.exports.gPlayerAvatar.value + 2],
    avatarPreventStep: u8[instance.exports.gPlayerAvatar.value + 6],
    x: readS16(saveBlock1),
    y: readS16(saveBlock1 + 2),
    mapGroup: u8[saveBlock1 + 4],
    mapNum: u8[saveBlock1 + 5],
    elevation: u8[objectEvent + 0x0b] & 0x0f,
    objectX: readS16(objectEvent + 0x10),
    objectY: readS16(objectEvent + 0x12),
    objectEventId,
    littlerootTownState: instance.exports.VarGet(0x4050),
    birchLabState: instance.exports.VarGet(0x4084),
    littlerootRivalState: instance.exports.VarGet(0x408d),
    littlerootIntroState: instance.exports.VarGet(0x4092),
    oldaleRivalState: instance.exports.VarGet(0x40c7),
    starterMon: instance.exports.VarGet(0x4023),
  };
}

async function benchmarkPresentation(frameCount = 120) {
  if (!Number.isInteger(frameCount) || frameCount < 1 || frameCount > 600)
    throw new Error('benchmark frame count must be between 1 and 600');
  await presenter.ready();
  const start = performance.now();
  for (let i = 0; i < frameCount; i++) render();
  await presenter.ready();
  const elapsedMs = performance.now() - start;
  return { frameCount, elapsedMs, fps: frameCount * 1000 / elapsedMs, renderScale, width: canvas.width, height: canvas.height };
}

function automationObjectEvents() {
  const base = instance.exports.gObjectEvents.value;
  const events = [];
  for (let id = 0; id < 16; id++) {
    const offset = base + id * 0x24;
    if (!(u8[offset] & 1)) continue;
    events.push({
      id,
      spriteId: u8[offset + 4],
      graphicsId: u8[offset + 5],
      localId: u8[offset + 8],
      mapNum: u8[offset + 9],
      mapGroup: u8[offset + 10],
      x: readS16(offset + 0x10),
      y: readS16(offset + 0x12),
      player: (u8[offset + 2] & 1) !== 0,
    });
  }
  return events;
}

function automationObjectDescriptors() {
  const count = instance.exports.WasmDisplayObjectSourceCount();
  const ptr = instance.exports.WasmDisplayObjectDescriptorBuffer();
  const words = new Int32Array(memory.buffer, ptr, count * 16);
  return Array.from({ length: count }, (_, layer) => {
    const o = layer * 16;
    return {
      layer, oamId: words[o], x: words[o + 1], y: words[o + 2],
      anchorX: words[o + 3], anchorY: words[o + 4],
      sourceW: words[o + 5], sourceH: words[o + 6],
      drawW: words[o + 7], drawH: words[o + 8], priority: words[o + 9],
      spriteId: words[o + 10], affine: words[o + 11],
      pa: words[o + 12], pb: words[o + 13], pc: words[o + 14], pd: words[o + 15],
    };
  });
}

function automationWeather(weather) {
  if (!Number.isInteger(weather) || weather < 0 || weather > 15)
    throw new Error(`invalid weather ${weather}`);
  return instance.exports.WasmSetAutomationWeather(weather) !== 0;
}

function automationAvatar(mode) {
  const flags = { 'on-foot': 1, 'mach-bike': 2, 'acro-bike': 4, surfing: 8, underwater: 16 }[mode];
  if (!flags) throw new Error(`unknown avatar mode ${mode}`);
  if (mode === 'mach-bike' || mode === 'acro-bike') {
    instance.exports.SetPlayerAvatarStateMask(1);
    instance.exports.GetOnOffBike(flags);
    return;
  }
  instance.exports.SetPlayerAvatarStateMask(flags);
  instance.exports.SetPlayerAvatarTransitionFlags(flags);
}

function automationWarp(mapGroup, mapNum, x, y) {
  for (const value of [mapGroup, mapNum, x, y])
    if (!Number.isInteger(value)) throw new Error('warp arguments must be integers');
  instance.exports.SetWarpDestination(mapGroup, mapNum, -1, x, y);
  instance.exports.DoWarp();
  instance.exports.ResetInitialPlayerAvatarState();
}

function automationBattleTransition(transition) {
  if (!Number.isInteger(transition) || transition < 0 || transition >= BATTLE_TRANSITION_COUNT)
    throw new Error('invalid battle transition');
  instance.exports.BattleTransition_StartOnField(transition);
}

async function automationLoadSave(encoded) {
  const bytes = base64ToBytes(encoded);
  const normalized = normalizeSaveForCurrentBuild(bytes);
  if (!normalized) throw new Error('automation save is not a valid Emerald save');
  await restartWithSave(normalized);
}

async function automationSimulateDeviceLoss() {
  if (!presenter || presenterRecoveryPromise) throw new Error('WebGPU presenter is not ready for a simulated loss');
  const failedPresenter = presenter;
  await failedPresenter.simulateDeviceLoss();
  await Promise.resolve();
  if (presenterRecoveryPromise) await presenterRecoveryPromise;
  if (runtimeStopped) throw new Error(statusEl.textContent);
  render();
  return automationState();
}

function automationMapGrid(radius = 14) {
  if (!Number.isInteger(radius) || radius < 1 || radius > 32) throw new Error('invalid map-grid radius');
  const state = automationState();
  const cells = [];
  for (let y = state.y - radius; y <= state.y + radius; y++) {
    const row = [];
    for (let x = state.x - radius; x <= state.x + radius; x++) {
      row.push({
        x,
        y,
        metatileId: instance.exports.MapGridGetMetatileIdAt(x + 7, y + 7),
        collision: instance.exports.MapGridGetCollisionAt(x + 7, y + 7),
        elevation: instance.exports.MapGridGetElevationAt(x + 7, y + 7),
        behavior: instance.exports.MapGridGetMetatileBehaviorAt(x + 7, y + 7),
      });
    }
    cells.push(row);
  }
  return {state, radius, cells};
}

function automationHd2dCourses(radius = 12) {
  if (!Number.isInteger(radius) || radius < 1 || radius > 32) throw new Error('invalid HD-2D course radius');
  const worldWidth = instance.exports.WasmWorldWidth();
  const worldHeight = instance.exports.WasmWorldHeight();
  const heights = new Int16Array(memory.buffer, instance.exports.WasmWorldHeightBuffer(), instance.exports.WasmWorldHeightBufferSize() / 2);
  const grounds = new Int16Array(memory.buffer, instance.exports.WasmWorldGroundHeightBuffer(), instance.exports.WasmWorldGroundHeightBufferSize() / 2);
  const geometry = new Uint16Array(memory.buffer, instance.exports.WasmWorldGeometryBuffer(), instance.exports.WasmWorldGeometryBufferSize() / 2);
  const receivers = new Uint16Array(memory.buffer, instance.exports.WasmWorldReceiverBuffer(), instance.exports.WasmWorldReceiverBufferSize() / 2);
  const facades = new Uint32Array(memory.buffer, instance.exports.WasmWorldFacadeBuffer(), instance.exports.WasmWorldFacadeBufferSize() / 4);
  const cx = Math.floor(worldWidth / 2);
  const cy = Math.floor(worldHeight / 2);
  const gridOffsetX = instance.exports.WasmWorldGridOffsetX();
  const gridOffsetY = instance.exports.WasmWorldGridOffsetY();
  const terrainOriginX = gridOffsetX - 8;
  const terrainOriginY = gridOffsetY - 8;
  const anchorX = terrainOriginX + Math.floor((cx - terrainOriginX) / 8) * 8 + 4;
  const anchorY = terrainOriginY + Math.floor((cy - terrainOriginY) / 8) * 8 + 4;
  const worldOriginX = instance.exports.WasmWorldPixelOriginX();
  const worldOriginY = instance.exports.WasmWorldPixelOriginY();
  const rows = [];
  for (let dy = -radius; dy <= radius; dy++) {
    const row = [];
    for (let dx = -radius; dx <= radius; dx++) {
      const px = Math.min(worldWidth - 1, Math.max(0, anchorX + dx * 8));
      const py = Math.min(worldHeight - 1, Math.max(0, anchorY + dy * 8));
      const i = py * worldWidth + px;
      const mapX = Math.floor((worldOriginX + px) / 16);
      const mapY = Math.floor((worldOriginY + py) / 16);
      const metatileId = instance.exports.MapGridGetMetatileIdAt(mapX, mapY);
      row.push({
        mapX,
        mapY,
        metatileId,
        collision: instance.exports.MapGridGetCollisionAt(mapX, mapY),
        h: heights[i],
        g: grounds[i],
        geo: geometry[i],
        receiver: receivers[i],
        facade: facades[i],
        terrace: instance.exports.WasmHdTerraceCellAt?.(mapX, mapY) ?? 0,
      });
    }
    rows.push(row);
  }
  return {
    worldWidth, worldHeight, cx, cy, gridOffsetX, gridOffsetY,
    anchorX, anchorY, worldOriginX, worldOriginY, radius, rows,
  };
}

function imageDataUrl(pixels, width, height) {
  const canvas = document.createElement('canvas');
  canvas.width = width;
  canvas.height = height;
  canvas.getContext('2d').putImageData(new ImageData(pixels, width, height), 0, 0);
  return canvas.toDataURL('image/png');
}

function automationWorldAtlas() {
  const worldWidth = instance.exports.WasmWorldWidth();
  const worldHeight = instance.exports.WasmWorldHeight();
  const pixels = new Uint8ClampedArray(memory.buffer, instance.exports.WasmWorldBuffer(), worldWidth * worldHeight * 4);
  return { worldWidth, worldHeight, dataUrl: imageDataUrl(pixels.slice(), worldWidth, worldHeight) };
}

function automationHeightMap() {
  const worldWidth = instance.exports.WasmWorldWidth();
  const worldHeight = instance.exports.WasmWorldHeight();
  const heights = new Int16Array(memory.buffer, instance.exports.WasmWorldHeightBuffer(), worldWidth * worldHeight);
  const geometry = new Uint16Array(memory.buffer, instance.exports.WasmWorldGeometryBuffer(), worldWidth * worldHeight);
  const pixels = new Uint8ClampedArray(worldWidth * worldHeight * 4);
  for (let i = 0; i < worldWidth * worldHeight; i++) {
    const value = Math.max(0, Math.min(255, Math.round((heights[i] + 8) * 255 / 40)));
    const surface = geometry[i] & HD2D_SURFACE_MASK;
    let red = value;
    let green = value;
    let blue = value;
    if (surface === HD2D_SURFACE_WATER) { red = value * 0.3; green = value * 0.5; blue = 255; }
    else if (surface === HD2D_SURFACE_DECK) { red = 255; green = value * 0.4; blue = value * 0.4; }
    else if (surface === HD2D_SURFACE_TERRAIN) { red = value * 0.3; green = 255; blue = value * 0.3; }
    else if (surface === HD2D_SURFACE_OBSTACLE) { red = 255; green = 255; blue = value * 0.3; }
    else if (surface === HD2D_SURFACE_OPEN_DECK) { red = value * 0.8; green = 255; blue = value * 0.6; }
    pixels[i * 4] = red;
    pixels[i * 4 + 1] = green;
    pixels[i * 4 + 2] = blue;
    pixels[i * 4 + 3] = 255;
  }
  return { worldWidth, worldHeight, dataUrl: imageDataUrl(pixels, worldWidth, worldHeight) };
}

function automationEncounters(enabled) {
  instance.exports.DisableWildEncounters(enabled ? 0 : 1);
}

function automationRunningShoes(enabled) {
  if (enabled) instance.exports.FlagSet(RUNNING_SHOES_FLAG);
  else instance.exports.FlagClear(RUNNING_SHOES_FLAG);
}

function automationApi() {
  return {
    ready: automationReady,
    loadSave: automationLoadSave,
    setEncounters: automationEncounters,
    setRunningShoes: automationRunningShoes,
    mapGrid: automationMapGrid,
    hd2dCourses: automationHd2dCourses,
    worldAtlas: automationWorldAtlas,
    heightMap: automationHeightMap,
    setButton: setAutomationButton,
    setAvatar: automationAvatar,
    setWeather: automationWeather,
    setVisualMode: (mode, animate = true) => setVisualSettings({
      mode,
      shading: shadingStrength,
      perspective: perspectiveStrength,
      zoom: zoomStrength,
      optics: opticsStrength,
    }, false, animate),
    startNewGame: () => instance.exports.WasmStartNewGameForAutomation(),
    warp: automationWarp,
    startBattleTransition: automationBattleTransition,
    runToFrame,
    screenshot: async () => { await presenter.ready(); return canvas.toDataURL('image/png'); },
    benchmarkPresentation,
    objectDescriptors: automationObjectDescriptors,
    objectEvents: automationObjectEvents,
    hblankDmaWin0HProbe,
    simulateDeviceLoss: automationSimulateDeviceLoss,
    state: automationState,
    frame: () => currentFrame,
  };
}

function runFramesForTick(elapsedMs) {
  const start = performance.now();
  const frameBudgetMs = speed === Infinity ? elapsedMs : FAST_FRAME_BUDGET_MS;
  let frameCount;

  if (speed === Infinity) {
    gameFrameAccumulator = 0;
    frameCount = Infinity;
  } else {
    gameFrameAccumulator += speed * elapsedMs / (1000 / 60);
    frameCount = Math.floor(gameFrameAccumulator);
    if (frameCount === 0) return 0;
  }

  let frames = 0;
  while (frames < frameCount && performance.now() - start < frameBudgetMs) {
    const batchSize = Math.min(frameCount - frames, 256);
    runFrames(batchSize);
    frames += batchSize;
  }
  if (speed !== Infinity) gameFrameAccumulator -= frames;
  return frames;
}

function tick(thisBootId, now) {
  if (thisBootId !== bootId || runtimeStopped) return;
  try {
    if (presenterRecoveryPromise) {
      lastTick = now;
      requestAnimationFrame((nextNow) => tick(thisBootId, nextNow));
      return;
    }
    const elapsedMs = Math.min(now - lastTick, 100);
    lastTick = now;
    const frames = runFramesForTick(elapsedMs);
    render();
    updateFps(frames);
    if (!runtimeStopped) requestAnimationFrame((nextNow) => tick(thisBootId, nextNow));
  } catch (error) {
    console.error(error);
    stopRuntime(error, 'The game stopped');
  }
}

boot().catch((error) => {
  console.error(error);
  stopRuntime(error, 'Unable to start');
});
