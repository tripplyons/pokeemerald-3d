#if WASM

#include "global.h"
#include "constants/weather.h"
#include "constants/map_types.h"
#include "constants/metatile_behaviors.h"
#include "gba/defines.h"
#include "gba/io_reg.h"
#include "field_weather.h"
#include "main.h"
#include "overworld.h"
#include "field_camera.h"
#include "fieldmap.h"
#include "metatile_behavior.h"
#include "sprite.h"

extern u32 WasmOamCount(void);
extern u32 WasmOamSpriteId(u32 oamIndex);
extern s32 WasmOamScreenX(u32 oamIndex);
extern s32 WasmOamScreenY(u32 oamIndex);
extern u32 WasmTilesetAnimationFrame(bool8 secondary);
extern void WasmApplyTilesetAnimations(const struct Tileset *tileset, u8 *dest, u16 *palettes,
                                        u16 *displayPalettes, u32 firstFrame, u32 lastFrame);

#define DISPLAY_WIDTH 240
#define DISPLAY_HEIGHT 160
#define DISPLAY_PIXELS (DISPLAY_WIDTH * DISPLAY_HEIGHT)
#define HD2D_WORLD_WIDTH 800
#define HD2D_WORLD_HEIGHT 768
#define HD2D_WORLD_PIXELS (HD2D_WORLD_WIDTH * HD2D_WORLD_HEIGHT)
#define HD2D_TILE_WIDTH 8
#define HD2D_GEOMETRY_RADIUS 8
#define HD2D_SAMPLE_COLS (HD2D_WORLD_WIDTH / 16 + HD2D_GEOMETRY_RADIUS * 2 + 2)
#define HD2D_SAMPLE_ROWS (HD2D_WORLD_HEIGHT / 16 + HD2D_GEOMETRY_RADIUS * 2 + 2)
#define HD2D_GEOMETRY_CACHE_COUNT 8
#define HD2D_DECODED_COURSE_CACHE_COUNT 4096
#define HD2D_GEOMETRY_VALID_BYTES (NUM_METATILES_TOTAL / 8)
#define HD2D_COURSE_HEIGHT 8
#define HD2D_COURSE_COLS (HD2D_SAMPLE_COLS * 2)
#define HD2D_COURSE_ROWS (HD2D_SAMPLE_ROWS * 2)
#define HD2D_COURSE_COUNT (HD2D_COURSE_COLS * HD2D_COURSE_ROWS)
#define HD2D_SURFACE_BITS 3
#define HD2D_SURFACE_MASK ((1 << HD2D_SURFACE_BITS) - 1)
#define HD2D_COMPONENT_SHIFT HD2D_SURFACE_BITS
#define HD2D_COMPONENT_MAX (0xffff >> HD2D_COMPONENT_SHIFT)
#define HD2D_RECEIVER_VALID 0x8000
#define HD2D_RECEIVER_OFFSET_MASK 31
#define HD2D_RECEIVER_OFFSET_BIAS 16
#define HD2D_RECEIVER_DX_SHIFT HD2D_SURFACE_BITS
#define HD2D_RECEIVER_DY_SHIFT 8
#define HD2D_FACADE_ROOF_OVERHANG 0x80000000
#define HD2D_FACADE_STEPPED_TIER  0x40000000
#define HD2D_BUILDING_COUNT (HD2D_SAMPLE_COLS * HD2D_SAMPLE_ROWS)
#define HD2D_WORLD_OFFSET_X ((HD2D_WORLD_WIDTH - DISPLAY_WIDTH) / 2)
#define HD2D_WORLD_OFFSET_Y ((HD2D_WORLD_HEIGHT - DISPLAY_HEIGHT) / 2)
#define RGBA_CHANNELS 4
#define OBJECT_SOURCE_SIZE 64
#define OBJECT_DESCRIPTOR_WORDS 16
#define OAM_ENTRY_COUNT 128

void WasmStartNewGameForAutomation(void)
{
    gMain.state = 0;
    CB2_NewGame();
}

enum HdSurface
{
    HD_SURFACE_GROUND,
    HD_SURFACE_WATER,
    HD_SURFACE_DECK,
    HD_SURFACE_TERRAIN,
    HD_SURFACE_OBSTACLE,
    HD_SURFACE_WALL,
    HD_SURFACE_ROOF,
    HD_SURFACE_OPEN_DECK = 7,
};

typedef char HdSurfaceOpenDeckFitsPackedGeometry[
    HD_SURFACE_OPEN_DECK <= HD2D_SURFACE_MASK ? 1 : -1];

#define HD2D_RECEIVER_TERRAIN_FACE 0x4000
#define HD2D_RECEIVER_TERRAIN_FACE_SOUTH 0x20
#define HD2D_RECEIVER_TERRAIN_FACE_SELF 0x40
#define HD2D_CLIFF_BAND_MIN_WIDTH 4
#define HD2D_CLIFF_BAND_MIN_SHORT_WIDTH 3
#define HD2D_CLIFF_BAND_MAX_HEIGHT 120

#define LAYER_BG0 0x01
#define LAYER_BG1 0x02
#define LAYER_BG2 0x04
#define LAYER_BG3 0x08
#define LAYER_OBJ 0x10
#define LAYER_BACKDROP 0x20
#define WINDOW_ALL_LAYERS 0x3f

#define REG_OFFSET_DMA0 0xb0
#define DMA_REG_SIZE 12
#define DMA_DEST_MASK 0x0060
#define DMA_DEST_FIXED 0x0040
#define DMA_DEST_RELOAD 0x0060
#define DMA_SRC_MASK 0x0180
#define DMA_SRC_DEC 0x0080
#define DMA_SRC_FIXED 0x0100
#define DMA_REPEAT 0x0200
#define DMA_32BIT 0x0400
#define DMA_START_HBLANK 0x2000
#define DMA_START_MASK 0x3000
#define DMA_ENABLE 0x8000
#define GPU_REG_U16_COUNT (REG_OFFSET_DMA0 / 2)

struct Rgb
{
    u8 r;
    u8 g;
    u8 b;
};

struct HblankDmaGpuReg
{
    bool8 active;
    u32 src;
    s32 stride;
};

struct BgLayer
{
    u8 bg;
    u8 type;
};

static bool8 sWasmHd2dEnabled;
static u8 sWasmDisplayRgba[DISPLAY_PIXELS * RGBA_CHANNELS];
static u8 sWasmWorldRgba[HD2D_WORLD_PIXELS * RGBA_CHANNELS];
static u8 sWasmWorldStructuralAlpha[HD2D_WORLD_PIXELS];
static u8 sWasmWorldLayerData[HD2D_WORLD_PIXELS];
static u8 sWasmBgPriorityData[HD2D_WORLD_PIXELS];
static s8 sWasmWorldHeightData[HD2D_WORLD_PIXELS];
static s8 sWasmWorldGroundHeightData[HD2D_WORLD_PIXELS];
static u16 sWasmWorldGeometryData[HD2D_WORLD_PIXELS];
static u16 sWasmWorldReceiverData[HD2D_WORLD_PIXELS];
static u32 sWasmWorldFacadeData[HD2D_WORLD_PIXELS];
static s32 sWasmWorldPixelOriginX;
static s32 sWasmWorldPixelOriginY;
static s32 sHdDebugMinMapX;
static s32 sHdDebugMinMapY;
static u32 sHdDebugSampleCols;
static u32 sHdDebugSampleRows;
static u8 sWasmObjectRgba[DISPLAY_PIXELS * RGBA_CHANNELS];
static u8 sWasmObjectIdData[DISPLAY_PIXELS];
static u8 sObjectSourceRgba[128 * OBJECT_SOURCE_SIZE * OBJECT_SOURCE_SIZE * RGBA_CHANNELS];
static s32 sObjectDescriptors[128 * OBJECT_DESCRIPTOR_WORDS];
static u32 sObjectSourceCount;
static u8 sLayerData[DISPLAY_PIXELS];
static u8 sObjectIdData[DISPLAY_PIXELS];
static s16 sObjectAnchors[128 * 2];
static u8 sObjectPriorities[128];
static u8 sCurrentObjectId;
static bool8 sRenderingObjectPass;
static struct HblankDmaGpuReg sHblankDmaGpuRegs[GPU_REG_U16_COUNT];

static inline u8 *Ptr8(u32 address)
{
    return (u8 *)address;
}

static inline u16 *Ptr16(u32 address)
{
    return (u16 *)address;
}

static inline u16 ReadU16(u32 address)
{
    return *Ptr16(address);
}

static inline u32 ReadU32(u32 address)
{
    return ((u32)ReadU16(address)) | ((u32)ReadU16(address + 2) << 16);
}

static inline s16 Signed16(u16 value)
{
    return (s16)value;
}

static inline s32 Signed28(u32 value)
{
    return ((s32)(value << 4)) >> 4;
}

static inline u32 Word(u32 offset)
{
    return ReadU32(REG_BASE + offset);
}

static inline u8 ClampBlend(u32 value)
{
    return value > 255 ? 255 : value;
}

static inline struct Rgb GbaColor(u16 value)
{
    struct Rgb color;
    color.r = (u8)((value & 31) * 255 / 31);
    color.g = (u8)(((value >> 5) & 31) * 255 / 31);
    color.b = (u8)(((value >> 10) & 31) * 255 / 31);
    return color;
}

static bool8 InWindowRange(u8 value, u16 range)
{
    const u8 start = range >> 8;
    const u8 end = range & 0xff;

    return start <= end ? value >= start && value < end : value >= start || value < end;
}

static void RefreshHblankDmaGpuRegs(void)
{
    u32 i;

    for (i = 0; i < GPU_REG_U16_COUNT; i++)
        sHblankDmaGpuRegs[i].active = FALSE;

    for (u32 channel = 0; channel < 4; channel++)
    {
        const u32 dma = REG_BASE + REG_OFFSET_DMA0 + channel * DMA_REG_SIZE;
        const u16 control = ReadU16(dma + 10);
        u16 destMode;
        u16 srcMode;
        u32 dest;
        s32 offset;

        if (!(control & DMA_ENABLE)
         || !(control & DMA_REPEAT)
         || (control & DMA_START_MASK) != DMA_START_HBLANK
         || (control & DMA_32BIT)
         || ReadU16(dma + 8) != 1)
            continue;

        destMode = control & DMA_DEST_MASK;
        if (destMode != DMA_DEST_FIXED && destMode != DMA_DEST_RELOAD)
            continue;

        dest = ReadU32(dma + 4);
        offset = (s32)(dest - REG_BASE);
        if (offset < 0 || offset >= REG_OFFSET_DMA0 || (offset & 1))
            continue;
        if (sHblankDmaGpuRegs[offset >> 1].active)
            continue;

        srcMode = control & DMA_SRC_MASK;
        sHblankDmaGpuRegs[offset >> 1].active = TRUE;
        sHblankDmaGpuRegs[offset >> 1].src = ReadU32(dma);
        sHblankDmaGpuRegs[offset >> 1].stride = srcMode == DMA_SRC_FIXED ? 0 : srcMode == DMA_SRC_DEC ? -2 : 2;
    }
}

static u16 ScanlineGpuReg(u32 offset, u8 y)
{
    struct HblankDmaGpuReg *dma;

    if (offset < REG_OFFSET_DMA0)
    {
        dma = &sHblankDmaGpuRegs[offset >> 1];
        if (dma->active && y > 0)
        {
            const u32 ptr = dma->src + dma->stride * (y - 1);
            return ReadU16(ptr);
        }
    }

    return ReadU16(REG_BASE + offset);
}

static u8 WindowMask(u8 x, u8 y)
{
    const u16 dispcnt = REG_DISPCNT;
    const u16 windowsEnabled = dispcnt & 0xe000;

    if (!windowsEnabled)
        return WINDOW_ALL_LAYERS;

    if ((dispcnt & 0x2000)
     && InWindowRange(x, ScanlineGpuReg(REG_OFFSET_WIN0H, y))
     && InWindowRange(y, REG_WIN0V))
        return REG_WININ & WINDOW_ALL_LAYERS;

    if ((dispcnt & 0x4000)
     && InWindowRange(x, ScanlineGpuReg(REG_OFFSET_WIN1H, y))
     && InWindowRange(y, REG_WIN1V))
        return (REG_WININ >> 8) & WINDOW_ALL_LAYERS;

    return REG_WINOUT & WINDOW_ALL_LAYERS;
}

static struct Rgb ActiveBlendColor(struct Rgb color, u8 layer, u32 pixel, bool8 effectsEnabled, u8 y, bool8 forceAlphaBlend)
{
    const u16 bldcnt = REG_BLDCNT;
    const u8 effect = (bldcnt >> 6) & 3;
    const u8 sourceTargets = bldcnt & WINDOW_ALL_LAYERS;
    const bool8 isSourceTarget = (sourceTargets & layer) || (forceAlphaBlend && effect == 1);
    u8 evy;

    if ((!effectsEnabled && !(forceAlphaBlend && effect == 1)) || !isSourceTarget || effect == 0)
        return color;

    if (effect == 1 && ((bldcnt >> 8) & sLayerData[pixel]))
    {
        const u16 alpha = REG_BLDALPHA;
        const u8 eva = (alpha & 0x1f) > 16 ? 16 : alpha & 0x1f;
        const u8 evb = ((alpha >> 8) & 0x1f) > 16 ? 16 : (alpha >> 8) & 0x1f;
        struct Rgb blended;
        const u32 p = pixel * RGBA_CHANNELS;

        blended.r = ClampBlend(((u32)color.r * eva + (u32)sWasmDisplayRgba[p] * evb) >> 4);
        blended.g = ClampBlend(((u32)color.g * eva + (u32)sWasmDisplayRgba[p + 1] * evb) >> 4);
        blended.b = ClampBlend(((u32)color.b * eva + (u32)sWasmDisplayRgba[p + 2] * evb) >> 4);
        return blended;
    }

    evy = ScanlineGpuReg(REG_OFFSET_BLDY, y) & 0x1f;
    if (evy > 16)
        evy = 16;

    if (effect == 2)
    {
        color.r = color.r + (((255 - color.r) * evy) >> 4);
        color.g = color.g + (((255 - color.g) * evy) >> 4);
        color.b = color.b + (((255 - color.b) * evy) >> 4);
    }
    else if (effect == 3)
    {
        color.r = color.r - ((color.r * evy) >> 4);
        color.g = color.g - ((color.g * evy) >> 4);
        color.b = color.b - ((color.b * evy) >> 4);
    }

    return color;
}

static void PutPixel(s32 x, s32 y, struct Rgb color, u8 layer, bool8 forceAlphaBlend)
{
    u8 mask;
    u32 pixel;
    u32 p;

    if (x < 0 || y < 0 || x >= DISPLAY_WIDTH || y >= DISPLAY_HEIGHT)
        return;

    mask = WindowMask(x, y);
    if (layer != LAYER_BACKDROP && !(mask & layer))
        return;

    pixel = y * DISPLAY_WIDTH + x;
    const bool8 rawAlpha = sRenderingObjectPass && layer == LAYER_OBJ
                        && (REG_BLDCNT & (3 << 6)) == BLDCNT_EFFECT_BLEND
                        && (forceAlphaBlend || (REG_BLDCNT & BLDCNT_TGT1_OBJ));
    if (!rawAlpha)
        color = ActiveBlendColor(color, layer, pixel, mask & LAYER_BACKDROP, y, forceAlphaBlend);
    p = pixel * RGBA_CHANNELS;
    sWasmDisplayRgba[p] = color.r;
    sWasmDisplayRgba[p + 1] = color.g;
    sWasmDisplayRgba[p + 2] = color.b;
    if (rawAlpha)
    {
        const u8 eva = (REG_BLDALPHA & 0x1f) > 16 ? 16 : REG_BLDALPHA & 0x1f;
        sWasmDisplayRgba[p + 3] = eva * 255 / 16;
    }
    else
        sWasmDisplayRgba[p + 3] = 255;
    sLayerData[pixel] = layer;
    sObjectIdData[pixel] = layer == LAYER_OBJ ? sCurrentObjectId : 0xff;
}

static void ClearScreen(void)
{
    const struct Rgb color = GbaColor(ReadU16(BG_PLTT));

    for (u32 y = 0; y < DISPLAY_HEIGHT; y++)
        for (u32 x = 0; x < DISPLAY_WIDTH; x++)
            PutPixel(x, y, color, LAYER_BACKDROP, FALSE);
}

static void ClearTransparent(void)
{
    for (u32 i = 0; i < DISPLAY_PIXELS; i++)
    {
        const u32 p = i * RGBA_CHANNELS;
        sWasmDisplayRgba[p] = 0;
        sWasmDisplayRgba[p + 1] = 0;
        sWasmDisplayRgba[p + 2] = 0;
        sWasmDisplayRgba[p + 3] = 0;
        sLayerData[i] = LAYER_BACKDROP;
        sObjectIdData[i] = 0xff;
    }
}

static void RenderBitmapMode3(void)
{
    for (u32 i = 0; i < DISPLAY_PIXELS; i++)
    {
        const struct Rgb color = GbaColor(ReadU16(VRAM + i * 2));
        const u32 p = i * RGBA_CHANNELS;
        sWasmDisplayRgba[p] = color.r;
        sWasmDisplayRgba[p + 1] = color.g;
        sWasmDisplayRgba[p + 2] = color.b;
        sWasmDisplayRgba[p + 3] = 255;
        sLayerData[i] = LAYER_BG2;
        sObjectIdData[i] = 0xff;
    }
}

static void RenderBitmapMode4(u16 dispcnt)
{
    const u32 page = dispcnt & 0x10 ? 0xA000 : 0;

    for (u32 i = 0; i < DISPLAY_PIXELS; i++)
    {
        const u8 colorIndex = *Ptr8(VRAM + page + i);
        const struct Rgb color = GbaColor(ReadU16(PLTT + colorIndex * 2));
        const u32 p = i * RGBA_CHANNELS;
        sWasmDisplayRgba[p] = color.r;
        sWasmDisplayRgba[p + 1] = color.g;
        sWasmDisplayRgba[p + 2] = color.b;
        sWasmDisplayRgba[p + 3] = 255;
        sLayerData[i] = LAYER_BG2;
        sObjectIdData[i] = 0xff;
    }
}

static bool8 TextBgPixel(u8 bg, s16 x, s16 y, struct Rgb *color)
{
    const u16 cnt = ReadU16(REG_BASE + REG_OFFSET_BG0CNT + bg * 2);
    const u32 charBase = VRAM + ((cnt >> 2) & 3) * 0x4000;
    const u32 screenBase = VRAM + ((cnt >> 8) & 31) * 0x800;
    const bool8 color256 = (cnt & 0x80) != 0;
    const u8 size = (cnt >> 14) & 3;
    const u16 width = size & 1 ? 512 : 256;
    const u16 height = size & 2 ? 512 : 256;
    const u32 hofsOffset = REG_OFFSET_BG0HOFS + bg * 4;
    const u8 scanlineY = y < 0 ? 0 : y >= DISPLAY_HEIGHT ? DISPLAY_HEIGHT - 1 : y;
    const u16 hofs = ScanlineGpuReg(hofsOffset, scanlineY) & 511;
    const u16 vofs = ScanlineGpuReg(hofsOffset + 2, scanlineY) & 511;
    const u16 sx = (x + hofs) & (width - 1);
    const u16 sy = (y + vofs) & (height - 1);
    const u8 block = (sx >= 256 ? 1 : 0) + (sy >= 256 ? (size == 3 ? 2 : 1) : 0);
    const u8 mapX = (sx & 255) >> 3;
    const u8 mapY = (sy & 255) >> 3;
    const u16 entry = ReadU16(screenBase + block * 0x800 + (mapY * 32 + mapX) * 2);
    const u16 tile = entry & 0x3ff;
    const u8 palette = (entry >> 12) & 15;
    const u8 px = entry & 0x400 ? 7 - (sx & 7) : sx & 7;
    const u8 py = entry & 0x800 ? 7 - (sy & 7) : sy & 7;
    u8 colorIndex;

    if (color256)
    {
        colorIndex = *Ptr8(charBase + tile * 64 + py * 8 + px);
        if (!colorIndex)
            return FALSE;
        *color = GbaColor(ReadU16(PLTT + colorIndex * 2));
        return TRUE;
    }

    {
        const u8 packed = *Ptr8(charBase + tile * 32 + py * 4 + (px >> 1));
        colorIndex = px & 1 ? packed >> 4 : packed & 15;
    }
    if (!colorIndex)
        return FALSE;

    *color = GbaColor(ReadU16(PLTT + (palette * 16 + colorIndex) * 2));
    return TRUE;
}

static bool8 AffineBgPixel(u8 bg, u8 x, u8 y, struct Rgb *color)
{
    const u16 cnt = ReadU16(REG_BASE + REG_OFFSET_BG0CNT + bg * 2);
    const u32 charBase = VRAM + ((cnt >> 2) & 3) * 0x4000;
    const u32 screenBase = VRAM + ((cnt >> 8) & 31) * 0x800;
    const u16 sizes[] = {128, 256, 512, 1024};
    const u16 size = sizes[(cnt >> 14) & 3];
    const bool8 wrap = (cnt & 0x2000) != 0;
    const u8 reg = bg == 2 ? REG_OFFSET_BG2PA : REG_OFFSET_BG3PA;
    const s16 pa = Signed16(ReadU16(REG_BASE + reg));
    const s16 pb = Signed16(ReadU16(REG_BASE + reg + 2));
    const s16 pc = Signed16(ReadU16(REG_BASE + reg + 4));
    const s16 pd = Signed16(ReadU16(REG_BASE + reg + 6));
    const s32 refX = Signed28(Word(reg + 8));
    const s32 refY = Signed28(Word(reg + 12));
    s32 sx = (refX + pa * x + pb * y) >> 8;
    s32 sy = (refY + pc * x + pd * y) >> 8;
    u16 tile;
    u8 colorIndex;

    if (wrap)
    {
        sx &= size - 1;
        sy &= size - 1;
    }
    else if (sx < 0 || sy < 0 || sx >= size || sy >= size)
    {
        return FALSE;
    }

    tile = *Ptr8(screenBase + (sy >> 3) * (size >> 3) + (sx >> 3));
    colorIndex = *Ptr8(charBase + tile * 64 + (sy & 7) * 8 + (sx & 7));
    if (!colorIndex)
        return FALSE;

    *color = GbaColor(ReadU16(PLTT + colorIndex * 2));
    return TRUE;
}

