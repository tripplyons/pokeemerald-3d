FILE_NAME := pokeemerald
BUILD_DIR := build

WASM_CC ?= $(shell { command -v /opt/homebrew/opt/llvm/bin/clang || command -v /usr/local/opt/llvm/bin/clang || command -v clang; })
WASM_LD ?= $(shell { command -v wasm-ld || find "$$HOME/.rustup/toolchains" -path '*/gcc-ld/wasm-ld' -type f 2>/dev/null | head -n1; })
WASM_OPT_FLAGS ?= -O2
WASM_LDFLAGS ?=

WASM_BUILD_DIR := $(BUILD_DIR)/wasm
WASM_OBJ_DIR := $(WASM_BUILD_DIR)/obj
WASM := $(WASM_BUILD_DIR)/$(FILE_NAME).wasm
WASM_SOUND_HEADER := $(WASM_BUILD_DIR)/wasm_sound.h
ASSETS_DIR_NAME := $(BUILD_DIR)/assets

C_SUBDIR := src
DATA_SRC_SUBDIR := src/data
DATA_ASM_SUBDIR := data
MID_SUBDIR := sound/songs/midi

SHELL := bash -o pipefail

EXE :=
ifeq ($(OS),Windows_NT)
  EXE := .exe
endif

AUTO_GEN_TARGETS :=
include make_tools.mk

GFX      := $(TOOLS_DIR)/gbagfx/gbagfx$(EXE)
WAV2AGB  := $(TOOLS_DIR)/wav2agb/wav2agb$(EXE)
MID      := $(TOOLS_DIR)/mid2agb/mid2agb$(EXE)
PREPROC  := $(TOOLS_DIR)/preproc/preproc$(EXE)
MAPJSON  := $(TOOLS_DIR)/mapjson/mapjson$(EXE)
JSONPROC := $(TOOLS_DIR)/jsonproc/jsonproc$(EXE)

MAKEFLAGS += --no-print-directory

.SUFFIXES:
.SECONDARY:
.DELETE_ON_ERROR:
.DEFAULT_GOAL := wasm

RULES_NO_SETUP := clean clean-assets clean-generated clean-tools clean-wasm tools check-tools
.PHONY: wasm wasm-assets clean clean-assets clean-generated clean-wasm serve-wasm wrangler-site generated

SETUP_PREREQS ?= 1
ifneq (,$(MAKECMDGOALS))
  ifeq (,$(filter-out $(RULES_NO_SETUP),$(MAKECMDGOALS)))
    SETUP_PREREQS := 0
  endif
endif

.SHELLSTATUS ?= 0
ifeq ($(SETUP_PREREQS),1)
  $(foreach line, $(shell $(MAKE) -f make_tools.mk | sed "s/ /__SPACE__/g"), $(info $(subst __SPACE__, ,$(line))))
  ifneq ($(.SHELLSTATUS),0)
    $(error Errors occurred while building tools. See error messages above for more details)
  endif
  $(foreach line, $(shell $(MAKE) SETUP_PREREQS=0 generated | sed "s/ /__SPACE__/g"), $(info $(subst __SPACE__, ,$(line))))
  ifneq ($(.SHELLSTATUS),0)
    $(error Errors occurred while generating map-related sources. See error messages above for more details)
  endif
endif

C_SRCS_IN := $(wildcard $(C_SUBDIR)/*.c $(C_SUBDIR)/*/*.c $(C_SUBDIR)/*/*/*.c)
C_SRCS := $(foreach src,$(C_SRCS_IN),$(if $(findstring .inc.c,$(src)),,$(src)))
WASM_C_OBJS := $(patsubst $(C_SUBDIR)/%.c,$(WASM_OBJ_DIR)/%.o,$(C_SRCS))
WASM_DATA_ASM_SRCS := \
	$(DATA_ASM_SUBDIR)/maps.s \
	$(DATA_ASM_SUBDIR)/map_events.s \
	$(DATA_ASM_SUBDIR)/event_scripts.s \
	$(DATA_ASM_SUBDIR)/battle_scripts_1.s \
	$(DATA_ASM_SUBDIR)/battle_scripts_2.s \
	$(DATA_ASM_SUBDIR)/battle_ai_scripts.s \
	$(DATA_ASM_SUBDIR)/battle_anim_scripts.s
