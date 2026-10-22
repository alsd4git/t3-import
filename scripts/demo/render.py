from pathlib import Path

from PIL import Image, ImageDraw, ImageFont


ROOT = Path(__file__).resolve().parents[2]
ASSETS = ROOT / "assets"
FRAMES = ["source", "statuses", "selected", "destination", "review"]
WIDTH = 1280
HEIGHT = 720
BACKGROUND = "#10151e"
FOREGROUND = "#e5e9f0"
MUTED = "#8993a4"
CYAN = "#64d8ed"
YELLOW = "#f0c674"


def load_font(size: int) -> ImageFont.FreeTypeFont:
    choices = [
        "/System/Library/Fonts/Menlo.ttc",
        "/usr/share/fonts/truetype/dejavu/DejaVuSansMono.ttf",
        "/usr/share/fonts/truetype/liberation2/LiberationMono-Regular.ttf",
    ]
    for path in choices:
        if Path(path).exists():
            return ImageFont.truetype(path, size)
    raise RuntimeError("Install a system monospace font (Menlo or DejaVu Sans Mono).")


def render_frame(name: str) -> Image.Image:
    font = load_font(18)
    image = Image.new("RGB", (WIDTH, HEIGHT), BACKGROUND)
    draw = ImageDraw.Draw(image)
    text = (ASSETS / f"fork-{name}.txt").read_text(encoding="utf-8").rstrip("\n")
    lines = text.splitlines()
    line_height = 25
    y = max(30, (HEIGHT - len(lines) * line_height) // 2)
    for line in lines:
        color = FOREGROUND
        if "t3-import" in line or "Choose a source" in line or "Review changes" in line:
            color = CYAN
        elif "↑/↓" in line or "Enter confirm" in line or "Enter choose" in line:
            color = MUTED
        elif "›" in line:
            color = CYAN
        elif "must remain closed" in line:
            color = YELLOW
        draw.text((42, y), line, font=font, fill=color)
        y += line_height
    return image


frames = [render_frame(name) for name in FRAMES]
frames[1].save(ASSETS / "fork-demo.png", optimize=True)
frames[0].save(
    ASSETS / "fork-demo.gif",
    save_all=True,
    append_images=frames[1:],
    duration=[2400, 2600, 1800, 2200, 3000],
    loop=0,
    optimize=True,
    disposal=2,
)
