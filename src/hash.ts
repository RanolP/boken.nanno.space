import { useEffect, useState } from "react";

const read = () => window.location.hash.replace(/^#\/?/, "");

/** Current map id from the URL hash (#/agf-2026). */
export const useHashId = (): string => {
  const [id, setId] = useState(read);
  useEffect(() => {
    const on = () => setId(read());
    window.addEventListener("hashchange", on);
    return () => window.removeEventListener("hashchange", on);
  }, []);
  return id;
};
