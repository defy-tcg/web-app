"""Build the matching Instagram A4 poster with the supplied QR unchanged."""

from pathlib import Path

from PIL import Image
from reportlab.lib.pagesizes import A4
from reportlab.lib.units import mm
from reportlab.pdfgen import canvas


SOURCE = Path(__file__).resolve().parent
DESTINATION = SOURCE.parent / "defy-tcg-instagram-a4.pdf"
WIDTH, HEIGHT = A4
PROFILE = "https://www.instagram.com/defytcg?utm_source=qr&stkn=cGd4c3B4MThmeDY4"

pdf = canvas.Canvas(str(DESTINATION), pagesize=A4, pageCompression=1)
pdf.setTitle("Defy TCG - Follow Us on Instagram - A4")
pdf.setAuthor("Defy TCG")
pdf.setSubject("Minimal portrait A4 Instagram poster; supplied QR preserved")
pdf.drawImage(str(SOURCE / "artwork.png"), 0, 0, width=WIDTH, height=HEIGHT)

# Match the approved Discord poster's 150 mm white panel and QR position.
cx = 527.5 / 1054 * WIDTH
cy = (1 - 665 / 1492) * HEIGHT
viewport = 122 * mm
left, bottom = cx - viewport / 2, cy - viewport / 2

# Show the original QR region through a PDF clipping window. The source JPEG
# stays byte-for-byte intact; neither its dots nor central icon are redrawn.
# QR bounds are approximately x=149..717 and y=110..675 in the 865x868 source.
qr_source = SOURCE / "instagram-qr.jpeg"
with Image.open(qr_source) as image:
    image_width, image_height = image.size
assert (image_width, image_height) == (865, 868)
scale = viewport / 592
pdf.saveState()
clip = pdf.beginPath()
clip.rect(left, bottom, viewport, viewport)
pdf.clipPath(clip, stroke=0, fill=0)
pdf.drawImage(str(qr_source),
              cx - 432.5 * scale,
              cy - (image_height - 392.5) * scale,
              width=image_width * scale, height=image_height * scale)
pdf.restoreState()
pdf.linkURL(PROFILE, (left, bottom, left + viewport, bottom + viewport), relative=0)
pdf.showPage()
pdf.save()
print(DESTINATION)
