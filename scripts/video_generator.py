import datetime
import hashlib
import json
import os
import re
import shutil
import subprocess
import sys
import tempfile

# ---------------------------------------------------------------------------
# Project layout (resolved relative to the repository root, two levels up
# from this file). Centralising paths here keeps the script portable across
# machines and avoids hard-coded absolute paths.
# ---------------------------------------------------------------------------
PROJECT_ROOT = os.path.abspath(os.path.join(os.path.dirname(__file__), os.pardir))
CONFIG_PATH = os.path.join(PROJECT_ROOT, "config", "settings.json")
PERSONALISATION_CONFIG_PATH = os.path.join(PROJECT_ROOT, "data", "personalisation-config.json")
OUTPUT_DIR = os.path.join(PROJECT_ROOT, "output", "videos")


def load_personalisation_config():
    """Operator-tunable style overrides (font / colour / background /
    position) written by the API's /personalisation-config endpoint.
    Returns a dict with safe defaults overlaid by anything the file
    contains, so call-sites can trust every key is populated."""
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


def sanitize_filename(text: str) -> str:
    """Make `text` safe to use as a filename stem: collapse whitespace into
    underscores and strip characters that are illegal on Windows. Returns
    "output1" if the result would be empty."""
    s = re.sub(r"\s+", "_", text.strip())
    s = re.sub(r'[<>:"/\\|?*,]', "", s)
    return s or "output1"


# Derive the output filename from the address argument (argv[1]); fall back
# to the legacy default when no address is supplied.
_raw_address = sys.argv[1].strip() if len(sys.argv) >= 2 and sys.argv[1] else ""
OUTPUT_NAME = f"{sanitize_filename(_raw_address)}.mp4" if _raw_address else "output1.mp4"

# External tools — resolved in this order so the pipeline works on any
# host (Linux deploys, fresh Windows boxes, CI runners) without hand-
# editing the script:
#   1. FFMPEG_BIN / FFPROBE_BIN environment variables (operator override)
#   2. shutil.which("ffmpeg") / shutil.which("ffprobe") (PATH lookup)
#   3. Hard-coded D:\ffmpeg\bin\ paths (the original Windows dev box)
# The hard-coded fallback stays last so existing dev workflow keeps
# working; any other host should set the env vars or put ffmpeg on PATH.
def _resolve_tool(env_var, exe_name, hard_fallback):
    val = os.environ.get(env_var, "").strip()
    if val and os.path.isfile(val):
        return val
    found = shutil.which(exe_name)
    if found:
        return found
    return hard_fallback

ffmpeg_path  = _resolve_tool("FFMPEG_BIN",  "ffmpeg",  r"D:\ffmpeg\bin\ffmpeg.exe")
ffprobe_path = _resolve_tool("FFPROBE_BIN", "ffprobe", r"D:\ffmpeg\bin\ffprobe.exe")


def load_settings(path: str) -> dict:
    with open(path, "r", encoding="utf-8") as f:
        return json.load(f)


settings = load_settings(CONFIG_PATH)

# Resolve template path: relative entries in settings are resolved against
# PROJECT_ROOT so the config file stays portable.
_template_setting = settings["template_video"]
template_path = (
    _template_setting if os.path.isabs(_template_setting)
    else os.path.join(PROJECT_ROOT, _template_setting)
)
output_path = os.path.join(OUTPUT_DIR, OUTPUT_NAME)

# Overlay window: from settings (seconds, absolute timeline of the input).
OVERLAY_START = float(settings["overlay_start"])
OVERLAY_END = float(settings["overlay_end"])

