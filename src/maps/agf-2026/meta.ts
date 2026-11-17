import type { MapMeta } from "../types";
import map from "./map.json";
import sources from "../../../public/maps/agf-2026/logos/SOURCES.tsv?raw";

/** booth code -> logo source URL, written by `npm run logos`. */
const logoUrl = new Map(sources.split("\n").slice(1).filter(Boolean).map((l) => l.split("\t")).map(([code, , url]) => [code, url]));

export const meta: MapMeta = {
  logo: "/maps/agf-2026/logo.png",
  showsExhibitorLogos: true,
  credits: [
    {
      what: "AGF 2026 로고·배치도 / AGF 2026 logo and floor plan",
      holder: "AGF 2026 조직위원회 (AGFKorea)",
      source_url: "https://www.agfkorea.com/event?idx=3",
      license_or_terms: "© AGF 2026 조직위원회 (AGFKorea)",
      usage_note:
        "Boken은 비공식 팬 프로젝트이며 조직위원회와 무관합니다. / Boken is an unofficial fan project and is not affiliated with the organizing committee.",
    },
    {
      what: "킨텍스 제1전시장 CAD 도면 (A3002 지상1층평면도) / KINTEX Hall 1 CAD drawing (A3002 ground-floor plan)",
      holder: "KINTEX",
      source_url: "https://www.kintex.com/web/ko/html/facility/exhibition_facility_01.do",
      license_or_terms: "Copyright © KINTEX All rights reserved.",
      usage_note: "전시장 벽체·출입구는 이 도면을 기반으로 그렸습니다. / Hall walls and openings are drawn from this drawing.",
    },
    {
      what: "킨텍스 제1전시장 홀 사진 (1-5홀) / KINTEX Exhibition Center 1 hall photos (Halls 1-5)",
      holder: "KINTEX",
      source_url: "https://www.kintex.com/web/ko/html/facility/exhibition_facility_01.do",
      license_or_terms: "Copyright © KINTEX All rights reserved.",
      usage_note:
        "로드뷰의 바닥·벽·천장은 홀 사진(https://www.kintex.com/public/common/images/content/exhibition_facility_hall{1-5}_{n}.jpg)을 평면 투영해 그렸습니다. / Road-view floor, wall and ceiling textures are planar projections of these hall photos.",
    },
    {
      what: "참가사 로고 / Exhibitor logos",
      holder: "각 참가사 및 권리자 / each exhibitor and rights holder",
      source_url: "https://www.agfkorea.com/information",
      license_or_terms: "© 각 참가사 및 권리자 / © each exhibitor and rights holder",
      usage_note: "비상업적 용도로만 사용합니다. 출처: AGF 2026 참가사 안내 / Used for non-commercial purposes only.",
      items: map.booths
        .filter((b) => "logo" in b && b.exhibitor)
        .map((b) => ({
          label: `${b.code} ${b.exhibitor?.ko}`,
          detail: b.exhibitor?.en && b.exhibitor.en !== b.exhibitor.ko ? b.exhibitor.en : undefined,
          url: logoUrl.get(b.code),
        })),
    },
  ],
};
