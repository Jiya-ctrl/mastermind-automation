"""Personalised branded image generator (v2 — canvas extension).

Composes a CLEAN personalisation strip BELOW the uploaded template image
so the template's existing design is left untouched. The strip renders
the recipient's Student / Address / Contact fields with premium typography
in a labelled two-column layout, with a thin orange accent bar separating
template from strip.

Why this approach:
  The previous version drew text directly on top of the template, which
  collided with templates that already had design content in the bottom
  region (e.g. the Mastermind Abacus marketing creative).  Extending the
  canvas downward gives the personalisation its own clean canvas while
  preserving the template pixel-for-pixel.

CLI:
    python scripts/image_generator.py "<address>" "<phone>" "<name>"

Reads config/settings.json:
    template_image          (relative or absolute path)
    image_overlay (optional, all keys optional with sensible defaults):
        strip_color, accent_color, label_color, value_color
        label_size, value_size, accent_thickness
        strip_padding_x, strip_padding_y_top, strip_padding_y_bottom
        row_gap, label_value_gap
        labels: { student, address, contact }
        fields_order: ["student", "address", "contact"]

Outputs PNG to output/images/<sanitised-address>.png.
"""

import datetime
import hashlib
import json
import os
import re
import sys

from PIL import Image, ImageDraw, ImageFont


# ---------------------------------------------------------------------------
PROJECT_ROOT = os.path.abspath(os.path.join(os.path.dirname(__file__), os.pardir))
CONFIG_PATH  = os.path.join(PROJECT_ROOT, "config", "settings.json")
PERSONALISATION_CONFIG_PATH = os.path.join(PROJECT_ROOT, "data", "personalisation-config.json")
OUTPUT_DIR   = os.path.join(PROJECT_ROOT, "output", "images")


def load_personalisation_config():
    """Operator-tunable style (font / colour / background / position),
    written by the API's /personalisation-config endpoint and shared
    with the video generator. Returns a fully-populated dict — missing
    keys are filled from defaults so the renderer never crashes when
    the operator has never opened the Style panel."""
    defaults = {
        "font_family":      "DejaVu Sans",
        "font_size":        46,
        "font_color":       "#0B1C30",
        "bold_name":        True,
        "shadow_opacity":   0.45,
        "background_mode":  "on_template",
        "strip_color":      "#F97316",
        "strip_height_pct": 0.24,
        "position":         "bottom",
        "margin_pct":       0.05,
    }
    if not os.path.isfile(PERSONALISATION_CONFIG_PATH):
        return defaults
    try:
        with open(PERSONALISATION_CONFIG_PATH, "r", encoding="utf-8") as f:
            persisted = json.load(f)
        if isinstance(persisted, dict):
            for k in defaults:
                if k in persisted:
                    defaults[k] = persisted[k]
    except Exception:
        pass
    return defaults

# Font cascade — Bahnschrift first (variable, ships on Win10+), Segoe as
# a static fallback. Linux production containers often do not have these
# Windows fonts, so we also try common DejaVu/Liberation installs.
FONT_BOLD = [
    (r"C:\Windows\Fonts\bahnschrift.ttf", "Bold"),
    (r"C:\Windows\Fonts\arialbd.ttf",     None),
    ("/usr/share/fonts/truetype/dejavu/DejaVuSans-Bold.ttf", None),
    ("/usr/share/fonts/truetype/liberation/LiberationSans-Bold.ttf", None),
]
FONT_SEMIBOLD = [
    (r"C:\Windows\Fonts\bahnschrift.ttf", "SemiBold"),
    (r"C:\Windows\Fonts\seguisb.ttf",     None),
    ("/usr/share/fonts/truetype/dejavu/DejaVuSans.ttf", None),
    ("/usr/share/fonts/truetype/liberation/LiberationSans-Regular.ttf", None),
]

