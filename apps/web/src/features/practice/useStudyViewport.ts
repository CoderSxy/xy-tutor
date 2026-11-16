import { useEffect, useState } from "react";

export type StudyViewport = {
  width: number;
  height: number;
  keyboardInset: number;
  phone: boolean;
  pad: boolean;
  desktop: boolean;
};

export function useStudyViewport(): StudyViewport {
  const read = () => {
    const visual = window.visualViewport;
    const width = visual?.width ?? window.innerWidth;
    const height = visual?.height ?? window.innerHeight;
    const keyboardInset = Math.max(
      0,
      window.innerHeight - height - (visual?.offsetTop ?? 0),
    );
    return {
      width,
      height,
      keyboardInset,
      phone: width < 768,
      pad: width >= 768 && width < 1200,
      desktop: width >= 1200,
    };
  };
  const [viewport, setViewport] = useState<StudyViewport>(read);
  useEffect(() => {
    const update = () => setViewport(read());
    window.addEventListener("resize", update);
    window.visualViewport?.addEventListener("resize", update);
    window.visualViewport?.addEventListener("scroll", update);
    return () => {
      window.removeEventListener("resize", update);
      window.visualViewport?.removeEventListener("resize", update);
      window.visualViewport?.removeEventListener("scroll", update);
    };
  }, []);
  return viewport;
}