static u8 BgLayersForMode(u16 dispcnt, struct BgLayer *layers)
{
    const u8 mode = dispcnt & 7;
    u8 count = 0;

    for (u8 bg = 0; bg < 4; bg++)
    {
        if (!(dispcnt & (0x100 << bg)))
            continue;

        if (mode == 0)
        {
            layers[count].bg = bg;
            layers[count].type = 0;
            count++;
        }
        else if (mode == 1 && bg < 2)
        {
            layers[count].bg = bg;
            layers[count].type = 0;
            count++;
        }
        else if (mode == 1 && bg == 2)
        {
            layers[count].bg = bg;
            layers[count].type = 1;
            count++;
        }
        else if (mode == 2 && bg >= 2)
        {
            layers[count].bg = bg;
            layers[count].type = 1;
            count++;
        }
    }

    return count;
}

static u16 ObjTileOffset(u16 tileBase, u8 tileX, u8 tileY, u8 width, bool8 color256, bool8 mapping1d)
{
    if (mapping1d)
        return tileBase + tileY * (color256 ? width >> 2 : width >> 3) + tileX * (color256 ? 2 : 1);
    return tileBase + tileY * 32 + tileX * (color256 ? 2 : 1);
}

static bool8 ObjPixel(u16 tileBase, u8 x, u8 y, u8 width, bool8 color256, u8 palette, bool8 mapping1d, struct Rgb *color)
{
    const u16 tileOffset = ObjTileOffset(tileBase, x >> 3, y >> 3, width, color256, mapping1d);
    u8 colorIndex;

    if (color256)
    {
        colorIndex = *Ptr8(VRAM + 0x10000 + tileOffset * 32 + (y & 7) * 8 + (x & 7));
    }
    else
    {
        const u8 packed = *Ptr8(VRAM + 0x10000 + tileOffset * 32 + (y & 7) * 4 + ((x & 7) >> 1));
        colorIndex = x & 1 ? packed >> 4 : packed & 15;
    }

    if (!colorIndex)
        return FALSE;

    *color = GbaColor(ReadU16(OBJ_PLTT + (color256 ? colorIndex : palette * 16 + colorIndex) * 2));
    return TRUE;
}

static void RenderBgLayer(u8 bg, u8 type)
{
    struct Rgb color;
    const u8 layer = 1 << bg;

    for (u32 y = 0; y < DISPLAY_HEIGHT; y++)
    {
        for (u32 x = 0; x < DISPLAY_WIDTH; x++)
        {
            const bool8 hasPixel = type ? AffineBgPixel(bg, x, y, &color) : TextBgPixel(bg, x, y, &color);
            if (hasPixel)
                PutPixel(x, y, color, layer, FALSE);
        }
    }
}

// The sprite engine emits a contiguous managed prefix with unwrapped logical
// coordinates, but several classic screens also write hardware OAM directly
// at fixed indices (including 64..127). Traverse all entries and only use the
// logical metadata for that managed prefix.
static s32 OamScreenX(u32 index, u16 attr1)
{
    s32 x;

    if (index < WasmOamCount())
        return WasmOamScreenX(index);
    x = attr1 & 511;
    return x > DISPLAY_WIDTH ? x - 512 : x;
}

static s32 OamScreenY(u32 index, u16 attr0)
{
    s32 y;

    if (index < WasmOamCount())
        return WasmOamScreenY(index);
    y = attr0 & 255;
    return y > DISPLAY_HEIGHT ? y - 256 : y;
}

static u32 OamSpriteId(u32 index)
{
    return index < WasmOamCount() ? WasmOamSpriteId(index) : 0xff;
}

static void RenderSprites(u16 dispcnt, s8 priority)
{
    const bool8 mapping1d = dispcnt & 0x40;
    static const u8 sizes[3][4][2] = {
        {{8, 8}, {16, 16}, {32, 32}, {64, 64}},
        {{16, 8}, {32, 8}, {32, 16}, {64, 32}},
        {{8, 16}, {8, 32}, {16, 32}, {32, 64}},
    };
    struct Rgb color;

    if (!(dispcnt & 0x1000))
        return;

    for (s32 i = OAM_ENTRY_COUNT - 1; i >= 0; i--)
    {
        const u32 base = OAM + i * 8;
        const u16 a0 = ReadU16(base);
        const u16 a1 = ReadU16(base + 2);
        const u16 a2 = ReadU16(base + 4);
        const u8 affineMode = (a0 >> 8) & 3;
        const u8 objMode = (a0 >> 10) & 3;
        const bool8 forceAlphaBlend = objMode == 1;
        const bool8 affine = affineMode & 1;
        const u8 shape = (a0 >> 14) & 3;
        const u8 spritePriority = (a2 >> 10) & 3;
        const bool8 color256 = (a0 & 0x2000) != 0;
        const u8 palette = (a2 >> 12) & 15;
        const u16 tileBase = a2 & 0x3ff;
        u8 w;
        u8 h;
        s32 ox;
        s32 oy;

        if (!affine && (a0 & 0x0200))
            continue;
        if (shape == 3)
            continue;
        if (priority >= 0 && spritePriority != priority)
            continue;

        sCurrentObjectId = i;
        sObjectPriorities[i] = spritePriority;
        w = sizes[shape][(a1 >> 14) & 3][0];
        h = sizes[shape][(a1 >> 14) & 3][1];
        ox = OamScreenX(i, a1);
        oy = OamScreenY(i, a0);

        sObjectAnchors[i * 2] = ox + (affine && affineMode == 3 ? w : w / 2);
        sObjectAnchors[i * 2 + 1] = oy + h + (affine && affineMode == 3 ? h / 2 : 0);

        if (affine)
        {
            const u8 matrix = (a1 >> 9) & 31;
            const u32 matrixBase = OAM + matrix * 32;
            const s16 pa = Signed16(ReadU16(matrixBase + 6));
            const s16 pb = Signed16(ReadU16(matrixBase + 14));
            const s16 pc = Signed16(ReadU16(matrixBase + 22));
            const s16 pd = Signed16(ReadU16(matrixBase + 30));
            const u16 drawW = affineMode == 3 ? w * 2 : w;
            const u16 drawH = affineMode == 3 ? h * 2 : h;
            const s32 drawCx = drawW / 2;
            const s32 drawCy = drawH / 2;
            const s32 texCx = w / 2;
            const s32 texCy = h / 2;

            for (u32 y = 0; y < drawH; y++)
            {
                for (u32 x = 0; x < drawW; x++)
                {
                    const s32 dx = (s32)x - drawCx;
                    const s32 dy = (s32)y - drawCy;
                    const s32 px = ((pa * dx + pb * dy) >> 8) + texCx;
                    const s32 py = ((pc * dx + pd * dy) >> 8) + texCy;

                    if (px < 0 || py < 0 || px >= w || py >= h)
                        continue;
                    if (ObjPixel(tileBase, px, py, w, color256, palette, mapping1d, &color))
                        PutPixel(ox + x, oy + y, color, LAYER_OBJ, forceAlphaBlend);
                }
            }
        }
        else
        {
            for (u32 y = 0; y < h; y++)
            {
                for (u32 x = 0; x < w; x++)
                {
                    const u8 px = a1 & 0x1000 ? w - 1 - x : x;
                    const u8 py = a1 & 0x2000 ? h - 1 - y : y;

                    if (ObjPixel(tileBase, px, py, w, color256, palette, mapping1d, &color))
                        PutPixel(ox + x, oy + y, color, LAYER_OBJ, forceAlphaBlend);
                }
            }
        }
    }
}

static void PutObjectSourcePixel(u32 layer, u32 x, u32 y, struct Rgb color, bool8 forceAlphaBlend)
{
    const u32 pixel = (layer * OBJECT_SOURCE_SIZE * OBJECT_SOURCE_SIZE + y * OBJECT_SOURCE_SIZE + x) * RGBA_CHANNELS;
    u8 alpha = 255;

    if (forceAlphaBlend)
    {
        u8 eva = REG_BLDALPHA & 0x1f;
        if (eva > 16) eva = 16;
        alpha = (eva * 255 + 8) / 16;
    }
    sObjectSourceRgba[pixel] = color.r;
    sObjectSourceRgba[pixel + 1] = color.g;
    sObjectSourceRgba[pixel + 2] = color.b;
    sObjectSourceRgba[pixel + 3] = alpha;
}

static void RenderObjectSources(u16 dispcnt)
{
    const bool8 mapping1d = dispcnt & 0x40;
    static const u8 sizes[3][4][2] = {
        {{8, 8}, {16, 16}, {32, 32}, {64, 64}},
        {{16, 8}, {32, 8}, {32, 16}, {64, 32}},
        {{8, 16}, {8, 32}, {16, 32}, {32, 64}},
    };
    struct Rgb color;

    sObjectSourceCount = 0;
    if (!(dispcnt & DISPCNT_OBJ_ON))
        return;
    for (s32 i = OAM_ENTRY_COUNT - 1; i >= 0; i--)
    {
        const u32 base = OAM + i * 8;
        const u16 a0 = ReadU16(base);
        const u16 a1 = ReadU16(base + 2);
        const u16 a2 = ReadU16(base + 4);
        const u8 affineMode = (a0 >> 8) & 3;
        const u8 objMode = (a0 >> 10) & 3;
        const bool8 affine = affineMode & 1;
        const u8 shape = (a0 >> 14) & 3;
        const bool8 color256 = (a0 & 0x2000) != 0;
        const u8 palette = (a2 >> 12) & 15;
        const u16 tileBase = a2 & 0x3ff;
        u32 layer;
        s32 *descriptor;
        u8 w;
        u8 h;
        u16 drawW;
        u16 drawH;
        s32 ox;
        s32 oy;

        if ((!affine && (a0 & 0x0200)) || shape == 3 || objMode == 2)
            continue;
        w = sizes[shape][(a1 >> 14) & 3][0];
        h = sizes[shape][(a1 >> 14) & 3][1];
        drawW = affine && affineMode == 3 ? w * 2 : w;
        drawH = affine && affineMode == 3 ? h * 2 : h;
        ox = OamScreenX(i, a1);
        oy = OamScreenY(i, a0);

        layer = sObjectSourceCount++;
        for (u32 clearY = 0; clearY < h; clearY++)
        {
            const u32 row = (layer * OBJECT_SOURCE_SIZE * OBJECT_SOURCE_SIZE + clearY * OBJECT_SOURCE_SIZE) * RGBA_CHANNELS;
            for (u32 clearX = 0; clearX < w * RGBA_CHANNELS; clearX++)
                sObjectSourceRgba[row + clearX] = 0;
        }
        descriptor = &sObjectDescriptors[layer * OBJECT_DESCRIPTOR_WORDS];
        descriptor[0] = i;
        descriptor[1] = ox;
        descriptor[2] = oy;
        descriptor[3] = ox + (affine && affineMode == 3 ? w : w / 2);
        descriptor[4] = oy + h + (affine && affineMode == 3 ? h / 2 : 0);
        descriptor[5] = w;
        descriptor[6] = h;
        descriptor[7] = drawW;
        descriptor[8] = drawH;
        descriptor[9] = (a2 >> 10) & 3;
        descriptor[10] = OamSpriteId(i);
        descriptor[11] = affine ? 1 : 0;
        descriptor[12] = 256;
        descriptor[13] = 0;
        descriptor[14] = 0;
        descriptor[15] = 256;

        if (affine)
        {
            const u8 matrix = (a1 >> 9) & 31;
            const u32 matrixBase = OAM + matrix * 32;
            descriptor[12] = Signed16(ReadU16(matrixBase + 6));
            descriptor[13] = Signed16(ReadU16(matrixBase + 14));
            descriptor[14] = Signed16(ReadU16(matrixBase + 22));
            descriptor[15] = Signed16(ReadU16(matrixBase + 30));
            for (u32 y = 0; y < h; y++)
            {
                for (u32 x = 0; x < w; x++)
                {
                    if (ObjPixel(tileBase, x, y, w, color256, palette, mapping1d, &color))
                        PutObjectSourcePixel(layer, x, y, color, objMode == 1);
                }
            }
        }
        else
        {
            for (u32 y = 0; y < h; y++)
            {
                for (u32 x = 0; x < w; x++)
                {
                    const u8 px = a1 & 0x1000 ? w - 1 - x : x;
                    const u8 py = a1 & 0x2000 ? h - 1 - y : y;
                    if (ObjPixel(tileBase, px, py, w, color256, palette, mapping1d, &color))
                        PutObjectSourcePixel(layer, x, y, color, objMode == 1);
                }
            }
        }
    }
}

static void RenderObjectPass(u16 dispcnt)
{
    ClearTransparent();
    sRenderingObjectPass = TRUE;
    for (s8 priority = 3; priority >= 0; priority--)
        RenderSprites(dispcnt, priority);
    sRenderingObjectPass = FALSE;
    for (u32 i = 0; i < sizeof(sWasmObjectRgba); i++)
        sWasmObjectRgba[i] = sWasmDisplayRgba[i];
    for (u32 i = 0; i < sizeof(sWasmObjectIdData); i++)
        sWasmObjectIdData[i] = sObjectIdData[i];
}

static void RenderTiled(u16 dispcnt, bool8 includeBg0, bool8 includeSprites)
{
    struct BgLayer layers[4];
    const u8 count = BgLayersForMode(dispcnt, layers);

    ClearScreen();
    for (s8 priority = 3; priority >= 0; priority--)
    {
        for (u8 i = 0; i < count; i++)
        {
            const u8 bg = layers[i].bg;
            if (!includeBg0 && bg == 0)
                continue;
            if ((ReadU16(REG_BASE + REG_OFFSET_BG0CNT + bg * 2) & 3) == priority)
                RenderBgLayer(bg, layers[i].type);
        }
        if (includeSprites)
            RenderSprites(dispcnt, priority);
    }
}

void WasmRefreshHblankDmaGpuRegs(void)
{
    RefreshHblankDmaGpuRegs();
}

u32 WasmWindowMask(u32 x, u32 y)
{
    return WindowMask(x, y);
}

u32 WasmHblankDmaGpuRegActive(u32 offset)
{
    return offset < REG_OFFSET_DMA0 && sHblankDmaGpuRegs[offset >> 1].active;
}


static s32 FloorDiv16(s32 value)
{
    return value >= 0 ? value / 16 : -((-value + 15) / 16);
}

static bool8 MetatilePixel(u16 entry, u8 x, u8 y, struct Rgb *color)
{
    const u16 tile = entry & 0x3ff;
    const u8 palette = (entry >> 12) & 15;
    const u8 px = entry & 0x400 ? 7 - x : x;
    const u8 py = entry & 0x800 ? 7 - y : y;
    const u8 packed = *Ptr8(VRAM + tile * 32 + py * 4 + px / 2);
    const u8 colorIndex = px & 1 ? packed >> 4 : packed & 15;

    if (colorIndex == 0)
        return FALSE;
    *color = GbaColor(ReadU16(BG_PLTT + (palette * 16 + colorIndex) * 2));
    return TRUE;
}

static struct Rgb DirectEffectColor(struct Rgb color, u8 layer, struct Rgb under, u8 underLayer,
                                    bool8 effectsEnabled, u8 scanlineY)
{
    const u16 bldcnt = REG_BLDCNT;
    const u8 effect = (bldcnt >> 6) & 3;

    if (!effectsEnabled || !(bldcnt & layer))
        return color;
    if (effect == 1 && ((bldcnt >> 8) & underLayer))
    {
        const u16 alpha = REG_BLDALPHA;
        const u8 eva = (alpha & 0x1f) > 16 ? 16 : alpha & 0x1f;
        const u8 evb = ((alpha >> 8) & 0x1f) > 16 ? 16 : (alpha >> 8) & 0x1f;
        color.r = ClampBlend(((u32)color.r * eva + (u32)under.r * evb) >> 4);
        color.g = ClampBlend(((u32)color.g * eva + (u32)under.g * evb) >> 4);
        color.b = ClampBlend(((u32)color.b * eva + (u32)under.b * evb) >> 4);
    }
    else if (effect == 2)
    {
        u8 evy = ScanlineGpuReg(REG_OFFSET_BLDY, scanlineY) & 0x1f;
        if (evy > 16) evy = 16;
        color.r += ((255 - color.r) * evy) >> 4;
        color.g += ((255 - color.g) * evy) >> 4;
        color.b += ((255 - color.b) * evy) >> 4;
    }
    else if (effect == 3)
    {
        u8 evy = ScanlineGpuReg(REG_OFFSET_BLDY, scanlineY) & 0x1f;
        if (evy > 16) evy = 16;
        color.r -= (color.r * evy) >> 4;
        color.g -= (color.g * evy) >> 4;
        color.b -= (color.b * evy) >> 4;
    }
    return color;
}

struct HdMapSample
{
    const struct MapLayout *layout;
    u16 metatileId;
    u8 collision;
    bool8 hasWarpEntrance;
    bool8 valid;
};

struct HdAdjacentSampleEvidence
{
    bool8 matchingWaterArt;
    bool8 matchingOpenDeckArt;
    bool8 matchingWaterReceiverArt;
    bool8 touchesReflection;
};

static struct HdMapSample sHdMapSamples[HD2D_SAMPLE_COLS * HD2D_SAMPLE_ROWS];
static u16 sHdMapAttributes[HD2D_SAMPLE_COLS * HD2D_SAMPLE_ROWS];
static u8 sHdSampleBaseSurfaces[HD2D_SAMPLE_COLS * HD2D_SAMPLE_ROWS];
static s8 sHdCourseHeights[HD2D_COURSE_COUNT];
static s8 sHdCourseGroundHeights[HD2D_COURSE_COUNT];
static u16 sHdCourseGeometry[HD2D_COURSE_COUNT];
static u16 sHdCourseReceivers[HD2D_COURSE_COUNT];
static s16 sHdCourseBuilding[HD2D_COURSE_COUNT];
static s16 sHdCourseFacade[HD2D_COURSE_COUNT];
static u8 sHdCourseBuildingKind[HD2D_COURSE_COUNT];
static u32 sHdCourseFacadeData[HD2D_COURSE_COUNT];
static u16 sHdCourseVisit[HD2D_COURSE_COUNT];
static u16 sHdCourseQueue[HD2D_COURSE_COUNT];

enum HdSamplePredicate
{
    HD_PREDICATE_FLOOR_SURFACE,
    HD_PREDICATE_DECORATIVE,
    HD_PREDICATE_FACADE_BODY,
    HD_PREDICATE_BUILDING_MASS,
    HD_PREDICATE_SOLID_ROOF,
    HD_PREDICATE_FACADE_SUPPORT,
    HD_PREDICATE_CLIFF_SEED,
    HD_PREDICATE_COUNT,
};

static u8 sHdSamplePredicateCaches[HD_PREDICATE_COUNT][HD2D_SAMPLE_COLS * HD2D_SAMPLE_ROWS];
static u8 sHdRoofArtCache[HD2D_COURSE_COUNT];

struct HdTilesetCache
{
    const struct Tileset *tileset;
    u32 animationFrame;
    u8 tiles[NUM_TILES_TOTAL * 32];
    u16 palettes[16 * 16];
    u16 displayPalettes[16 * 16];
};

struct HdDecodedCourseCache
{
    const struct MapLayout *layout;
    u32 generation;
    u16 metatileId;
    u8 half;
    u8 quadrant;
    u32 pixels[HD2D_TILE_WIDTH * HD2D_TILE_WIDTH];
};

struct HdArtPredicateCache
{
    const struct MapLayout *layout;
    u32 generation;
    u16 metatileId;
    bool8 valid;
    u8 known;
    u8 results;
};

#define HD_ART_PREDICATE_WALKABLE_FLOOR (1 << 0)
#define HD_ART_PREDICATE_PLANE0_FLOOR   (1 << 1)
#define HD_ART_PREDICATE_FOLIAGE        (1 << 2)
#define HD_ART_PREDICATE_EARTH          (1 << 3)
#define HD_ART_PREDICATE_PLANES_MATCH   (1 << 4)

struct HdGeometryCache
{
    const struct Tileset *primaryTileset;
    const struct Tileset *secondaryTileset;
    u8 coverage[2][4][NUM_METATILES_TOTAL];
    u8 valid[2][HD2D_GEOMETRY_VALID_BYTES];
};

struct HdBuildingCandidate
{
    u16 parent;
    u16 componentId;
    u16 facadeAnchorCourseY;
    s8 baseHeight;
    s8 roofHeight;
    bool8 hasEntrance;
    bool8 isClipped;
    bool8 isSteppedTier;
};

struct HdBuildingBounds
{
    u16 minCourseX;
    u16 minCourseY;
    u16 maxCourseX;
    u16 maxCourseY;
};

