"""Native OpenCV AKAZE. Native scores are evidence, never probabilities.

Feature version is deliberately distinct from OpenCV.js: interpolation, image
codecs and native builds can change descriptors. Cloud approval is independent.
"""
from __future__ import annotations
import io
import json
import math
from dataclasses import dataclass
from pathlib import Path
from typing import Any
import cv2
import numpy as np
from PIL import Image, ImageOps

VERSION = "rw-native-akaze-630-v1"
WIDTH, HEIGHT = 630, 880
MAX_BYTES, MAX_PIXELS = 12_000_000, 24_000_000
Image.MAX_IMAGE_PIXELS = MAX_PIXELS
cv2.setNumThreads(2)

@dataclass
class Feature:
    points: np.ndarray
    descriptors: np.ndarray
    gray: np.ndarray
    quality: dict[str, Any]

    def save(self, path: Path) -> None:
        temp = path.with_suffix(".part")
        with temp.open("wb") as stream:
            np.savez_compressed(stream, points=self.points, descriptors=self.descriptors,
                                gray=self.gray, metadata=np.array(json.dumps({
                                    "version": VERSION, "quality": self.quality})))
        temp.replace(path)

    @classmethod
    def load(cls, path: Path) -> Feature:
        if path.stat().st_size > 2_500_000:
            raise ValueError("Feature cache is too large")
        with np.load(path, allow_pickle=False) as archive:
            meta = json.loads(str(archive["metadata"]))
            points, descriptors, gray = archive["points"], archive["descriptors"], archive["gray"]
        if (meta["version"] != VERSION or len(points) > 1800 or
            points.shape != (len(points), 2) or descriptors.shape != (len(points), 61) or
            gray.shape != (HEIGHT, WIDTH) or gray.dtype != np.uint8 or
            descriptors.dtype != np.uint8 or not np.isfinite(points).all()):
            raise ValueError("Feature cache failed validation")
        return cls(points, descriptors, gray, meta["quality"])

def decode(data: bytes) -> Image.Image:
    if not 32 <= len(data) <= MAX_BYTES:
        raise ValueError("Use an image below 12 MB")
    with Image.open(io.BytesIO(data)) as im:
        if im.format not in {"JPEG", "PNG", "WEBP"}:
            raise ValueError("Only JPG, PNG and WebP are supported")
        if im.width * im.height > MAX_PIXELS or min(im.size) < 80:
            raise ValueError("Image dimensions exceed scanner limits")
        im.load()
        image = ImageOps.exif_transpose(im).convert("RGBA")
    background = Image.new("RGBA", image.size, "white")
    background.alpha_composite(image)
    return background.convert("RGB")

def preview(data: bytes) -> bytes:
    image = decode(data)
    image.thumbnail((1600, 1600), Image.Resampling.LANCZOS)
    out = io.BytesIO()
    image.save(out, "JPEG", quality=92)
    result = out.getvalue()
    if len(result) > 2_000_000:
        raise ValueError("Preview exceeds the cloud's 2 MB image limit")
    return result

def order_corners(points: np.ndarray) -> np.ndarray:
    center = points.mean(axis=0)
    points = points[np.argsort(np.arctan2(points[:, 1]-center[1], points[:, 0]-center[0]))]
    return np.roll(points, -int(np.argmin(points.sum(axis=1))), axis=0)

def extract(data: bytes) -> Feature:
    image = decode(data)
    original = image.size
    image.thumbnail((1400, 1400), Image.Resampling.LANCZOS)
    source = cv2.cvtColor(np.asarray(image), cv2.COLOR_RGB2GRAY)
    edges = cv2.Canny(cv2.GaussianBlur(source, (5,5), 0), 35, 110)
    contours, _ = cv2.findContours(edges, cv2.RETR_LIST, cv2.CHAIN_APPROX_SIMPLE)
    corners, largest = None, 0.0
    for contour in contours:
        approx = cv2.approxPolyDP(contour, .02 * cv2.arcLength(contour, True), True)
        if len(approx) != 4 or not cv2.isContourConvex(approx):
            continue
        pts = order_corners(approx.reshape(4, 2).astype(np.float32))
        area = abs(cv2.contourArea(pts)) / source.size
        if not .55 <= area <= 1.01:
            continue
        horizontal = np.linalg.norm(pts[0]-pts[1]) + np.linalg.norm(pts[3]-pts[2])
        vertical = np.linalg.norm(pts[0]-pts[3]) + np.linalg.norm(pts[1]-pts[2])
        ratio = horizontal / max(vertical, 1)
        if not (.60 < ratio < .83 or 1.20 < ratio < 1.68):
            continue
        if area > largest:
            corners, largest = (np.roll(pts, -1, axis=0) if ratio > 1 else pts), area
    if corners is not None:
        dest = np.float32([[0,0],[WIDTH-1,0],[WIDTH-1,HEIGHT-1],[0,HEIGHT-1]])
        gray = cv2.warpPerspective(source, cv2.getPerspectiveTransform(corners, dest),
                                  (WIDTH, HEIGHT), flags=cv2.INTER_LINEAR,
                                  borderMode=cv2.BORDER_REPLICATE)
        crop, aspect_valid = "quadrilateral", True
    else:
        ratio = min(source.shape) / max(source.shape)
        if source.shape[1] > source.shape[0]:
            source = cv2.rotate(source, cv2.ROTATE_90_CLOCKWISE)
        gray = cv2.resize(source, (WIDTH, HEIGHT), interpolation=cv2.INTER_AREA)
        crop, aspect_valid = "full-frame", .65 <= ratio <= .79
    enhanced = cv2.createCLAHE(2.0, (8,8)).apply(gray)
    points, descriptors = cv2.AKAZE_create().detectAndCompute(enhanced, None)
    if descriptors is None:
        descriptors = np.empty((0,61), dtype=np.uint8)
    ids = sorted(range(len(points)), key=lambda i: points[i].response, reverse=True)[:1800]
    positions = np.array([points[i].pt for i in ids], dtype=np.float32).reshape(-1,2)
    selected = descriptors[ids].copy()
    quality = {"sourceWidth": min(original), "sourceHeight": max(original),
               "crop": crop, "aspectValid": aspect_valid,
               "sharpness": round(float(cv2.Laplacian(gray, cv2.CV_32F).var()), 2),
               "keypoints": len(positions)}
    return Feature(positions, selected, gray, quality)

