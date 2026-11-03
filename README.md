# Eltale Monsters Texture Tool

Version 1.0

I built this so anyone with the original game can change its textures. It exports every texture from the Japanese ROM of
Eltale Monsters as a PNG in named folders. You edit the ones you like, and it puts them back into a new copy of the ROM
that you can play.

It works on the **original Japanese ROM only**, so the result is still the Japanese game. It doesn't work on my
[English translation](https://github.com/CanadaX21/Eltale-English).

No game data comes with this tool. You need your own legally obtained copy of the game.

**Download it from the [Releases](../../releases) page** and unpack it anywhere.

## What you need

- **[Python 3](https://www.python.org/downloads/)**
- **Pillow**, the Python image library. Install it with: `python -m pip install pillow`
- **The original Japanese ROM of Eltale Monsters**, this exact dump:

  | | |
  |---|---|
  | CRC32 | `24D937BF` |
  | MD5 | `9b456acb96291fc8b55232a08ae03346` |
  | SHA-1 | `4161b5c100ec82b0241b20ca8f81366e23564ccb` |

  `.z64`, `.v64` and `.n64` byte orders all work. Any other dump, or a ROM that's already patched, is refused, because the
  addresses would be wrong.

## How to use it

Open a terminal in a folder where you want to work. In the commands below, replace `path/to/` with where you unpacked this tool.

**1. Export the textures**

```
python path/to/export_textures.py "my rom.z64"
```

This writes about 3,300 PNGs to a new folder, `exported_textures`. Each folder has a `_sheet.png`, a contact sheet that makes
browsing easy.

**2. Edit copies, not the export**

Copy the PNGs you want to change into a folder of your own, such as `my_folder`, and edit them there. Keep each file's width and
height exactly the same. The end of each name is how the tool finds it (the address, size and format), so don't change that part.

**3. Build your ROM**

```
python path/to/import_textures.py my_folder --rom "my rom.z64" --out my_mod.z64
```

You get `my_mod.z64` and `my_mod.z64.report.txt`, which lists every file changed and anything worth checking. Your original ROM
is never changed. Every run starts from it, so your folder is your whole mod. Change a file and run it again.

## The rules

- **Size:** width and height must stay the same. If any file can't be used, the import stops and writes nothing, so an edit
  can't silently go missing.
- **Colours:**
  - **RGBA16** files (most of the game) take nearly any colour, reduced to 5 bits per channel.
  - **CI4 and CI8** files can only use the colours already in their palette. A new colour snaps to the closest one and the
    report counts those pixels. Bright colours can come out quite different, so check the result. Add `--strict` to stop instead.
  - **I and IA** files are greyscale, so a coloured pixel becomes its brightness.
  - The format is at the end of each file name.
- **Palettes** can't be edited, because other art may share them. The `palettes` folder is only for reference.
- **Transparency:** some files are exported opaque because the game ignores their alpha, so erasing pixels there does nothing.
  The report tells you, and `manifest.csv` notes which files these are.
- **Duplicate art:** the same image can be stored in several places, such as a hand texture shared between characters. Only the
  copy you edited changes, and the report lists the others. Add `--all-copies` to change them all.

## Finding things

- `manifest.csv` lists every texture: address, format, size, palette and what uses it.
- `coverage.txt` shows what each part of the ROM holds and what the tool can't read.
- Most files are named `tex_` plus their address, because nobody has named them yet.
- Monsters have a folder each, using the English names. NPCs are still grouped by file, not by character.

## Sharing your mod

Please don't share the modded ROM. Share your folder of edited PNGs instead: anyone with the same original ROM can run step 3
on it and get exactly the same result.

## If something goes wrong

| Message | What to do |
|---|---|
| `This tool needs Pillow` | Run `python -m pip install pillow` |
| `is not the original Japanese ROM` | Your dump differs from the one above; compare its hash |
| `already holds an export` | Export to another folder with `--out`, or add `--overwrite` if you have no edits in it |
| `it must stay ...` | That PNG changed size; restore its original width and height |
| `cannot be matched` | That PNG's name lost its address; restore the name |

## Known limits

- I've tested this on Windows and Linux, and tested the resulting ROMs in Project64. Real hardware is untested.
- A few sizes may be wrong: `coverage.txt` lists the files whose bytes overlap.
- Art that the game only builds while running isn't exported.

## License

The tool's code is under the [MIT License](LICENSE), so you can use, change and share it, as long as you keep the license and
copyright notice. That covers this tool only. Eltale Monsters and its art, including anything you export from it, belong to their
rights holders.

## Credits

- **Planning, design and testing:** CanadaX21.
- **Claude** (Anthropic's AI model): the tool I used to build this. Claude wrote the code to my direction.
- **Mallos31:** the Eltale Monsters and Quest 64 decompilations, and the boss, HUD and marker texture names.
- **Rainchus, vbhayden:** Quest 64 decompilation work this builds on.

This is a fan project. It is not affiliated with or endorsed by Imagineer, THQ or any rights holder. No ROMs are distributed. You
need your own copy of the game.