#define HD_BUILDING_ROOF 0x01
#define HD_BUILDING_WALL 0x02

static struct HdBuildingCandidate sHdBuildings[HD2D_BUILDING_COUNT];
static u16 sHdBuildingCount;

static struct HdTilesetCache sHdTilesetCaches[16];
static u8 sHdTilesetCacheNext;
static struct HdDecodedCourseCache sHdDecodedCourseCaches[HD2D_DECODED_COURSE_CACHE_COUNT];
static struct HdArtPredicateCache sHdArtPredicateCaches[HD2D_DECODED_COURSE_CACHE_COUNT];
static u32 sHdDecodedCourseGeneration;
static struct HdGeometryCache sHdGeometryCaches[HD2D_GEOMETRY_CACHE_COUNT];
static u8 sHdGeometryCacheNext;

static struct HdTilesetCache *HdTilesetCache(const struct Tileset *tileset)
{
    struct HdTilesetCache *cache = NULL;
    const u32 frame = WasmTilesetAnimationFrame(tileset->isSecondary);
    bool8 reset;

    for (u32 i = 0; i < ARRAY_COUNT(sHdTilesetCaches); i++)
    {
        if (sHdTilesetCaches[i].tileset == tileset)
        {
            cache = &sHdTilesetCaches[i];
            break;
        }
        if (cache == NULL && sHdTilesetCaches[i].tileset == NULL)
            cache = &sHdTilesetCaches[i];
    }
    if (cache == NULL)
        cache = &sHdTilesetCaches[sHdTilesetCacheNext++ % ARRAY_COUNT(sHdTilesetCaches)];
    reset = cache->tileset != tileset
         || (cache->animationFrame != 0xffffffff && cache->animationFrame > frame);
    if (reset)
    {
        cache->tileset = tileset;
        cache->animationFrame = 0xffffffff;
        for (u32 palette = 0; palette < 16; palette++)
        {
            for (u32 color = 0; color < 16; color++)
            {
                const u32 index = palette * 16 + color;
                cache->palettes[index] = tileset->palettes[palette][color];
                cache->displayPalettes[index] = cache->palettes[index];
            }
        }
        if (tileset->isCompressed)
            LZ77UnCompWram(tileset->tiles, cache->tiles);
        else
        {
            const u32 size = (tileset->isSecondary ? NUM_TILES_TOTAL - NUM_TILES_IN_PRIMARY
                                                   : NUM_TILES_IN_PRIMARY) * 32;
            const u8 *source = (const u8 *)tileset->tiles;
            for (u32 i = 0; i < size; i++)
                cache->tiles[i] = source[i];
        }
    }
    if (cache->animationFrame != frame)
    {
        const u32 firstFrame = cache->animationFrame == 0xffffffff
            ? (frame > 255 ? frame - 255 : 1)
            : cache->animationFrame + 1;
        // The engine increments each counter before invoking its callback, so
        // the monotonic epoch identifies the last callback that ran. Replay
        // the interval (cachedFrame, frame]. The inverted 1..0 interval still
        // refreshes display palettes before the first callback.
        WasmApplyTilesetAnimations(tileset, cache->tiles, cache->palettes,
                                   cache->displayPalettes, firstFrame, frame);
        cache->animationFrame = frame;
    }
    return cache;
}

static bool8 HdMapHeaderHasWarpAt(const struct MapHeader *header, s32 x, s32 y)
{
    const struct MapEvents *events;

    if (header == NULL || header->events == NULL || header->events->warps == NULL)
        return FALSE;
    events = header->events;
    for (u32 i = 0; i < events->warpCount; i++)
    {
        const struct WarpEvent *warp = &events->warps[i];

        if (warp->x == x && warp->y == y)
            return TRUE;
    }
    return FALSE;
}

static bool8 ResolveHdMapSample(s32 mapX, s32 mapY, struct HdMapSample *sample)
{
    const struct MapLayout *current = gMapHeader.mapLayout;
    const s32 localX = mapX - MAP_OFFSET;
    const s32 localY = mapY - MAP_OFFSET;

    sample->layout = current;
    sample->collision = 0;
    sample->hasWarpEntrance = FALSE;
    sample->valid = FALSE;
    if (localX >= 0 && localY >= 0 && localX < current->width && localY < current->height)
    {
        u16 block = MAPGRID_UNDEFINED;

        if (mapX >= 0 && mapY >= 0
         && mapX < gBackupMapLayout.width && mapY < gBackupMapLayout.height)
            block = gBackupMapLayout.map[mapY * gBackupMapLayout.width + mapX];

        if (block == MAPGRID_UNDEFINED)
        {
            sample->metatileId = MapGridGetMetatileIdAt(mapX, mapY);
            sample->collision = MapGridGetCollisionAt(mapX, mapY);
        }
        else
        {
            sample->metatileId = UNPACK_METATILE(block);
            sample->collision = UNPACK_COLLISION(block);
        }
        sample->hasWarpEntrance = HdMapHeaderHasWarpAt(&gMapHeader, localX, localY);
        sample->valid = TRUE;
        return TRUE;
    }
    if (gMapHeader.connections != NULL)
    {
        for (s32 i = 0; i < gMapHeader.connections->count; i++)
        {
            const struct MapConnection *connection = &gMapHeader.connections->connections[i];
            const struct MapHeader *header = GetMapHeaderFromConnection(connection);
            const struct MapLayout *layout;
            s32 x;
            s32 y;

            if (header == NULL || header->mapLayout == NULL)
                continue;
            layout = header->mapLayout;
            switch (connection->direction)
            {
            case CONNECTION_NORTH:
                x = localX - connection->offset;
                y = layout->height + localY;
                break;
            case CONNECTION_SOUTH:
                x = localX - connection->offset;
                y = localY - current->height;
                break;
            case CONNECTION_WEST:
                x = layout->width + localX;
                y = localY - connection->offset;
                break;
            case CONNECTION_EAST:
                x = localX - current->width;
                y = localY - connection->offset;
                break;
            default:
                continue;
            }
            if (x >= 0 && y >= 0 && x < layout->width && y < layout->height)
            {
                const u16 block = layout->map[y * layout->width + x];
                sample->layout = layout;
                sample->metatileId = UNPACK_METATILE(block);
                sample->collision = UNPACK_COLLISION(block);
                sample->hasWarpEntrance = HdMapHeaderHasWarpAt(header, x, y);
                sample->valid = TRUE;
                return TRUE;
            }
        }
    }
    sample->metatileId = MapGridGetMetatileIdAt(mapX, mapY);
    sample->collision = MapGridGetCollisionAt(mapX, mapY);
    return FALSE;
}


static void HdDecodeMetatileCourse(const struct MapLayout *layout, u16 metatileId,
                                   u8 half, u8 quadrant, u32 *pixels)
{
    const struct Tileset *tileset;
    const struct Tileset *paletteTileset;
    const u16 *metatiles;
    u8 tilePixels[32];
    const u16 *paletteData = NULL;
    struct HdTilesetCache *tilesetCache;
    u16 localMetatile;
    u16 entry;
    u16 tile;
    u8 palette;
    bool8 useVram;

    if (metatileId >= NUM_METATILES_TOTAL)
        metatileId = 0;
    if (metatileId < NUM_METATILES_IN_PRIMARY)
    {
        tileset = layout->primaryTileset;
        localMetatile = metatileId;
        useVram = tileset == gMapHeader.mapLayout->primaryTileset;
    }
    else
    {
        tileset = layout->secondaryTileset;
        localMetatile = metatileId - NUM_METATILES_IN_PRIMARY;
        useVram = tileset == gMapHeader.mapLayout->secondaryTileset;
    }
    metatiles = tileset->metatiles + localMetatile * NUM_TILES_PER_METATILE;
    entry = metatiles[half * 4 + quadrant];
    if (useVram)
    {
        for (u32 y = 0; y < HD2D_TILE_WIDTH; y++)
        {
            for (u32 x = 0; x < HD2D_TILE_WIDTH; x++)
            {
                struct Rgb color;
                const u32 pixel = y * HD2D_TILE_WIDTH + x;

                if (MetatilePixel(entry, x, y, &color))
                    pixels[pixel] = 0xff000000 | color.r | (color.g << 8) | (color.b << 16);
                else
                    pixels[pixel] = 0;
            }
        }
        return;
    }

    tile = entry & 0x3ff;
    if (tile < NUM_TILES_IN_PRIMARY)
    {
        tileset = layout->primaryTileset;
    }
    else
    {
        tileset = layout->secondaryTileset;
        tile -= NUM_TILES_IN_PRIMARY;
    }
    tilesetCache = HdTilesetCache(tileset);
    if ((!tileset->isSecondary && tile >= NUM_TILES_IN_PRIMARY)
     || (tileset->isSecondary && tile >= NUM_TILES_TOTAL - NUM_TILES_IN_PRIMARY))
    {
        for (u32 pixel = 0; pixel < HD2D_TILE_WIDTH * HD2D_TILE_WIDTH; pixel++)
            pixels[pixel] = 0;
        return;
    }
    for (u32 i = 0; i < ARRAY_COUNT(tilePixels); i++)
        tilePixels[i] = tilesetCache->tiles[tile * 32 + i];
    palette = (entry >> 12) & 15;
    paletteTileset = palette < NUM_PALS_IN_PRIMARY ? layout->primaryTileset : layout->secondaryTileset;
    if (paletteTileset == (palette < NUM_PALS_IN_PRIMARY
        ? gMapHeader.mapLayout->primaryTileset : gMapHeader.mapLayout->secondaryTileset))
        paletteData = Ptr16(BG_PLTT + palette * 16 * sizeof(u16));
    else
        paletteData = &HdTilesetCache(paletteTileset)->displayPalettes[palette * 16];
    for (u32 y = 0; y < HD2D_TILE_WIDTH; y++)
    {
        for (u32 x = 0; x < HD2D_TILE_WIDTH; x++)
        {
            const u8 px = entry & 0x400 ? 7 - x : x;
            const u8 py = entry & 0x800 ? 7 - y : y;
            const u8 packed = tilePixels[py * 4 + px / 2];
            const u8 colorIndex = px & 1 ? packed >> 4 : packed & 15;
            const u32 pixel = y * HD2D_TILE_WIDTH + x;

            if (colorIndex != 0)
            {
                const struct Rgb color = GbaColor(paletteData[colorIndex]);
                pixels[pixel] = 0xff000000 | color.r | (color.g << 8) | (color.b << 16);
            }
            else
                pixels[pixel] = 0;
        }
    }
}

static const u32 *HdMetatileCourse(const struct MapLayout *layout, u16 metatileId,
                                   u8 half, u8 quadrant)
{
    const u32 hash = ((((u32)layout >> 4) ^ ((u32)metatileId * 33)
                     ^ (half * 4 + quadrant)) & (HD2D_DECODED_COURSE_CACHE_COUNT - 1));
    struct HdDecodedCourseCache *cache = &sHdDecodedCourseCaches[hash];

    if (cache->generation != sHdDecodedCourseGeneration
     || cache->layout != layout
     || cache->metatileId != metatileId
     || cache->half != half
     || cache->quadrant != quadrant)
    {
        cache->layout = layout;
        cache->generation = sHdDecodedCourseGeneration;
        cache->metatileId = metatileId;
        cache->half = half;
        cache->quadrant = quadrant;
        HdDecodeMetatileCourse(layout, metatileId, half, quadrant, cache->pixels);
    }
    return cache->pixels;
}

static bool8 HdMetatilePixel(const struct MapLayout *layout, u16 metatileId, u8 half, u8 quadrant,
                             u8 x, u8 y, struct Rgb *color)
{
    const u32 packed = HdMetatileCourse(layout, metatileId, half, quadrant)
        [y * HD2D_TILE_WIDTH + x];

    if ((packed >> 24) == 0)
        return FALSE;
    color->r = packed;
    color->g = packed >> 8;
    color->b = packed >> 16;
    return TRUE;
}

static struct HdArtPredicateCache *HdArtPredicateCache(u32 index)
{
    const struct HdMapSample *sample = &sHdMapSamples[index];
    const u32 hash = ((((u32)sample->layout >> 4) ^ ((u32)sample->metatileId * 33)
                     ^ sample->valid)
                    & (HD2D_DECODED_COURSE_CACHE_COUNT - 1));
    struct HdArtPredicateCache *cache = &sHdArtPredicateCaches[hash];

    if (cache->generation != sHdDecodedCourseGeneration
     || cache->layout != sample->layout
     || cache->metatileId != sample->metatileId
     || cache->valid != sample->valid)
    {
        cache->layout = sample->layout;
        cache->generation = sHdDecodedCourseGeneration;
        cache->metatileId = sample->metatileId;
        cache->valid = sample->valid;
        cache->known = 0;
        cache->results = 0;
    }
    return cache;
}

static u16 HdMetatileAttributes(const struct MapLayout *layout, u16 metatileId)
{
    if (metatileId < NUM_METATILES_IN_PRIMARY)
        return layout->primaryTileset->metatileAttributes[metatileId];
    if (metatileId < NUM_METATILES_TOTAL)
        return layout->secondaryTileset->metatileAttributes[metatileId - NUM_METATILES_IN_PRIMARY];
    return 0;
}

static struct HdGeometryCache *HdGeometryCacheForLayout(const struct MapLayout *layout)
{
    struct HdGeometryCache *cache = NULL;

    for (u32 i = 0; i < ARRAY_COUNT(sHdGeometryCaches); i++)
    {
        if (sHdGeometryCaches[i].primaryTileset == layout->primaryTileset
         && sHdGeometryCaches[i].secondaryTileset == layout->secondaryTileset)
            return &sHdGeometryCaches[i];
        if (cache == NULL && sHdGeometryCaches[i].primaryTileset == NULL)
            cache = &sHdGeometryCaches[i];
    }
    if (cache == NULL)
        cache = &sHdGeometryCaches[sHdGeometryCacheNext++ % ARRAY_COUNT(sHdGeometryCaches)];
    cache->primaryTileset = layout->primaryTileset;
    cache->secondaryTileset = layout->secondaryTileset;
    for (u32 plane = 0; plane < ARRAY_COUNT(cache->valid); plane++)
        for (u32 i = 0; i < ARRAY_COUNT(cache->valid[plane]); i++)
            cache->valid[plane][i] = 0;
    return cache;
}

static u8 HdMetatileQuadrantCoverage(const struct HdMapSample *sample, u8 plane, u8 quadrant)
{
    struct HdGeometryCache *cache = HdGeometryCacheForLayout(sample->layout);
    struct Rgb color;
    u16 metatileId = sample->metatileId;

    if (metatileId >= NUM_METATILES_TOTAL)
        metatileId = 0;
    if (!(cache->valid[plane][metatileId >> 3] & (1 << (metatileId & 7))))
    {
        for (u32 currentQuadrant = 0; currentQuadrant < 4; currentQuadrant++)
        {
            u8 coverage = 0;

            for (u32 y = 0; y < HD2D_TILE_WIDTH; y++)
            {
                for (u32 x = 0; x < HD2D_TILE_WIDTH; x++)
                {
                    if (HdMetatilePixel(sample->layout, metatileId, plane,
                                        currentQuadrant, x, y, &color))
                        coverage++;
                }
            }
            cache->coverage[plane][currentQuadrant][metatileId] = coverage;
        }
        cache->valid[plane][metatileId >> 3] |= 1 << (metatileId & 7);
    }
    return cache->coverage[plane][quadrant][metatileId];
}

static u16 HdMetatileCoverage(const struct HdMapSample *sample, u8 plane)
{
    u16 coverage = 0;

    for (u32 quadrant = 0; quadrant < 4; quadrant++)
        coverage += HdMetatileQuadrantCoverage(sample, plane, quadrant);
    return coverage;
}

static bool8 HdMetatilesHaveSamePlaneArt(const struct HdMapSample *left,
                                         const struct HdMapSample *right,
                                         u8 plane)
{
    if (!left->valid || !right->valid)
        return FALSE;
    if (left->metatileId >= NUM_METATILES_TOTAL
     || right->metatileId >= NUM_METATILES_TOTAL)
        return FALSE;

    for (u32 quadrant = 0; quadrant < 4; quadrant++)
    {
        for (u32 y = 0; y < HD2D_TILE_WIDTH; y++)
        {
            for (u32 x = 0; x < HD2D_TILE_WIDTH; x++)
            {
                struct Rgb leftColor;
                struct Rgb rightColor;
                const bool8 leftOpaque = HdMetatilePixel(left->layout, left->metatileId,
                                                          plane, quadrant, x, y, &leftColor);
                const bool8 rightOpaque = HdMetatilePixel(right->layout, right->metatileId,
                                                           plane, quadrant, x, y, &rightColor);

                if (leftOpaque != rightOpaque)
                    return FALSE;
                if (leftOpaque
                 && (leftColor.r != rightColor.r
                  || leftColor.g != rightColor.g
                  || leftColor.b != rightColor.b))
                    return FALSE;
            }
        }
    }
    return TRUE;
}

static bool8 HdMetatilesHaveSameVisibleArt(const struct HdMapSample *left,
                                           const struct HdMapSample *right)
{
    if (!left->valid || !right->valid)
        return FALSE;
    if (left->metatileId >= NUM_METATILES_TOTAL
     || right->metatileId >= NUM_METATILES_TOTAL)
        return FALSE;

    for (u32 quadrant = 0; quadrant < 4; quadrant++)
    {
        for (u32 y = 0; y < HD2D_TILE_WIDTH; y++)
        {
            for (u32 x = 0; x < HD2D_TILE_WIDTH; x++)
            {
                struct Rgb leftBottom;
                struct Rgb leftTop;
                struct Rgb rightBottom;
                struct Rgb rightTop;
                struct Rgb leftColor;
                struct Rgb rightColor;
                bool8 leftBottomOpaque;
                bool8 rightBottomOpaque;
                bool8 leftOpaque = FALSE;
                bool8 rightOpaque = FALSE;

                leftBottomOpaque = HdMetatilePixel(left->layout, left->metatileId, 0,
                                                   quadrant, x, y, &leftBottom);
                if (HdMetatilePixel(left->layout, left->metatileId, 1,
                                    quadrant, x, y, &leftTop))
                {
                    leftOpaque = TRUE;
                    leftColor = leftTop;
                }
                else if (leftBottomOpaque)
                {
                    leftOpaque = TRUE;
                    leftColor = leftBottom;
                }

                rightBottomOpaque = HdMetatilePixel(right->layout, right->metatileId, 0,
                                                    quadrant, x, y, &rightBottom);
                if (HdMetatilePixel(right->layout, right->metatileId, 1,
                                    quadrant, x, y, &rightTop))
                {
                    rightOpaque = TRUE;
                    rightColor = rightTop;
                }
                else if (rightBottomOpaque)
                {
                    rightOpaque = TRUE;
                    rightColor = rightBottom;
                }

                if (leftOpaque != rightOpaque)
                    return FALSE;
                if (leftOpaque
                 && (leftColor.r != rightColor.r
                  || leftColor.g != rightColor.g
                  || leftColor.b != rightColor.b))
                    return FALSE;
            }
        }
    }
    return TRUE;
}

static bool8 HdMapSampleIsDoorCourse(u32 index)
{
    const u8 behavior = UNPACK_BEHAVIOR(sHdMapAttributes[index]);

    return MetatileBehavior_IsDoor(behavior)
        || MetatileBehavior_IsNonAnimDoor(behavior);
}

static bool8 HdMapSampleIsCoveredCourse(u32 index)
{
    // COVERED is a layer contract, not a behavior. Fortree cottages and
    // Lilycove houses mark porch/door tiles MB_NO_RUNNING on that layer.
    return sHdMapSamples[index].valid
        && UNPACK_LAYER_TYPE(sHdMapAttributes[index]) == METATILE_LAYER_TYPE_COVERED;
}

static bool8 HdMapSampleIsStructuralMaterial(u32 index)
{
    const u8 behavior = UNPACK_BEHAVIOR(sHdMapAttributes[index]);

    return !MetatileBehavior_IsSurfableWaterOrUnderwater(behavior)
        && !MetatileBehavior_IsBridgeOverWater(behavior)
        && !MetatileBehavior_IsFortreeBridge(behavior)
        && !MetatileBehavior_IsPacifidlogLog(behavior)
        && behavior != MB_REFLECTION_UNDER_BRIDGE;
}

static bool8 HdMapSampleHasTopArt(u32 index)
{
    return sHdMapSamples[index].valid
        && HdMetatileCoverage(&sHdMapSamples[index], 1) != 0;
}

static bool8 HdMapSampleHasVisibleArt(u32 index)
{
    return sHdMapSamples[index].valid
        && (HdMetatileCoverage(&sHdMapSamples[index], 0)
          + HdMetatileCoverage(&sHdMapSamples[index], 1) != 0);
}

static bool8 HdCourseHasVisibleArt(u32 courseX, u32 courseY, u32 sampleCols)
{
    const u32 sampleX = courseX / 2;
    const u32 sampleY = courseY / 2;
    const u32 sample = sampleY * sampleCols + sampleX;
    const u8 quadrant = (courseY & 1) * 2 + (courseX & 1);

    return sHdMapSamples[sample].valid
        && (HdMetatileQuadrantCoverage(&sHdMapSamples[sample], 0, quadrant)
          + HdMetatileQuadrantCoverage(&sHdMapSamples[sample], 1, quadrant) != 0);
}