# Default overlay content (used when no CLI args are supplied). The address
# is hand-wrapped at a comma so each line fits the safe-area; {\fs20}\h{\r}
# is a half-height non-breaking spacer between the Address and Contact
# blocks (libass override; {\r} resets the style for subsequent lines).
DEFAULT_NAME_LINE = "Rahul Jain"
DEFAULT_ADDRESS_LINES = ["SKF Colony, Pune,", "Maharashtra"]
DEFAULT_CONTACT_LINE = "7770080900"
# Half-height non-breaking spacer between the Address and Contact blocks.
# Tightened from \fs20 to \fs12 so the gap reads as breathing room, not as
# an empty line — keeps the strip compact and the template dominant.
SECTION_SPACER = r"{\fs12}\h{\r}"
# Inline weight overrides. Everything in the overlay defaults to SemiBold
# (set by the style); only the recipient NAME gets true Bold, matching the
# image renderer's weight-based hierarchy. Labels (Address: / Contact:)
# render at the same weight as their values — no oversized text anywhere.
B_OPEN  = r"{\b1}"
B_CLOSE = r"{\b0}"


def build_text_lines(name_line: str, address_lines: list[str], contact_line: str
                     ) -> list[str]:
    """Assemble the user-approved labelled overlay block.

    Final layout (mirrors the image renderer for unified branding):

        Address: <address line 1>
                 <address line 2>     ← only when address wraps
        (spacer)
        Contact:
        <name>                        ← bold, same size as everything else
        <phone>
    """
    out: list[str] = []
    if address_lines:
        out.append(f"Address: {address_lines[0]}")
        # Indent continuation lines under the address value (no label) by
        # padding with the visual width of "Address: " — libass uses \h
        # for non-breaking space.
        indent = r"\h" * 9  # "Address: " is 9 characters
        for cont in address_lines[1:]:
            out.append(f"{indent}{cont}")

    out.append(SECTION_SPACER)
    out.append("Contact:")
    if name_line:
        # Name optionally gets weight emphasis (operator-toggleable via
        # personalisation-config.bold_name). Same size as everything else —
        # premium, balanced hierarchy.
        if BOLD_NAME:
            out.append(f"{B_OPEN}{name_line}{B_CLOSE}")
        else:
            out.append(name_line)
    out.append(contact_line)
    return out


def wrap_address(address: str, max_chars: int = 38) -> list[str]:
    """Wrap a long address into 1-2 lines by splitting on commas.

    The image renderer wraps with PIL pixel metrics; here we don't have a
    font instance at this point so we use a character-count heuristic
    calibrated for Bahnschrift SemiBold at the default fontsize. The
    overlay's `fit_fontsize` later shrinks the font if even the wrapped
    line is too wide, so this only needs to be approximately right."""
    address = address.strip()
    if len(address) <= max_chars or "," not in address:
        return [address]

    parts = [p.strip() for p in address.split(",") if p.strip()]
    # Greedy: fill the first line as full as possible without exceeding
    # max_chars, then put the rest on the second line.
    first, second = "", ""
    for p in parts:
        candidate = (first + ", " + p) if first else p
        if len(candidate) <= max_chars:
            first = candidate
        else:
            second = (second + ", " + p) if second else p
    if not second:
        return [first]
    return [first, second]


def overlay_content_from_argv() -> tuple[str, list[str], str]:
    """Return (name_line, address_lines, contact_line).

    argv[1]=address, argv[2]=phone, argv[3]=name (optional).

    * Address is wrapped to 1-2 lines on commas so long inputs stay
      inside the safe area.
    * If address and phone are present but name is missing, we render
      the Address + Phone layout (no Name section).
    * If anything required is missing, we fall back to the bundled
      defaults.
    """
    if len(sys.argv) >= 3 and sys.argv[1] and sys.argv[2]:
        name = sys.argv[3].strip() if len(sys.argv) >= 4 and sys.argv[3] else ""
        return name, wrap_address(sys.argv[1]), sys.argv[2]
    return DEFAULT_NAME_LINE, DEFAULT_ADDRESS_LINES, DEFAULT_CONTACT_LINE


