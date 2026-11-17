import pkg from "../../package.json";
import type { Credit } from "./types";

/** License and holder per dependency, from node_modules/<pkg>/package.json "license" and LICENSE; versions come from package.json. */
const LIBS: { name: keyof typeof pkg.dependencies; holder: string; license: string; url: string }[] = [
  { name: "react", holder: "Meta Platforms, Inc. and affiliates", license: "MIT", url: "https://github.com/facebook/react" },
  { name: "react-dom", holder: "Meta Platforms, Inc. and affiliates", license: "MIT", url: "https://github.com/facebook/react" },
  { name: "three", holder: "three.js authors", license: "MIT", url: "https://github.com/mrdoob/three.js" },
  { name: "@react-three/fiber", holder: "pmndrs (Poimandres)", license: "MIT", url: "https://github.com/pmndrs/react-three-fiber" },
  { name: "@react-three/drei", holder: "react-spring / pmndrs", license: "MIT", url: "https://github.com/pmndrs/drei" },
];

export const appCredits: Credit[] = [
  {
    what: "글꼴 Noto Sans KR Bold (부분 추출: public/fonts/boken-labels.woff) / Font: Noto Sans KR Bold (subset)",
    holder: "© 2014-2021 Adobe (http://www.adobe.com/)",
    source_url: "https://github.com/notofonts/noto-cjk",
    license_or_terms: "SIL Open Font License 1.1",
    license_url: "/fonts/OFL.txt",
    usage_note: "지도 라벨에 쓰인 글자만 남긴 부분 집합 (scripts/subset-font.sh) / Subset to the glyphs used by map labels.",
  },
  ...LIBS.map(
    (l): Credit => ({
      what: `${l.name} ${pkg.dependencies[l.name]} (오픈소스 라이브러리 / open-source library)`,
      holder: l.holder,
      source_url: l.url,
      license_or_terms: `${l.license} License`,
    }),
  ),
];
