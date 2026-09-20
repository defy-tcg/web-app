"""Build the A4 poster with the profile's non-expiring invite and crisp vector QR."""

from pathlib import Path

from reportlab.lib.pagesizes import A4
from reportlab.lib.units import mm
from reportlab.graphics import renderPDF
from reportlab.graphics.barcode.qr import QrCodeWidget
from reportlab.graphics.shapes import Drawing
from reportlab.pdfgen import canvas


SOURCE = Path(__file__).resolve().parent
DESTINATION = SOURCE.parent / "defy-tcg-discord-a4.pdf"
WIDTH, HEIGHT = A4
INVITE = "https://discord.gg/ytzCuk7VKy"

pdf = canvas.Canvas(str(DESTINATION), pagesize=A4, pageCompression=1)
pdf.setTitle("Defy TCG - Join Our Discord - A4")
pdf.setAuthor("Defy TCG")
pdf.setSubject("Portrait A4 in-store Discord poster; profile invite with no scheduled expiry")
pdf.drawImage(str(SOURCE / "artwork.png"), 0, 0, width=WIDTH, height=HEIGHT)

# Artwork's white card is x=238..817, y=604..1181 in its 1054x1492 image.
# A vector QR with four modules of quiet zone, plus the card's outer margin.
qr_size = 106 * mm
cx = 527.5 / 1054 * WIDTH
cy = (1 - 892.5 / 1492) * HEIGHT
left, bottom = cx - qr_size / 2, cy - qr_size / 2
qr = QrCodeWidget(INVITE, barLevel="H", barBorder=4,
                  barWidth=qr_size, barHeight=qr_size)
drawing = Drawing(qr_size, qr_size)
drawing.add(qr)
renderPDF.draw(drawing, pdf, left, bottom)

# Place the supplied mascot within a small central PDF clipping window.
# The source JPEG itself is unchanged; H error correction protects the inset.
badge = 17 * mm
pdf.setFillColorRGB(1, 1, 1)
pdf.roundRect(cx - badge / 2 - 1.2 * mm, cy - badge / 2 - 1.2 * mm,
              badge + 2.4 * mm, badge + 2.4 * mm, 5 * mm, stroke=0, fill=1)
pdf.saveState()
clip = pdf.beginPath()
clip.roundRect(cx - badge / 2, cy - badge / 2, badge, badge, 4.3 * mm)
pdf.clipPath(clip, stroke=0, fill=0)
# The blue mascot square occupies pixels 293..427 in the 720 px source.
scale = badge / 134
image_size = 720 * scale
pdf.drawImage(str(SOURCE / "discord-qr.jpeg"),
              cx - image_size / 2, cy - image_size / 2,
              width=image_size, height=image_size)
pdf.restoreState()
pdf.linkURL(INVITE, (left, bottom, left + qr_size, bottom + qr_size), relative=0)
pdf.showPage()
pdf.save()
print(DESTINATION)