# Font-family resolver — maps the operator's chosen font_family string
# (from the Style panel) to platform-specific font files. We provide a
# few common families; everything else falls back to the safe defaults
# above so the renderer never breaks on a missing font.
_FAMILY_BOLD = {
    "DejaVu Sans": [
        ("/usr/share/fonts/truetype/dejavu/DejaVuSans-Bold.ttf", None),
        (r"C:\Windows\Fonts\arialbd.ttf", None),
    ],
    "Roboto": [
        ("/usr/share/fonts/truetype/roboto/Roboto-Bold.ttf", None),
        (r"C:\Windows\Fonts\arialbd.ttf", None),
    ],
    "Open Sans": [
        ("/usr/share/fonts/truetype/open-sans/OpenSans-Bold.ttf", None),
        (r"C:\Windows\Fonts\arialbd.ttf", None),
    ],
    "Liberation Sans": [
        ("/usr/share/fonts/truetype/liberation/LiberationSans-Bold.ttf", None),
    ],
    "Inter": [
        ("/usr/share/fonts/truetype/inter/Inter-Bold.ttf", None),
    ],
}
_FAMILY_REGULAR = {
    "DejaVu Sans": [
        ("/usr/share/fonts/truetype/dejavu/DejaVuSans.ttf", None),
        (r"C:\Windows\Fonts\arial.ttf", None),
    ],
    "Roboto": [
        ("/usr/share/fonts/truetype/roboto/Roboto-Regular.ttf", None),
        (r"C:\Windows\Fonts\arial.ttf", None),
    ],
    "Open Sans": [
        ("/usr/share/fonts/truetype/open-sans/OpenSans-Regular.ttf", None),
        (r"C:\Windows\Fonts\arial.ttf", None),
    ],
    "Liberation Sans": [
        ("/usr/share/fonts/truetype/liberation/LiberationSans-Regular.ttf", None),
    ],
    "Inter": [
        ("/usr/share/fonts/truetype/inter/Inter-Regular.ttf", None),
    ],
}


def font_cascade(family, weight):
    """Return the font-file cascade for the given family + weight,
    with the global safe fallbacks appended so we always find something."""
    base = (_FAMILY_BOLD if weight == "bold" else _FAMILY_REGULAR).get(family, [])
    fallback = FONT_BOLD if weight == "bold" else FONT_SEMIBOLD
    return base + fallback


# ---------------------------------------------------------------------------
def sanitize_filename(text):
    """Make a string safe to use as a filename stem."""
    s = re.sub(r"\s+", "_", text.strip())
    s = re.sub(r'[<>:"/\\|?*,]', "", s)
    return s or "output1"


def hex_to_rgb(hex_color):
    h = hex_color.lstrip("#")
    return int(h[0:2], 16), int(h[2:4], 16), int(h[4:6], 16)


def hex_to_rgba(hex_color, alpha=255):
    return (*hex_to_rgb(hex_color), alpha)


def load_font(candidates, size, variation_preferred=None):
    """Open the first available font in the cascade at the given size,
    selecting the variable-axis name when present."""
    for path, variation in candidates:
        if not os.path.isfile(path):
            continue
        try:
            font = ImageFont.truetype(path, size)
        except OSError:
            continue
        v = variation_preferred or variation
        if v:
            try:
                font.set_variation_by_name(v)
            except (OSError, ValueError, AttributeError):
                pass
        return font

    try:
        return ImageFont.load_default()
    except Exception:
        pass

    raise FileNotFoundError(
        "No suitable font found (tried Bahnschrift, Arial/Segoe/DejaVu/Liberation fallbacks)"
    )


def measure(text, font):
    if not text:
        return 0
    box = font.getbbox(text)
    return box[2] - box[0]


def wrap_text(text, font, max_width):
    """Greedy word-wrap that fits each line within max_width."""
    words = (text or "").split()
    if not words:
        return []
    lines, cur = [], words[0]
    for w in words[1:]:
        candidate = cur + " " + w
        if measure(candidate, font) <= max_width:
            cur = candidate
        else:
            lines.append(cur)
            cur = w
    lines.append(cur)
    return lines