static bool8 HdMapSampleIsWalkableFloorArt(u32 index);
static bool8 HdMapSamplePlane0IsFloorArt(u32 index);
static bool8 HdMapSampleIsFoliageArt(u32 index);
static bool8 HdMapSampleHasFacadeSupport(u32 index, u32 sampleCols, u32 sampleRows);
static bool8 HdMapSampleIsPropColumn(u32 index, u32 sampleCols, u32 sampleRows);
static bool8 HdCourseIsRoofArt(u32 courseX, u32 courseY, u32 sampleCols,
                               u32 sampleRows);

static bool8 HdMapSampleMatchesWalkableFront(u32 index, u32 sampleCols, u32 sampleRows)
{
    const u32 front = index + sampleCols;

    if (index + sampleCols >= sampleCols * sampleRows)
        return FALSE;
    if (!sHdMapSamples[front].valid || sHdMapSamples[front].collision)
        return FALSE;
    return HdMetatilesHaveSameVisibleArt(&sHdMapSamples[index], &sHdMapSamples[front]);
}

static bool8 HdMapSampleIsFloorSurfaceUncached(u32 index, u32 sampleCols, u32 sampleRows)
{
    const u32 sampleY = index / sampleCols;
    const u32 north = index - sampleCols;

    // Walkable floor art is a floor even when a collision copy sits inside a
    // building footprint or a covered porch uses the same painting as the
    // deck in front.
    // Authored doors keep their own walkable painting, so matching that
    // painting as floor art would flatten every cottage and house entrance.
    // COVERED collision posts under more house collision share porch art
    // and must stay in the facade span.
    if (HdMapSampleIsDoorCourse(index))
        return FALSE;
    if (sHdMapSamples[index].collision
     && HdMapSampleIsCoveredCourse(index)
     && sampleY > 0
     && sHdMapSamples[north].valid
     && sHdMapSamples[north].collision
     && HdMapSampleIsStructuralMaterial(north)
     && HdMapSampleHasVisibleArt(north)
     && !HdMapSampleIsDoorCourse(north))
        return FALSE;
    return HdMapSampleIsWalkableFloorArt(index)
        || HdMapSampleMatchesWalkableFront(index, sampleCols, sampleRows);
}

static bool8 HdMapSampleIsFloorSurface(u32 index, u32 sampleCols, u32 sampleRows)
{
    u8 *cached = &sHdSamplePredicateCaches[HD_PREDICATE_FLOOR_SURFACE][index];

    if (*cached == 0)
        *cached = HdMapSampleIsFloorSurfaceUncached(index, sampleCols, sampleRows) + 1;
    return *cached == 2;
}

static bool8 HdMapSampleIsDecorativeOverlayUncached(u32 index)
{
    // Hedges, planter rims, and some roof sheets paint the top plane over a
    // walkable ground underlay. Foliage stays decoration; roof-colored
    // sheets can still cap a facade.
    return HdMapSampleHasTopArt(index)
        && !HdMapSampleIsDoorCourse(index)
        && !HdMapSampleIsCoveredCourse(index)
        && HdMapSamplePlane0IsFloorArt(index);
}

static bool8 HdMapSampleIsDecorativeOverlay(u32 index)
{
    u8 *cached = &sHdSamplePredicateCaches[HD_PREDICATE_DECORATIVE][index];

    if (*cached == 0)
        *cached = HdMapSampleIsDecorativeOverlayUncached(index) + 1;
    return *cached == 2;
}

static bool8 HdMapSampleIsFacadeBodyUncached(u32 index, u32 sampleCols, u32 sampleRows)
{
    return sHdMapSamples[index].valid
        && HdMapSampleIsStructuralMaterial(index)
        && !HdMapSampleIsFloorSurface(index, sampleCols, sampleRows)
        && !HdMapSampleIsDecorativeOverlay(index)
        && (HdMapSampleIsDoorCourse(index)
         || HdMapSampleIsCoveredCourse(index)
         || (sHdMapSamples[index].collision && HdMapSampleHasVisibleArt(index)));
}

static bool8 HdMapSampleIsFacadeBody(u32 index, u32 sampleCols, u32 sampleRows)
{
    u8 *cached = &sHdSamplePredicateCaches[HD_PREDICATE_FACADE_BODY][index];

    if (*cached == 0)
        *cached = HdMapSampleIsFacadeBodyUncached(index, sampleCols, sampleRows) + 1;
    return *cached == 2;
}

static bool8 HdMapSampleIsBuildingMassUncached(u32 index, u32 sampleCols, u32 sampleRows)
{
    const u32 sampleX = index % sampleCols;
    const u32 sampleY = index / sampleCols;

    if (!sHdMapSamples[index].valid
     || !sHdMapSamples[index].collision
     || !HdMapSampleIsStructuralMaterial(index)
     || !HdMapSampleHasVisibleArt(index)
     || HdMapSampleIsFloorSurface(index, sampleCols, sampleRows)
     || HdMapSampleIsFoliageArt(index))
        return FALSE;
    if (!HdMapSampleIsDecorativeOverlay(index))
        return TRUE;
    return sampleY + 1 < sampleRows
        && HdMapSampleIsFacadeBody((sampleY + 1) * sampleCols + sampleX,
                                   sampleCols, sampleRows);
}

static bool8 HdMapSampleIsBuildingMass(u32 index, u32 sampleCols, u32 sampleRows)
{
    u8 *cached = &sHdSamplePredicateCaches[HD_PREDICATE_BUILDING_MASS][index];

    if (*cached == 0)
        *cached = HdMapSampleIsBuildingMassUncached(index, sampleCols, sampleRows) + 1;
    return *cached == 2;
}

static bool8 HdMapSamplePlanesMatchUncached(u32 index)
{
    const struct HdMapSample *sample = &sHdMapSamples[index];

    if (!sample->valid)
        return FALSE;
    if (HdMetatileCoverage(sample, 1) == 0)
        return TRUE;
    for (u32 quadrant = 0; quadrant < 4; quadrant++)
    {
        for (u32 y = 0; y < HD2D_TILE_WIDTH; y++)
        {
            for (u32 x = 0; x < HD2D_TILE_WIDTH; x++)
            {
                struct Rgb bottom;
                struct Rgb top;
                const bool8 bottomOpaque = HdMetatilePixel(sample->layout, sample->metatileId,
                                                            0, quadrant, x, y, &bottom);
                const bool8 topOpaque = HdMetatilePixel(sample->layout, sample->metatileId,
                                                         1, quadrant, x, y, &top);

                if (bottomOpaque != topOpaque)
                    return FALSE;
                if (bottomOpaque
                 && (bottom.r != top.r || bottom.g != top.g || bottom.b != top.b))
                    return FALSE;
            }
        }
    }
    return TRUE;
}

static bool8 HdMapSamplePlanesMatch(u32 index)
{
    struct HdArtPredicateCache *cache = HdArtPredicateCache(index);

    if (!(cache->known & HD_ART_PREDICATE_PLANES_MATCH))
    {
        cache->known |= HD_ART_PREDICATE_PLANES_MATCH;
        if (HdMapSamplePlanesMatchUncached(index))
            cache->results |= HD_ART_PREDICATE_PLANES_MATCH;
    }
    return (cache->results & HD_ART_PREDICATE_PLANES_MATCH) != 0;
}

static bool8 HdMapSampleSitsOnFacade(u32 index, u32 sampleCols, u32 sampleRows)
{
    const u32 sampleX = index % sampleCols;
    const u32 sampleY = index / sampleCols;

    return sampleY + 1 < sampleRows
        && HdMapSampleIsFacadeBody((sampleY + 1) * sampleCols + sampleX,
                                   sampleCols, sampleRows);
}

static bool8 HdMapSampleIsSolidRoofSheetUncached(u32 index, u32 sampleCols, u32 sampleRows)
{
    const u32 sampleY = index / sampleCols;
    const bool8 massAbove = sampleY > 0
        && HdMapSampleIsBuildingMass(index - sampleCols, sampleCols, sampleRows);

    if (!sHdMapSamples[index].valid
     || !sHdMapSamples[index].collision
     || !HdMapSampleIsStructuralMaterial(index)
     || !HdMapSampleHasVisibleArt(index)
     || HdMapSampleIsFloorSurface(index, sampleCols, sampleRows)
     || HdMapSampleIsDoorCourse(index)
     || HdMapSampleIsFoliageArt(index))
        return FALSE;
    // Prop stacks (shelves, plant boxes, crates) are their own support and
    // must never read as a building cap, or the eaves rule spreads their
    // roof status onto neighboring facade columns.
    if (HdMapSampleIsPropColumn(index, sampleCols, sampleRows))
        return FALSE;
    if (HdMapSampleIsCoveredCourse(index))
    {
        const u32 south = sampleY + 1 < sampleRows
            ? index + sampleCols : index;

        // 1-row MART/PC tiles are both facade and roof. Stacked COVERED
        // cottage posts sit on another COVERED course and stay wall.
        if (HdMapSampleHasFacadeSupport(index, sampleCols, sampleRows))
            return !massAbove;
        return HdMapSampleSitsOnFacade(index, sampleCols, sampleRows)
            && !HdMapSampleIsCoveredCourse(south);
    }
    // Solid caps paint the same sheet on both planes, or only plane 0.
    // Window and gable rows overlay different top-plane house art.
    return HdMapSamplePlanesMatch(index)
        && HdMapSampleSitsOnFacade(index, sampleCols, sampleRows);
}

static bool8 HdMapSampleIsSolidRoofSheet(u32 index, u32 sampleCols, u32 sampleRows)
{
    u8 *cached = &sHdSamplePredicateCaches[HD_PREDICATE_SOLID_ROOF][index];

    if (*cached == 0)
        *cached = HdMapSampleIsSolidRoofSheetUncached(index, sampleCols, sampleRows) + 1;
    return *cached == 2;
}

static bool8 HdCourseIsRoofArtUncached(u32 courseX, u32 courseY, u32 sampleCols,
                                       u32 sampleRows)
{
    const u32 sampleX = courseX / 2;
    const u32 sampleY = courseY / 2;
    const u32 sample = sampleY * sampleCols + sampleX;
    const u8 quadrant = (courseY & 1) * 2 + (courseX & 1);
    const u32 south = sampleY + 1 < sampleRows
        ? (sampleY + 1) * sampleCols + sampleX : sample;
    const bool8 extendsRoof = courseY + 2 < sampleRows * 2
        && sHdMapSamples[sample].valid
        && !sHdMapSamples[sample].collision
        && HdMetatileQuadrantCoverage(&sHdMapSamples[sample], 1, quadrant) != 0
        && HdMapSampleIsDecorativeOverlay(sample)
        && HdMapSampleIsStructuralMaterial(sample)
        && !HdMapSampleIsFoliageArt(sample)
        && HdCourseIsRoofArt(courseX, courseY + 2, sampleCols, sampleRows);

    // Landmark roofs are authored caps on a facade. Collision top-art also
    // covers hedges and planter rims; green overlays stay on the ground. A
    // non-blocking decorative course may continue proven roof art immediately
    // south: rear gables use walkable ground underlay so actors can pass behind
    // the building, but their exact top-plane quadrants belong to the cap.
    if (!HdCourseHasVisibleArt(courseX, courseY, sampleCols)
     || (!sHdMapSamples[sample].collision && !extendsRoof)
     || !HdMapSampleIsStructuralMaterial(sample)
     || (HdMapSampleIsFloorSurface(sample, sampleCols, sampleRows) && !extendsRoof)
     || HdMapSampleIsDoorCourse(sample))
        return FALSE;
    if (extendsRoof)
        return TRUE;
    if (HdMapSampleIsFoliageArt(sample))
    {
        // Leafy house caps sit on a NORMAL gable row. Green posts on a
        // COVERED/door facade stay wall, and hedges on fences stay ground.
        return HdMapSampleSitsOnFacade(sample, sampleCols, sampleRows)
            && !HdMapSampleIsCoveredCourse(south)
            && !HdMapSampleIsDoorCourse(south);
    }
    if (HdMapSampleIsCoveredCourse(sample)
     && sampleY > 0
     && HdMapSampleSitsOnFacade(sample, sampleCols, sampleRows)
     && (HdMapSampleIsCoveredCourse(south) || HdMapSampleIsDoorCourse(south))
     && HdMapSampleIsDecorativeOverlay(sample - sampleCols)
     && HdMapSampleIsStructuralMaterial(sample - sampleCols))
    {
        // A COVERED course pinched between a decorative roof sheet above and
        // a covered/door facade below is the closing transition of the cap
        // (recessed storefronts, canopy kiosks): panel borders and front
        // eave arcs authored in 3/4 view. The whole row is cap art — the
        // vertical facade is the covered/door row beneath it — so the roof
        // keeps its closing border when stretched to the front line. The
        // decorative sheet may be a non-blocking, ground-underlaid rear cap;
        // its art contract, not collision, proves the transition.
        // Cottage bodies keep NORMAL or COVERED art above (their roof rows
        // are baked sheets, not decorative overlays) and stay wall.
        return TRUE;
    }
    if (HdMapSampleIsSolidRoofSheet(sample, sampleCols, sampleRows))
        return TRUE;
    // Eaves keep top-plane edge art beside a solid roof sheet. They sit on
    // the same facade or on another roof/eave row, not on open plaza.
    if (HdMapSampleHasTopArt(sample)
     && (HdMapSampleSitsOnFacade(sample, sampleCols, sampleRows)
      || HdMapSampleIsDecorativeOverlay(south)
      || HdMapSampleIsSolidRoofSheet(south, sampleCols, sampleRows)
      || HdMapSampleIsBuildingMass(south, sampleCols, sampleRows))
     && ((sampleX > 0
       && HdMapSampleIsSolidRoofSheet(sample - 1, sampleCols, sampleRows))
      || (sampleX + 1 < sampleCols
       && HdMapSampleIsSolidRoofSheet(sample + 1, sampleCols, sampleRows))))
        return TRUE;
    // Same-width MART/PC window rows are NORMAL art on a COVERED facade.
    // COVERED cottage posts sit on another COVERED post and stay wall.
    return HdMapSampleSitsOnFacade(sample, sampleCols, sampleRows)
        && HdMapSampleIsCoveredCourse(south)
        && !HdMapSampleIsCoveredCourse(sample);
}

static bool8 HdCourseIsRoofArt(u32 courseX, u32 courseY, u32 sampleCols,
                               u32 sampleRows)
{
    u8 *cached = &sHdRoofArtCache[courseY * sampleCols * 2 + courseX];

    if (*cached == 0)
        *cached = HdCourseIsRoofArtUncached(courseX, courseY, sampleCols, sampleRows) + 1;
    return *cached == 2;
}

static bool8 HdMapSampleIsOpaqueBlocked(u32 index)
{
    return sHdMapSamples[index].valid
        && sHdMapSamples[index].collision
        && HdMapSampleIsStructuralMaterial(index)
        && HdMapSampleHasVisibleArt(index);
}

static bool8 HdMapSampleHasFacadeSupportUncached(u32 index, u32 sampleCols, u32 sampleRows)
{
    if (index < sampleCols
     || index + sampleCols >= sampleCols * sampleRows
     || !sHdMapSamples[index].valid)
        return FALSE;
    // Cottage porches keep NORMAL collision art beside the door. COVERED
    // fences and plaza sheets are not facades unless they sit on a door.
    if (!(HdMapSampleIsDoorCourse(index)
       || HdMapSampleIsCoveredCourse(index)
       || (sHdMapSamples[index].collision
        && HdMapSampleHasVisibleArt(index)
        && HdMapSampleIsStructuralMaterial(index)
        && !HdMapSampleIsDecorativeOverlay(index)
        && !HdMapSampleIsFoliageArt(index))))
        return FALSE;
    return HdMapSampleIsOpaqueBlocked(index - sampleCols)
        && sHdMapSamples[index + sampleCols].valid
        && !sHdMapSamples[index + sampleCols].collision
        // Walkable mountain caps sit in front of cave warps and other
        // terrain mouths. That is not building-facade support.
        && sHdSampleBaseSurfaces[index + sampleCols] != HD_SURFACE_TERRAIN
        && sHdSampleBaseSurfaces[index + sampleCols] != HD_SURFACE_WATER
        && !HdMapSampleIsFloorSurface(index, sampleCols, sampleRows);
}

static bool8 HdMapSampleHasFacadeSupport(u32 index, u32 sampleCols, u32 sampleRows)
{
    u8 *cached = &sHdSamplePredicateCaches[HD_PREDICATE_FACADE_SUPPORT][index];

    if (*cached == 0)
        *cached = HdMapSampleHasFacadeSupportUncached(index, sampleCols, sampleRows) + 1;
    return *cached == 2;
}

static bool8 HdMapSampleIsSupportedWallCore(u32 index, u32 sampleCols, u32 sampleRows)
{
    return HdMapSampleHasFacadeSupport(index, sampleCols, sampleRows)
        && (sHdMapSamples[index].collision
         || HdMapSampleHasTopArt(index)
         || HdMapSampleIsDoorCourse(index)
         || sHdMapSamples[index].hasWarpEntrance);
}

static bool8 HdMapSampleIsRoofCapCourse(u32 index, u32 sampleCols, u32 sampleRows)
{
    const u32 sampleX = index % sampleCols;
    const u32 sampleY = index / sampleCols;

    // Only a full roof sheet counts. 1-row COVERED MART/PC tiles keep their
    // lower 8px as facade, so the metatile itself is not a roof cap.
    return HdCourseIsRoofArt(sampleX * 2, sampleY * 2 + 1, sampleCols, sampleRows)
        || HdCourseIsRoofArt(sampleX * 2 + 1, sampleY * 2 + 1, sampleCols, sampleRows);
}

static bool8 HdMapSampleIsFacadeStackCourse(u32 index, u32 sampleCols, u32 sampleRows)
{
    // Rows above a door are often normal-layer house art (windows, gable),
    // not COVERED. They are more of the same 2D facade stack, not obstacles.
    // Same-width MART/PC caps stay horizontal because they are roof art.
    if (!sHdMapSamples[index].valid
     || !sHdMapSamples[index].collision
     || !HdMapSampleHasVisibleArt(index)
     || !HdMapSampleIsStructuralMaterial(index)
     || HdMapSampleIsFloorSurface(index, sampleCols, sampleRows)
     || HdMapSampleIsRoofCapCourse(index, sampleCols, sampleRows))
        return FALSE;
    if (!HdMapSampleIsDecorativeOverlay(index))
        return TRUE;
    // Cottage gables overlay house art on a ground-colored plane. Keep them
    // in the wall stack when they sit on the door span.
    return HdMapSampleSitsOnFacade(index, sampleCols, sampleRows);
}

static bool8 HdMapRowIsRoofOverhang(u32 row, u32 startX, u32 endX,
                                    u32 sampleCols, u32 sampleRows)
{
    // Only an authored roof-cap row stops the climb. Adjacent house posts
    // and overlay gables stay in the wall stack even when they sit beside
    // the door span.
    for (u32 x = startX; x <= endX; x++)
    {
        if (HdMapSampleIsRoofCapCourse(row * sampleCols + x, sampleCols, sampleRows))
            return TRUE;
    }
    return FALSE;
}

static bool8 HdMapRowContinuesFacade(u32 row, u32 startX, u32 endX,
                                     u32 sampleCols, u32 sampleRows)
{
    for (u32 x = startX; x <= endX; x++)
    {
        const u32 index = row * sampleCols + x;

        if (HdMapSampleHasFacadeSupport(index, sampleCols, sampleRows))
            continue;
        if (HdMapSampleIsFacadeStackCourse(index, sampleCols, sampleRows))
            continue;
        return FALSE;
    }
    return TRUE;
}

static bool8 HdMapSampleIsPropColumn(u32 index, u32 sampleCols, u32 sampleRows)
{
    u32 probe = index;

    // Prop stacks (market shelves, plant boxes, crates, tall trees) satisfy
    // facade support just like a wall-with-door column, but they are plain
    // collision art from plaza to open sky. Genuine facade columns carry
    // covered, door, or warp art somewhere in their collision run.
    // Walk to the base of the collision run first so the same answer comes
    // back for every course of the stack, not just its bottom row.
    while (probe + sampleCols < sampleCols * sampleRows
        && sHdMapSamples[probe + sampleCols].valid
        && sHdMapSamples[probe + sampleCols].collision)
        probe += sampleCols;
    // A doorway's flanking wall bays (cottage window strips) carry no
    // covered art in their own run; the door beside the run base proves the
    // column is facade, not a free-standing prop stack.
    if (probe % sampleCols > 0 && HdMapSampleIsDoorCourse(probe - 1))
        return FALSE;
    if (probe % sampleCols + 1 < sampleCols && HdMapSampleIsDoorCourse(probe + 1))
        return FALSE;
    while (probe >= sampleCols)
    {
        if (!sHdMapSamples[probe].valid)
            return FALSE;
        if (HdMapSampleIsDoorCourse(probe)
         || HdMapSampleIsCoveredCourse(probe)
         || sHdMapSamples[probe].hasWarpEntrance)
            return FALSE;
        if (!sHdMapSamples[probe - sampleCols].valid
         || !sHdMapSamples[probe - sampleCols].collision)
            return TRUE;
        probe -= sampleCols;
    }
    return FALSE;
}

static bool8 HdMapSampleIsDirectTerrainCourse(u32 index)
{
    const u8 behavior = UNPACK_BEHAVIOR(sHdMapAttributes[index]);

    // MB_MOUNTAIN_TOP is a wild-battle environment tag, not a height contract.
    // Treating it as a 24px plateau turns crater lips and coastal cities into
    // dirt walls. Elevation comes from authored cliff sheets; blocked cave
    // tiles remain the only native cap.
    return behavior == MB_CAVE && sHdMapSamples[index].collision;
}