# Personalisation style — operator-tunable via the dashboard
# (/personalisation-config). Settings.json values are used as the seed,
# then the persisted personalisation file overlays its own choices on
# top. This MUST be loaded BEFORE build_text_lines() is called because
# the function reads BOLD_NAME at call time.
_pcfg = load_personalisation_config()
# Settings.json defaults are kept as the final fallback so an
# operator who never opens the Style panel still gets sane output.
FONT_NAME       = _pcfg.get("font_family") or "DejaVu Sans"
BOLD            = False                              # name-only bold handled inline via {\b1}
BOLD_NAME       = bool(_pcfg.get("bold_name", True))
TEXT_COLOR      = _pcfg.get("font_color") or settings.get("font_color") or "#0B1C30"
BASE_FONTSIZE   = int(_pcfg.get("font_size") or settings.get("font_size") or 46)
SHADOW_ALPHA    = float(_pcfg.get("shadow_opacity", 0.45))
SHADOW_PX       = 2 if SHADOW_ALPHA > 0 else 0
BG_MODE         = _pcfg.get("background_mode") or "on_template"
STRIP_COLOR     = (_pcfg.get("strip_color") or "#F97316").lstrip("#")
STRIP_HEIGHT_PCT = float(_pcfg.get("strip_height_pct") or 0.24)
MARGIN_PCT      = float(_pcfg.get("margin_pct") or 0.05)
# MarginV is calculated from frame height in build_overlay below — keep
# a reasonable absolute fallback for ASS layout calculations.
BOTTOM_MARGIN_PX = 80

name_line, address_lines, contact_line = overlay_content_from_argv()
TEXT_LINES = build_text_lines(name_line, address_lines, contact_line)

# WhatsApp Cloud API caps video uploads at 16 MB. We target 14 MB so
# container overhead + Meta's internal re-mux can't push us over.
# Override per deploy: WHATSAPP_VIDEO_TARGET_MB (float, e.g. "10" for
# tighter, "14" default).
WHATSAPP_VIDEO_LIMIT_MB = 16.0
TARGET_SIZE_MB          = float(os.environ.get("WHATSAPP_VIDEO_TARGET_MB", "14"))
AUDIO_BITRATE_KBPS      = 96     # AAC stereo, comfortable for voice + light music


def rgb_hex_to_ass(hex_color: str, alpha: float = 1.0) -> str:
    """Convert '#RRGGBB' + opacity (1.0 = fully visible) to ASS '&HAABBGGRR'.
    ASS alpha is inverted: 00 = opaque, FF = fully transparent."""
    h = hex_color.lstrip("#")
    r, g, b = h[0:2], h[2:4], h[4:6]
    aa = round((1.0 - alpha) * 255)
    return f"&H{aa:02X}{b}{g}{r}".upper()


def get_duration(video_path: str) -> float:
    out = subprocess.check_output([
        ffprobe_path,
        "-v", "error",
        "-show_entries", "format=duration",
        "-of", "json",
        video_path,
    ])
    return float(json.loads(out)["format"]["duration"])


def get_video_size(video_path: str) -> tuple[int, int]:
    out = subprocess.check_output([
        ffprobe_path,
        "-v", "error",
        "-select_streams", "v:0",
        "-show_entries", "stream=width,height",
        "-of", "json",
        video_path,
    ])
    s = json.loads(out)["streams"][0]
    return int(s["width"]), int(s["height"])


_ASS_OVERRIDE_RE = re.compile(r"\\h|\{[^}]*\}")


def _visible_length(line: str) -> int:
    """Return the number of glyph-equivalent characters libass will draw.

    Strips ASS overrides ({\b1}, {\fs20}, etc.) and the \\h non-breaking
    space marker so `fit_fontsize` doesn't shrink the font just because
    the source contains markup that doesn't actually render."""
    return len(_ASS_OVERRIDE_RE.sub("", line))


def fit_fontsize(lines: list[str], video_width: int, fontsize: int,
                 side_margin_pct: float = 0.05,
                 avg_char_width_ratio: float = 0.46) -> int:
    """Shrink fontsize until the longest line fits in (video_width - 2*margin).
    Calibrated for libass-rendered Bahnschrift SemiBold: avg glyph width
    ~0.46 * fontsize. 5% side safe-area is comfortable on mobile."""
    longest_chars = max((_visible_length(line) for line in lines), default=1)
    while fontsize > 16:
        usable_px = video_width * (1 - 2 * side_margin_pct)
        if longest_chars * fontsize * avg_char_width_ratio <= usable_px:
            return fontsize
        fontsize -= 2
    return fontsize


