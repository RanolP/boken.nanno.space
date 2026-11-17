import type { MapData } from "../maps/types";

type Booth = MapData["booths"][number];

interface Props {
  booth: Booth;
  category?: { label: string; color: string };
  showsLogoCredit?: boolean;
  onClose: () => void;
}

export const Panel = ({ booth, category, showsLogoCredit, onClose }: Props) => {
  return (
    <aside className="panel" aria-label="부스 정보 / Booth details">
      <button className="close" onClick={onClose} aria-label="닫기 / Close">
        ×
      </button>
      <h2>{booth.code}</h2>
      <p className="cat">
        <span className="dot" style={{ background: category?.color }} />
        {category?.label ?? booth.category}
      </p>
      {booth.logo && (
        <figure className="booth-logo">
          <img
            src={booth.logo}
            alt={`${booth.exhibitor?.en ?? booth.exhibitor?.ko ?? booth.code} logo`}
          />
          {showsLogoCredit && <figcaption>로고 © 해당 참가사 / Logo © its owner</figcaption>}
        </figure>
      )}
      {booth.exhibitor ? (
        <>
          <p className="ko">{booth.exhibitor.ko}</p>
          {booth.exhibitor.en && <p className="en">{booth.exhibitor.en}</p>}
        </>
      ) : (
        <p className="en">참가사 정보 없음 / No exhibitor info</p>
      )}
    </aside>
  );
};
