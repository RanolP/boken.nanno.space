import { useEffect } from "react";
import { maps } from "../maps";
import { appCredits } from "./app-credits";
import type { Credit } from "./types";
import "./credits.css";

const Link = ({ href }: { href: string }) => (
  <a href={href} target={href.startsWith("http") ? "_blank" : undefined} rel="noreferrer">
    {href}
  </a>
);

const CreditList = ({ credits }: { credits: Credit[] }) => (
  <ul className="credit-list">
    {credits.map((c) => (
      <li key={c.what} className="credit">
        <h3>{c.what}</h3>
        <dl>
          <dt>권리자 / Holder</dt>
          <dd>{c.holder}</dd>
          <dt>라이선스·조건 / License or terms</dt>
          <dd>
            {c.license_or_terms}
            {c.license_url && (
              <>
                {" "}
                (<Link href={c.license_url} />)
              </>
            )}
          </dd>
          {c.source_url && (
            <>
              <dt>출처 / Source</dt>
              <dd>
                <Link href={c.source_url} />
              </dd>
            </>
          )}
          {c.usage_note && (
            <>
              <dt>비고 / Note</dt>
              <dd>{c.usage_note}</dd>
            </>
          )}
        </dl>
        {c.items && (
          <details>
            <summary>
              부스별 목록 / Per-booth list ({c.items.length})
            </summary>
            <div className="table-wrap">
              <table>
                <thead>
                  <tr>
                    <th scope="col">부스 · 참가사 / Booth · Exhibitor</th>
                    <th scope="col">로고 출처 / Logo source</th>
                  </tr>
                </thead>
                <tbody>
                  {c.items.map((it) => (
                    <tr key={it.label}>
                      <td>
                        {it.label}
                        {it.detail && <span className="sub"> · {it.detail}</span>}
                      </td>
                      <td>{it.url ? <Link href={it.url} /> : "-"}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </details>
        )}
      </li>
    ))}
  </ul>
);

/** #/credits lists every map; #/credits/<mapId> scrolls to that map's section. */
export const CreditsPage = ({ section }: { section?: string }) => {
  useEffect(() => {
    document.title = "출처 및 저작권 / Credits - Boken";
    if (section) document.getElementById(`credits-${section}`)?.scrollIntoView();
    else window.scrollTo(0, 0);
    return () => {
      document.title = "Boken";
    };
  }, [section]);
  const back = maps.find((m) => m.id === section) ?? maps[0];
  return (
    <div className="credits">
      <a className="back" href={`#/${back.id}`}>
        ← 지도로 돌아가기 / Back to map
      </a>
      <main>
        <h1>출처 및 저작권 / Credits</h1>
        <p className="lead">
          Boken은 비공식 팬 프로젝트이며 행사 조직위원회·킨텍스와 무관합니다. / Boken is an unofficial fan project, not affiliated with the organizers or KINTEX.
        </p>
        {maps.map((m) => (
          <section key={m.id} id={`credits-${m.id}`} aria-labelledby={`h-${m.id}`}>
            <h2 id={`h-${m.id}`}>{m.data.title}</h2>
            <CreditList credits={m.meta.credits} />
          </section>
        ))}
        <section id="credits-app" aria-labelledby="h-app">
          <h2 id="h-app">글꼴 및 오픈소스 / Font and open-source software</h2>
          <CreditList credits={appCredits} />
        </section>
      </main>
    </div>
  );
};