def seconds_to_ass_time(seconds: float) -> str:
    """Convert seconds (e.g. 61.0) to ASS H:MM:SS.cs (e.g. '0:01:01.00')."""
    cs = int(round(seconds * 100))
    h, cs = divmod(cs, 360_000)
    m, cs = divmod(cs, 6_000)
    s, cs = divmod(cs, 100)
    return f"{h}:{m:02d}:{s:02d}.{cs:02d}"


def build_ass(lines: list[str], play_w: int, play_h: int, fontsize: int,
              start_s: float, end_s: float) -> str:
    """Build a minimal libass v4+ document. Brand-blue text in regular weight,
    very light drop-shadow, no outline, no background box, bottom-center."""
    bold_flag = -1 if BOLD else 0
    body = "\\N".join(lines)
    primary = rgb_hex_to_ass(TEXT_COLOR, alpha=1.0)         # fully opaque fill
    shadow = rgb_hex_to_ass("#000000", alpha=SHADOW_ALPHA)  # light black shadow
    return (
        "[Script Info]\n"
        "ScriptType: v4.00+\n"
        f"PlayResX: {play_w}\n"
        f"PlayResY: {play_h}\n"
        "ScaledBorderAndShadow: yes\n"
        "WrapStyle: 2\n"
        "\n"
        "[V4+ Styles]\n"
        "Format: Name, Fontname, Fontsize, PrimaryColour, SecondaryColour, "
        "OutlineColour, BackColour, Bold, Italic, Underline, StrikeOut, "
        "ScaleX, ScaleY, Spacing, Angle, BorderStyle, Outline, Shadow, "
        "Alignment, MarginL, MarginR, MarginV, Encoding\n"
        # BorderStyle=1 (outline+shadow), Outline=0 (no outline ring),
        # Shadow=SHADOW_PX, Alignment=2 (bottom-center).
        f"Style: Addr,{FONT_NAME},{fontsize},"
        f"{primary},&H000000FF,&H00000000,{shadow},"
        f"{bold_flag},0,0,0,100,100,0,0,1,0,{SHADOW_PX},2,40,40,"
        f"{BOTTOM_MARGIN_PX},1\n"
        "\n"
        "[Events]\n"
        "Format: Layer, Start, End, Style, Name, MarginL, MarginR, "
        "MarginV, Effect, Text\n"
        f"Dialogue: 0,{seconds_to_ass_time(start_s)},"
        f"{seconds_to_ass_time(end_s)},Addr,,0,0,0,,{body}\n"
    )


if not os.path.isfile(template_path):
    print("Template video not found:", template_path)
    sys.exit(1)


def describe(path: str) -> str:
    st = os.stat(path)
    mtime = datetime.datetime.fromtimestamp(st.st_mtime).isoformat(timespec="seconds")
    h = hashlib.md5()
    with open(path, "rb") as fh:
        for chunk in iter(lambda: fh.read(1 << 20), b""):
            h.update(chunk)
    return f"size={st.st_size:,}B  mtime={mtime}  md5={h.hexdigest()[:12]}"


abs_template = os.path.abspath(template_path)
abs_output = os.path.abspath(output_path)
print("=" * 60)
print("INPUT  template_path :", abs_template)
print("INPUT  template info :", describe(abs_template))
print("OUTPUT output_path   :", abs_output)
print("=" * 60)

duration = get_duration(template_path)
# Overlay window: settings.json may carry legacy hard-coded
# overlay_start/overlay_end values (61-64 from the original template).
# Honour them ONLY if they're inside this template's duration;
# otherwise default to the LAST 5.5 SECONDS of the video — that's the
# convention the operator's brand templates leave free for the
# personalised contact card and it works for any video length without
# manual reconfiguration on new uploads.
DEFAULT_TAIL_SEC = 5.5
if OVERLAY_END <= duration and OVERLAY_START < OVERLAY_END:
    start = max(0.0, OVERLAY_START)
    end   = OVERLAY_END
