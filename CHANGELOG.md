# Changelog

## 2.0.0: a complete overhaul

This is a new tool, not an update. Version 1 was a pair of command-line scripts: export every texture to a folder, edit some, build a ROM, and only then see the result in an emulator. Version 2 is one page in your browser, with nothing to install, that shows you the game
as you change it. You pick a model or a room, replace what you want, watch it change, and build your ROM. The repository, the README and the way you work have all been redone around that.

**New way of working**
- There's no Python or Pillow to install. You open a page.
- You start from what you're looking at, not from a folder of 3,300 files.
- You see every change on the model straight away, before you build anything.
- Your work lives in one working folder, with your replacements, exports and new ROMs side by side.

**Textures**
- Pick a model or a room, then save one texture or export all of them.
- Replace textures one at a time, under any file name. The model changes straight away.
- A working folder keeps your replacements, exports and new ROMs as files on your computer.
- Build a new ROM from the page.
- Change the colours the game gives its grey textures, like Brian's hair. New in this version: the command-line tool can't do this.
- All 3,300 textures are still there in the same folders, under the same names.

**Viewer**
- Brian, 67 monsters, 8 bosses and 141 NPCs with their animations at the game's speed.
- All 36 maps and 258 rooms in story order, with the sky, fog, doors, and the NPCs and bosses where the game places them.
- Bones, display lists and textures for whatever you're looking at.
- Save PNG, Export GIF, and Export glTF or OBJ.

**The repository**
- The page and its code are now the tool. They're at the top of the repository, with technical notes in `docs`.
- The command-line tool moved to the `python` folder. It works as before, but new features go in the page.

**Compatibility**
- Mods from version 1 still work, and the same files build the same ROM, byte for byte.
- An export from the page leaves out the `_sheet.png` contact sheets and `coverage.txt`, because the Textures tab does their job. The command-line tool still writes them.

## 1.1.1

- Named the monster folders after the maps each set is met on, from the game's encounter tables.

## 1.1

- Added drag and drop on Windows: drop a ROM to export, drop a folder to build. The build finds the original ROM by itself.

## 1.0.1

- Added the mod workflow to the README: your folder is your mod, and every build starts from the original ROM.

## 1.0

- Export every texture from the original Japanese ROM as PNGs in named folders, edit them, and build a new playable ROM.