def correlation(a: np.ndarray, b: np.ndarray, box: tuple[float,float,float,float]) -> float:
    x0,y0,x1,y1 = box
    region = (slice(math.ceil(y0*HEIGHT), math.floor(y1*HEIGHT)),
              slice(math.ceil(x0*WIDTH), math.floor(x1*WIDTH)))
    first, second = a[region].astype(np.float64).ravel(), b[region].astype(np.float64).ravel()
    first -= first.mean(); second -= second.mean()
    denom = float(np.linalg.norm(first) * np.linalg.norm(second))
    return max(0., min(1., float(first @ second / denom))) if denom > 1e-5 else 0.

def compare(query: Feature, ref: Feature) -> dict[str, Any]:
    result = dict(score=0., inliers=0, matches=0, coverage=0., artwork=0., title=0.,
                  footer=0., inlierRatio=0., geometry=False, verified=False)
    if len(query.points) < 10 or len(ref.points) < 10:
        return result
    matcher = cv2.BFMatcher(cv2.NORM_HAMMING)
    forward = matcher.knnMatch(query.descriptors, ref.descriptors, k=2)
    backward = matcher.knnMatch(ref.descriptors, query.descriptors, k=2)
    reverse = {p[0].queryIdx:p[0].trainIdx for p in backward
               if len(p)==2 and p[0].distance < .72*p[1].distance and p[0].distance <= 100}
    good = [p[0] for p in forward if len(p)==2 and p[0].distance < .72*p[1].distance
            and p[0].distance <= 100 and reverse.get(p[0].trainIdx) == p[0].queryIdx]
    if len(good) < 10:
        return result
    src = np.float32([query.points[m.queryIdx] for m in good])
    dst = np.float32([ref.points[m.trainIdx] for m in good])
    matrix, mask = cv2.findHomography(src, dst, cv2.RANSAC, 3., maxIters=3000, confidence=.995)
    if matrix is None or mask is None or not np.isfinite(matrix).all():
        return result
    corners = cv2.perspectiveTransform(np.float32([[[0,0],[WIDTH-1,0],
                           [WIDTH-1,HEIGHT-1],[0,HEIGHT-1]]]), matrix)[0]
    area = abs(cv2.contourArea(corners)) / (WIDTH*HEIGHT)
    geometry = (np.isfinite(corners).all() and .72 < area < 1.32 and
                (corners[:,0] > -.15*WIDTH).all() and (corners[:,0] < 1.15*WIDTH).all() and
                (corners[:,1] > -.15*HEIGHT).all() and (corners[:,1] < 1.15*HEIGHT).all())
    inliers = dst[mask.ravel().astype(bool)]
    ratio = len(inliers) / len(good)
    cells = {(min(3,int(x/WIDTH*4)),min(4,int(y/HEIGHT*5))) for x,y in inliers}
    artwork_inliers = sum(.07*WIDTH<x<.93*WIDTH and .12*HEIGHT<y<.53*HEIGHT for x,y in inliers)
    result.update(matches=len(good), inliers=len(inliers), inlierRatio=ratio,
                  coverage=len(cells)/20., geometry=bool(geometry))
    if not geometry or artwork_inliers < 8:
        return result
    aligned = cv2.warpPerspective(query.gray, matrix, (WIDTH,HEIGHT),
                                 flags=cv2.INTER_LINEAR, borderValue=255)
    aligned = cv2.GaussianBlur(aligned,(3,3),.6)
    target = cv2.GaussianBlur(ref.gray,(3,3),.6)
    art = correlation(aligned,target,(.08,.13,.92,.52))
    title = correlation(aligned,target,(.08,.54,.92,.64))
    footer = correlation(aligned,target,(.035,.93,.965,.988))
    score = .45*art + .20*title + .20*footer + .10*ratio + .05*min(1.,len(cells)/12.)
    enough = lambda q: (q["aspectValid"] and q["sourceWidth"]>=300 and
                         q["sourceHeight"]>=400 and q["sharpness"]>=12 and q["keypoints"]>=40)
    verified = (enough(query.quality) and enough(ref.quality) and len(inliers)>=28
                and ratio>=.65 and len(cells)/20.>=.30 and art>=.84 and title>=.82 and footer>=.80)
    result.update(score=score, artwork=art, title=title, footer=footer, verified=bool(verified))
    return result

def eligible(card: dict[str, Any]) -> bool:
    return (card.get("inventory_eligible")=="1" and card.get("inventory_count_weight")=="1"
            and card.get("release_status")=="released" and bool(card.get("physical_key"))
            and card.get("finish") in {"Foil","Nonfoil","Non-foil","Normal"})

def finish(value: str) -> str:
    return "Nonfoil" if value in {"Nonfoil","Non-foil","Normal"} else value
