import { PDFDocument, PrintScaling, StandardFonts, rgb } from "pdf-lib";
import qrcode from "qrcode-generator";
import { isGeneratedSku, MAX_LABEL_COPIES, MAX_LABELS_PER_PRINT, MAX_SKU_BATCH, type SkuLabel } from "./sku-labels.ts";

const MM = 72 / 25.4;
const WIDTH_MM = 38;
const HEIGHT_MM = 13;
const QR_MM = 11;
const DETAILS_MM = 24;
const LINE_MM = 2;
const NAME_DPI = 600;

type NameImage = { png: Uint8Array | string; heightMm: number };
type RasterizeName = (name: string) => Promise<NameImage>;
type LoadLogo = () => Promise<Uint8Array | string>;

async function loadBrandLogo(): Promise<Uint8Array> {
  try {
    const response = await fetch("/defy-tcg-label-logo.png", { cache: "force-cache" });
    if (!response.ok) throw new Error("Logo request failed");
    return new Uint8Array(await response.arrayBuffer());
  } catch {
    throw new Error("The Defy TCG logo could not load. Check your connection and download the PDF again.");
  }
}

/** Wrap at spaces when possible, without splitting Unicode code points. */
export function wrapSkuLabelName(name: string, maxWidth: number, measure: (value: string) => number): string[] {
  let remaining = Array.from(name);
  const lines: string[] = [];
  while (remaining.length > 0 && lines.length < 2) {
    let length = 0;
    while (length < remaining.length && measure(remaining.slice(0, length + 1).join("")) <= maxWidth) length++;
    if (length === remaining.length) {
      lines.push(remaining.join(""));
      break;
    }
    if (lines.length === 1) {
      const visible = remaining.slice(0, length);
      while (visible.length && measure(`${visible.join("").trimEnd()}…`) > maxWidth) visible.pop();
      lines.push(`${visible.join("").trimEnd()}…`);
      break;
    }
    const space = remaining.slice(0, length + 1).lastIndexOf(" ");
    const boundary = space > 0 ? space : Math.max(1, length);
    lines.push(remaining.slice(0, boundary).join("").trimEnd());
    remaining = Array.from(remaining.slice(boundary).join("").trimStart());
  }
  return lines;
}

async function rasterizeName(name: string): Promise<NameImage> {
  const canvas = document.createElement("canvas");
  const dotsPerMm = NAME_DPI / 25.4;
  canvas.width = Math.ceil(DETAILS_MM * dotsPerMm);
  canvas.height = Math.ceil(2 * LINE_MM * dotsPerMm);
  const context = canvas.getContext("2d");
  if (!context) throw new Error("This browser cannot prepare card names for PDF. Try another browser.");
  const font = `${5.5 * NAME_DPI / 72}px Arial, sans-serif`;
  await document.fonts?.load(font, name);
  context.font = font;
  const lines = wrapSkuLabelName(name, canvas.width - 2, (value) => context.measureText(value).width);
  const heightMm = lines.length * LINE_MM;
  canvas.height = Math.ceil(heightMm * dotsPerMm);
  // Resizing resets the drawing state.
  context.font = font;
  context.fillStyle = "white";
  context.fillRect(0, 0, canvas.width, canvas.height);
  context.fillStyle = "black";
  context.textBaseline = "middle";
  lines.forEach((line, index) => context.fillText(line, 0, (index + 0.5) * LINE_MM * dotsPerMm));
  // Keep fallback emoji/font glyphs monochrome for thermal printers too.
  const pixels = context.getImageData(0, 0, canvas.width, canvas.height);
  for (let index = 0; index < pixels.data.length; index += 4) {
    const shade = pixels.data[index] * 0.299 + pixels.data[index + 1] * 0.587 + pixels.data[index + 2] * 0.114 < 180 ? 0 : 255;
    pixels.data[index] = shade;
    pixels.data[index + 1] = shade;
    pixels.data[index + 2] = shade;
  }
  context.putImageData(pixels, 0, 0);
  return { png: canvas.toDataURL("image/png"), heightMm };
}

