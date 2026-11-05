# Technical notes

How the tool reads the game, and what it doesn't do yet. The [README](../README.md) is the place to start. Function names in brackets come from my own AI-assisted notes on the Eltale Monsters decompilation, so they may not match other copies of it.

## How it was checked

The code is ported from the decompilation and then compared with the running game, using frames and RAM captured from an emulator:

- **Brian:** his field idle agrees with the game: all 23 part matrices within 1/65536, 273 triangles.
- **Monsters:** 11 live Hell Hounds in a battle agree, including one in an attack. All 67 monsters and 440 animations run without an error and were looked at by eye; the others were not compared with the game.
- **Bosses:** all 8 and 47 animations were looked at by eye. None has been compared with the game. They go through the same drawing code as the monsters.
- **NPCs:** the 6 drawn in one frame of Melrode agree with the game's matrices. All 141 models and 466 animations run without an error.
- **Maps:** in that frame all 62 static models match placements read from the ROM, and 143 floor heights match the game's. All 36 maps and 258 rooms run without an error, and every door leads to a room that exists. A whole frame through the viewer differs from the emulator's by a median of 6 of 255 per channel. It is close, not pixel-identical.
- **Actors in rooms:** where Melrode's NPC stands, the median difference from that frame is 11 with the NPC drawn and 67 without. Other rooms were not compared.
- **Fog:** with the frame's own fog values, pixels within 16 levels of the frame go from 65% to 75%. **Sky:** the record, palette and flag match the frame, but no captured frame shows open sky, so the picture itself has not been compared.
- **Exports:** all 217 models were read back by a separate small glTF reader and compared with the game's math, worst vertex under 0.001 units. Khronos's glTF validator reports no errors. They have not been opened in Blender or Maya by these tests.
- **Textures against the command-line tool:** the same 3,347 files, `manifest.csv` byte for byte and every PNG pixel for pixel, read by a separate library. 197 test mods through both tools gave the same ROM, the same report and the same refusals, covering every format and rule.
- **The page:** clicks in a real browser run Open ROM, the remembered ROM, every tab, Export all, Replace, colours, Build ROM and all the downloads. A ROM with a changed colour ran in the ares emulator with Brian's hair showing the new colour.

## The format

Decomp functions in brackets.

- `AnimEntry` (0xC): s16 part count, s16 frames, `ModelPart*`, `Gfx**` display list table.
- `ModelPart` (0x20): `ModelKeyFrame*`, u16 key count, u16 frames, pivot (3 floats), s8 parent + 1 (0 = root), s8 display
  list (-1 = none), u8 flags, `s32*` per-frame display list table or NULL, u16 its length.
- `ModelKeyFrame` (0x34): 9 floats (x y z, 3 angles in degrees, 3 scales), tension, continuity, bias, u16 linear, u16 frame.
- Sampling is Kochanek-Bartels at `frame % part.frames` (`SampleSpline`), so an animation stores keys, not frames.
- A part's matrix: `BuildSRTMatrix(x, y, z, key+0x10, key+0xC, key+0x14, scales)`, note the angle order; then the pivot
  (`ApplyPivotOffset`), then parent (`MatrixMultiply`). Vertices are stored in model space, not relative to their bone.
- A part with no display list still poses its children. Brian's part 22 carries the cape.
- The per-frame table picks a list by the total frame counter, not the animation frame. Brian's head uses it for the
  blink: 80 entries, lists 0 (open), 23 (closed), 24 (half) at positions 20-21 and 28-29, each loading one face texture
  and jumping to the same head mesh.
- Draw with a persistent vertex buffer, transforming at `G_VTX`: vertices keep the matrix they were loaded under.
- Monsters: `gMonsterSets` (ROM 0x56DA0, 0x14 B each: file start, file end, animation tables, base stats, names). A set's whole
  file loads to 0x8020E6F0, pointers already absolute, keys and all. `tables[model ID]` is that monster's `AnimEntry` array.
- That array has no length in the data. `listAnims` runs while records look right and share the first one's display list
  table; over all 67 monsters the second test never decides it. Each monster has 4 to 10 animations.
