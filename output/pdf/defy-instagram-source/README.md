# Defy TCG Instagram poster

Matching companion to the approved minimal Discord poster: electric blue,
small corner labels, a dominant white QR panel, and simple white typography.
The headline is "follow us." and the supporting line is
"@defytcg on Instagram".

Deliverables: `../defy-tcg-instagram-a4.pdf` (one portrait A4 page,
210 x 297 mm) and `../defy-tcg-instagram-a4.png` (2481 x 3508 pixels,
rendered at 300 dpi). Print A4, portrait, fit to printable area on printers
that cannot print to the edge.

The built-in image generation tool adapted the approved Discord artwork;
the exact prompt is in `imagegen-prompt.txt`. Its 1054 x 1492 pixel artwork
is preserved in `artwork.png`. The higher-resolution PNG export does not
add detail to its source images.

## QR preservation and verification

The user-supplied 865 x 868 JPEG is retained byte-for-byte in
`instagram-qr.jpeg`. Its original blue-to-purple dots and Instagram icon are
placed through a PDF clipping window without redrawing or modifying them.
Only the QR region is visible, at about 117 mm across, surrounded by the
white panel's generous quiet zone. The source image's separate handle and
outer colored corners remain outside the clipping window.

The original image and final 150 dpi and 300 dpi PDF renders were independently
decoded with macOS Vision. The exact QR payload and PDF hyperlink are:

```text
https://www.instagram.com/defytcg?utm_source=qr&stkn=cGd4c3B4MThmeDY4
```

Validation also checks the one-page A4 dimensions, hyperlink, unchanged
source JPEG, and visual layout. A physical print scan has not been tested.
No application code changed.

## Rebuild

Requires Python, Pillow, ReportLab, and Poppler. From this directory:

```sh
python3 build_poster.py
pdftoppm -png -r 300 -singlefile ../defy-tcg-instagram-a4.pdf ../defy-tcg-instagram-a4
```
