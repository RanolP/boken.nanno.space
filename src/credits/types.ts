/** One notice on the credits page. Strings are bilingual "ko / en" where the reader needs both. */
export type Credit = {
  what: string;
  holder: string;
  source_url?: string;
  license_or_terms: string;
  /** Link to the license text, when the terms are a named license. */
  license_url?: string;
  usage_note?: string;
  /** Per-item breakdown, e.g. one row per exhibitor booth. */
  items?: { label: string; detail?: string; url?: string }[];
};