# ---------------------------------------------------------------------------
def render(template_path, output_path, settings, name, address, phone):
    """Compose the template + a tight, balanced orange personalisation strip.

    Premium SaaS look: ONE uniform text size across the whole block, with
    hierarchy created by weight (name = Bold; everything else = SemiBold)
    rather than scale. The template remains the dominant focal point —
    the strip is a compact support panel, not a competing element.
    """
    cfg = settings.get("image_overlay", {})

    # Operator-tunable personalisation — overrides settings.json defaults
    # whenever the Style panel has been edited.  Falls back to the
    # baked-in palette/strip when no overrides are persisted yet.
    pcfg = load_personalisation_config()

    base = Image.open(template_path).convert("RGB")
    img_w, img_h = base.size

    # ---- palette ----
    # Background mode decides whether we paint a coloured strip below the
    # template (orange / white / custom) or skip the strip entirely and
    # render the text directly on the template's own area.
    bg_mode = pcfg.get("background_mode", "on_template")
    mode_to_strip_hex = {
        "orange_strip": "#F97316",
        "white_strip":  "#FFFFFF",
        "custom_strip": pcfg.get("strip_color", "#F97316"),
    }
    if bg_mode in mode_to_strip_hex:
        strip_bg = mode_to_strip_hex[bg_mode]
        draw_on_template = False
    elif bg_mode == "on_template":
        strip_bg = cfg.get("strip_color", "#F97316")  # unused when drawing on template
        draw_on_template = True
    else:
        strip_bg = cfg.get("strip_color", "#F97316")
        draw_on_template = False

    # Single body/name colour driven by the Style panel.  When painting
    # on a strip, the operator's chosen colour is used as-is.  When
    # painting directly on the template, the same colour applies — the
    # operator picks one that contrasts with their template.
    body_color = pcfg.get("font_color", cfg.get("body_color", "#FFF1DC"))
    name_color = body_color

    # Font family — comes from the Style panel; we resolve to a real
    # font file via the cascade defined at module scope.
    font_family = pcfg.get("font_family", "DejaVu Sans")

    # ---- responsive sizing (scaled to image width) ----
    # One size for everything. The visual hierarchy is weight-based:
    # SemiBold for the address / labels / phone, true Bold for the name.
    # The operator's font_size acts as a base — we still scale to image
    # width so large templates get readable output and small ones don't
    # blow out the strip.
    base_pt = int(pcfg.get("font_size", 46))
    derived = max(14, int(img_w * 0.034))
    # Take whichever is larger so the operator's choice is always
    # respected as a floor, but very narrow images still get a
    # legible minimum size from the responsive heuristic.
    body_size = cfg.get("body_size", max(base_pt, derived))
    pad_x          = cfg.get("strip_padding_x",
                             max(24, int(img_w * 0.055)))
    pad_y_top      = cfg.get("strip_padding_y_top",
                             max(10, int(img_w * 0.026)))
    pad_y_bottom   = cfg.get("strip_padding_y_bottom",
                             max(10, int(img_w * 0.026)))
    line_gap       = cfg.get("line_gap",
                             max(2, int(img_w * 0.008)))
    section_gap    = cfg.get("section_gap",
                             max(7, int(img_w * 0.020)))

    name    = (name    or "").strip()
    address = (address or "").strip()
    phone   = (phone   or "").strip()

    # Nothing to overlay? Copy the template as-is.
    if not (name or address or phone):
        base.save(output_path, format="PNG", optimize=True)
        return img_w, img_h

    # ---- fonts ----
    # Single body face (SemiBold) at one size, plus a same-size Bold for
    # the recipient name. Hierarchy = weight, NOT scale.  The bold weight
    # for the name is only applied when the operator toggled it on in the
    # Style panel (default: on).
    body_font = load_font(font_cascade(font_family, "regular"), body_size, "SemiBold")
    if pcfg.get("bold_name", True):
        name_font = load_font(font_cascade(font_family, "bold"), body_size, "Bold")
    else:
        name_font = body_font

    body_h = sum(body_font.getmetrics())

    # ---- prepare text lines (final user-approved format) ----
    #     Address: <address>            ← inline; label + value on one line
    #
    #     Contact:                      ← label
    #     <name>                        ← bold, same size
    #     <phone>                       ← regular weight
    max_text_w = img_w - 2 * pad_x

    lines = []

    def _addr_line(text, font):
        return {"text": text, "font": font, "h": body_h,
                "color": body_color, "block": "address"}

    # ---- Address block ----
    if address:
        # Try to fit the whole "Address: <text>" on one centred line. When
        # the address is too long we wrap to a second line; the label only
        # appears on the first.
        inline = f"Address: {address}"
        if measure(inline, body_font) <= max_text_w:
            lines.append(_addr_line(inline, body_font))
        else:
            wrapped = wrap_text(address, body_font, max_text_w) or [address]
            first = f"Address: {wrapped[0]}"
            if measure(first, body_font) > max_text_w:
                lines.append(_addr_line("Address:", body_font))
                for ln in wrapped:
                    lines.append(_addr_line(ln, body_font))
            else:
                lines.append(_addr_line(first, body_font))
                for ln in wrapped[1:]:
                    lines.append(_addr_line(ln, body_font))

    # ---- Contact block ----
    if name or phone:
        lines.append({"text": "Contact:", "font": body_font, "h": body_h,
                      "color": body_color, "block": "contact"})
        if name:
            lines.append({"text": name, "font": name_font, "h": body_h,
                          "color": name_color, "block": "contact"})
        if phone:
            lines.append({"text": phone, "font": body_font, "h": body_h,
                          "color": body_color, "block": "contact"})

    # ---- vertical spacing rule ----
    # · section_gap between two different blocks (address → contact)
    # · line_gap otherwise (within a block)
    def _gap_between(a, b):
        return section_gap if a["block"] != b["block"] else line_gap

    total_text_h = 0
    for i, ln in enumerate(lines):
        total_text_h += ln["h"]
        if i < len(lines) - 1:
            total_text_h += _gap_between(ln, lines[i + 1])

    strip_h = pad_y_top + total_text_h + pad_y_bottom

    # ---- compose canvas ----
    # Strip modes EXTEND the canvas downward and paint the text on a
    # coloured band below the template (template stays pristine).
    # 'on_template' mode skips the extension and paints the text
    # directly on the template's own bottom margin — best when the
    # template already includes a designed footer.
    if draw_on_template:
        canvas = base.copy()
        new_h  = img_h
        text_origin_y = img_h - pad_y_bottom - total_text_h
    else:
        new_h  = img_h + strip_h
        canvas = Image.new("RGB", (img_w, new_h), hex_to_rgb(strip_bg))
        canvas.paste(base, (0, 0))
        text_origin_y = img_h + pad_y_top

    draw = ImageDraw.Draw(canvas)

    # ---- render each line centred horizontally ----
    y = text_origin_y
    for i, ln in enumerate(lines):
        w = measure(ln["text"], ln["font"])
        x = (img_w - w) // 2
        draw.text((x, y), ln["text"], font=ln["font"],
                  fill=hex_to_rgba(ln["color"]))
        y += ln["h"]
        if i < len(lines) - 1:
            y += _gap_between(ln, lines[i + 1])

    canvas.save(output_path, format="PNG", optimize=True)
    return img_w, new_h


