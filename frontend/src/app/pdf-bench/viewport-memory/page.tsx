"use client";

import dynamic from "next/dynamic";
import { useSearchParams } from "next/navigation";
import { Suspense } from "react";

const PDFViewer = dynamic(
  () => import("@/components/pdfViewportMemory/PDFViewer"),
  { ssr: false, loading: () => <div>로딩 중...</div> }
);

function Content() {
  const searchParams = useSearchParams();
  const url = searchParams.get("url") ?? "/sample4.pdf";

  return <PDFViewer url={url} />;
}

export default function BenchViewportMemoryPage() {
  return (
    <Suspense fallback={<div>로딩 중...</div>}>
      <Content />
    </Suspense>
  );
}