- Where a monster is met comes from the encounter tables (`monsterLocations`). A ROM set
  is not a region: set 4 is Windward Forest, Baragoon Tunnel and Isle of Skye, and the map's area field picks it per room.
- The list is by game area, not ROM set (`WALKTHROUGH`): which maps go together comes from the game's Map page region table
  (0x80060F30), the order from the guide (a Quest 64 guide; Eltale's story order was not separately
  checked against it). A monster met in two areas is listed under both. Properties still gives its ROM set and model ID.
- Each record in the base stats (0x38 B) holds its own model ID at +2, equal to its position in all 67. +0x20 is the game's
  scale, +0x28 the hurt animation. Animations 0 and 1 are idle and walk (`src/9D50.c`); +0x2C and +0x30 are the AI options
  (0x18 B each: +8 anim, +0xA next, +0xC recover), which name the rest. An animation none of those reach is labelled "not
  played": 2 for 64 monsters, 4 for 63, a few others. Mostly the length of walk or hurt. This is a reading of the tables and
  calls, not a run of the game.
- `DrawEnemies` and `DrawBoss` call `DrawModel(1, ...)`, holding the root's x and z still, so In place is on by default for both.
- Bosses (`BOSSES` in `model_core.js`): one file each, to 0x802A7BC0, by boss number (the file order in the ROM differs: Nepty's
  comes first). Files, placements, base data (0x38 B, as a monster's) and animation tables are in the cutscene bank. The test
  checks that number, model ID and table agree across those tables. Every boss animation plays at rate 1 (`gBattleState & 0x100`).
  Effect scripts spawn effects and never set an animation, so "not played" holds for bosses too: Beigis's 7 and 8, for one.
- Each animation has a play rate: `AdvanceAnimation` moves the frame by it each tick (the total by 1), and frame counts assume
  it, so a 700-frame walk at rate 10 is 70 ticks. From the `SetAnimation` calls: monster walk and hurt 10 (1 in a boss battle,
  `gBattleState & 0x100`), other monster animations 1; Brian's walk and run follow the stick (`want * 14 + 3`: 3-24, up to 31),
  his other animations 1, except that the door walk is animation 1 at 10. The viewer uses 10 for his walk and 31 for his run.
  A monster's not-played animation with the length of its walk or hurt gets 10 too, shown as assumed.

## NPCs

157 records in the map headers' lists place 141 distinct models. A record's model pointer leads straight to its `AnimEntry` array, which is the split per character: nothing
needs cutting out of the blobs by offset. A blob holds one area's NPCs at 0x8020E6F0, with the held objects and Shannon always loaded beside them. Some NPCs borrow textures from
Brian's block, so `npcMemory` maps him too. They are listed by the area where each is first met, in story order. Names are plain English labels by record. Animations 0 and 1
are idle and walk, plus the record's talk animation. Unlike monsters, nothing is marked "not played", because event overlays are outside the decomp's C.

## Maps

This tool is for the original Japanese ROM. Its names are plain English labels, because the ROM's own are Japanese.

The list is in story order, under 8 outdoor areas (`MAP_STORY`). A map goes where the story first reaches it, so the ship and cabin rooms sit
before West Carmagh: the ferry from Dondoran Flats is how you get there. The order started from a walkthrough of Quest 64; the ROM then checks
it: each map has a door from one earlier in the list, and the game's boss numbers rise along it. That shows the order is possible and agrees
with the bosses, not that it is the only order: several maps can be reached in more than one order.

`LoadMap` (`src/E2A0.c`) decides what is in RAM, and `mapMemory` copies it: the map's file at its header's address, gameplay common at
0x80100000; with `flags & 2` interiors common at 0x8010FE00; with `flags & 7` a region block at 0x801F8000; for maps 3, 5, 7, 12 the shared
field block at 0x801E0000; the room's sky record. The last word of a map's header is its room count.

- A room's submap names a model set, whose placed models (0x18 B: x, y, z, angle, scale, geometry index, flags) are in lists: tiles, or one
  list if untiled, plus untiled models. The game draws those near the camera; the viewer draws them all.
- Models flagged 0x8000 (970 of them, trees and some terrain) get their height from the floor at load: `pollFloor` is `PollWorldCollision`,
  `PollModelInstance` and `PollModelFaces`. Reading the file's y without this leaves them floating or buried.
- The flags' low byte routes a model as `SortMapModels` does: 0 and 8 ordinary, flag 0x4000 a second pass; 1-3 and 0x7F, 0x80 translucent
  billboards (1-3 sway in the game, at rest here); 0x40-0x44 scrolling textures (at rest here); 0x10 trees and props, which share the layout,
  with the type in the index, and turn to face the camera; 0x11, 0x12 flames and 0x82 spinning props, not drawn yet; 0x81, 0x83, 0x84 draw
  nothing themselves.
- Lights are the room's own, from its light record, taken at midday when it has several keys: the game's change with the time of day. The
  game turns its fill light with its camera; the viewer uses a fixed one. So rooms are close to the game's colours, not exact.
- Doors (0x24 B) lead to a map, room and entrance; a door with flag 0x10 needs the item shown. Their labels and the entrances' stand on the
  floor under them. Labels use the map names in `model_core.js`; rooms have no names of their own in the ROM's tables, so they are numbers.

## Sky and fog

From the decomp (`E2A0.c` `DrawSky`, `12660.c`), all at midday in the viewer, as the lights are.

- A light key (0x3C B) is: time, ambient, two light colours, the fog colour, fog near, fog far. `UpdateMapLights` interpolates between keys; `gSPFogPosition` takes the range.
- Background: the fog colour on maps with flag 0x80, else black. In front of it, if the light record's flag 4 is set, the sky record's display list around the camera (at camera y - 10), under white.
- The sky's palette is the day period's (`gDayPalettePeriods`, ROM 0x4EAD0: time, palette, fade steps), so the page takes 13,500 to mean period 1. In a frame at time 7,996, RAM holds record palette 0, as the table says.
- Fog is the blender's first cycle, mix(in, fog colour, shade alpha), on surfaces with G_FOG set and that blender. Alpha is per vertex, from the game's own z over **|w|**: a vertex behind the camera has none. Plain z/w puts fog on all the near ground, and the real frame shows none.
- The viewer's fog uses the game's near and far planes (15, 2400, the default camera setup's) with the viewer's camera. From far outside a room everything is deep in fog, so Fog is off by default. Sky is on. Fog on models isn't drawn.

Proof: The test uses the frame's own values (fog 962 to 998, colour 75, 129, 156; the keys predict those, to rounding). With fog the frame's pixels within 16 levels go from 65% to 75%. The sky list's record, palette and flag match that frame, but no frame so far shows open sky, so its picture has not been compared with the game.

## Export

**Export glTF** saves one `.glb` with its textures inside. **Export OBJ** saves a zip of `.obj`, `.mtl` and PNGs. Nothing is uploaded. A file made from the
ROM holds game data: keep it to yourself.

- A model's `.glb` has a real skeleton and every animation, baked at the frames the game shows, one per 1/30 s (so a walk at x10 keeps every tenth frame). Bones sit at the
  game's pivots and follow its hierarchy, so a part's rotation and scale reproduce the game's. In place follows the button, as on screen. Models come out at the game's scale,
  so a monster fits an exported room.
- A model's part table changes per animation (parts come and go, pivots move, and 7 models change a parent, like Brian's staff changing hands). Joints are keyed on what a part
  draws. A part that switches lists (Brian's head, the blink) has one leaf bone per list, with scale 0 or 1 on STEP channels. A moved part whose matrix holds shear gets a helper
  bone above it: rotation and scale there, the second rotation on the bone. Its keys are exact; between keys it can differ, in the few animations that have one.
- A room's `.glb` is in world space with its lighting baked into vertex colours and `KHR_materials_unlit`, so it looks as in the viewer whatever the scene's lights. Doors and
  entrances are named empty nodes. Trees face the camera in the game, so they keep the angle the viewer has when you export.
- File units are game units x 0.1, so Brian is about 1.4 m in a tool that reads metres, and models and rooms still fit each other. Base colours, vertex colours and OBJ's `Kd` are converted to
  linear, which is what glTF and Blender expect; PNGs stay sRGB.
- Materials: the texture, the game's constant colour as the base colour factor (the guide's "grey textures" problem), cut-out as MASK, blended as BLEND, everything else OPAQUE, and
  double-sided where the game does not cull. Tiles are saved at their wrap size with a clamped, repeated or mirrored sampler, so half-stored mirrored textures stay right.
- OBJ has no bones, vertex colours or mirrored sampler. It is the current pose or room, mirrored tiles are doubled and their UVs halved, the constant colour goes to `Kd`, and `vt` is
  flipped for OBJ's bottom-left origin. Rooms lose their baked lighting. Clamped tiles will repeat in tools that always repeat.
- Not carried: reflective parts' texture generation (frozen at the export's camera), second textures, fog, and flames or spinning props.

