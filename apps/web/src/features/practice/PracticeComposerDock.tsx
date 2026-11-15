import { useEffect, useRef, type ReactNode } from "react";

export function PracticeComposerDock({
  actions,
  target,
  children,
  onHeight,
}: {
  actions?: ReactNode;
  target?: string;
  children: ReactNode;
  onHeight?: (height: number) => void;
}) {
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const node = ref.current;
    if (!node || !onHeight) return;
    const observer = new ResizeObserver((entries) => {
      onHeight(entries[0]?.contentRect.height ?? node.offsetHeight);
    });
    observer.observe(node);
    onHeight(node.offsetHeight);
    return () => observer.disconnect();
  }, [onHeight]);
  return (
    <div ref={ref} className="practice-dock">
      {target && <p className="practice-dock-target">{target}</p>}
      {actions}
      {children}
    </div>
  );
}