static bool8 HdMapSampleIsTerrainCapCourse(u32 index, u32 sampleX,
                                           u32 sampleCols)
{
    if (HdMapSampleIsDirectTerrainCourse(index))
        return TRUE;
    if (!HdMapSampleIsCoveredCourse(index)
     || !sHdMapSamples[index].collision
     || !HdMapSampleIsStructuralMaterial(index)
     || !HdMapSampleHasTopArt(index))
        return FALSE;

    // Native cliff families place one covered corner beside a semantic
    // mountain span. Admit only that immediate same-row flank, and only when
    // its underlying plane is identical to the semantic seed. Layer type and
    // collision alone remain insufficient: both are also common on buildings.
    if (sampleX > 0 && HdMapSampleIsDirectTerrainCourse(index - 1)
     && HdMetatilesHaveSamePlaneArt(&sHdMapSamples[index],
                                    &sHdMapSamples[index - 1], 0))
        return TRUE;
    if (sampleX + 1 < sampleCols && HdMapSampleIsDirectTerrainCourse(index + 1)
     && HdMetatilesHaveSamePlaneArt(&sHdMapSamples[index],
                                    &sHdMapSamples[index + 1], 0))
        return TRUE;
    return FALSE;
}

static bool8 HdBehaviorIsOpenDeck(u8 behavior)
{
    if (MetatileBehavior_IsFortreeBridge(behavior)
     || MetatileBehavior_IsPacifidlogLog(behavior))
        return TRUE;
    if (MetatileBehavior_IsBridgeOverWater(behavior)
     && MetatileBehavior_GetBridgeType(behavior) != BRIDGE_TYPE_OCEAN)
        return TRUE;
    return FALSE;
}

static bool8 HdBehaviorIsWaterSurface(u8 behavior)
{
    return behavior == MB_REFLECTION_UNDER_BRIDGE
        || (MetatileBehavior_IsSurfableWaterOrUnderwater(behavior)
         && !MetatileBehavior_IsWaterfall(behavior));
}

static bool8 HdBehaviorOpenDeckUsesWaterReceiver(u8 behavior);

static struct HdAdjacentSampleEvidence HdSampleAdjacentEvidence(u32 index,
                                                               u32 sampleX,
                                                               u32 sampleY,
                                                               u32 sampleCols,
                                                               u32 sampleRows)
{
    static const s8 offsets[4][2] = {{-1, 0}, {1, 0}, {0, -1}, {0, 1}};
    struct HdAdjacentSampleEvidence evidence = {0};

    for (u32 i = 0; i < ARRAY_COUNT(offsets); i++)
    {
        const s32 neighborX = (s32)sampleX + offsets[i][0];
        const s32 neighborY = (s32)sampleY + offsets[i][1];
        u32 neighbor;
        u8 behavior;

        if (neighborX < 0 || neighborY < 0
         || neighborX >= (s32)sampleCols || neighborY >= (s32)sampleRows)
            continue;
        neighbor = neighborY * sampleCols + neighborX;
        behavior = UNPACK_BEHAVIOR(sHdMapAttributes[neighbor]);
        if (behavior == MB_REFLECTION_UNDER_BRIDGE)
            evidence.touchesReflection = TRUE;
        {
            const bool8 isWater = HdBehaviorIsWaterSurface(behavior);
            const bool8 isOpenDeck = HdBehaviorIsOpenDeck(behavior);
            const bool8 usesWaterReceiver = HdBehaviorOpenDeckUsesWaterReceiver(behavior);

            if (!isWater && !isOpenDeck && !usesWaterReceiver)
                continue;
            if (!HdMetatilesHaveSameVisibleArt(&sHdMapSamples[index], &sHdMapSamples[neighbor]))
                continue;
            if (isWater)
                evidence.matchingWaterArt = TRUE;
            if (isOpenDeck)
                evidence.matchingOpenDeckArt = TRUE;
            if (usesWaterReceiver)
                evidence.matchingWaterReceiverArt = TRUE;
        }
    }
    return evidence;
}

static u8 HdMapSampleBaseSurface(u32 index, u32 sampleX, u32 sampleY,
                                 u32 sampleCols, u32 sampleRows)
{
    const struct HdMapSample *sample = &sHdMapSamples[index];
    const u8 behavior = UNPACK_BEHAVIOR(sHdMapAttributes[index]);

    if (gMapHeader.mapType == MAP_TYPE_INDOOR
     || gMapHeader.mapType == MAP_TYPE_SECRET_BASE)
        return HD_SURFACE_GROUND;
    if (HdBehaviorIsWaterSurface(behavior))
        return HD_SURFACE_WATER;
    if (HdBehaviorIsOpenDeck(behavior))
    {
        const struct HdAdjacentSampleEvidence evidence =
            HdSampleAdjacentEvidence(index, sampleX, sampleY, sampleCols, sampleRows);

        if (evidence.matchingWaterArt)
            return HD_SURFACE_WATER;
        return HD_SURFACE_OPEN_DECK;
    }
    if (MetatileBehavior_IsBridgeOverWater(behavior))
        return HD_SURFACE_DECK;
    if (behavior == MB_NORMAL)
    {
        const struct HdAdjacentSampleEvidence evidence =
            HdSampleAdjacentEvidence(index, sampleX, sampleY, sampleCols, sampleRows);

        if (evidence.matchingOpenDeckArt)
            return HD_SURFACE_OPEN_DECK;
        if (sample->collision
         && HdMetatileCoverage(sample, 1) != 0
         && evidence.touchesReflection)
            return HD_SURFACE_OPEN_DECK;
    }
    if (HdMapSampleIsTerrainCapCourse(index, sampleX, sampleCols))
        return HD_SURFACE_TERRAIN;
    // Preserve generic collision as a rendering tag only. Collision describes
    // gameplay obstruction, not structural elevation, and covers both objects
    // and flat decorative art. HdSurfaceBaseHeight keeps this surface on the
    // authored ground plane instead of inventing a solid 16x16 block.
    if (sample->collision && HdMetatileCoverage(sample, 1) != 0)
        return HD_SURFACE_OBSTACLE;
    return HD_SURFACE_GROUND;
}

static s8 HdSurfaceBaseHeight(u8 surface)
{
    switch (surface)
    {
    case HD_SURFACE_WATER:
        return -4;
    case HD_SURFACE_DECK:
    case HD_SURFACE_OPEN_DECK:
        return 4;
    case HD_SURFACE_TERRAIN:
        return 24;
    // Generic collision is not a structural height contract. Its source art
    // includes trees, flowers, signs, planters, fences, and decorative floors;
    // raising the whole 16x16 cell invents solid slabs around transparent or
    // flat pixels. Keep that art on the authored ground plane and reserve
    // elevation for semantic terrain, decks, water, and building components.
    case HD_SURFACE_OBSTACLE:
        return 0;
    default:
        return 0;
    }
}

static u16 HdPackOpenDeckReceiver(u8 surface, s32 dx, s32 dy)
{
    return HD2D_RECEIVER_VALID
        | (surface & HD2D_SURFACE_MASK)
        | ((dx + HD2D_RECEIVER_OFFSET_BIAS) << HD2D_RECEIVER_DX_SHIFT)
        | ((dy + HD2D_RECEIVER_OFFSET_BIAS) << HD2D_RECEIVER_DY_SHIFT);
}

static bool8 HdMapSampleIsTerrainFaceSource(u32 sample)
{
    return HdMapSampleIsStructuralMaterial(sample)
        && !HdMapSampleIsDirectTerrainCourse(sample)
        && HdMetatileCoverage(&sHdMapSamples[sample], 0)
         + HdMetatileCoverage(&sHdMapSamples[sample], 1) != 0;
}

static bool8 HdTerrainFaceBandValid(u32 startX, u32 endX, u32 sampleY,
                                    u32 sampleCols)
{
    u32 faceCells = 0;
    u32 gaps = 0;

    for (u32 x = startX; x <= endX; x++)
    {
        const u32 sample = sampleY * sampleCols + x;

        if (HdMapSampleIsTerrainFaceSource(sample))
        {
            faceCells++;
            continue;
        }
        gaps++;
        if (x == startX || x == endX)
            return FALSE;
        if (!HdMapSampleIsTerrainFaceSource(sample - 1)
         || !HdMapSampleIsTerrainFaceSource(sample + 1))
            return FALSE;
    }
    return faceCells != 0 && gaps <= faceCells / 2;
}

static u32 HdTerrainFaceDepth(u32 startX, u32 endX, u32 sampleY, s32 directionY,
                              u32 sampleCols, u32 sampleRows)
{
    u32 sampleDepth = 0;

    for (u32 distance = 1; distance <= 3; distance++)
    {
        const s32 sourceY = (s32)sampleY + directionY * (s32)distance;

        if (sourceY < 0 || sourceY >= (s32)sampleRows)
            break;
        if (!HdTerrainFaceBandValid(startX, endX, (u32)sourceY, sampleCols))
            break;
        sampleDepth = distance;
    }
    return sampleDepth;
}

static void HdTerrainSpanForSample(u32 sampleX, u32 sampleY, u32 sampleCols,
                                   u32 *startX, u32 *endX)
{
    u32 start = sampleX;
    u32 end = sampleX;

    while (start > 0
        && sHdSampleBaseSurfaces[sampleY * sampleCols + start - 1] == HD_SURFACE_TERRAIN)
        start--;
    while (end + 1 < sampleCols
        && sHdSampleBaseSurfaces[sampleY * sampleCols + end + 1] == HD_SURFACE_TERRAIN)
        end++;
    *startX = start;
    *endX = end;
}

static void HdResolveTerrainFaceReceivers(u32 courseCols, u32 courseRows)
{
    const u32 sampleCols = courseCols / 2;
    const u32 sampleRows = courseRows / 2;

    for (u32 courseY = 0; courseY < courseRows; courseY++)
    {
        for (u32 courseX = 0; courseX < courseCols; courseX++)
        {
            const u32 course = courseY * courseCols + courseX;
            const u8 surface = sHdCourseGeometry[course] & HD2D_SURFACE_MASK;

            if (surface != HD_SURFACE_TERRAIN)
                continue;
            // Native terrain faces are blocked structural rows adjacent to a
            // semantic mountain cap. They are source art for the exposed edge,
            // never additional elevated horizontal slabs. Battle Frontier
            // families place face rows south of the cap, while other families
            // use rows north of it; publish the direction explicitly so the
            // browser consumes authored courses in map order instead of
            // mirroring the wrong side.
            // Work at sample granularity because a face family advances in
            // 16px metatiles while the renderer publishes 8px courses.
            {
                const u32 sampleX = courseX / 2;
                const u32 sampleY = courseY / 2;
                u32 spanStart;
                u32 spanEnd;
                u32 northDepth = 0;
                u32 southDepth = 0;
                u32 sampleDepth;
                u16 direction;

                HdTerrainSpanForSample(sampleX, sampleY, sampleCols,
                                       &spanStart, &spanEnd);
                if (sampleY == 0
                 || sHdSampleBaseSurfaces[(sampleY - 1) * sampleCols + sampleX] != HD_SURFACE_TERRAIN)
                    northDepth = HdTerrainFaceDepth(spanStart, spanEnd, sampleY, -1,
                                                    sampleCols, sampleRows);
                if (sampleY + 1 == sampleRows
                 || sHdSampleBaseSurfaces[(sampleY + 1) * sampleCols + sampleX] != HD_SURFACE_TERRAIN)
                    southDepth = HdTerrainFaceDepth(spanStart, spanEnd, sampleY, 1,
                                                    sampleCols, sampleRows);
                // A water drop on the camera-facing side is a real cliff edge.
                // North-side approach/slope art must not be copied onto that
                // seaward face; that duplicates cave mouths and dark recesses.
                if (sampleY + 1 < sampleRows
                 && sHdSampleBaseSurfaces[(sampleY + 1) * sampleCols + sampleX] == HD_SURFACE_WATER)
                    northDepth = 0;
                else if (northDepth != 0 && southDepth == 0)
                {
                    u32 southY = sampleY;

                    while (southY + 1 < sampleRows
                        && sHdSampleBaseSurfaces[(southY + 1) * sampleCols + sampleX] == HD_SURFACE_TERRAIN)
                        southY++;
                    if (southY + 1 < sampleRows
                     && sHdSampleBaseSurfaces[(southY + 1) * sampleCols + sampleX] == HD_SURFACE_WATER)
                        northDepth = 0;
                }
                if (northDepth != 0 && southDepth != 0)
                {
                    sampleDepth = southDepth;
                    direction = HD2D_RECEIVER_TERRAIN_FACE_SOUTH;
                }
                else
                {
                    sampleDepth = northDepth != 0 ? northDepth : southDepth;
                    direction = southDepth != 0 ? HD2D_RECEIVER_TERRAIN_FACE_SOUTH : 0;
                }

                if (sampleDepth != 0
                 && ((direction && (courseY & 1))
                  || (!direction && !(courseY & 1))))
                    sHdCourseReceivers[course] = HD2D_RECEIVER_TERRAIN_FACE
                        | direction
                        | ((sampleDepth * 2) & HD2D_RECEIVER_OFFSET_MASK);
            }
        }
    }
}

static bool8 HdMapSampleIsCliffBandSurface(u32 index)
{
    const u8 surface = sHdSampleBaseSurfaces[index];

    return surface != HD_SURFACE_WATER
        && surface != HD_SURFACE_DECK
        && surface != HD_SURFACE_OPEN_DECK
        && surface != HD_SURFACE_WALL
        && surface != HD_SURFACE_ROOF
        && surface != HD_SURFACE_TERRAIN;
}

static bool8 HdMapSampleIsEarthArtUncached(u32 index)
{
    const struct HdMapSample *sample = &sHdMapSamples[index];
    u32 earth = 0;
    u32 opaque = 0;

    if (!sample->valid)
        return FALSE;
    // Authored cliff/opening sheets are rock, dirt, or stone paintings.
    // Hedges, planters, and plaza tiles share collision and width with those
    // sheets; only earth-colored plane-0 art should stand up.
    for (u32 quadrant = 0; quadrant < 4; quadrant++)
    {
        for (u32 y = 0; y < HD2D_TILE_WIDTH; y += 2)
        {
            for (u32 x = 0; x < HD2D_TILE_WIDTH; x += 2)
            {
                struct Rgb color;
                u8 rg;
                u8 gb;
                u8 rb;
                bool8 brown;
                bool8 gray;

                if (!HdMetatilePixel(sample->layout, sample->metatileId, 0,
                                     quadrant, x, y, &color))
                    continue;
                opaque++;
                if (color.g > color.r + 12 && color.g > color.b + 12)
                    continue;
                rg = color.r > color.g ? color.r - color.g : color.g - color.r;
                gb = color.g > color.b ? color.g - color.b : color.b - color.g;
                rb = color.r > color.b ? color.r - color.b : color.b - color.r;
                brown = color.r + 32 >= color.g
                     && color.r > color.b + 8
                     && color.g + 8 >= color.b
                     && color.r >= 32;
                gray = rg < 28 && gb < 28 && rb < 28
                    && color.r >= 32 && color.r <= 188;
                if (brown || gray)
                    earth++;
            }
        }
    }
    return opaque != 0 && earth * 2 >= opaque;
}

static bool8 HdMapSampleIsEarthArt(u32 index)
{
    struct HdArtPredicateCache *cache = HdArtPredicateCache(index);

    if (!(cache->known & HD_ART_PREDICATE_EARTH))
    {
        cache->known |= HD_ART_PREDICATE_EARTH;
        if (HdMapSampleIsEarthArtUncached(index))
            cache->results |= HD_ART_PREDICATE_EARTH;
    }
    return (cache->results & HD_ART_PREDICATE_EARTH) != 0;
}

static bool8 HdMapSampleIsWalkableFloorArtUncached(u32 index)
{
    const u16 metatileId = sHdMapSamples[index].metatileId;
    const struct MapLayout *layout = sHdMapSamples[index].layout;

    for (u32 i = 0; i < ARRAY_COUNT(sHdMapSamples); i++)
    {
        if (!sHdMapSamples[i].valid || sHdMapSamples[i].collision)
            continue;
        if (sHdMapSamples[i].layout == layout
         && sHdMapSamples[i].metatileId == metatileId
         && sHdSampleBaseSurfaces[i] == HD_SURFACE_GROUND)
            return TRUE;
    }
    return FALSE;
}

static bool8 HdMapSampleIsWalkableFloorArt(u32 index)
{
    struct HdArtPredicateCache *cache = HdArtPredicateCache(index);

    if (!(cache->known & HD_ART_PREDICATE_WALKABLE_FLOOR))
    {
        cache->known |= HD_ART_PREDICATE_WALKABLE_FLOOR;
        if (HdMapSampleIsWalkableFloorArtUncached(index))
            cache->results |= HD_ART_PREDICATE_WALKABLE_FLOOR;
    }
    return (cache->results & HD_ART_PREDICATE_WALKABLE_FLOOR) != 0;
}

static bool8 HdMapSamplePlane0IsFloorArtUncached(u32 index)
{
    const struct HdMapSample *sample = &sHdMapSamples[index];

    if (!sample->valid || HdMetatileCoverage(sample, 0) == 0)
        return FALSE;
    for (u32 i = 0; i < ARRAY_COUNT(sHdMapSamples); i++)
    {
        if (!sHdMapSamples[i].valid || sHdMapSamples[i].collision)
            continue;
        if (sHdSampleBaseSurfaces[i] == HD_SURFACE_GROUND
         && HdMetatilesHaveSamePlaneArt(sample, &sHdMapSamples[i], 0))
            return TRUE;
    }
    return FALSE;
}

static bool8 HdMapSamplePlane0IsFloorArt(u32 index)
{
    struct HdArtPredicateCache *cache = HdArtPredicateCache(index);

    if (!(cache->known & HD_ART_PREDICATE_PLANE0_FLOOR))
    {
        cache->known |= HD_ART_PREDICATE_PLANE0_FLOOR;
        if (HdMapSamplePlane0IsFloorArtUncached(index))
            cache->results |= HD_ART_PREDICATE_PLANE0_FLOOR;
    }
    return (cache->results & HD_ART_PREDICATE_PLANE0_FLOOR) != 0;
}

static bool8 HdMapSampleIsFoliageArtUncached(u32 index)
{
    const struct HdMapSample *sample = &sHdMapSamples[index];
    const u8 plane = HdMetatileCoverage(sample, 1) != 0 ? 1 : 0;
    u32 foliage = 0;
    u32 opaque = 0;

    if (!sample->valid)
        return FALSE;
    for (u32 quadrant = 0; quadrant < 4; quadrant++)
    {
        for (u32 y = 0; y < HD2D_TILE_WIDTH; y += 2)
        {
            for (u32 x = 0; x < HD2D_TILE_WIDTH; x += 2)
            {
                struct Rgb color;

                if (!HdMetatilePixel(sample->layout, sample->metatileId, plane,
                                     quadrant, x, y, &color))
                    continue;
                opaque++;
                if (color.g > color.r + 12 && color.g > color.b + 12)
                    foliage++;
            }
        }
    }
    return opaque != 0 && foliage * 2 >= opaque;
}

static bool8 HdMapSampleIsFoliageArt(u32 index)
{
    struct HdArtPredicateCache *cache = HdArtPredicateCache(index);

    if (!(cache->known & HD_ART_PREDICATE_FOLIAGE))
    {
        cache->known |= HD_ART_PREDICATE_FOLIAGE;
        if (HdMapSampleIsFoliageArtUncached(index))
            cache->results |= HD_ART_PREDICATE_FOLIAGE;
    }
    return (cache->results & HD_ART_PREDICATE_FOLIAGE) != 0;
}

static bool8 HdMapSampleIsCliffSeedUncached(u32 index)
{
    const u8 behavior = UNPACK_BEHAVIOR(sHdMapAttributes[index]);

    if (!sHdMapSamples[index].valid || !sHdMapSamples[index].collision)
        return FALSE;
    if (!HdMapSampleIsStructuralMaterial(index) || !HdMapSampleIsCliffBandSurface(index))
        return FALSE;
    if (HdMapSampleIsDoorCourse(index) || sHdMapSamples[index].hasWarpEntrance)
        return FALSE;
    if (behavior != MB_NORMAL)
        return FALSE;
    // Decorative objects use the top plane. Authored 2D cliff/opening sheets
    // are plane-0 paintings that currently stay flat and band under tilt.
    if (HdMetatileCoverage(&sHdMapSamples[index], 0) == 0
     || HdMetatileCoverage(&sHdMapSamples[index], 1) != 0)
        return FALSE;
    // Collision marks obstruction, not height. Only rock/dirt/stone paintings
    // become cliff sheets; hedges and plaza copies stay on the ground.
    return HdMapSampleIsEarthArt(index)
        && !HdMapSampleIsWalkableFloorArt(index);
}

static bool8 HdMapSampleIsCliffSeed(u32 index)
{
    u8 *cached = &sHdSamplePredicateCaches[HD_PREDICATE_CLIFF_SEED][index];

    if (*cached == 0)
        *cached = HdMapSampleIsCliffSeedUncached(index) + 1;
    return *cached == 2;
}

