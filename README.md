# Eltale Monsters Texture Tool

Version 2.0.0

I built this so anyone with the original game can look inside it and change how it looks. Open one page in your browser and you can walk through every model and room of the Japanese ROM of Eltale Monsters,
replace textures, change colours, watch the change appear on the model, and build a new ROM to play. There's nothing to install.

Version 2 is a complete overhaul. If you used the old command-line scripts, see [Coming from version 1](#coming-from-version-1) and the [changelog](CHANGELOG.md).

It works on the **original Japanese ROM only**, so the result is still the Japanese game. It doesn't work on my [English translation](https://github.com/CanadaX21/Eltale-English).

No game data comes with this tool. You need your own legally obtained copy of the game.

**Download it from the [Releases](../../releases) page**, unpack it anywhere, and open `Eltale Texture Tool.html`.

## What you need

- **A browser.** I test in Microsoft Edge on Windows, and Chrome should behave the same. Other browsers can't open a real folder, so your work stays in the browser and files come as downloads, and I haven't tested them.
- **The original Japanese ROM of Eltale Monsters**, this exact dump:

  | | |
  |---|---|
  | CRC32 | `24D937BF` |
  | MD5 | `9b456acb96291fc8b55232a08ae03346` |
  | SHA-1 | `4161b5c100ec82b0241b20ca8f81366e23564ccb` |

  `.z64`, `.v64` and `.n64` byte orders all work. Any other dump, or a ROM that's already patched, is refused, because the addresses would be wrong.

Your ROM is read in the page and never leaves your computer. The page keeps a copy in your browser's own storage so it can reopen by itself next time. **Forget saved ROM** removes that copy.

## Change a texture

1. **Pick a model or a room** from the **Models** or **Maps** tab on the left.
2. **Open the Textures tab on the right.** A model shows every texture its animations can draw.
3. **Save the one you want**, or press **Export all** to get all of that model's textures. Paint on your copy in any image editor, and keep its width and height.
4. **Click the texture and press Replace**, or drop your PNG on it. Your file can have any name. The model changes straight away, and an orange edge marks what you've replaced.
5. **Press Build ROM** at the top. You get a new ROM to play. Your original is never changed.

**Undo replace** puts a texture back. The **Edits** tab lists everything you've changed.

## Change a colour

Some textures are grey, and the game colours them when it draws them. Brian's hair is a grey texture drawn in brown. A coloured PNG can't change that, because these textures only store brightness.

So click the texture on its model, and the Textures tab shows the colours the game uses for it. Pick a new one and the model changes straight away. It's built into your ROM along with your textures.

## Your working folder

In the **Edits** tab, press **Choose folder** to keep your work as files on your computer. I recommend it. The first time you use Export all, the page asks for one anyway. The folder holds:

| Folder or file | What's in it |
|---|---|
| `import/` | Your replacement textures, under the names the tool needs. You can keep editing them here: when you come back to the page, it notices. |
| `tints.json` | The colours you've changed |
| `export/` | What Export all saved, one folder per model |
| `build/` | Your new ROM and a report of what changed |

Your browser may ask you to allow the folder again after a restart. If you cancel the folder dialog, Export all gives you a zip instead. With no folder, your work stays in this browser, and exports and ROMs come as downloads.

Every build starts fresh from the original ROM, so to undo something you just take it out. **Back up your folder:** it's the only part you can't rebuild.

## Every other texture

The **Textures** tab on the left has all 3,300 textures in named folders, including what no model shows, like the font, menus and effects. You can save and replace them the same way, or export them all at once. **Add a folder** in the Edits tab takes a whole folder of edited PNGs, or a zip, as long as they keep the names Export gave them.

Filter by folder, file name, ROM offset or what uses a texture.

## The rules

- **Size:** width and height must stay the same. A file of the wrong size is refused right away.
- **Colours in a texture:**
  - **RGBA16** textures (most of the game) take nearly any colour, reduced to 5 bits per channel.
  - **CI4 and CI8** textures can only use the colours already in their palette. A new colour moves to the closest one, and the report counts those pixels. Bright colours can come out quite different, so check the result. Tick **Stop on new colours** to refuse them instead.
  - **I and IA** textures are grey, so a coloured pixel becomes its brightness. Change their colour as above.
- **Palettes** can't be edited, because other art may share them.
- **Transparency:** some textures ignore transparency in the game, so erasing pixels there does nothing. The report tells you.
- **Duplicate art:** the same picture can be stored in several places. Only the one you replaced changes, and the report lists the others. Tick **Also change identical copies** to change them all.

## Look around

Everything here works without changing anything.

- **Models:** Brian, 67 monsters, 8 bosses and 141 NPCs, with their animations at the game's speed. Monsters are listed by where you meet them, in story order.
- **Maps:** all 36 maps and 258 rooms in story order, with the sky, fog, doors and where they lead, and the NPCs and bosses standing where the game puts them.
- **Tabs on the right:** Properties, Bones, DLs (draw one display list or one object alone), Textures and Edits.
- **Save your work elsewhere:** Save PNG, Export GIF, and Export glTF or OBJ for Blender and other 3D tools. A `.glb` keeps the skeleton and every animation.

Drag to orbit, right-drag or Shift-drag to pan, scroll to zoom. W, A, S, D or the arrow keys fly, E up, Q down, and Shift goes faster. The **?** button at the top shows this any time.

[docs/TECHNICAL.md](docs/TECHNICAL.md) has the formats, how each piece was checked against the game, and what isn't there yet.

## Checking your edit in the game

Reset the game or load an in-game save. An emulator save state can bring back the old textures, because it restores what was already in memory. If your emulator has the ROM open, you may need to close it before saving over that file.

## Sharing your mod

Please don't share the modded ROM. Share your `import` folder and `tints.json` instead: anyone with the same original ROM can build exactly the same result.

## Coming from version 1

Your mod folder still works. Press **Add a folder** in the Edits tab and pick it, or copy it into `import/` in your working folder. The names, offsets and rules haven't changed, and for the same files the page builds the same ROM, byte for byte.

The command-line tool is still here, in the [python](python) folder, if you'd rather use it. It needs Python and Pillow, and it doesn't read `tints.json`, so it won't apply colour changes.

## If something goes wrong

| Message | What to do |
|---|---|
| `This is not the original Japanese ROM` | Your dump differs from the one above; compare its hash |
| `this texture must stay ...` | That PNG changed size; restore its original width and height |
| `its name does not end in ...` | A file added by folder or zip lost its name. Rename it, or use Replace, which takes any name |
| `A ROM can't be built until these are fixed` | The Edits tab lists the files. Fix or take out each one |
| The page asks for a folder again | Press **Reconnect** in the Edits tab. Browsers ask again after a restart |
| The model looks wrong or nothing draws | The page needs WebGL2; check that your browser has hardware acceleration on |

## Known limits

- A ROM this page built has run in the ares emulator with its changes showing. Real hardware is untested.
- The folder dialog and its permission prompt are the one part my automated tests can't press, so that part has only been tested on a stand-in folder.
- Flames, spinning props and spell effects aren't drawn in the viewer. You can still change their textures.
- Rooms show midday. The game changes its lights, sky and fog through the day.
- Art that the game only builds while running isn't exported.
- A few texture sizes may be wrong, and NPC folders are grouped by file, not by character.

## License

The tool's code is under the [MIT License](LICENSE), so you can use, change and share it, as long as you keep the license and copyright notice. That covers this tool only. Eltale Monsters and its art, including anything you export from it, belong to their rights holders.

## Credits

- **Planning, design and testing:** CanadaX21.
- **Claude** (Anthropic's AI model): the tool I used to build this. Claude wrote the code to my direction.
- **Mallos31:** the Eltale Monsters and Quest 64 decompilations, and the boss, HUD and marker texture names.
- **Rainchus, vbhayden:** Quest 64 decompilation work this builds on.
- **MARO (zmarotrix):** the idea for the viewer comes from screenshots of MARO's Quest 64 Model Viewer. None of its code is used.

This is a fan project. It is not affiliated with or endorsed by Imagineer, THQ or any rights holder. The people credited above didn't take part in making it, and crediting their work doesn't mean they endorse it. No ROMs are distributed. You need your own copy of the game.