/** One exact-size PDF page per label; the QR and readable SKU stay vector sharp. */
export async function createSkuLabelPdf(
  labels: readonly SkuLabel[],
  copies: number,
  renderName: RasterizeName = rasterizeName,
  loadLogo: LoadLogo = loadBrandLogo,
): Promise<Uint8Array> {
  if (!Number.isInteger(copies) || copies < 1 || copies > MAX_LABEL_COPIES) {
    throw new Error(`Print between 1 and ${MAX_LABEL_COPIES} copies per SKU.`);
  }
  if (labels.length < 1 || labels.length > MAX_SKU_BATCH) {
    throw new Error(`Print between 1 and ${MAX_SKU_BATCH} SKUs at a time.`);
  }
  if (labels.length * copies > MAX_LABELS_PER_PRINT) throw new Error("Print no more than 1,000 labels at a time.");
  if (labels.some((label) => !isGeneratedSku(label.sku) || typeof label.name !== "string")) {
    throw new Error("Use generated SKUs and valid card names for the PDF labels.");
  }

  const pdf = await PDFDocument.create();
  pdf.setTitle("Defy TCG singles QR labels - 38 x 13 mm");
  pdf.setCreator("Defy Store OS");
  pdf.catalog.getOrCreateViewerPreferences().setPrintScaling(PrintScaling.None);
  const font = await pdf.embedFont(StandardFonts.CourierBold);
  const brandFont = await pdf.embedFont(StandardFonts.HelveticaBold);
  let logo;
  try {
    logo = await pdf.embedPng(await loadLogo());
  } catch {
    throw new Error("The Defy TCG logo could not load. Check your connection and download the PDF again.");
  }
  const nameImages = new Map<string, Promise<{ image: Awaited<ReturnType<typeof pdf.embedPng>>; heightMm: number }>>();

  for (const label of labels) {
    const name = Array.from(label.name.trim().replace(/\s+/g, " ")).slice(0, 48).join("");
    if (name && !nameImages.has(name)) {
      nameImages.set(name, (async () => {
        const rendered = await renderName(name);
        if (!Number.isFinite(rendered.heightMm) || rendered.heightMm <= 0 || rendered.heightMm > 2 * LINE_MM) {
          throw new Error("The card name could not fit the PDF label.");
        }
        return { image: await pdf.embedPng(rendered.png), heightMm: rendered.heightMm };
      })());
    }
    const nameImage = name ? await nameImages.get(name)! : undefined;
    const qr = qrcode(1, "Q");
    qr.addData(label.sku, "Alphanumeric");
    qr.make();
    const moduleSize = QR_MM * MM / (qr.getModuleCount() + 8);
    const textHeightMm = nameImage ? 4 + 0.25 + nameImage.heightMm + 0.25 + 2.5 : 4 + 0.25 + 2.5;
    const textBottom = (HEIGHT_MM - textHeightMm) / 2;
    const brandBottom = textBottom + textHeightMm - 4;

    for (let copy = 0; copy < copies; copy++) {
      const page = pdf.addPage([WIDTH_MM * MM, HEIGHT_MM * MM]);
      for (let row = 0; row < qr.getModuleCount(); row++) {
        for (let column = 0; column < qr.getModuleCount(); column++) {
          if (!qr.isDark(row, column)) continue;
          page.drawRectangle({
            x: MM + (column + 4) * moduleSize,
            y: (HEIGHT_MM - 1) * MM - (row + 5) * moduleSize,
            width: moduleSize,
            height: moduleSize,
            color: rgb(0, 0, 0),
          });
        }
      }
      page.drawImage(logo, { x: 13 * MM, y: brandBottom * MM, width: 4 * MM, height: 4 * MM });
      page.drawText("Defy TCG", {
        x: 18 * MM,
        y: brandBottom * MM + (4 * MM - brandFont.heightAtSize(7.5, { descender: false })) / 2,
        size: 7.5,
        font: brandFont,
        color: rgb(0, 0, 0),
      });
      if (nameImage) page.drawImage(nameImage.image, {
        x: 13 * MM,
        y: (textBottom + 2.5 + 0.25) * MM,
        width: DETAILS_MM * MM,
        height: nameImage.heightMm * MM,
      });
      const fontHeight = font.heightAtSize(7, { descender: false });
      page.drawText(label.sku, {
        x: 13 * MM,
        y: textBottom * MM + (2.5 * MM - fontHeight) / 2,
        size: 7,
        font,
        color: rgb(0, 0, 0),
      });
    }
  }
  return pdf.save();
}