static void HdPublishCliffBandCell(u32 sampleX, u32 sampleY, u32 sampleCols,
                                   u32 courseCols, s8 height, u16 faceReceiver)
{
    const u32 sample = sampleY * sampleCols + sampleX;

    sHdSampleBaseSurfaces[sample] = HD_SURFACE_TERRAIN;
    for (u32 courseY = sampleY * 2; courseY < sampleY * 2 + 2; courseY++)
    {
        for (u32 courseX = sampleX * 2; courseX < sampleX * 2 + 2; courseX++)
        {
            const u32 course = courseY * courseCols + courseX;

            sHdCourseGeometry[course] = HD_SURFACE_TERRAIN;
            sHdCourseHeights[course] = height;
            sHdCourseGroundHeights[course] = height;
            sHdCourseReceivers[course] = (faceReceiver != 0 && (courseY & 1))
                ? faceReceiver : 0;
        }
    }
}

static bool8 HdCliffRowRun(u32 sampleY, u32 sampleCols, u32 startX, u32 endX)
{
    u32 faceCells = 0;
    u32 width = endX - startX + 1;

    for (u32 x = startX; x <= endX; x++)
    {
        if (HdMapSampleIsCliffSeed(sampleY * sampleCols + x))
            faceCells++;
    }
    return faceCells * 2 >= width;
}

static void HdRaiseBlockedCliffBands(u32 sampleCols, u32 sampleRows,
                                     u32 courseCols)
{
    static u8 raised[HD2D_SAMPLE_COLS * HD2D_SAMPLE_ROWS];
    static const s8 offsets[4][2] = {{-1, 0}, {1, 0}, {0, -1}, {0, 1}};

    memset(raised, 0, sampleCols * sampleRows);
    // Grow overlapping horizontal runs, not 4-connected blobs. A 1-tile
    // hedge ring around a pond is one flood-fill component and becomes a
    // tower; a cliff sheet is a stack of wide overlapping rows.
    for (u32 y = 0; y < sampleRows; y++)
    {
        for (u32 x = 0; x < sampleCols;)
        {
            u32 start;
            u32 end;
            u32 top;
            u32 bottom;
            u32 width;
            u32 depth;
            u32 count = 0;
            u16 component[HD2D_SAMPLE_COLS * 8];
            bool8 touchesTerrain = FALSE;
            s8 height;
            u16 faceReceiver;
            u32 faceCourses;
            u32 heightCourses;

            if (raised[y * sampleCols + x] || !HdMapSampleIsCliffSeed(y * sampleCols + x))
            {
                x++;
                continue;
            }
            start = x;
            end = x;
            while (end + 1 < sampleCols
                && !raised[y * sampleCols + end + 1]
                && HdMapSampleIsCliffSeed(y * sampleCols + end + 1))
                end++;
            width = end - start + 1;
            if (width < HD2D_CLIFF_BAND_MIN_SHORT_WIDTH)
            {
                x = end + 1;
                continue;
            }
            top = y;
            bottom = y;
            while (top > 0 && HdCliffRowRun(top - 1, sampleCols, start, end))
                top--;
            while (bottom + 1 < sampleRows && HdCliffRowRun(bottom + 1, sampleCols, start, end))
                bottom++;
            depth = bottom - top + 1;
            if (depth < 2)
            {
                x = end + 1;
                continue;
            }
            for (u32 bandY = top; bandY <= bottom; bandY++)
            {
                for (u32 bandX = start; bandX <= end; bandX++)
                {
                    const u32 sample = bandY * sampleCols + bandX;

                    if (!HdMapSampleIsCliffSeed(sample) || raised[sample])
                        continue;
                    if (count < ARRAY_COUNT(component))
                        component[count++] = sample;
                    for (u32 d = 0; d < ARRAY_COUNT(offsets); d++)
                    {
                        const s32 nx = (s32)bandX + offsets[d][0];
                        const s32 ny = (s32)bandY + offsets[d][1];
                        u8 surface;

                        if (nx < 0 || ny < 0
                         || nx >= (s32)sampleCols || ny >= (s32)sampleRows)
                            continue;
                        surface = sHdSampleBaseSurfaces[ny * sampleCols + nx];
                        if (surface == HD_SURFACE_TERRAIN)
                            touchesTerrain = TRUE;
                    }
                }
            }
            if (count < HD2D_CLIFF_BAND_MIN_SHORT_WIDTH)
            {
                x = end + 1;
                continue;
            }
            // Collision is not height. A sheet with walkable ground in front
            // matches cave mouths, building bases, and plaza curbs. Only an
            // existing terrain cap (cave / authored cliff) proves a cliff.
            // MB_MOUNTAIN_TOP is a wild-battle tag, not a raise license, and
            // water is a drop, not proof of a cliff.
            if (!touchesTerrain)
            {
                x = end + 1;
                continue;
            }
            height = (s8)(depth * 16);
            if (height > HD2D_CLIFF_BAND_MAX_HEIGHT)
                height = HD2D_CLIFF_BAND_MAX_HEIGHT;
            faceCourses = depth * 2;
            heightCourses = (u32)height / HD2D_COURSE_HEIGHT;
            if (faceCourses > HD2D_RECEIVER_OFFSET_MASK)
                faceCourses = HD2D_RECEIVER_OFFSET_MASK;
            if (faceCourses > heightCourses)
                faceCourses = heightCourses;
            faceReceiver = HD2D_RECEIVER_TERRAIN_FACE
                | HD2D_RECEIVER_TERRAIN_FACE_SELF
                | (faceCourses & HD2D_RECEIVER_OFFSET_MASK);
            for (u32 i = 0; i < count; i++)
            {
                const u32 sample = component[i];
                const u32 sampleX = sample % sampleCols;
                const u32 sampleY = sample / sampleCols;

                raised[sample] = 1;
                HdPublishCliffBandCell(sampleX, sampleY, sampleCols, courseCols,
                                       height, sampleY == bottom ? faceReceiver : 0);
            }
            x = end + 1;
        }
    }
}

static bool8 HdBehaviorOpenDeckUsesWaterReceiver(u8 behavior)
{
    if (MetatileBehavior_IsFortreeBridge(behavior))
        return FALSE;
    if (MetatileBehavior_IsPacifidlogLog(behavior)
     || behavior == MB_REFLECTION_UNDER_BRIDGE)
        return TRUE;
    if (MetatileBehavior_IsBridgeOverWater(behavior)
     && MetatileBehavior_GetBridgeType(behavior) != BRIDGE_TYPE_OCEAN)
        return TRUE;
    return FALSE;
}

static bool8 HdSampleOpenDeckUsesWaterReceiver(u32 sampleX, u32 sampleY,
                                               u32 sampleCols, u32 sampleRows)
{
    const u32 sample = sampleY * sampleCols + sampleX;
    const u8 behavior = UNPACK_BEHAVIOR(sHdMapAttributes[sample]);
    const struct HdAdjacentSampleEvidence evidence =
        HdSampleAdjacentEvidence(sample, sampleX, sampleY, sampleCols, sampleRows);

    if (HdBehaviorOpenDeckUsesWaterReceiver(behavior))
        return TRUE;
    if (MetatileBehavior_IsFortreeBridge(behavior))
        return FALSE;
    return evidence.matchingWaterReceiverArt;
}

static bool8 HdOpenDeckReceiverSurfaceMatches(u8 surface, bool8 useWaterReceiver)
{
    if (useWaterReceiver)
        return surface == HD_SURFACE_WATER;
    return surface != HD_SURFACE_OPEN_DECK
        && surface != HD_SURFACE_WATER
        && surface != HD_SURFACE_WALL
        && surface != HD_SURFACE_ROOF;
}

static void HdResolveOpenDeckReceivers(u32 courseCols, u32 courseRows)
{
    const u32 sampleCols = courseCols / 2;
    const u32 sampleRows = courseRows / 2;

    for (u32 courseY = 0; courseY < courseRows; courseY++)
    {
        for (u32 courseX = 0; courseX < courseCols; courseX++)
        {
            const u32 course = courseY * courseCols + courseX;
            bool8 useWaterReceiver;

            sHdCourseReceivers[course] = 0;
            if ((sHdCourseGeometry[course] & HD2D_SURFACE_MASK) != HD_SURFACE_OPEN_DECK)
                continue;
            useWaterReceiver = HdSampleOpenDeckUsesWaterReceiver(courseX / 2,
                                                                 courseY / 2,
                                                                 sampleCols,
                                                                 sampleRows);
            for (u32 radius = 1; radius <= HD2D_GEOMETRY_RADIUS; radius++)
            {
                for (s32 dy = -(s32)radius; dy <= (s32)radius; dy++)
                {
                    const s32 dxLimit = radius - (dy < 0 ? -dy : dy);
                    const s32 dxs[2] = {-dxLimit, dxLimit};

                    for (u32 i = 0; i < ARRAY_COUNT(dxs); i++)
                    {
                        const s32 dx = dxs[i];
                        const s32 sourceX = (s32)courseX + dx;
                        const s32 sourceY = (s32)courseY + dy;
                        u32 source;

                        if (sourceX < 0 || sourceY < 0
                         || sourceX >= (s32)courseCols || sourceY >= (s32)courseRows)
                            continue;
                        source = sourceY * courseCols + sourceX;
                        if (HdOpenDeckReceiverSurfaceMatches(sHdCourseGeometry[source] & HD2D_SURFACE_MASK,
                                                             useWaterReceiver)
                         && sHdCourseHeights[source] < sHdCourseHeights[course])
                        {
                            sHdCourseReceivers[course] = HdPackOpenDeckReceiver(sHdCourseGeometry[source] & HD2D_SURFACE_MASK,
                                                                                dx, dy);
                            goto nextCourse;
                        }
                    }
                }
            }
        nextCourse:
            ;
        }
    }
}

static u16 HdFindBuildingRoot(u16 building)
{
    u16 root = building;

    while (sHdBuildings[root].parent != root)
        root = sHdBuildings[root].parent;
    while (sHdBuildings[building].parent != building)
    {
        const u16 next = sHdBuildings[building].parent;
        sHdBuildings[building].parent = root;
        building = next;
    }
    return root;
}

static bool8 HdBuildingHeightsEqual(u16 first, u16 second)
{
    return sHdBuildings[first].baseHeight == sHdBuildings[second].baseHeight
        && sHdBuildings[first].roofHeight == sHdBuildings[second].roofHeight;
}

static void HdUnionBuildingRoots(u16 first, u16 second)
{
    first = HdFindBuildingRoot(first);
    second = HdFindBuildingRoot(second);
    if (first != second)
        sHdBuildings[second].parent = first;
}

static bool8 HdCourseTouchesBuildingBoundary(u32 courseX, u32 courseY, u32 courseCols,
                                             const struct HdBuildingBounds *bounds)
{
    return courseX == 0 || courseY == 0 || courseX + 1 == courseCols
        || courseX <= bounds->minCourseX || courseY <= bounds->minCourseY
        || courseX + 1 >= bounds->maxCourseX || courseY + 1 >= bounds->maxCourseY;
}

static void HdClaimBuildingCourse(u32 courseX, u32 courseY, u32 courseCols,
                                  u16 building, u8 kind)
{
    const u32 course = courseY * courseCols + courseX;
    const s16 owner = sHdCourseBuilding[course];

    if (owner >= 0 && HdBuildingHeightsEqual(building, owner))
    {
        HdUnionBuildingRoots(building, owner);
        sHdCourseBuildingKind[course] |= kind;
        if ((kind & HD_BUILDING_WALL) && sHdCourseFacade[course] < 0)
            sHdCourseFacade[course] = building;
    }
    else if (owner < 0)
    {
        sHdCourseBuilding[course] = building;
        sHdCourseBuildingKind[course] = kind;
        if (kind & HD_BUILDING_WALL)
            sHdCourseFacade[course] = building;
    }
}

static bool8 HdCourseColumnSupportsRoofClaim(u32 courseX, u32 courseY,
                                             u32 courseCols, u32 sampleCols,
                                             u32 sampleRows)
{
    const u32 sampleX = courseX / 2;
    const u32 sampleY = courseY / 2;
    const u32 sample = sampleY * sampleCols + sampleX;
    u32 southCourse;

    // A roof course over open ground is an authored overhang. A roof course
    // over a facade body must sit on mass that actually joined a building:
    // stacked prop columns (shelves, tall trees) are their own support and
    // never become part of the neighboring building's roof.
    if (!HdMapSampleSitsOnFacade(sample, sampleCols, sampleRows))
        return TRUE;
    if (sampleY + 1 >= sampleRows)
        return TRUE;
    southCourse = ((sampleY + 1) * 2) * courseCols + sampleX * 2;
    return sHdCourseBuilding[southCourse] >= 0
        || sHdCourseBuilding[southCourse + 1] >= 0
        || sHdCourseBuilding[southCourse + courseCols] >= 0
        || sHdCourseBuilding[southCourse + courseCols + 1] >= 0;
}

static void HdFloodBuildingRoof(u16 building, u32 seedY, u32 spanStart,
                                u32 spanEnd, u32 sampleCols, u32 sampleRows,
                                u32 courseCols, const struct HdBuildingBounds *bounds)
{
    const u32 minY = seedY > HD2D_GEOMETRY_RADIUS * 2
        ? seedY - HD2D_GEOMETRY_RADIUS * 2 : 0;
    const u32 minX = spanStart > 2 ? spanStart - 2 : 0;
    const u32 maxX = spanEnd + 2 < courseCols ? spanEnd + 2 : courseCols;
    const u16 visit = building + 1;
    u32 queueStart = 0;
    u32 queueEnd = 0;

    for (u32 courseX = spanStart; courseX < spanEnd; courseX++)
    {
        const u32 course = seedY * courseCols + courseX;

        if (!HdCourseIsRoofArt(courseX, seedY, sampleCols, sampleRows))
            continue;
        sHdCourseVisit[course] = visit;
        sHdCourseQueue[queueEnd++] = course;
    }
    while (queueStart < queueEnd)
    {
        const u32 course = sHdCourseQueue[queueStart++];
        const u32 courseX = course % courseCols;
        const u32 courseY = course / courseCols;
        const s32 nextX[3] = {(s32)courseX - 1, (s32)courseX + 1, (s32)courseX};
        const s32 nextY[3] = {(s32)courseY, (s32)courseY, (s32)courseY - 1};

        if (!HdCourseColumnSupportsRoofClaim(courseX, courseY, courseCols,
                                             sampleCols, sampleRows))
            continue;
        HdClaimBuildingCourse(courseX, courseY, courseCols, building, HD_BUILDING_ROOF);
        if (HdCourseTouchesBuildingBoundary(courseX, courseY, courseCols, bounds))
            sHdBuildings[building].isClipped = TRUE;
        if (courseY == minY)
        {
            if (courseY > 0
             && HdCourseIsRoofArt(courseX, courseY - 1, sampleCols, sampleRows))
                sHdBuildings[building].isClipped = TRUE;
            continue;
        }
        for (u32 direction = 0; direction < ARRAY_COUNT(nextX); direction++)
        {
            u32 next;

            if (nextX[direction] < (s32)minX || nextX[direction] >= (s32)maxX
             || nextY[direction] < (s32)minY || nextY[direction] > (s32)seedY)
                continue;
            next = nextY[direction] * courseCols + nextX[direction];
            if (sHdCourseVisit[next] == visit
             || !HdCourseIsRoofArt(nextX[direction], nextY[direction], sampleCols, sampleRows))
                continue;
            sHdCourseVisit[next] = visit;
            sHdCourseQueue[queueEnd++] = next;
        }
    }
}

struct HdFacadeBand
{
    u16 y;
    u16 spanStart;
    u16 spanEnd;
    u16 coreStart;
    u16 coreEnd;
    u16 wallTop;
    bool8 hasEntrance;
    bool8 claimed;
};

static struct HdFacadeBand sHdFacadeBands[HD2D_BUILDING_COUNT];

static bool8 HdClaimFacadeBand(struct HdFacadeBand *band, u32 sampleCols,
                               u32 sampleRows, const struct HdBuildingBounds *bounds,
                               bool8 isSteppedTier)
{
    const u32 courseCols = sampleCols * 2;
    const u32 y = band->y;
    // The north half of a multi-row facade's top row is the roof/facade
    // contact-shadow course in the authored top-down tile, not vertical wall
    // art. Starting at the south half keeps that shadow on the horizontal
    // roof plane instead of turning it into detached black feet. A 1-row
    // facade IS the storefront: door, sign, and window art fill the whole
    // entrance metatile, so both of its courses stand as wall and the roof
    // flood seeds from the solid cap row above instead.
    const u32 wallStartCourse = band->wallTop == y ? band->wallTop * 2 : band->wallTop * 2 + 1;
    const u32 wallEndCourse = y * 2 + 2;
    const u32 spanStartCourse = band->spanStart * 2;
    const u32 spanEndCourse = (band->spanEnd + 1) * 2;
    const u32 supportCourse = ((y + 1) * 2) * courseCols + (band->coreStart + band->coreEnd + 1);
    const s16 roofHeight = sHdCourseGroundHeights[supportCourse]
                         + (wallEndCourse - wallStartCourse) * HD2D_COURSE_HEIGHT;
    u16 building;

    if (sHdBuildingCount >= ARRAY_COUNT(sHdBuildings) || roofHeight > 127)
        return FALSE;

    band->claimed = TRUE;
    building = sHdBuildingCount++;
    sHdBuildings[building].parent = building;
    sHdBuildings[building].componentId = 0;
    sHdBuildings[building].facadeAnchorCourseY = wallStartCourse;
    sHdBuildings[building].baseHeight = sHdCourseGroundHeights[supportCourse];
    sHdBuildings[building].roofHeight = roofHeight;
    sHdBuildings[building].hasEntrance = TRUE;
    sHdBuildings[building].isClipped = band->spanStart == 0 || band->spanEnd + 1 == sampleCols;
    sHdBuildings[building].isSteppedTier = isSteppedTier;

    for (u32 courseY = wallStartCourse; courseY < wallEndCourse; courseY++)
    {
        for (u32 courseX = spanStartCourse; courseX < spanEndCourse; courseX++)
        {
            if (HdCourseIsRoofArt(courseX, courseY, sampleCols, sampleRows))
                continue;
            // Prop stacks standing inside a recessed span (courtyard
            // shelves, planters) support the row contract but are
            // plaza furniture, not wall sheet.
            if (HdMapSampleIsPropColumn(y * sampleCols + courseX / 2, sampleCols, sampleRows))
                continue;
            HdClaimBuildingCourse(courseX, courseY, courseCols, building, HD_BUILDING_WALL);
            if (HdCourseTouchesBuildingBoundary(courseX, courseY, courseCols, bounds))
                sHdBuildings[building].isClipped = TRUE;
        }
    }
    // A multi-row wall starts on the south half of its top facade row. When
    // the metatile immediately above is the roof cap, its nearest course is
    // two courses north; seed it as well as the intervening contact-shadow row.
    // The roof predicate still decides which of these seeds may be claimed.
    if (wallStartCourse > 1)
    {
        HdFloodBuildingRoof(building, wallStartCourse - 2, spanStartCourse,
                            spanEndCourse, sampleCols, sampleRows, courseCols, bounds);
        // The north half of this facade row is the horizontal contact course
        // between a cap in the preceding metatile and the vertical wall below.
        // It is not independently recognizable as roof art, but must bridge
        // the proven cap to the facade so their physical planes meet.
        for (u32 courseX = spanStartCourse; courseX < spanEndCourse; courseX++)
        {
            if (HdCourseIsRoofArt(courseX, wallStartCourse - 2, sampleCols, sampleRows)
             && HdCourseHasVisibleArt(courseX, wallStartCourse - 1, sampleCols)
             && HdCourseColumnSupportsRoofClaim(courseX, wallStartCourse - 1,
                                                courseCols, sampleCols, sampleRows))
            {
                HdClaimBuildingCourse(courseX, wallStartCourse - 1, courseCols,
                                      building, HD_BUILDING_ROOF);
                if (HdCourseTouchesBuildingBoundary(courseX, wallStartCourse - 1,
                                                    courseCols, bounds))
                    sHdBuildings[building].isClipped = TRUE;
            }
        }
    }
    if (wallStartCourse > 0)
        HdFloodBuildingRoof(building, wallStartCourse - 1, spanStartCourse,
                            spanEndCourse, sampleCols, sampleRows, courseCols, bounds);
    HdFloodBuildingRoof(building, wallStartCourse, spanStartCourse,
                        spanEndCourse, sampleCols, sampleRows, courseCols, bounds);
    return TRUE;
}

static bool8 HdBandTouchesClaimedWall(const struct HdFacadeBand *band, u32 sampleCols,
                                      u32 sampleRows)
{
    const u32 courseCols = sampleCols * 2;
    const u32 courseRows = sampleRows * 2;
    bool8 touches = FALSE;
    const u32 wallStartCourse = band->wallTop == band->y
        ? band->wallTop * 2 : band->wallTop * 2 + 1;
    const u32 x0 = band->spanStart * 2 > 0 ? band->spanStart * 2 - 1 : 0;
    const u32 x1 = (band->spanEnd + 1) * 2 < courseCols
        ? (band->spanEnd + 1) * 2 : courseCols - 1;
    const u32 y0 = wallStartCourse > 0 ? wallStartCourse - 1 : 0;
    const u32 y1 = band->y * 2 + 2 < courseRows ? band->y * 2 + 2 : courseRows - 1;

    for (u32 courseY = y0; courseY <= y1; courseY++)
    {
        for (u32 courseX = x0; courseX <= x1; courseX++)
        {
            const u32 course = courseY * courseCols + courseX;

            if (sHdCourseBuilding[course] >= 0
             && (sHdCourseBuildingKind[course] & HD_BUILDING_WALL))
            {
                // The existing entrance band and this attached band are two
                // authored tiers of the same shell; publish that relationship
                // instead of asking the presenter to infer it from proximity.
                sHdBuildings[sHdCourseBuilding[course]].isSteppedTier = TRUE;
                touches = TRUE;
            }
        }
    }
    return touches;
}