## Textures

**On a model or a room** (right-hand Textures tab). A model lists everything its animations can draw, whether played yet or not; a room lists what it draws as shown. Pick one to
save it, or Export all. **Replace** takes a PNG of the same size, under any file name: it goes in the working folder under the name the importer needs, and the model updates at once.
An orange edge marks a replaced texture. **Undo replace** takes it out. Dropping a PNG on a thumbnail replaces that one.

**On the whole ROM** (left-hand Textures tab). All 3,300, by the Texture Tool's folders, for what no model shows: the font, menus, effects. Same buttons, plus Export all 3,300.

**Edits tab.** The working folder, the list of replaced textures, Add a folder or a zip (by the names Export gave them; only real changes are kept), the importer's two options, and **Build ROM**.

**The working folder.** Choose one and it holds `import/` (the replacements; edit them there if you like, the page rereads them when it gets focus), `export/` (Export all) and `build/`
(the new ROM and its report). `import/` is an ordinary mod folder: the Python tool builds the same ROM from it. Without a chosen folder, replacements stay in this browser and exports and ROMs come as downloads.
The original ROM is never changed.

**The same as the command-line tool.** Names, offsets and rules are version 1.1.1's, so its mods work here. A test compares the same 3,347 files, `manifest.csv` byte for byte, every PNG pixel for pixel by Pillow; 197 mod
folders giving the same ROM bytes, the same report and the same refusals, with every rule reached. Left out of an export on purpose: the `_sheet.png` contact sheets and `coverage.txt`. Only the words for the two command-line flags differ in a report.