# ---------------------------------------------------------------------------
def describe(path):
    st = os.stat(path)
    mtime = datetime.datetime.fromtimestamp(st.st_mtime).isoformat(timespec="seconds")
    h = hashlib.md5()
    with open(path, "rb") as fh:
        for chunk in iter(lambda: fh.read(1 << 20), b""):
            h.update(chunk)
    return f"size={st.st_size:,}B  mtime={mtime}  md5={h.hexdigest()[:12]}"


def load_settings(path):
    with open(path, "r", encoding="utf-8") as f:
        return json.load(f)


def resolve_template(setting_value):
    return setting_value if os.path.isabs(setting_value) \
        else os.path.join(PROJECT_ROOT, setting_value)


def main():
    settings = load_settings(CONFIG_PATH)

    template_path = resolve_template(settings["template_image"])
    if not os.path.isfile(template_path):
        print(f"Template image not found: {template_path}", file=sys.stderr)
        return 1

    # CLI:  argv[1]=address, argv[2]=phone, argv[3]=name (optional)
    address = sys.argv[1].strip() if len(sys.argv) >= 2 and sys.argv[1] else ""
    phone   = sys.argv[2].strip() if len(sys.argv) >= 3 and sys.argv[2] else ""
    name    = sys.argv[3].strip() if len(sys.argv) >= 4 and sys.argv[3] else ""

    output_name = f"{sanitize_filename(address)}.png" if address else "output1.png"
    output_path = os.path.join(OUTPUT_DIR, output_name)
    os.makedirs(OUTPUT_DIR, exist_ok=True)
    if os.path.exists(output_path):
        os.remove(output_path)

    print("=" * 60)
    print("INPUT  template_image:", template_path)
    print("INPUT  template info :", describe(template_path))
    print(f"INPUT  recipient     : name='{name}'  address='{address}'  phone='{phone}'")
    print("OUTPUT image_path    :", output_path)
    print("=" * 60)

    img_w, img_h = render(template_path, output_path, settings, name, address, phone)

    print(f"Composed: {img_w}x{img_h}")
    print("OUTPUT info          :", describe(output_path))
    print("=" * 60)
    print(f"Generated image: {os.path.abspath(output_path)}")
    print("Done!")
    return 0


if __name__ == "__main__":
    sys.exit(main())