static bool8 HdBandHasAttachableColumn(const struct HdFacadeBand *band, u32 sampleCols,
                                       u32 sampleRows)
{
    for (u32 x = band->spanStart; x <= band->spanEnd; x++)
    {
        const u32 sample = band->y * sampleCols + x;

        // Tree canopy and hedge rows beside Fortree tree houses satisfy the
        // wall contract but are vegetation, not a stepped tier of the
        // structure they touch.
        if (!HdMapSampleIsPropColumn(sample, sampleCols, sampleRows)
         && !HdMapSampleIsFoliageArt(sample))
            return TRUE;
    }
    return FALSE;
}

static void HdCollectBuildingCandidates(u32 sampleCols, u32 sampleRows,
                                        const struct HdBuildingBounds *bounds)
{
    u32 bandCount = 0;
    bool8 attached;

    sHdBuildingCount = 0;

    // Collect complete supported facade bands before asking whether any one
    // band owns a door. This lets stepped and overhanging authored courses join
    // one shell instead of dropping every non-door section independently.
    for (u32 y = 1; y + 1 < sampleRows; y++)
    {
        for (u32 x = 0; x < sampleCols;)
        {
            u32 coreStart;
            u32 coreEnd;
            u32 spanStart;
            u32 spanEnd;
            u32 advanceX;
            u32 wallTop;
            struct HdFacadeBand *band;
            bool8 hasEntrance = FALSE;

            if (!HdMapSampleIsSupportedWallCore(y * sampleCols + x, sampleCols, sampleRows))
            {
                x++;
                continue;
            }
            coreStart = x;
            while (x + 1 < sampleCols
                && HdMapSampleIsSupportedWallCore(y * sampleCols + x + 1, sampleCols, sampleRows))
                x++;
            coreEnd = x;

            spanStart = coreStart;
            spanEnd = coreEnd;
            while (spanStart > 0
                && HdMapSampleHasFacadeSupport(y * sampleCols + spanStart - 1, sampleCols, sampleRows))
                spanStart--;
            while (spanEnd + 1 < sampleCols
                && HdMapSampleHasFacadeSupport(y * sampleCols + spanEnd + 1, sampleCols, sampleRows))
                spanEnd++;
            advanceX = spanEnd + 1;
            // Free-standing prop columns at the span edge satisfy facade
            // support but belong to the plaza, not the wall sheet. Trimming
            // them keeps shelves and trees out of the building shell.
            while (spanStart < spanEnd
                && HdMapSampleIsPropColumn(y * sampleCols + spanStart, sampleCols, sampleRows))
                spanStart++;
            while (spanEnd > spanStart
                && HdMapSampleIsPropColumn(y * sampleCols + spanEnd, sampleCols, sampleRows))
                spanEnd--;

            wallTop = y;
            while (wallTop > 1 && y - wallTop < HD2D_GEOMETRY_RADIUS
                && HdMapRowContinuesFacade(wallTop - 1, spanStart, spanEnd, sampleCols, sampleRows)
                && !HdMapRowIsRoofOverhang(wallTop - 1, spanStart, spanEnd, sampleCols, sampleRows))
                wallTop--;
            // A facade sheet is owned by its actual entrance row. Scanning
            // every row above the door creates shifted, overlapping copies of
            // the same wall with identical height but different source bounds.
            for (u32 wallX = spanStart; wallX <= spanEnd; wallX++)
            {
                const u32 sample = y * sampleCols + wallX;

                hasEntrance |= HdMapSampleIsDoorCourse(sample)
                            || sHdMapSamples[sample].hasWarpEntrance;
            }
            if (bandCount >= ARRAY_COUNT(sHdFacadeBands))
            {
                x = advanceX;
                continue;
            }
            band = &sHdFacadeBands[bandCount++];
            band->y = y;
            band->spanStart = spanStart;
            band->spanEnd = spanEnd;
            band->coreStart = coreStart;
            band->coreEnd = coreEnd;
            band->wallTop = wallTop;
            band->hasEntrance = hasEntrance;
            band->claimed = FALSE;
            x = advanceX;
        }
    }

    for (u32 index = 0; index < bandCount; index++)
    {
        if (sHdFacadeBands[index].hasEntrance)
            HdClaimFacadeBand(&sHdFacadeBands[index], sampleCols, sampleRows, bounds, FALSE);
    }

    // A doorless band standing beside an entrance-owning wall is a stepped
    // tier of the same structure (gym wings around a protruding entrance
    // pavilion). Claim it as its own building with its own height, borrowing
    // the entrance; repeat so chained tiers attach through each other. Bands
    // made only of prop columns stay plaza furniture.
    do
    {
        attached = FALSE;
        for (u32 index = 0; index < bandCount; index++)
        {
            struct HdFacadeBand *band = &sHdFacadeBands[index];

            if (band->claimed || band->hasEntrance)
                continue;
            if (!HdBandHasAttachableColumn(band, sampleCols, sampleRows))
                continue;
            if (!HdBandTouchesClaimedWall(band, sampleCols, sampleRows))
                continue;
            attached |= HdClaimFacadeBand(band, sampleCols, sampleRows, bounds, TRUE);
        }
    } while (attached);
}

static void HdPublishBuildingComponents(u32 courseCols, u32 courseRows)
{
    u16 nextComponent = 1;

    // Overlapping height-compatible roof/facade claims have already been
    // unioned while claimed. Only now require one semantic entrance for the
    // whole building and reject roots clipped by either semantic or atlas
    // boundary.
    for (u16 building = 0; building < sHdBuildingCount; building++)
    {
        const u16 root = HdFindBuildingRoot(building);
        if (root != building)
        {
            sHdBuildings[root].hasEntrance |= sHdBuildings[building].hasEntrance;
            sHdBuildings[root].isClipped |= sHdBuildings[building].isClipped;
            sHdBuildings[root].isSteppedTier |= sHdBuildings[building].isSteppedTier;
        }
    }

    for (u32 course = 0; course < courseRows * courseCols; course++)
    {
        const s16 owner = sHdCourseBuilding[course];
        u16 root;
        u8 surface;

        if (owner < 0)
            continue;
        root = HdFindBuildingRoot(owner);
        if (!sHdBuildings[root].hasEntrance || sHdBuildings[root].isClipped)
            continue;
        if (sHdBuildings[root].componentId == 0)
        {
            if (nextComponent > HD2D_COMPONENT_MAX)
                continue;
            sHdBuildings[root].componentId = nextComponent++;
        }
        surface = sHdCourseBuildingKind[course] & HD_BUILDING_WALL
            ? HD_SURFACE_WALL : HD_SURFACE_ROOF;
        sHdCourseGeometry[course] = (sHdBuildings[root].componentId << HD2D_COMPONENT_SHIFT)
                                  | surface;
        sHdCourseGroundHeights[course] = sHdBuildings[root].baseHeight;
        sHdCourseHeights[course] = surface == HD_SURFACE_ROOF
            ? sHdBuildings[root].roofHeight : sHdBuildings[root].baseHeight;
        if (surface == HD_SURFACE_ROOF)
        {
            const u32 courseX = course % courseCols;
            const u32 courseY = course / courseCols;
            const u32 sample = (courseY / 2) * (courseCols / 2) + courseX / 2;

            // Decorative rear gables sit over non-blocking ground so actors
            // can walk behind the native top-down art. Publish that support
            // contract with the building metadata: their roof sheet remains
            // elevated, but it must not grow a generated wall down to ground.
            if (!sHdMapSamples[sample].collision)
                sHdCourseFacadeData[course] = HD2D_FACADE_ROOF_OVERHANG;
        }
        else if (sHdCourseFacade[course] >= 0)
        {
            const u16 facade = sHdCourseFacade[course];

            if (HdFindBuildingRoot(facade) == root)
            {
                const u32 courseY = course / courseCols;
                const u32 rowOffset = courseY - sHdBuildings[facade].facadeAnchorCourseY;

                sHdCourseFacadeData[course] = (rowOffset << 16) | (facade + 1);
            }
        }
        if (sHdBuildings[root].isSteppedTier)
            sHdCourseFacadeData[course] |= HD2D_FACADE_STEPPED_TIER;
    }
}

static void HdClassifyBuildingComponents(u32 sampleCols, u32 sampleRows,
                                         u32 renderSampleMinX, u32 renderSampleMinY,
                                         u32 renderSampleMaxX, u32 renderSampleMaxY)
{
    const u32 courseCols = sampleCols * 2;
    const u32 courseRows = sampleRows * 2;
    const struct HdBuildingBounds bounds = {
        renderSampleMinX * 2,
        renderSampleMinY * 2,
        renderSampleMaxX * 2,
        renderSampleMaxY * 2,
    };

    if (gMapHeader.mapType == MAP_TYPE_INDOOR
     || gMapHeader.mapType == MAP_TYPE_SECRET_BASE)
        return;

    HdCollectBuildingCandidates(sampleCols, sampleRows, &bounds);
    HdPublishBuildingComponents(courseCols, courseRows);
}

static bool8 MapWorldPixel(s32 screenX, s32 screenY, const struct HdMapSample *sample,
                           u16 attributes, u32 bottomPacked, u32 topPacked,
                           struct Rgb *color, u8 *layer)
{
    u8 layerType;
    u8 bottomLayer;
    u8 topLayer;
    struct Rgb bottomColor;
    struct Rgb topColor;
    bool8 bottomVisible;
    bool8 topVisible;
    u8 mask = WINDOW_ALL_LAYERS;

    if (!sample->valid && (gMapHeader.mapType == MAP_TYPE_INDOOR
                         || gMapHeader.mapType == MAP_TYPE_SECRET_BASE))
    {
        *color = (struct Rgb){0};
        *layer = LAYER_BACKDROP;
        return FALSE;
    }

    layerType = UNPACK_LAYER_TYPE(attributes);
    if (layerType == METATILE_LAYER_TYPE_SPLIT)
    {
        bottomLayer = LAYER_BG3;
        topLayer = LAYER_BG1;
    }
    else if (layerType == METATILE_LAYER_TYPE_COVERED)
    {
        bottomLayer = LAYER_BG3;
        topLayer = LAYER_BG2;
    }
    else
    {
        bottomLayer = LAYER_BG2;
        topLayer = LAYER_BG1;
    }

    if (screenX >= 0 && screenX < DISPLAY_WIDTH && screenY >= 0 && screenY < DISPLAY_HEIGHT)
        mask = WindowMask(screenX, screenY);
    *color = GbaColor(ReadU16(BG_PLTT));
    *layer = LAYER_BACKDROP;
    bottomVisible = (mask & bottomLayer) && (bottomPacked >> 24) != 0;
    topVisible = (mask & topLayer) && (topPacked >> 24) != 0;
    if (bottomVisible)
    {
        bottomColor.r = bottomPacked;
        bottomColor.g = bottomPacked >> 8;
        bottomColor.b = bottomPacked >> 16;
    }
    if (topVisible)
    {
        topColor.r = topPacked;
        topColor.g = topPacked >> 8;
        topColor.b = topPacked >> 16;
    }
    if (bottomVisible)
    {
        *color = bottomColor;
        *layer = bottomLayer;
    }
    if (topVisible)
    {
        const u8 scanlineY = screenY < 0 ? 0 : screenY >= DISPLAY_HEIGHT ? DISPLAY_HEIGHT - 1 : screenY;
        *color = DirectEffectColor(topColor, topLayer, *color, *layer, mask & LAYER_BACKDROP, scanlineY);
        *layer = topLayer;
    }
    else if (bottomVisible)
    {
        const u8 scanlineY = screenY < 0 ? 0 : screenY >= DISPLAY_HEIGHT ? DISPLAY_HEIGHT - 1 : screenY;
        *color = DirectEffectColor(*color, *layer, GbaColor(ReadU16(BG_PLTT)), LAYER_BACKDROP,
                                   mask & LAYER_BACKDROP, scanlineY);
    }

    return TRUE;
}

static bool8 HdStructuralPixelVisible(u32 courseX, u32 courseY,
                                      u32 courseCols, u32 courseRows,
                                      u8 pixelX, u8 pixelY, u8 visibleLayer,
                                      u32 visiblePacked)
{
    const u32 course = courseY * courseCols + courseX;
    const u16 geometry = sHdCourseGeometry[course];
    const u8 surface = geometry & HD2D_SURFACE_MASK;
    const u16 component = geometry >> HD2D_COMPONENT_SHIFT;
    const u32 sampleCols = courseCols / 2;
    const u32 sample = (courseY / 2) * sampleCols + courseX / 2;
    const u8 layerType = UNPACK_LAYER_TYPE(sHdMapAttributes[sample]);
    const u8 topLayer = layerType == METATILE_LAYER_TYPE_COVERED ? LAYER_BG2 : LAYER_BG1;
    const u8 bottomLayer = layerType == METATILE_LAYER_TYPE_NORMAL ? LAYER_BG2 : LAYER_BG3;
    struct Rgb sourceColor;

    if (surface != HD_SURFACE_WALL && surface != HD_SURFACE_ROOF)
        return FALSE;
    if ((visibleLayer != topLayer && visibleLayer != bottomLayer)
     || (visiblePacked >> 24) == 0)
        return FALSE;
    // The primary art plane is the authored facade/roof sheet itself. Its
    // pixels may reuse the same palette colors as the plaza pattern below, so
    // a ground-match test there punches per-pixel holes through real walls
    // and signs, which render as clear-color speckle. Only the underlay plane
    // can carry ground through transparent wall art.
    if (visibleLayer == topLayer)
        return TRUE;
    sourceColor.r = visiblePacked;
    sourceColor.g = visiblePacked >> 8;
    sourceColor.b = visiblePacked >> 16;

    // The underlay plane may carry facade details or repeated ground underlay.
    // Compare the visible source with the first authored receiver below this
    // facade column, retaining only pixels that differ from the ground carried
    // through transparent wall art.
    for (u32 receiverY = courseY + 1; receiverY < courseRows; receiverY++)
    {
        const u32 receiverCourse = receiverY * courseCols + courseX;
        const u16 receiverGeometry = sHdCourseGeometry[receiverCourse];
        const u8 receiverSurface = receiverGeometry & HD2D_SURFACE_MASK;
        const u16 receiverComponent = receiverGeometry >> HD2D_COMPONENT_SHIFT;
        const u32 receiverSample = (receiverY / 2) * sampleCols + courseX / 2;
        const u8 receiverQuadrant = (receiverY & 1) * 2 + (courseX & 1);
        struct Rgb receiverBottom;
        struct Rgb receiverTop;
        struct Rgb receiverColor;
        bool8 receiverVisible = FALSE;

        if ((receiverSurface == HD_SURFACE_WALL || receiverSurface == HD_SURFACE_ROOF)
         && receiverComponent == component)
            continue;
        if (HdMetatilePixel(sHdMapSamples[receiverSample].layout,
                            sHdMapSamples[receiverSample].metatileId, 0,
                            receiverQuadrant, pixelX, pixelY, &receiverBottom))
        {
            receiverColor = receiverBottom;
            receiverVisible = TRUE;
        }
        if (HdMetatilePixel(sHdMapSamples[receiverSample].layout,
                            sHdMapSamples[receiverSample].metatileId, 1,
                            receiverQuadrant, pixelX, pixelY, &receiverTop))
        {
            receiverColor = receiverTop;
            receiverVisible = TRUE;
        }
        if (!receiverVisible
         || sourceColor.r != receiverColor.r
         || sourceColor.g != receiverColor.g
         || sourceColor.b != receiverColor.b)
            return TRUE;
        // The center pixel equals the ground below. Authored facade ink can
        // coincide with the plaza's sparkle dots pixel-for-pixel (shared
        // palette), and dropping those punches the plaza pattern through
        // walls and signs as clear-color speckle. Genuine baked ground
        // matches in wide runs, so demand the horizontal 5-pixel run to
        // match too before treating this pixel as carried underlay.
        {
            const u8 sourcePlane = visibleLayer == topLayer ? 1 : 0;
            const u8 quadrant = (courseY & 1) * 2 + (courseX & 1);

            for (s32 dx = -2; dx <= 2; dx++)
            {
                const s32 nx = (s32)pixelX + dx;
                struct Rgb sourceNeighbor;
                struct Rgb receiverNeighbor;
                struct Rgb probe;
                bool8 neighborVisible = FALSE;

                if (dx == 0 || nx < 0 || nx >= HD2D_TILE_WIDTH)
                    continue;
                if (!HdMetatilePixel(sHdMapSamples[sample].layout,
                                     sHdMapSamples[sample].metatileId,
                                     sourcePlane, quadrant, (u8)nx, pixelY,
                                     &sourceNeighbor))
                    continue; // transparent art keeps the carried run going
                if (HdMetatilePixel(sHdMapSamples[receiverSample].layout,
                                    sHdMapSamples[receiverSample].metatileId, 0,
                                    receiverQuadrant, (u8)nx, pixelY, &probe))
                {
                    receiverNeighbor = probe;
                    neighborVisible = TRUE;
                }
                if (HdMetatilePixel(sHdMapSamples[receiverSample].layout,
                                    sHdMapSamples[receiverSample].metatileId, 1,
                                    receiverQuadrant, (u8)nx, pixelY, &probe))
                {
                    receiverNeighbor = probe;
                    neighborVisible = TRUE;
                }
                if (!neighborVisible
                 || sourceNeighbor.r != receiverNeighbor.r
                 || sourceNeighbor.g != receiverNeighbor.g
                 || sourceNeighbor.b != receiverNeighbor.b)
                    return TRUE; // palette coincidence, keep structural
            }
        }
        return FALSE;
    }
    return TRUE;
}