**Why a table.** The tool accepts one exact ROM, so what the exporter's scan finds never changes. The scan runs once, in Python; the page reads the result (`texture_table.js`).

**Exports are always the original pictures,** even while a replacement is on: what you replaced is already in the working folder, and an export's `rom.json` names the original ROM. Save this texture saves what you see.

**Grey textures and their colours.** 112 of the 3,300 are grey (79 I4, 31 I8, 2 IA4), mostly on NPCs. The game draws them through a two-cycle combiner, texture x shade, then x the primitive colour + environment. The primitive colour is the `0xFA` command in the
model's own display list: on Brian's head, I4 0x869A50 under 143, 71, 0 is his hair. So the PNG stays grey, a coloured replacement is reduced to brightness (the report says so), and one grey texture draws in many colours: across all NPCs, 70 grey textures under 318 colours.

The Textures tab lists each texture's colours, with the ROM offsets of the `0xFA` commands that hold them (the Rsp records each one's address). Picking a colour writes it for all of that texture's commands of that colour. Edits live in `tints.json` beside `import/`, `{ "offset in hex": [r, g, b] }`,
so `import/` stays PNG-only and the Python tool can still build it, without the colours. Build ROM writes bytes +4 to +6 of each command, and refuses an offset that isn't an `0xFA`. A colour the code sets while running isn't listed. Proof: a ROM built this way, with Brian's hair at 16, 160, 64, changes 3 bytes and draws green hair in ares (2026-11-05).

