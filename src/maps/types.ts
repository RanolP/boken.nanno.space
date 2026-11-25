import type { Structure } from "./structure";
import type { Credit } from "../credits/types";
import type { Tweet } from "react-tweet/api";

/** Single source for valid area kinds; the renderer styles each one. */
export const AREA_KINDS = ["stage", "seating", "facility", "hall-label", "photo-zone", "floor-marking"] as const;
export type AreaKind = (typeof AREA_KINDS)[number];

/** RED/BLUE STAGE, as the official timetable names them (agfkorea.com/stage `gubun`). */
export type StageId = "red" | "blue";
/** One programme on a stage's official timetable, written by `npm run stages`; an empty string means not given. */
export type StageEntry = { time: string; name: string; guest: string; comment: string; image: string; copyright: string; url: string };
/** Stage timetables by stage, then by show day ("12-05"), each day in time order. */
export type Stages = Record<StageId, Record<string, StageEntry[]>>;
/** App's `selected` holds booth codes; a stage card is selected under this key instead. */
export const stageKey = (id: StageId) => `stage:${id}`;
export const stageOfKey = (key: string | null): StageId | null => (key === "stage:red" ? "red" : key === "stage:blue" ? "blue" : null);
/** The timetable a stage area opens, by its id: "red-stage", "red-stage-wing-left", "blue-stage", ... */
export const stageOfArea = (a: { id: string; kind: AreaKind }): StageId | null =>
  a.kind === "stage" ? ((a.id.match(/^(red|blue)-stage/)?.[1] as StageId | undefined) ?? null) : null;

export type MapData = {
  id: string;
  title: string;
  venue: string;
  dates: string[];
  source: { url: string; image: string; widthPx: number; heightPx: number };
  /**
   * Real-world scale of the plan image. Take it from the venue CAD fit when one exists (structure.json `fit.metersPerPx`):
   * agf-2026 uses 0.02083 from the KINTEX CAD fit (5 halls, RMS 0.54 m), replacing 0.02179, which assumed 3 m booths.
   */
  metersPerPx: number;
  /** Hall walls and openings from the venue CAD drawings, from <id>/structure.json via `npm run structure`. */
  structure?: Structure;
  categories: Record<string, { label: string; color: string }>;
  booths: {
    code: string;
    category: string;
    x: number;
    y: number;
    w: number;
    h: number;
    exhibitor?: { ko: string; en?: string };
    /** Public path of the exhibitor logo, written by `npm run logos`. */
    logo?: string;
    /** Exhibitor's own intro (official `promotionCopy`), written by `npm run exhibitors`. */
    intro?: string;
    /** Exhibitor homepage URL from the same official list, written by `npm run exhibitors`. */
    homepage?: string;
    /** Official X handles (no @), most relevant first; each found from the exhibitor's homepage link or a verified bio. */
    xAccounts?: string[];
    /** The exhibitor's own X posts about its AGF booth, newest first. */
    notices?: { url: string; date?: string; summary?: string }[];
  }[];
  areas: {
    id: string;
    /** Empty string hides the on-map label. */
    label: string;
    kind: AreaKind;
    x: number;
    y: number;
    w: number;
    h: number;
    /** Outline in source px, for non-rectangular areas; x/y/w/h stay as its bounding box. */
    polygon?: [number, number][];
    /** Flat fill as #rrggbb, overriding the kind's default colour (e.g. to follow the official plan). */
    color?: string;
  }[];
  /**
   * Images cropped from the official plan (pictograms, printed labels, frame lines), laid flat
   * on top of whatever area is under them; x/y/w/h in source px. Written by `npm run markers`.
   */
  markers?: {
    /** Public path of the image. */
    icon: string;
    x: number;
    y: number;
    w: number;
    h: number;
  }[];
};

/** Per-map presentation data that is not part of the extracted map.json. */
export type MapMeta = {
  logo: string;
  /** Notices for this map's third-party material, listed on #/credits. */
  credits: Credit[];
  /** True when booths show exhibitor logos; adds a short caption under the Panel logo. */
  showsExhibitorLogos?: boolean;
  /** Crawled notice posts keyed by status id (`npm run tweets`); loaded on first card open to keep them out of the main bundle. */
  loadTweets?: () => Promise<Record<string, Tweet>>;
  /** Each official X account's recent own posts, as status ids newest first (`npm run tweets`); loaded with the tweets. */
  loadTimelines?: () => Promise<Record<string, string[]>>;
  /** Official stage timetables (`npm run stages`); loaded when a stage card first opens. */
  loadStages?: () => Promise<Stages>;
};
