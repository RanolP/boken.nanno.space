import { useEffect, useMemo, useState } from "react";
import { findMap, maps, type MapEntry } from "./maps";
import { useHashId } from "./hash";
import { CreditsPage } from "./credits/Credits";
import { Scene } from "./venue-view/Scene";
import { Panel } from "./booth-finder/Panel";
import { Search } from "./booth-finder/Search";
import { Legend } from "./booth-finder/Legend";
import { DebugHud } from "./venue-view/DebugInspector";
import { BoothProbe, MovePad, RoadHud, ViewToggle } from "./venue-view/ViewControls";
import { isTypingTarget, useMoveKeys, type MoveInput, type ViewMode } from "./venue-view/walk";

export const App = () => {
  const hashId = useHashId();
  const [route, section] = hashId.split("/");
  const isCredits = route === "credits";
  const entry = findMap(hashId) ?? maps[0];
  useEffect(() => {
    if (!isCredits && !findMap(hashId)) window.location.replace(`#/${entry.id}`);
  }, [hashId, entry.id, isCredits]);
  if (isCredits) return <CreditsPage section={section} />;
  return <MapView key={entry.id} entry={entry} />;
};

interface MapViewProps {
  entry: MapEntry;
}

const MapView = ({ entry }: MapViewProps) => {
  const { data, meta } = entry;
  const [selected, setSelected] = useState<string | null>(null);
  const [hidden, setHidden] = useState<Set<string>>(new Set());
  const [flyKey, setFlyKey] = useState(0);
  const [view, setView] = useState<ViewMode>("road");
  const [input] = useState<MoveInput>(() => new Set());
  useMoveKeys(input);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.code !== "KeyV" || e.repeat || e.ctrlKey || e.metaKey || e.altKey || isTypingTarget(e.target)) return;
      setView((v) => (v === "drone" ? "road" : "drone"));
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, []);

  const visible = useMemo(
    () => data.booths.filter((b) => !hidden.has(b.category)),
    [data.booths, hidden],
  );
  const selectedBooth = data.booths.find((b) => b.code === selected) ?? null;
  // The card stays mounted after a close until its exit animation (the entrance played in reverse) ends.
  const [shownCode, setShownCode] = useState<string | null>(selected);
  useEffect(() => {
    if (selected !== null) setShownCode(selected);
  }, [selected]);
  const shownBooth = selectedBooth ?? data.booths.find((b) => b.code === shownCode) ?? null;
  const closing = selectedBooth === null && shownBooth !== null;

  const toggle = (cat: string) =>
    setHidden((h) => {
      const n = new Set(h);
      if (n.has(cat)) n.delete(cat);
      else n.add(cat);
      return n;
    });

  return (
    <div className="app">
      <header className="header">
        <img className="logo" src={meta.logo} alt={`${data.title} logo`} />
        <div className="title">
          <h1>Boken</h1>
          <p>
            {data.title} · {data.venue} · {data.dates[0]}
            {data.dates.length > 1 ? ` ~ ${data.dates[data.dates.length - 1].slice(5)}` : ""}
          </p>
        </div>
      </header>
      <main className="main">
        <Scene
          data={data}
          booths={visible}
          selected={selected}
          flyKey={flyKey}
          view={view}
          input={input}
          onSelect={setSelected}
        />
        <div className="overlay">
          <Search
            booths={data.booths}
            onPick={(code) => {
              const booth = data.booths.find((b) => b.code === code);
              if (booth) {
                setHidden((h) => {
                  if (!h.has(booth.category)) return h;
                  const n = new Set(h);
                  n.delete(booth.category);
                  return n;
                });
              }
              setSelected(code);
              setFlyKey((k) => k + 1);
            }}
          />
          <Legend categories={data.categories} hidden={hidden} onToggle={toggle} />
          <ViewToggle view={view} onChange={setView} />
        </div>
        {view === "road" && <MovePad input={input} />}
        {view === "road" && <DebugHud />}
        {view === "road" && <RoadHud panelOpen={selectedBooth !== null} />}
        {view === "road" && <BoothProbe data={data} />}
        {view === "road" && shownBooth && <div className={closing ? "panel-dim closing" : "panel-dim"} aria-hidden />}
        {shownBooth && (
          <Panel
            key={shownBooth.code}
            booth={shownBooth}
            closing={closing}
            onClosed={() => setShownCode(null)}
            category={data.categories[shownBooth.category]}
            showsLogoCredit={meta.showsExhibitorLogos}
            onClose={() => setSelected(null)}
          />
        )}
      </main>
      <footer className="footer">
        Boken은 비공식 팬 프로젝트입니다 / Unofficial fan project. ·{" "}
        <a href={`#/credits/${entry.id}`}>출처 및 저작권 / Credits</a>
      </footer>
    </div>
  );
};