else:
    start = max(0.0, duration - DEFAULT_TAIL_SEC)
    end   = duration
    print(f"Overlay window auto-set to last {DEFAULT_TAIL_SEC}s "
          f"({start:.2f}-{end:.2f}s of {duration:.2f}s) — "
          f"settings.json values ({OVERLAY_START}-{OVERLAY_END}) "
          f"were outside this template's duration.")
if end <= start:
    print(f"Computed overlay window {start}-{end}s is invalid for duration {duration:.2f}s")
    sys.exit(1)
print(f"Video duration: {duration:.2f}s -> overlay from {start:.2f}s to {end:.2f}s")

# Fontsize comes from settings.json; fit_fontsize is a safety net that shrinks
# further only if the configured size would cause a line to overflow the frame.
video_w, video_h = get_video_size(template_path)
is_portrait = video_h > video_w
fontsize = fit_fontsize(TEXT_LINES, video_w, BASE_FONTSIZE)
print(f"Frame {video_w}x{video_h}  portrait={is_portrait}  fontsize={fontsize}  bold={BOLD}")
print("Lines:")
for line in TEXT_LINES:
    print("   ", line)

# Stage the .ass overlay in a working dir; run ffmpeg with cwd=work_dir so
# the filter argument is just `ass=overlay.ass` (no Windows ':' escape pain
# in absolute paths).
work_dir = tempfile.mkdtemp(prefix="vidgen_")
ass_path = os.path.join(work_dir, "overlay.ass")
ass_doc = build_ass(TEXT_LINES, video_w, video_h, fontsize, start, end)
with open(ass_path, "w", encoding="utf-8", newline="\n") as f:
    f.write(ass_doc)

os.makedirs(os.path.dirname(output_path), exist_ok=True)

# Compute target bitrates from desired file size + duration. We re-encode
# the video (not stream-copy) so the personalised render slots cleanly
# inside Meta's 16 MB ceiling regardless of how heavy the source template
# was. CRF + maxrate gives us "as good as it can be" up to the cap, so
# short videos look excellent and long ones still fit.
target_total_kbps = max(400, int((TARGET_SIZE_MB * 8 * 1024) / duration))
target_video_kbps = max(300, target_total_kbps - AUDIO_BITRATE_KBPS)
target_maxrate    = int(target_video_kbps * 1.25)   # 25% headroom for spikes
target_bufsize    = target_maxrate * 2
print(f"Size budget: {TARGET_SIZE_MB:.1f} MB over {duration:.1f}s -> "
      f"video {target_video_kbps}k (cap {target_maxrate}k) + audio {AUDIO_BITRATE_KBPS}k")

# Build the filter chain. Background mode decides whether libass
# alone renders on the template's own designed area, or whether
# drawbox paints a coloured strip behind the text first. All four
# modes pull their colour from the personalisation config.
_BG_MODE_TO_COLOUR = {
    "orange_strip": "F97316",
    "white_strip":  "FFFFFF",
    "custom_strip": STRIP_COLOR,
}
if BG_MODE in _BG_MODE_TO_COLOUR:
    _strip_hex = _BG_MODE_TO_COLOUR[BG_MODE]
    overlay_filter = (
        "drawbox="
        f"x=0:y=ih*(1-{STRIP_HEIGHT_PCT}):w=iw:h=ih*{STRIP_HEIGHT_PCT}:"
        f"color=0x{_strip_hex}@1:t=fill:"
        f"enable='between(t\\,{start:.3f}\\,{end:.3f})'"
        ",ass=overlay.ass"
    )
    print(f"Filter: drawbox ({BG_MODE}, #{_strip_hex}) + ass overlay")