static void RenderHd2dWorld(u16 dispcnt)
{
    s16 cameraOffsetX;
    s16 cameraOffsetY;
    static u16 courseXs[HD2D_WORLD_WIDTH];
    static u16 sampleXs[HD2D_WORLD_WIDTH];
    static u8 pixelXs[HD2D_WORLD_WIDTH];

    (void)dispcnt;
    if (++sHdDecodedCourseGeneration == 0)
    {
        memset(sHdDecodedCourseCaches, 0, sizeof(sHdDecodedCourseCaches));
        memset(sHdArtPredicateCaches, 0, sizeof(sHdArtPredicateCaches));
        sHdDecodedCourseGeneration = 1;
    }
    // Recover the full signed scripted pan from the same state used to place
    // OAM. Unlike masking GetCameraOffsetWithPan to 0..15, this preserves the
    // normal +32 vertical pan and larger camera shakes, keeping entity feet on
    // their world tiles.
    {
        s16 gpuOffsetX;
        s16 gpuOffsetY;
        const s16 panX = (s16)(gTotalCameraPixelOffsetX - gSpriteCoordOffsetX);
        const s16 panY = (s16)(gTotalCameraPixelOffsetY - gSpriteCoordOffsetY);

        GetCameraOffsetWithPan(&gpuOffsetX, &gpuOffsetY);
        cameraOffsetX = ((gpuOffsetX - panX - gFieldCamera.x) & 15) + gFieldCamera.x + panX;
        cameraOffsetY = ((gpuOffsetY - panY - gFieldCamera.y) & 15) + gFieldCamera.y + panY;
    }

    // CameraMove advances the saved metatile position at the start of a
    // 16-pixel step. Add the signed residual within that step so direct map
    // sampling stays continuous instead of jumping one metatile twice.
    if (gFieldCamera.x > 0) cameraOffsetX -= 16;
    else if (gFieldCamera.x < 0) cameraOffsetX += 16;
    if (gFieldCamera.y > 0) cameraOffsetY -= 16;
    else if (gFieldCamera.y < 0) cameraOffsetY += 16;
    // Anchor shader noise to map-space pixels rather than this frame's moving
    // overscan atlas. The sum stays continuous through sub-tile camera motion.
    sWasmWorldPixelOriginX = gSaveBlock1Ptr->pos.x * 16 - HD2D_WORLD_OFFSET_X + cameraOffsetX;
    sWasmWorldPixelOriginY = gSaveBlock1Ptr->pos.y * 16 - HD2D_WORLD_OFFSET_Y + cameraOffsetY;
    const s32 renderMinMapX = gSaveBlock1Ptr->pos.x + FloorDiv16(-HD2D_WORLD_OFFSET_X + cameraOffsetX);
    const s32 renderMinMapY = gSaveBlock1Ptr->pos.y + FloorDiv16(-HD2D_WORLD_OFFSET_Y + cameraOffsetY);
    const s32 renderMaxMapX = gSaveBlock1Ptr->pos.x + FloorDiv16(HD2D_WORLD_WIDTH - HD2D_WORLD_OFFSET_X - 1 + cameraOffsetX);
    const s32 renderMaxMapY = gSaveBlock1Ptr->pos.y + FloorDiv16(HD2D_WORLD_HEIGHT - HD2D_WORLD_OFFSET_Y - 1 + cameraOffsetY);
    // Keep the semantic neighborhood wider than the texture atlas. Complete
    // roof and facade spans remain stable while entering the visible overscan
    // instead of changing class when their authored support is just offscreen.
    const s32 minMapX = renderMinMapX - HD2D_GEOMETRY_RADIUS;
    const s32 minMapY = renderMinMapY - HD2D_GEOMETRY_RADIUS;
    const s32 maxMapX = renderMaxMapX + HD2D_GEOMETRY_RADIUS;
    const s32 maxMapY = renderMaxMapY + HD2D_GEOMETRY_RADIUS;
    const u32 sampleCols = maxMapX - minMapX + 1;
    const u32 sampleRows = maxMapY - minMapY + 1;

    sHdDebugMinMapX = minMapX;
    sHdDebugMinMapY = minMapY;
    sHdDebugSampleCols = sampleCols;
    sHdDebugSampleRows = sampleRows;

    for (u32 predicate = 0; predicate < HD_PREDICATE_COUNT; predicate++)
        memset(sHdSamplePredicateCaches[predicate], 0, sampleCols * sampleRows);
    memset(sHdRoofArtCache, 0, sampleCols * sampleRows * 4);

    for (u32 x = 0; x < HD2D_WORLD_WIDTH; x++)
    {
        const s32 viewX = (s32)x - HD2D_WORLD_OFFSET_X + cameraOffsetX;
        const s32 mapOffsetX = FloorDiv16(viewX);
        const u8 localX = viewX - mapOffsetX * 16;

        sampleXs[x] = gSaveBlock1Ptr->pos.x + mapOffsetX - minMapX;
        courseXs[x] = sampleXs[x] * 2 + localX / HD2D_TILE_WIDTH;
        pixelXs[x] = localX & (HD2D_TILE_WIDTH - 1);
    }

    for (u32 sampleY = 0; sampleY < sampleRows; sampleY++)
    {
        for (u32 sampleX = 0; sampleX < sampleCols; sampleX++)
        {
            const u32 index = sampleY * sampleCols + sampleX;
            ResolveHdMapSample(minMapX + sampleX, minMapY + sampleY, &sHdMapSamples[index]);
            sHdMapAttributes[index] = HdMetatileAttributes(sHdMapSamples[index].layout,
                                                           sHdMapSamples[index].metatileId);
        }
    }
    for (u32 sampleY = 0; sampleY < sampleRows; sampleY++)
    {
        for (u32 sampleX = 0; sampleX < sampleCols; sampleX++)
        {
            const u32 sample = sampleY * sampleCols + sampleX;

            sHdSampleBaseSurfaces[sample] = HdMapSampleBaseSurface(sample, sampleX, sampleY,
                                                                   sampleCols, sampleRows);
        }
    }
    // Resolve the visual and receiver contracts on independent 8x8 authored
    // courses. Base surface semantics are sample-level; local source
    // coordinates select the 8x8 authored course within each metatile.
    {
        const u32 courseCols = sampleCols * 2;
        const u32 courseRows = sampleRows * 2;

        for (u32 courseY = 0; courseY < courseRows; courseY++)
        {
            for (u32 courseX = 0; courseX < courseCols; courseX++)
            {
                const u32 course = courseY * courseCols + courseX;
                const u32 sampleX = courseX / 2;
                const u32 sampleY = courseY / 2;
                const u32 sample = sampleY * sampleCols + sampleX;
                const u8 surface = sHdSampleBaseSurfaces[sample];
                const s8 height = HdSurfaceBaseHeight(surface);

                sHdCourseGeometry[course] = surface;
                sHdCourseHeights[course] = height;
                sHdCourseGroundHeights[course] = height;
                sHdCourseReceivers[course] = 0;
                sHdCourseBuilding[course] = -1;
                sHdCourseFacade[course] = -1;
                sHdCourseBuildingKind[course] = 0;
                sHdCourseFacadeData[course] = 0;
                sHdCourseVisit[course] = 0;
            }
        }
        HdResolveOpenDeckReceivers(courseCols, courseRows);
        HdResolveTerrainFaceReceivers(courseCols, courseRows);
        HdRaiseBlockedCliffBands(sampleCols, sampleRows, courseCols);
        HdClassifyBuildingComponents(sampleCols, sampleRows,
                                     renderMinMapX - minMapX, renderMinMapY - minMapY,
                                     renderMaxMapX - minMapX + 1, renderMaxMapY - minMapY + 1);
    }
    const u8 bg1Priority = ReadU16(REG_BASE + REG_OFFSET_BG1CNT) & 3;
    const u8 bg2Priority = ReadU16(REG_BASE + REG_OFFSET_BG2CNT) & 3;
    const u8 bg3Priority = ReadU16(REG_BASE + REG_OFFSET_BG3CNT) & 3;

    for (u32 y = 0; y < HD2D_WORLD_HEIGHT; y++)
    {
        const s32 screenY = (s32)y - HD2D_WORLD_OFFSET_Y;
        const s32 viewY = screenY + cameraOffsetY;
        const s32 mapOffsetY = FloorDiv16(viewY);
        const u8 localY = viewY - mapOffsetY * 16;
        const u32 sampleY = gSaveBlock1Ptr->pos.y + mapOffsetY - minMapY;
        const u32 courseY = sampleY * 2 + localY / HD2D_TILE_WIDTH;
        const u8 pixelY = localY & (HD2D_TILE_WIDTH - 1);
        const u32 *bottomCourse = NULL;
        const u32 *topCourse = NULL;
        u32 previousCourseX = 0xffffffff;

        for (u32 x = 0; x < HD2D_WORLD_WIDTH; x++)
        {
            const s32 screenX = (s32)x - HD2D_WORLD_OFFSET_X;
            const u32 pixel = y * HD2D_WORLD_WIDTH + x;
            const u32 p = pixel * RGBA_CHANNELS;
            struct Rgb color;
            u8 layer;
            const u32 courseX = courseXs[x];
            const u32 courseIndex = courseY * sampleCols * 2 + courseX;
            const u32 sampleIndex = sampleY * sampleCols + sampleXs[x];
            const u8 quadrant = (courseY & 1) * 2 + (courseX & 1);
            const struct HdMapSample *mapSample = &sHdMapSamples[sampleIndex];
            u32 bottomPacked;
            u32 topPacked;

            if (courseX != previousCourseX)
            {
                bottomCourse = HdMetatileCourse(mapSample->layout, mapSample->metatileId, 0, quadrant);
                topCourse = HdMetatileCourse(mapSample->layout, mapSample->metatileId, 1, quadrant);
                previousCourseX = courseX;
            }
            bottomPacked = bottomCourse[pixelY * HD2D_TILE_WIDTH + pixelXs[x]];
            topPacked = topCourse[pixelY * HD2D_TILE_WIDTH + pixelXs[x]];
            const bool8 mapVisible = MapWorldPixel(screenX, screenY,
                                                   mapSample, sHdMapAttributes[sampleIndex],
                                                   bottomPacked, topPacked,
                                                   &color, &layer);
            sWasmWorldRgba[p] = color.r;
            sWasmWorldRgba[p + 1] = color.g;
            sWasmWorldRgba[p + 2] = color.b;
            sWasmWorldRgba[p + 3] = mapVisible ? 255 : 0;
            sWasmWorldStructuralAlpha[pixel] = HdStructuralPixelVisible(
                courseX, courseY, sampleCols * 2, sampleRows * 2,
                pixelXs[x], pixelY, layer,
                layer == (UNPACK_LAYER_TYPE(sHdMapAttributes[sampleIndex]) == METATILE_LAYER_TYPE_COVERED
                    ? LAYER_BG2 : LAYER_BG1) ? topPacked : bottomPacked) ? 255 : 0;
            sWasmWorldLayerData[pixel] = layer;
            if (layer == LAYER_BG1)
                sWasmBgPriorityData[pixel] = bg1Priority;
            else if (layer == LAYER_BG2)
                sWasmBgPriorityData[pixel] = bg2Priority;
            else if (layer == LAYER_BG3)
                sWasmBgPriorityData[pixel] = bg3Priority;
            else
                sWasmBgPriorityData[pixel] = 4;
            sWasmWorldHeightData[pixel] = sHdCourseHeights[courseIndex];
            sWasmWorldGroundHeightData[pixel] = sHdCourseGroundHeights[courseIndex];
            sWasmWorldGeometryData[pixel] = sHdCourseGeometry[courseIndex];
            sWasmWorldReceiverData[pixel] = sHdCourseReceivers[courseIndex];
            sWasmWorldFacadeData[pixel] = sHdCourseFacadeData[courseIndex];
        }
    }
}

static void CopyCanonicalWorld(void)
{
    for (u32 y = 0; y < DISPLAY_HEIGHT; y++)
    {
        for (u32 x = 0; x < DISPLAY_WIDTH; x++)
        {
            const u32 source = y * DISPLAY_WIDTH + x;
            const u32 target = (y + HD2D_WORLD_OFFSET_Y) * HD2D_WORLD_WIDTH + x + HD2D_WORLD_OFFSET_X;
            const u32 sourceRgba = source * RGBA_CHANNELS;
            const u32 targetRgba = target * RGBA_CHANNELS;

            // Do not turn the native border filler outside indoor layouts
            // into projected terrain when replacing the canonical viewport.
            if (sWasmWorldRgba[targetRgba + 3] == 0)
                continue;
            sWasmWorldRgba[targetRgba] = sWasmDisplayRgba[sourceRgba];
            sWasmWorldRgba[targetRgba + 1] = sWasmDisplayRgba[sourceRgba + 1];
            sWasmWorldRgba[targetRgba + 2] = sWasmDisplayRgba[sourceRgba + 2];
            sWasmWorldRgba[targetRgba + 3] = sWasmDisplayRgba[sourceRgba + 3];
            sWasmWorldLayerData[target] = sLayerData[source] & (LAYER_BG1 | LAYER_BG2 | LAYER_BG3 | LAYER_BACKDROP);
            if (!(WindowMask(x, y) & LAYER_OBJ))
                sWasmBgPriorityData[target] = 0xff;
            else if (sLayerData[source] == LAYER_BG1)
                sWasmBgPriorityData[target] = ReadU16(REG_BASE + REG_OFFSET_BG1CNT) & 3;
            else if (sLayerData[source] == LAYER_BG2)
                sWasmBgPriorityData[target] = ReadU16(REG_BASE + REG_OFFSET_BG2CNT) & 3;
            else if (sLayerData[source] == LAYER_BG3)
                sWasmBgPriorityData[target] = ReadU16(REG_BASE + REG_OFFSET_BG3CNT) & 3;
            else
                sWasmBgPriorityData[target] = 4;
        }
    }
}

void WasmRenderFrame(void)
{
    const u16 dispcnt = REG_DISPCNT;
    const u8 mode = dispcnt & 7;

    WasmRefreshHblankDmaGpuRegs();
    if (mode == 3)
        RenderBitmapMode3();
    else if (mode == 4)
        RenderBitmapMode4(dispcnt);
    else
        RenderTiled(dispcnt, TRUE, TRUE);

    if (mode == 3 || mode == 4)
        RenderSprites(dispcnt, -1);
}

void WasmRenderHd2dFrame(void)
{
    const u16 dispcnt = REG_DISPCNT;
    const u8 mode = dispcnt & 7;

    if (mode > 2)
    {
        WasmRenderFrame();
        return;
    }

    WasmRefreshHblankDmaGpuRegs();
    RenderHd2dWorld(dispcnt);
    // Keep the canonical viewport sourced from the live BG tilemaps so doors,
    // tile overrides, animations, windows, and scanline effects remain exact.
    RenderTiled(dispcnt, FALSE, FALSE);
    CopyCanonicalWorld();
    RenderObjectSources(dispcnt);
    RenderObjectPass(dispcnt);
    RenderTiled(dispcnt, TRUE, TRUE);
}

u32 WasmDisplaySceneKind(void)
{
    const u8 mode = REG_DISPCNT & 7;

    if (mode != 0)
        return 0;
    // Basic-overworld callbacks are used by field transitions whose
    // screen-space effects cannot be projected faithfully.
    if (gMain.callback2 != CB2_Overworld)
        return 0;
    if (gMapHeader.mapType == MAP_TYPE_NONE)
        return 0;
    if (gMapHeader.mapType == MAP_TYPE_INDOOR
     || gMapHeader.mapType == MAP_TYPE_SECRET_BASE)
        return 0;
    RefreshHblankDmaGpuRegs();
    for (u32 offset = 0; offset < REG_OFFSET_DMA0; offset += 2)
    {
        if (sHblankDmaGpuRegs[offset >> 1].active)
            return 0;
    }
    // Hardware effects selecting OBJ as target 1 are not baked into the
    // independent raw billboard sources. Keep alpha, brighten, and darken
    // frames exact rather than presenting entities with the wrong treatment.
    if (((REG_BLDCNT >> 6) & 3) != 0 && (REG_BLDCNT & LAYER_OBJ))
        return 0;
    for (u32 i = 0; i < OAM_ENTRY_COUNT; i++)
    {
        const u16 attr0 = ReadU16(OAM + i * 8);
        if (((attr0 >> 10) & 3) == 1)
            return 0;
    }
    return 1;
}

// Keep automation weather changes on the same saved-weather translation path
// as gameplay. WEATHER_ABNORMAL is a saved-weather marker rather than an
// entry in sWeatherFuncs, so let DoCurrentWeather resolve it before the
// no-delay setter is used for ordinary weather values.
u32 WasmSetAutomationWeather(u32 weather)
{
    if (weather > WEATHER_ABNORMAL)
        return FALSE;

    if (weather == WEATHER_ABNORMAL)
    {
        SetSavedWeather(weather);
        DoCurrentWeather();
        return TRUE;
    }

    SetWeather(weather);
    DoCurrentWeather();
    SetCurrentAndNextWeatherNoDelay(GetSavedWeather());
    return TRUE;
}

u8 *WasmWorldBuffer(void)
{
    return sWasmWorldRgba;
}

u8 *WasmWorldStructuralAlphaBuffer(void)
{
    return sWasmWorldStructuralAlpha;
}

u32 WasmWorldStructuralAlphaBufferSize(void)
{
    return sizeof(sWasmWorldStructuralAlpha);
}

void WasmSetHd2dEnabled(u32 enabled)
{
    sWasmHd2dEnabled = enabled != 0;
}

u32 WasmHd2dEnabled(void)
{
    return sWasmHd2dEnabled;
}

u32 WasmWorldBufferSize(void)
{
    return sizeof(sWasmWorldRgba);
}

u32 WasmWorldWidth(void)
{
    return HD2D_WORLD_WIDTH;
}

u32 WasmWorldHeight(void)
{
    return HD2D_WORLD_HEIGHT;
}

u32 WasmWorldGridOffsetX(void)
{
    return (HD2D_WORLD_OFFSET_X - (REG_BG1HOFS & (HD2D_TILE_WIDTH - 1))) & (HD2D_TILE_WIDTH - 1);
}

u32 WasmWorldGridOffsetY(void)
{
    return (HD2D_WORLD_OFFSET_Y - (REG_BG1VOFS & (HD2D_TILE_WIDTH - 1))) & (HD2D_TILE_WIDTH - 1);
}

s32 WasmWorldPixelOriginX(void)
{
    return sWasmWorldPixelOriginX;
}

s32 WasmWorldPixelOriginY(void)
{
    return sWasmWorldPixelOriginY;
}

u8 *WasmWorldLayerBuffer(void)
{
    return sWasmWorldLayerData;
}

u32 WasmWorldLayerBufferSize(void)
{
    return sizeof(sWasmWorldLayerData);
}

s8 *WasmWorldHeightBuffer(void)
{
    return sWasmWorldHeightData;
}

u32 WasmWorldHeightBufferSize(void)
{
    return sizeof(sWasmWorldHeightData);
}

s8 *WasmWorldGroundHeightBuffer(void)
{
    return sWasmWorldGroundHeightData;
}

u32 WasmWorldGroundHeightBufferSize(void)
{
    return sizeof(sWasmWorldGroundHeightData);
}

u16 *WasmWorldGeometryBuffer(void)
{
    return sWasmWorldGeometryData;
}

u32 WasmWorldGeometryBufferSize(void)
{
    return sizeof(sWasmWorldGeometryData);
}

u16 *WasmWorldReceiverBuffer(void)
{
    return sWasmWorldReceiverData;
}

u32 WasmWorldReceiverBufferSize(void)
{
    return sizeof(sWasmWorldReceiverData);
}

u32 *WasmWorldFacadeBuffer(void)
{
    return sWasmWorldFacadeData;
}

u32 WasmWorldFacadeBufferSize(void)
{
    return sizeof(sWasmWorldFacadeData);
}

u8 *WasmDisplayLayerBuffer(void)
{
    return sLayerData;
}

u32 WasmDisplayLayerBufferSize(void)
{
    return sizeof(sLayerData);
}

u8 *WasmDisplayObjectIdBuffer(void)
{
    return sWasmObjectIdData;
}

u32 WasmDisplayObjectIdBufferSize(void)
{
    return sizeof(sWasmObjectIdData);
}

u8 *WasmDisplayBgPriorityBuffer(void)
{
    return sWasmBgPriorityData;
}

u32 WasmDisplayBgPriorityBufferSize(void)
{
    return sizeof(sWasmBgPriorityData);
}

u8 *WasmDisplayObjectSourceBuffer(void)
{
    return sObjectSourceRgba;
}

u32 WasmDisplayObjectSourceBufferSize(void)
{
    return sizeof(sObjectSourceRgba);
}

s32 *WasmDisplayObjectDescriptorBuffer(void)
{
    return sObjectDescriptors;
}

u32 WasmDisplayObjectDescriptorBufferSize(void)
{
    return sizeof(sObjectDescriptors);
}

u32 WasmDisplayObjectSourceCount(void)
{
    return sObjectSourceCount;
}

u8 *WasmDisplayObjectBuffer(void)
{
    return sWasmObjectRgba;
}

u32 WasmDisplayObjectBufferSize(void)
{
    return sizeof(sWasmObjectRgba);
}

s16 *WasmDisplayObjectAnchors(void)
{
    return sObjectAnchors;
}

u32 WasmDisplayObjectAnchorsSize(void)
{
    return sizeof(sObjectAnchors);
}

u8 *WasmDisplayObjectPriorities(void)
{
    return sObjectPriorities;
}

u32 WasmDisplayObjectPrioritiesSize(void)
{
    return sizeof(sObjectPriorities);
}

// Debug aid: expose the sample-grid classification predicates for one map
// tile (gBackupMapLayout coordinates, i.e. map-local + MAP_OFFSET). Reads the
// same caches the classifier fills, so results match the last rendered frame.
u32 WasmHdDebugSamplePredicates(s32 mapX, s32 mapY)
{
    const u32 cols = sHdDebugSampleCols;
    const u32 rows = sHdDebugSampleRows;
    const s32 sampleX = mapX - sHdDebugMinMapX;
    const s32 sampleY = mapY - sHdDebugMinMapY;
    u32 index;
    u32 bits = 0;

    if (cols == 0 || sampleX < 0 || sampleY < 0
     || sampleX >= (s32)cols || sampleY >= (s32)rows)
        return 0xffffffff;
    index = (u32)sampleY * cols + (u32)sampleX;
    if (sHdMapSamples[index].valid) bits |= 1u << 0;
    if (sHdMapSamples[index].collision) bits |= 1u << 1;
    if (HdMapSampleIsStructuralMaterial(index)) bits |= 1u << 2;
    if (HdMapSampleHasVisibleArt(index)) bits |= 1u << 3;
    if (HdMapSampleHasTopArt(index)) bits |= 1u << 4;
    if (HdMapSamplePlanesMatch(index)) bits |= 1u << 5;
    if (HdMapSampleIsFloorSurface(index, cols, rows)) bits |= 1u << 6;
    if (HdMapSampleIsDoorCourse(index)) bits |= 1u << 7;
    if (HdMapSampleIsCoveredCourse(index)) bits |= 1u << 8;
    if (HdMapSampleIsFoliageArt(index)) bits |= 1u << 9;
    if (HdMapSampleIsDecorativeOverlay(index)) bits |= 1u << 10;
    if (HdMapSampleIsWalkableFloorArt(index)) bits |= 1u << 11;
    if (HdMapSamplePlane0IsFloorArt(index)) bits |= 1u << 12;
    if (HdMapSampleHasFacadeSupport(index, cols, rows)) bits |= 1u << 13;
    if (HdMapSampleIsFacadeBody(index, cols, rows)) bits |= 1u << 14;
    if (HdMapSampleSitsOnFacade(index, cols, rows)) bits |= 1u << 15;
    if (HdMapSampleIsSolidRoofSheet(index, cols, rows)) bits |= 1u << 16;
    if (HdMapSampleIsBuildingMass(index, cols, rows)) bits |= 1u << 17;
    if (HdMapSampleIsPropColumn(index, cols, rows)) bits |= 1u << 18;
    if (HdMapSampleIsSupportedWallCore(index, cols, rows)) bits |= 1u << 19;
    if (HdMapSampleMatchesWalkableFront(index, cols, rows)) bits |= 1u << 20;
    if (HdMapSampleIsRoofCapCourse(index, cols, rows)) bits |= 1u << 21;
    if (HdCourseIsRoofArt((u32)sampleX * 2, (u32)sampleY * 2, cols, rows)) bits |= 1u << 22;
    if (HdCourseIsRoofArt((u32)sampleX * 2, (u32)sampleY * 2 + 1, cols, rows)) bits |= 1u << 23;
    if (HdCourseIsRoofArt((u32)sampleX * 2 + 1, (u32)sampleY * 2, cols, rows)) bits |= 1u << 24;
    if (HdCourseIsRoofArt((u32)sampleX * 2 + 1, (u32)sampleY * 2 + 1, cols, rows)) bits |= 1u << 25;
    if (sHdMapSamples[index].hasWarpEntrance) bits |= 1u << 26;
    return bits;
}

u8 *WasmDisplayBuffer(void)
{
    return sWasmDisplayRgba;
}

u32 WasmDisplayBufferSize(void)
{
    return sizeof(sWasmDisplayRgba);
}

#endif // WASM
