import type { ReactNode } from "react";

export function MobileStudyShell({
  header,
  progress,
  children,
  dock,
}: {
  header: ReactNode;
  progress?: ReactNode;
  children: ReactNode;
  dock: ReactNode;
}) {
  return (
    <div className="mobile-study-shell">
      <header className="mobile-study-header">{header}</header>
      {progress}
      <div className="mobile-study-scroll">{children}</div>
      <div className="mobile-study-dock">{dock}</div>
    </div>
  );
}
