# AstroMaxClarity

A PixInsight script that brings **Lightroom-style Clarity and Luminance Sharpening** to astrophotography post-processing — with per-tone-zone control over Shadows, Midtones, and Highlights independently.

![AstroMaxClarity UI](https://raw.githubusercontent.com/deanlinic/AstroMaxClarity/main/screenshot.png)

---

## Features

### 1 · Clarity by Tone Zone
Lightroom-accurate local contrast enhancement (LCE) applied selectively by luminance zone:

- **Shadows clarity** — enhances or softens microcontrast in dark areas (nebula backgrounds, dust lanes)
- **Midtones clarity** — the main structural zone; brings out pillar edges, cloud detail, galaxy arms
- **Highlights clarity** — controls contrast in bright regions (star halos, emission peaks)
- **Zone width** — controls how broadly each zone bleeds into adjacent tones (smoothstep falloff)

Positive values add local contrast (structures "pop"), negative values soften local contrast (useful for smoothing noisy flat areas).

### 2 · USM Parameters
Global sigma for the underlying UnsharpMask used in Clarity processing. Higher values = larger-radius local contrast (more macro effect, like Lightroom Clarity at high values).

### 3 · Luminance Sharpening
Colour-neutral sharpening that operates only on the luminance channel:

- **Amount** — sharpening strength
- **Radius (sigma)** — size of the sharpening kernel; small values (1–3) sharpen fine detail and star edges, larger values (5–10) sharpen macro structure
- **Threshold** — protects smooth areas from sharpening (higher = only sharp edges get enhanced)

Uses an L-channel ratio method: applies USM to a copy, then transfers only the luminance delta back — zero colour fringing.

---

## Preview

- **Live preview** at 25% scale with bilinear zoom rendering
- **Drag a rectangle** on the preview to zoom into that area (zoom level auto-selected by rectangle size)
- **2x / 4x / 8x** zoom level buttons
- **Sliders update instantly** — preview refreshes only when you release the slider, keeping the UI responsive
- **Apply & Continue** — bakes current parameters and resets sliders for a second pass
- **Create New Image** — applies all parameters to the full-resolution original and opens a new window; your source image is never modified

---

## Installation

### Option A — Script directory (permanent)
Copy `AstroMaxClarity.js` to your PixInsight scripts folder:

```
macOS:   ~/Library/Application Support/PixInsight/src/scripts/
Windows: C:\Program Files\PixInsight\src\scripts\
Linux:   ~/.pixinsight/src/scripts/
```

Then restart PixInsight and run via **Script > Utilities > AstroMaxClarity**.

### Option B — Feature Scripts (no restart needed)
1. Go to **Script > Feature Scripts...**
2. Click **Add** and navigate to `AstroMaxClarity.js`
3. Click **Done**
4. Run via **Script > Utilities > AstroMaxClarity**

---

## Requirements

- PixInsight **1.8.9** or later
- Works on **RGB** and **grayscale** images
- Works on **linear** and **non-linear** (stretched) images — designed primarily for post-stretch use

---

## Typical Workflow

1. Open your finished/stretched image in PixInsight
2. Run AstroMaxClarity
3. Start with **Midtones clarity** (+20 to +60) to bring out nebula structure
4. Add **Highlights clarity** (+10 to +30) to pop star-forming regions
5. Use **Shadows clarity** sparingly (positive to reveal dark lane detail, negative to smooth noisy backgrounds)
6. Add **Luminance Sharpening** (Amount 30–60, Radius 1.5–3.0) for fine edge definition
7. Use **Apply & Continue** to bake and do a second pass if needed
8. Click **Create New Image** to apply at full resolution

---

## Changelog

| Version | Notes |
|---------|-------|
| v2.0.0 | Stable release. Clarity via MLT local contrast. Lum sharpening via L-ratio. Bilinear zoom. Slider-release refresh. |
| v1.9.0 | Added NoiseXTerminator-based NR (requires NXT plugin) |
| v1.8.x | Experimental PixelMath-based NR (removed) |
| v1.3.0 | Lightroom-accurate Clarity algorithm, bilinear zoom |
| v1.0.0 | Initial release |

---

## License

MIT License — free to use, modify, and distribute.  
Copyright © 2026 Dean Linic
