import { lazy, Suspense } from "react";
const Renderer = lazy(() => import("./MarkdownRenderer"));
export function Markdown({ children }: { children: string }) {
  return (
    <Suspense
      fallback={
        <div className="markdown" style={{ whiteSpace: "pre-wrap" }}>
          {children}
        </div>
      }
    >
      <Renderer>{children}</Renderer>
    </Suspense>
  );
}
