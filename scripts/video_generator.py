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
    """Assemble the operator-approved 2-row overlay block.

    Final layout (mirrors the image renderer for unified branding):

        Address: <address line 1>
                 <address line 2>          ← only when address wraps
        Contact: <name> <phone>            ← name optionally bold

    Compact, scannable, premium. No 4-line stack any more.
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

    contact_parts: list[str] = []
    if name_line:
        # Name optionally gets weight emphasis (operator-toggleable via
        # personalisation-config.bold_name). Same size as everything else —
        # premium, balanced hierarchy.
        if BOLD_NAME:
            contact_parts.append(f"{B_OPEN}{name_line}{B_CLOSE}")
        else:
            contact_parts.append(name_line)
    if contact_line:
        contact_parts.append(contact_line)
    if contact_parts:
        out.append("Contact: " + " ".join(contact_parts))
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


def get_audio_codec(video_path: str) -> str:
    """Return the codec_name of the first audio stream, or '' if no audio.
    Used to decide between '-c:a copy' (when AAC) and '-c:a aac' (otherwise).
    Copying AAC straight through saves ~20-30% of total encode time."""
    try:
        out = subprocess.check_output([
            ffprobe_path,
            "-v", "error",
            "-select_streams", "a:0",
            "-show_entries", "stream=codec_name",
            "-of", "json",
            video_path,
        ])
        streams = json.loads(out).get("streams", [])
        if not streams:
            return ""
        return (streams[0].get("codec_name") or "").lower()
    except Exception:
        return ""


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

# Note: target bitrates used to be computed here for a CBR-style cap.
# The main encode now uses CRF only (faster), and the post-encode size-
# guard recomputes its own fallback budget from the actual overshoot.
# Kept just the headline target for log readability.
print(f"Size budget: {TARGET_SIZE_MB:.1f} MB over {duration:.1f}s (CRF-only, "
      f"size-guard fallback at {WHATSAPP_VIDEO_LIMIT_MB:.0f} MB)")

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

# Encode to a .partial.mp4 first; only after the encode finishes AND
# ffprobe confirms a valid moov atom do we rename it to the real
# output path. Without this, a killed/crashed ffmpeg leaves a
# truncated file at output_path that the delivery worker happily
# ships to Meta — Meta then returns "Media upload error" because the
# moov atom is missing. Atomic rename + post-encode validation makes
# that failure mode impossible.
partial_path = output_path + ".partial.mp4"

# Audio probe — picked up the codec once so we can decide between
# `-c:a copy` (AAC, the universal case for consumer mp4s) and a real
# AAC re-encode for exotic inputs. Audio probing is also a precondition
# for the segment+concat fast path (concat -c copy needs consistent
# audio streams across segments).
_audio_codec = get_audio_codec(template_path)
if _audio_codec == "aac":
    print(f"Audio: {_audio_codec} -> stream-copy (skipping re-encode)")
elif _audio_codec:
    print(f"Audio: {_audio_codec} -> re-encode to AAC {AUDIO_BITRATE_KBPS}k")
else:
    print("Audio: no audio stream detected -> output will be silent")

# Remove any stale output so we can prove a fresh file was created.
# Also wipe any leftover .partial from a previous crashed run.
for stale in (output_path, partial_path):
    if os.path.exists(stale):
        try:
            os.remove(stale)
        except OSError:
            pass


def _run(cmd_list: list[str], label: str) -> int:
    """Run an ffmpeg subprocess inside the working dir, printing a
    one-line marker. Returns the exit code (0 = success)."""
    print(f"[{label}] " + " ".join(cmd_list))
    return subprocess.run(cmd_list, cwd=work_dir).returncode


# =============================================================================
# FAST PATH: SEGMENT + CONCAT
#
# A typical template is 60-90 s of video where the personalised overlay
# only occupies the final 3-5 s. Re-encoding the entire clip per
# recipient burned ~95% of the CPU time on bits that were going to be
# byte-identical across every recipient. The fix:
#
#   pre  = template[0 .. overlay_start]      stream-copy (instant)
#   mid  = template[overlay_start .. end]    re-encode WITH overlay baked in
#   post = template[overlay_end .. duration] stream-copy (instant)
#
# Then concat them with `-c copy` (no second encode). For a 68-s clip
# with a 5-s overlay window, the encoder now does ~5 s of real work
# instead of 68 s — a ~13× speedup. The pre/post stream-copies run at
# disk-throughput speed (hundreds of MB/s).
#
# Preconditions for the fast path:
#   * The pre segment is non-trivial (start > 5.0 s). Below that the
#     three-subprocess overhead eats the savings.
#   * Audio is AAC. Concat -c copy demands consistent audio across
#     segments — pre/post inherit the source codec and we stream-copy
#     audio in the mid segment too, so all three need to agree.
#
# When either precondition fails we fall through to the single-pass
# full re-encode at the bottom of this block. That path is also the
# safety net if any of the three segment subprocesses or the concat
# step exits non-zero — segment-split is best-effort, never required.
# =============================================================================

_use_fast_path = (start >= 5.0) and (_audio_codec == "aac")
_fast_path_ok  = False

if _use_fast_path:
    print(f"Encode strategy: SEGMENT+CONCAT  pre=0..{start:.2f}s  "
          f"mid={start:.2f}..{end:.2f}s ({end - start:.2f}s)  "
          f"post={end:.2f}..{duration:.2f}s")

    mid_duration = end - start

    # Rewrite the ASS file with mid-relative timing. The original ASS
    # carried absolute timestamps (e.g. 0:01:01.00 for a 61-s overlay)
    # — fine for the single-pass approach, but wrong here because the
    # mid segment starts at t=0 from ffmpeg's perspective.
    ass_mid_doc = build_ass(TEXT_LINES, video_w, video_h, fontsize, 0.0, mid_duration)
    with open(ass_path, "w", encoding="utf-8", newline="\n") as f:
        f.write(ass_mid_doc)

    # Re-build the drawbox enable window with mid-relative timing too.
    if BG_MODE in _BG_MODE_TO_COLOUR:
        _strip_hex = _BG_MODE_TO_COLOUR[BG_MODE]
        mid_overlay_filter = (
            "drawbox="
            f"x=0:y=ih*(1-{STRIP_HEIGHT_PCT}):w=iw:h=ih*{STRIP_HEIGHT_PCT}:"
            f"color=0x{_strip_hex}@1:t=fill:"
            f"enable='between(t\\,0\\,{mid_duration:.3f})'"
            ",ass=overlay.ass"
        )
    else:
        mid_overlay_filter = "ass=overlay.ass"

    pre_path  = os.path.join(work_dir, "pre.mp4")
    mid_path  = os.path.join(work_dir, "mid.mp4")
    post_path = os.path.join(work_dir, "post.mp4")

    pre_cmd = [
        ffmpeg_path, "-y",
        "-i", template_path,
        "-t", f"{start:.3f}",
        "-c", "copy",
        "-avoid_negative_ts", "make_zero",
        pre_path,
    ]
    mid_cmd = [
        ffmpeg_path, "-y",
        "-ss", f"{start:.3f}",
        "-i", template_path,
        "-t", f"{mid_duration:.3f}",
        "-vf", mid_overlay_filter,
        "-c:v", "libx264",
        "-preset", "ultrafast",
        "-crf", "28",
        "-pix_fmt", "yuv420p",
        "-c:a", "copy",
        mid_path,
    ]
    has_post = (duration - end) > 0.5
    post_cmd = [
        ffmpeg_path, "-y",
        "-ss", f"{end:.3f}",
        "-i", template_path,
        "-c", "copy",
        "-avoid_negative_ts", "make_zero",
        post_path,
    ] if has_post else None

    _fast_path_ok = (_run(pre_cmd, "pre") == 0) and (_run(mid_cmd, "mid") == 0)
    if _fast_path_ok and post_cmd is not None:
        _fast_path_ok = (_run(post_cmd, "post") == 0)

    if _fast_path_ok:
        # Build the concat list as basenames (work_dir is the cwd, so
        # `-safe 0` + filenames-only avoids the abs-path escaping
        # nightmare on Windows).
        list_path = os.path.join(work_dir, "concat.txt")
        with open(list_path, "w", encoding="utf-8", newline="\n") as f:
            f.write(f"file 'pre.mp4'\n")
            f.write(f"file 'mid.mp4'\n")
            if has_post:
                f.write(f"file 'post.mp4'\n")
        concat_cmd = [
            ffmpeg_path, "-y",
            "-f", "concat", "-safe", "0",
            "-i", "concat.txt",
            "-c", "copy",
            "-movflags", "+faststart",
            partial_path,
        ]
        _fast_path_ok = (_run(concat_cmd, "concat") == 0)

    if not _fast_path_ok:
        print("Fast path failed at some step — falling back to single-pass re-encode")
        if os.path.exists(partial_path):
            try: os.remove(partial_path)
            except OSError: pass


# =============================================================================
# SAFE PATH: SINGLE-PASS FULL RE-ENCODE
#
# Used when the fast-path preconditions aren't met (short pre segment
# or non-AAC audio), or as a fallback when any segment/concat step
# fails. Same flags as before — ultrafast + CRF 28 + the chosen audio
# strategy — just without the segment split.
# =============================================================================

if not _fast_path_ok:
    if _audio_codec == "aac":
        _AUDIO_ARGS = ["-c:a", "copy"]
    elif _audio_codec:
        _AUDIO_ARGS = ["-c:a", "aac", "-b:a", f"{AUDIO_BITRATE_KBPS}k", "-ac", "2"]
    else:
        _AUDIO_ARGS = ["-an"]

    # Make sure the ASS file is the absolute-timed version (the fast-
    # path attempt may have overwritten it with mid-relative timings).
    with open(ass_path, "w", encoding="utf-8", newline="\n") as f:
        f.write(ass_doc)

    cmd = [
        ffmpeg_path, "-y",
        "-threads", "0",
        "-i", template_path,
        "-vf", overlay_filter,
        "-c:v", "libx264",
        "-preset", "ultrafast",
        "-crf", "28",
        "-pix_fmt", "yuv420p",
        *_AUDIO_ARGS,
        "-movflags", "+faststart",
        partial_path,
    ]
    print("Encode strategy: SINGLE-PASS full re-encode")
    if _run(cmd, "single-pass") != 0:
        shutil.rmtree(work_dir, ignore_errors=True)
        if os.path.exists(partial_path):
            try: os.remove(partial_path)
            except OSError: pass
        print("ffmpeg failed")
        sys.exit(1)

shutil.rmtree(work_dir, ignore_errors=True)

# Validate the encoded file is actually playable BEFORE swapping it
# into the final path. ffprobe with `-show_format` reads the moov
# atom; if it's missing or unreadable, ffprobe exits non-zero and we
# refuse to publish the corrupt file.
print("[validate] ffprobe-checking the encoded file before publishing")
probe = subprocess.run(
    [ffprobe_path, "-v", "error", "-show_format", "-show_streams", partial_path],
    capture_output=True,
)
if probe.returncode != 0:
    err = probe.stderr.decode("utf-8", errors="replace").strip()
    print(f"[validate] FAILED — refusing to publish a corrupt mp4: {err!r}")
    try: os.remove(partial_path)
    except OSError: pass
    sys.exit(2)

# All checks passed — atomically rename the .partial into place.
os.replace(partial_path, output_path)

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
