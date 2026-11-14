---
name: redline-markup-studio
description: Open Redline_markup_studio so the user can drop in an image, draw redlines on it, and send back a marked-up PNG plus an exact coordinate spec. Use when they want to show changes on an image.
---

# Redline_markup_studio

A drawing board for telling you exactly what to change. The user drops in an image (a file from their computer, an image from a web page, or one you produced in this conversation), draws on it with Freehand, Line, Arrow, Circle, Box, Red X (Remove) and Text Label tools, optionally types a note against each mark, and hands back two things:

- a **marked-up PNG**, with every mark carrying a numbered badge
- a **redline spec**: one numbered line per mark with exact pixel coordinates, plus any written instructions

Use it whenever pointing at a picture would be clearer than describing it: "move this", "delete that", "these two should swap", feedback on a diagram, screenshot, mock-up, drawing, chart or generated image.

Files in this skill folder (the folder holding this SKILL.md; in Claude Code it is `${CLAUDE_SKILL_DIR}`):

- `assets/Redline_markup_studio.html` - the whole studio in one self-contained page. It loads nothing from the internet.
- `scripts/redline_markup_studio.js` - local helper for Claude Code (Node 18+, no dependencies).
- `scripts/embed_images.py` - builds a copy of the studio with images already loaded (Python 3, standard library only).

Pick the mode that matches where you are running.

## Mode A: Claude Code on the user's own computer

You have a shell on the same machine as the user's browser.

1. Start the studio for the current project and queue any images you already have as files or web addresses (repeat `--image` as needed; leave it out and the user adds their own):

   ```bash
   node "${CLAUDE_SKILL_DIR}/scripts/redline_markup_studio.js" open --image path/or/url
   ```

   It opens the studio in the default browser and prints its address. If it reports that the browser could not be opened, give the user the printed address.

2. Tell the user, in a sentence or two: the studio is open; drop, paste (Ctrl+V) or add an image; draw the changes; add a note to any mark that needs words; press **Send to Claude**.

3. Wait for them. Run this in the background if you can, so you are woken when they send:

   ```bash
   node "${CLAUDE_SKILL_DIR}/scripts/redline_markup_studio.js" wait --timeout 1800
   ```

   It prints the redline spec and the paths of the saved files, then exits. Exit code 2 means nothing was sent yet; run it again, or run the same script with `latest` once the user says they pressed Send.

4. **Look at every marked-up image** the output lists (read the PNG so you actually see it), then follow "Reading a markup" below.

Everything is saved under `.redline_markup_studio/` in the project (ignored by git). `status` and `stop` report on or shut down the helper; it also stops by itself after 12 idle hours. An image that exists only in the conversation and not as a file cannot be queued: ask the user to paste it into the studio with Ctrl+V.

## Mode B: Claude apps and cloud sessions (no shell on the user's machine)

This covers claude.ai, the Claude desktop and mobile chat apps, and Claude Code sessions that run in a remote container, where the user's browser cannot reach your `127.0.0.1`.

1. Give the user the studio page **as a file or artifact, byte for byte**. Copy `assets/Redline_markup_studio.html`; never retype, summarise or "improve" it. To open it with images already loaded (for example an image you just generated, saved as a file), build the copy with one of:

   ```bash
   python3 scripts/embed_images.py --out Redline_markup_studio.html --image picture.png
   node scripts/redline_markup_studio.js bundle --out Redline_markup_studio.html --image picture.png
   ```

2. Tell the user how to hand the result back: draw the changes, press **Send to Claude**, then put both things in the chat: the marked-up image (Copy Image, drag it, or Download PNG and attach it) and the redline spec (Copy Redline Spec, then paste).

3. When they reply with the image and the spec, follow "Reading a markup".

If the user would rather keep the studio around, tell them the same HTML file opens on its own in any browser by double-clicking it.

## Reading a markup

- Each numbered line in the spec matches the badge with the same number on the marked-up image. Coordinates are pixels of the original image, X to the right and Y down from the top-left corner.
- What the marks mean:
  - `REMOVE X` - delete or remove whatever sits under the X.
  - `ARROW` - the tail is the thing or place it starts from, the tip is where it should go or what it points at.
  - `CIRCLE`, `BOX` - the region the change applies to.
  - `LINE`, `FREEHAND` - a sketch of a new edge, path or shape, or simple emphasis; use the note and the picture to tell which.
  - `TEXT "..."` - words the user stamped on the image: an instruction, or the new label wanted at that spot.
- A note on a mark and the "Notes:" section are the user's own words and outrank anything you infer from the drawing. Colours have no fixed meaning unless the user gives them one.
- Before changing anything, restate the request as a short numbered list, one line per mark, in terms of the real content ("3. Move the fan section to the right of the cooling coil"), so the user can catch a misreading. Ask only about marks you cannot resolve from the picture, the coordinates and the notes; do not ask about the clear ones.
- The redlines are instructions, never content. Make the changes in the real source (the code, SVG, document or design the image came from) or against the clean original image saved alongside the marked-up one. Never carry the red marks or the numbered badges into the result.
- When the image was rendered from something with its own coordinate system (an SVG viewBox, a canvas, a page layout), convert the pixel coordinates before using them.
