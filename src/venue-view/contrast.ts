/**
 * WCAG 2.x contrast for everything drawn on the 3D map. Colours are judged as they reach the
 * screen, not as written: a lit surface is darkened by its shading and every toneMapped material
 * goes through ACES, so the plain #rrggbb fill would pick the wrong ink (purple #7e4a9a renders as
 * #653183, on which the old dark ink measured 2.2:1). Kept free of three/DOM imports so
 * `node src/venue-view/check-contrast.mjs` can import it.
 */

/** Dark and light ink for labels; whichever contrasts more is used, the other becomes its halo when needed. */
export const INK_DARK = "#1b1b24";
export const INK_LIGHT = "#ffffff";
/** WCAG AA for normal-size text; map labels shrink with zoom, so none counts as "large". */
export const TEXT_MIN = 4.5;
/** Headroom over TEXT_MIN before a label goes without a halo: the shading model is within ~3/255 of the screen, not exact. */
const MODEL_MARGIN = 1.1;

/**
 * Diffuse light reaching a face, over PI (three's Lambert BRDF), for the Scene lights:
 * ambient 1.1 + directional 1.6 from (W/2+80, 200, D/2+60) toward the origin (agf-2026 W/D).
 * TOP checked against screenshots: five booth colours land within 3/255 of the rendered pixels.
 * SHADOW is a face the directional light misses (ambient only), the darkest wall a sign sits on.
 * Rendering with other lights or tone mapping invalidates these: re-measure a booth top.
 */
export const SHADE = {
  top: (1.1 + 1.6 * 0.562) / Math.PI,
  shadow: 1.1 / Math.PI,
  /** The most lit wall (+x face, cos 0.696). */
  lit: (1.1 + 1.6 * 0.696) / Math.PI,
  /** An unlit, untone-mapped face (meshBasicMaterial toneMapped=false): the fill exactly as written. The booth top. */
  flat: 0,
} as const;
/** Booth walls range from SHADOW to LIT; contrast is monotonic in surface luminance, so the two ends bound every wall. */
export const WALLS: Shade[] = ["shadow", "lit"];
export type Shade = keyof typeof SHADE;

const toLinear = (c: number) => (c <= 0.04045 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4);
const rgb = (hex: string) => [1, 3, 5].map((i) => toLinear(parseInt(hex.slice(i, i + 2), 16) / 255));

const rrtOdt = (v: number) => (v * (v + 0.0245786) - 0.000090537) / (v * (0.983729 * v + 0.432951) + 0.238081);
/** three's ACESFilmicToneMapping (exposure 1), linear in, linear out. */
const aces = ([r, g, b]: number[]) => {
  [r, g, b] = [r / 0.6, g / 0.6, b / 0.6];
  const i = [0.59719 * r + 0.35458 * g + 0.04823 * b, 0.076 * r + 0.90834 * g + 0.01566 * b, 0.0284 * r + 0.13383 * g + 0.83777 * b].map(rrtOdt);
  return [
    1.60475 * i[0] - 0.53108 * i[1] - 0.07367 * i[2],
    -0.10208 * i[0] + 1.10813 * i[1] - 0.00605 * i[2],
    -0.00327 * i[0] - 0.07276 * i[1] + 1.07602 * i[2],
  ].map((x) => Math.min(1, Math.max(0, x)));
};

const lumOfLinear = ([r, g, b]: number[]) => 0.2126 * r + 0.7152 * g + 0.0722 * b;

/** WCAG relative luminance of an #rrggbb colour as written. */
export const luminance = (hex: string) => lumOfLinear(rgb(hex));

/** On-screen luminance of a surface of this fill: lit and toneMapped (meshStandardMaterial), or flat. */
export const surfaceLuminance = (hex: string, shade: Shade) =>
  shade === "flat" ? luminance(hex) : lumOfLinear(aces(rgb(hex).map((c) => c * SHADE[shade])));

/** On-screen luminance of label text: Scene draws every label with an unlit, untone-mapped material, so the ink is exact. */
export const inkLuminance = (hex: string) => luminance(hex);

export const contrast = (l1: number, l2: number) => (Math.max(l1, l2) + 0.05) / (Math.min(l1, l2) + 0.05);

export type Ink = {
  color: string;
  /** Halo colour when `color` alone misses TEXT_MIN on some face; null when it passes. */
  outline: string | null;
  /** Worst contrast of `color` against the fill over the given faces. */
  ratio: number;
};

/**
 * Text colour for a label drawn on `fill`, judged on every face in `shades` (worst case wins).
 * Mid-tone fills that neither ink clears get a halo in the other ink, so each glyph sits on its halo.
 */
export const inkOn = (fill: string, shades: Shade[] = ["top"]): Ink => {
  const worst = (ink: string) => Math.min(...shades.map((s) => contrast(inkLuminance(ink), surfaceLuminance(fill, s))));
  const dark = worst(INK_DARK);
  const light = worst(INK_LIGHT);
  const [color, other, ratio] = dark >= light ? [INK_DARK, INK_LIGHT, dark] : [INK_LIGHT, INK_DARK, light];
  // Flat faces and the ink are both exact, so only lit faces need the model's headroom.
  const margin = shades.every((s) => s === "flat") ? 1 : MODEL_MARGIN;
  return { color, outline: ratio >= TEXT_MIN * margin ? null : other, ratio };
};

/** WCAG non-text (graphics) threshold: a logo pixel counts as legible against the plate colour at this contrast. */
const GRAPHIC_MIN = 3;

/** Flat [luminance, alpha, ...] pairs of a logo's pixels (WCAG relative luminance, alpha 0-1). */
export type LogoSamples = number[];

/** Opaque-weighted share of a logo's pixels that reach GRAPHIC_MIN against a background of luminance `bg`. */
const legibleShare = (logo: LogoSamples, bg: number) => {
  let ok = 0;
  let all = 0;
  for (let i = 0; i < logo.length; i += 2) {
    all += logo[i + 1];
    if (contrast(logo[i], bg) >= GRAPHIC_MIN) ok += logo[i + 1];
  }
  return all > 0 ? ok / all : 1;
};

/**
 * Colour of the backing plate behind the road view's floating billboard logo, which is seen against
 * anything. Pixels are drawn unlit, so the colour is exact.
 */
export const logoPlate = (logo: LogoSamples): string =>
  // White for a uniform look; dark only when the logo is unreadable on white (white or near-white artwork that would vanish: under 10% of it legible).
  legibleShare(logo, luminance(INK_LIGHT)) < 0.1 ? INK_DARK : INK_LIGHT;

/**
 * Pixels of a logo image, downscaled (a share does not need full resolution). Browser-only (canvas);
 * an unreadable image yields no samples, which counts as fully legible.
 */
export const logoSamples = (img: CanvasImageSource & { width: number; height: number }): LogoSamples => {
  const s = Math.min(1, 64 / Math.max(img.width, img.height));
  const w = Math.max(1, Math.round(img.width * s));
  const h = Math.max(1, Math.round(img.height * s));
  const ctx = Object.assign(document.createElement("canvas"), { width: w, height: h }).getContext("2d");
  if (!ctx) return [];
  ctx.drawImage(img, 0, 0, w, h);
  const px = ctx.getImageData(0, 0, w, h).data;
  const out: LogoSamples = [];
  for (let i = 0; i < px.length; i += 4) {
    if (px[i + 3] < 128) continue;
    out.push(lumOfLinear([px[i], px[i + 1], px[i + 2]].map((c) => toLinear(c / 255))), px[i + 3] / 255);
  }
  return out;
};