## The page

**Left tabs.** Models (with Source: Brian, Monsters, Bosses, NPCs), Maps and Textures. Each list comes back to what you last had open in it,
down to the animation or the room.

**Right tabs.** Properties. Bones: the tree, click one to see its pivot, parent, list and keys and to highlight it on the skeleton.
DLs: on a model, the list table, click one to draw only that list (the others still run, drawing nothing, for the state they leave); on
a room, the actors and placed objects, click one to draw only it. Textures and Edits: see Textures above. All 217 textures of six models and rooms are found in the Texture Tool's manifest by ROM offset, with no palette
disagreeing. The saved picture is the stored one, which can be smaller than the tile the game draws from it (24 x 16 stored, wrapped to 32 x 16).

**Actors in rooms** (toggle, on by default): the NPCs and boss the game places, in their idle, in the game's actor lighting. Exports
of a room include them when they are on. Only the NPCs placed by a room's NPC record are here, at their placed spots. Scripted
scenes can move them; the viewer doesn't play those.

**Sky and Fog** (rooms): see Sky and fog above. **N64 depth** (rooms): on, each surface's own z compare, z update and decal offset as the game sets them; off, a plain depth buffer.
MARO's screenshot shows a button of that name; what his does is unknown, so this is our reading of it. **Transparent:** no background;
Save PNG keeps it. **Background colour:** the colour box. **Forget saved ROM:** the page keeps a copy of the ROM in this browser's
own storage so it can reopen it; the copy never leaves the computer, and this removes it.

**Export GIF:** one loop of the animation at the game's rate and the chosen speed, at 320 x 240, 480 x 360 or 640 x 480, optionally
transparent (GIF has one on-or-off level of transparency, so edges are hard). It keeps your camera; a picture narrower than the
window still shows the window's width. One 256-colour palette for the whole loop. Models only, as MARO's button appears to be.

## Playing

Loop is on by default. Off, an animation plays once and stops on frame 0; Play starts it again, and choosing another animation
plays that one. It plays at the game's rate, so a walk at x10 shows every tenth frame (the last it reaches of 200 is 190); the slider
reaches every frame. The game itself never stops: when an animation ends it plays the next one it was given, usually idle. Loop off
is for looking at one animation.

## Known limits

- Monsters are drawn with the viewer's default lights, not those of their region or battle. Their lists set their own render modes.
- Some animations move Brian a long way on purpose (root motion): 9 lies on the ground, 16 leaps. Zoom out or use In place. The game zeroes the root's x and z only in states 0xA and 0xB, so In place is off by default.
- The animation labels come from the `SetAnimation` calls in `src/3F50.c`. 4, 5, 6, 19, 20 and 21 have no call there, so they stay numbers. No label has been checked by watching the game.
- A model's lights are the ones from that frame of map 0, not chosen per map. Fog is not drawn on models, and the game's model mode has fog on.
- Billboard parts (flag 1) are drawn as ordinary parts. Brian has none in any of the 30 animations.
- Texture generation (16 of Brian's vertices a frame) follows the camera. In the test frame the game's look-at axes equal its view matrix's right and up, signs included, and the viewer takes its axes the same way. Scale: `gSPTexture(size << 6)` = `size` texels (src/1B200.c).
- Blending is a simplified reading of the render mode: opaque, cut-out or alpha blend.
- A headless browser cannot work a native dialog, so the folder picker and the permission prompt after a reload are untested. The tests run the same folder code on the browser's private folder over a local server. The lists of
  Brian, Zelse and Hell Hound equal the Texture Tool's for those models; the NPCs' and the rooms' were not compared that way.
- The tests run Open ROM through the file input, but no one has yet dragged a file onto the page in a test. Orbit, pan,
  zoom and the fly keys have no test either.
- Actors were checked against a real frame only in Melrode room 0 (where the NPC stands, median difference 11 with it drawn, 67
  without), plus Larapool's total of 2,258 triangles, which equals MARO's.