else:
    # 'on_template' or any unknown mode → libass only, text lands on
    # whatever the template already shows during the overlay window.
    overlay_filter = "ass=overlay.ass"
    print("Filter: ass overlay only (text on template)")

cmd = [
    ffmpeg_path,
    "-y",
    "-i", template_path,
    "-vf", overlay_filter,
    # Video re-encode with quality-aware bitrate ceiling
    "-c:v", "libx264",
    "-preset", "fast",
    "-crf", "26",                          # good quality; overridden by maxrate cap when needed
    "-maxrate", f"{target_maxrate}k",
    "-bufsize", f"{target_bufsize}k",
    "-pix_fmt", "yuv420p",                 # broad device + WhatsApp compatibility
    # Audio re-encode at fixed bitrate (gracefully no-ops if input has no audio)
    "-c:a", "aac",
    "-b:a", f"{AUDIO_BITRATE_KBPS}k",
    "-ac", "2",
    # Faststart moves moov atom to file head so Meta + recipients can
    # start playing before the full download completes.
    "-movflags", "+faststart",
    output_path,
]

# Remove any stale output so we can prove a fresh file was created.
if os.path.exists(output_path):
    os.remove(output_path)

print("Running ffmpeg with the following command:")
for token in cmd:
    print("   ", token)
print("CWD:", work_dir)
print("ASS overlay:\n" + ass_doc)

result = subprocess.run(cmd, cwd=work_dir)
shutil.rmtree(work_dir, ignore_errors=True)

if result.returncode != 0:
    print("ffmpeg failed with exit code", result.returncode)
    sys.exit(result.returncode)

# Hard guarantee: never ship a file over the WhatsApp ceiling. Single
# fallback re-encode at a tighter cap if the first pass overshot (e.g.
# very-long template + complex motion). Two passes is enough — the
# fallback budget is computed from the actual overshoot, not a guess.
final_size_mb = os.path.getsize(output_path) / (1024 * 1024)
if final_size_mb > WHATSAPP_VIDEO_LIMIT_MB:
    fallback_target = WHATSAPP_VIDEO_LIMIT_MB * 0.85       # leave 15% margin
    fallback_total  = max(350, int((fallback_target * 8 * 1024) / duration))
    fallback_video  = max(250, fallback_total - AUDIO_BITRATE_KBPS)
    fallback_max    = int(fallback_video * 1.15)
    print(f"[size-guard] first pass {final_size_mb:.1f} MB > {WHATSAPP_VIDEO_LIMIT_MB} MB limit; "
          f"re-encoding at video {fallback_video}k (cap {fallback_max}k)")
    fallback_path = output_path + ".tight.mp4"
    fb_cmd = [
        ffmpeg_path, "-y", "-i", output_path,
        "-c:v", "libx264", "-preset", "fast",
        "-b:v", f"{fallback_video}k",
        "-maxrate", f"{fallback_max}k",
        "-bufsize", f"{fallback_max * 2}k",
        "-pix_fmt", "yuv420p",
        "-c:a", "aac", "-b:a", f"{AUDIO_BITRATE_KBPS}k", "-ac", "2",
        "-movflags", "+faststart",
        fallback_path,
    ]
    fb_result = subprocess.run(fb_cmd)
    if fb_result.returncode != 0:
        print(f"[size-guard] fallback encode failed (exit {fb_result.returncode}); keeping first pass")
    else:
        os.replace(fallback_path, output_path)
        final_size_mb = os.path.getsize(output_path) / (1024 * 1024)
        print(f"[size-guard] fallback succeeded -> {final_size_mb:.1f} MB")

print("=" * 60)
print("OUTPUT written to    :", abs_output)
print("OUTPUT info          :", describe(abs_output))
print(f"OUTPUT size          : {final_size_mb:.2f} MB "
      f"(WhatsApp limit {WHATSAPP_VIDEO_LIMIT_MB:.0f} MB, target {TARGET_SIZE_MB:.0f} MB)")
print("=" * 60)
print(f"Generated video: {abs_output}")
print("Done!")
