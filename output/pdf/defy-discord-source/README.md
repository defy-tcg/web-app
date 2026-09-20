# Defy TCG Discord poster - minimal revision

Deliverables: `../defy-tcg-discord-a4.pdf` (one portrait A4 page, 210 x 297 mm)
and `../defy-tcg-discord-a4.png` (2481 x 3508 pixels, rendered at 300 dpi).
Print the PDF on A4 in portrait orientation. Select fit to printable area for
printers that cannot print to the edge.

The design follows the user's simpler Defy TCG reference: electric blue,
clean white lowercase lettering, generous open space, and a dominant QR panel.
The mascot appears only as a small central QR badge. The decorative cards,
sparkles, border, yellow accents, and extra promotional copy were removed.
Artwork was generated with the built-in image generation tool; its complete
prompt is saved in `imagegen-prompt.txt`. The poster artwork is a 1054 x 1492
pixel original. The PNG export's higher resolution does not add source detail.
The QR modules in the PDF are vector geometry for sharp printing.

## Invite verification

On September 20, 2026, Discord's public invite API confirmed both supplied
invites resolve to **Defy TCG - Redmond**. The user-provided QR decodes to
`https://discord.gg/wtzSxpsDW`, with expiry October 20, 2026 at 21:02:41 UTC.
The profile screenshot's invite, `https://discord.gg/ytzCuk7VKy`, reports
`expires_at: null`. The final poster uses that profile invite so the printed
poster has no scheduled invite expiration. Any invite can still be revoked by
the server administrator.

The final QR uses level H error correction and a four-module quiet zone, with
extra clear space from the white panel. Its 143 mm footprint (including quiet
zone) is 35% wider than the earlier design. Actual black modules span about
115 mm. The supplied cat badge appears in a
small central inset. The reference JPEG is retained unchanged; the builder
uses a PDF clipping window to display its badge. The QR is also a clickable
link in the PDF.

## Rebuild

Requires Python and ReportLab. From this directory:

```sh
python3 build_poster.py
pdftoppm -png -r 300 -singlefile ../defy-tcg-discord-a4.pdf ../defy-tcg-discord-a4
```

Validation includes A4 page dimensions, one-page PDF structure, exact hyperlink,
visual review of the rendered page, and independent QR decoding of the final
150 dpi and 300 dpi renders using macOS Vision. No application code changed.