WASM_DATA_OBJS := $(patsubst $(DATA_ASM_SUBDIR)/%.s,$(WASM_OBJ_DIR)/%.o,$(WASM_DATA_ASM_SRCS))
MID_SRCS := $(wildcard $(MID_SUBDIR)/*.mid)

wasm: generated wasm-assets $(WASM)

wasm-assets: $(GFX)
	uv run python tools/generate_wasm_assets.py

$(WASM_SOUND_HEADER): tools/generate_wasm_sound.py sound/song_table.inc sound/songs/midi/midi.cfg $(MID_SRCS)
	@mkdir -p $(dir $@)
	uv run python tools/generate_wasm_sound.py $@

$(WASM_C_OBJS): | generated wasm-assets
$(WASM_OBJ_DIR)/m4a.o: $(WASM_SOUND_HEADER)

$(WASM): Makefile $(WASM_C_OBJS) $(WASM_DATA_OBJS)
	@test -n "$(WASM_LD)" || { echo "wasm-ld not found; set WASM_LD=/path/to/wasm-ld"; exit 1; }
	$(WASM_LD) $(WASM_LDFLAGS) --no-entry --allow-undefined --initial-memory=268435456 --max-memory=268435456 --export=AgbMain --export=WasmRunFrame --export-all -o $@ $(filter %.o,$^)

$(WASM_OBJ_DIR)/sprite.o: Makefile
$(WASM_OBJ_DIR)/sprite.o: WASM_OPT_FLAGS := -O3
$(WASM_OBJ_DIR)/task.o: Makefile
$(WASM_OBJ_DIR)/task.o: WASM_OPT_FLAGS := -O3
$(WASM_OBJ_DIR)/tileset_anims.o: Makefile
$(WASM_OBJ_DIR)/tileset_anims.o: WASM_OPT_FLAGS := -O3

$(WASM_OBJ_DIR)/wasm_display.o: Makefile
$(WASM_OBJ_DIR)/wasm_display.o: WASM_OPT_FLAGS := -O3

$(WASM_OBJ_DIR)/%.o: $(C_SUBDIR)/%.c
	@mkdir -p $(dir $@)
	$(WASM_CC) --target=wasm32-unknown-unknown -DMODERN=1 -DWASM=1 -I $(WASM_BUILD_DIR) -I include/wasm -I include -iquote include -E $< | $(PREPROC) -i -g $(ASSETS_DIR_NAME) $< charmap.txt | $(WASM_CC) --target=wasm32-unknown-unknown -x c $(WASM_OPT_FLAGS) -Wno-incompatible-library-redeclaration -Wno-unknown-attributes -Wno-ignored-attributes -Wno-parentheses -Wno-pointer-to-int-cast -Wno-int-to-pointer-cast -Wno-builtin-requires-header -Wno-gnu-alignof-expression -Wno-unknown-escape-sequence -Wno-excess-initializers -c - -o $@

$(WASM_OBJ_DIR)/%.o: $(DATA_ASM_SUBDIR)/%.s tools/wasm_asm_data.py | generated
	@mkdir -p $(dir $@) $(WASM_BUILD_DIR)
	uv run python tools/wasm_asm_data.py $< $(WASM_BUILD_DIR)/$*.wasm.s
	$(WASM_CC) --target=wasm32-unknown-unknown -c $(WASM_BUILD_DIR)/$*.wasm.s -o $@

serve-wasm: wasm
	node web/server.mjs

wrangler-site: wasm
	node tools/build_wrangler_site.mjs

include graphics_file_rules.mk
include map_data_rules.mk
include json_data_rules.mk
include audio_rules.mk

$(WASM_OBJ_DIR)/maps.o: $(DATA_ASM_SUBDIR)/maps.s $(LAYOUTS_DIR)/layouts.inc $(LAYOUTS_DIR)/layouts_table.inc $(MAPS_DIR)/headers.inc $(MAPS_DIR)/groups.inc $(MAPS_DIR)/connections.inc $(MAP_CONNECTIONS) $(MAP_HEADERS)
$(WASM_OBJ_DIR)/map_events.o: $(DATA_ASM_SUBDIR)/map_events.s $(MAPS_DIR)/events.inc $(MAP_EVENTS)

generated: $(AUTO_GEN_TARGETS)
	@: # Silence the "Nothing to be done" message.

%.s:   ;
%.png: ;
%.pal: ;
%.wav: ;

%.1bpp:   %.png  ; $(GFX) $< $@
%.4bpp:   %.png  ; $(GFX) $< $@
%.8bpp:   %.png  ; $(GFX) $< $@
%.gbapal: %.pal  ; $(GFX) $< $@
%.gbapal: %.png  ; $(GFX) $< $@
%.lz:     %      ; $(GFX) $< $@
%.rl:     %      ; $(GFX) $< $@

$(ASSETS_DIR_NAME)/%.png.1bpp: %.png  ; @mkdir -p $(dir $@); $(GFX) $< $@
$(ASSETS_DIR_NAME)/%.png.4bpp: %.png  ; @mkdir -p $(dir $@); $(GFX) $< $@
$(ASSETS_DIR_NAME)/%.png.8bpp: %.png  ; @mkdir -p $(dir $@); $(GFX) $< $@
$(ASSETS_DIR_NAME)/%.png.gbapal: %.png; @mkdir -p $(dir $@); $(GFX) $< $@
$(ASSETS_DIR_NAME)/%.pal.gbapal: %.pal; @mkdir -p $(dir $@); $(GFX) $< $@
$(ASSETS_DIR_NAME)/%: %               ; @mkdir -p $(dir $@); cp $< $@

clean: clean-wasm clean-generated clean-assets clean-tools

clean-wasm:
	rm -rf $(WASM_BUILD_DIR)

clean-generated:
	@rm -f $(AUTO_GEN_TARGETS)
	@echo "rm -f <AUTO_GEN_TARGETS>"

clean-assets:
	rm -rf $(ASSETS_DIR_NAME)
	rm -f $(MID_SUBDIR)/*.s
	rm -f $(DATA_ASM_SUBDIR)/layouts/layouts.inc $(DATA_ASM_SUBDIR)/layouts/layouts_table.inc
	rm -f $(DATA_ASM_SUBDIR)/maps/connections.inc $(DATA_ASM_SUBDIR)/maps/events.inc $(DATA_ASM_SUBDIR)/maps/groups.inc $(DATA_ASM_SUBDIR)/maps/headers.inc
	find sound -iname '*.bin' -exec rm {} +
	find . \( -iname '*.1bpp' -o -iname '*.4bpp' -o -iname '*.8bpp' -o -iname '*.gbapal' -o -iname '*.lz' -o -iname '*.rl' -o -iname '*.latfont' -o -iname '*.hwjpnfont' -o -iname '*.fwjpnfont' \) -exec rm {} +
	find $(DATA_ASM_SUBDIR)/maps \( -iname 'connections.inc' -o -iname 'events.inc' -o -iname 'header.inc' \) -exec rm {} +
