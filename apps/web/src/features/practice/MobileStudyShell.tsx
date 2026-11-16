import type { ReactNode } from "react";

export function MobileStudyShell({
  header,
  progress,
  children,
  dock,
  keyboardInset = 0,
}: {
  header: ReactNode;
  progress?: ReactNode;
  children: ReactNode;
  dock: ReactNode;
  keyboardInset?: number;
}) {
  return (
    <div
      className="mobile-study-shell"
      style={{ paddingBottom: keyboardInset }}
    >
      <header className="mobile-study-header">{header}</header>
      {progress}
      <div className="mobile-study-scroll">{children}</div>
      <div className="mobile-study-dock">{dock}</div>
    </div>
  );
}
