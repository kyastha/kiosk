import { ChevronLeft, ChevronRight, ExternalLink } from 'lucide-react';
import { useEffect, useRef, useState } from 'react';
import { getDocument, GlobalWorkerOptions } from 'pdfjs-dist/legacy/build/pdf.mjs';
import workerUrl from 'pdfjs-dist/legacy/build/pdf.worker.mjs?url';
import { ErrorMessage, Loading } from './ui.jsx';

GlobalWorkerOptions.workerSrc = workerUrl;

export default function Preview({ url, pageCount }) {
  const [pdf, setPdf] = useState(null);
  const [page, setPage] = useState(1);
  const [drawing, setDrawing] = useState(true);
  const [error, setError] = useState('');
  const frame = useRef(null);

  useEffect(() => {
    let cancelled = false;
    const task = getDocument({ url, withCredentials: true, isEvalSupported: false, useWasm: false });
    task.promise
      .then((document) => {
        if (!cancelled) setPdf(document);
      })
      .catch(() => {
        if (!cancelled) {
          setDrawing(false);
          setError('The preview could not be shown here. Open the PDF to check it.');
        }
      });
    return () => {
      cancelled = true;
      task.destroy().catch(() => {});
    };
  }, [url]);

  useEffect(() => {
    if (!pdf) return;
    let cancelled = false;
    let render;
    setDrawing(true);
    setError('');
    async function draw() {
      const pdfPage = await pdf.getPage(page);
      if (cancelled) return;
      const original = pdfPage.getViewport({ scale: 1 });
      const viewport = pdfPage.getViewport({ scale: 1300 / Math.max(original.width, original.height) });
      const canvas = window.document.createElement('canvas');
      canvas.width = Math.ceil(viewport.width);
      canvas.height = Math.ceil(viewport.height);
      canvas.setAttribute('role', 'img');
      canvas.setAttribute('aria-label', 'Preview of page ' + page);
      render = pdfPage.render({ canvasContext: canvas.getContext('2d'), viewport });
      await render.promise;
      if (!cancelled) {
        frame.current?.replaceChildren(canvas);
        setDrawing(false);
      }
    }
    draw().catch(() => {
      if (!cancelled) {
        setDrawing(false);
        setError('The preview could not be shown here. Open the PDF to check it.');
      }
    });
    return () => {
      cancelled = true;
      render?.cancel();
    };
  }, [page, pdf]);

  return (
    <>
      <div className="preview-frame" aria-busy={drawing}>
        {drawing && <Loading>Rendering page…</Loading>}
        <div className={drawing || error ? 'preview-canvas visually-hidden' : 'preview-canvas'} ref={frame} />
        <ErrorMessage message={error} />
      </div>
      <div className="preview-tools">
        <div className="preview-nav" aria-label="Preview pages">
          <button
            className="icon-button"
            type="button"
            aria-label="Previous page"
            disabled={page <= 1 || drawing}
            onClick={() => setPage(page - 1)}
          >
            <ChevronLeft size={19} />
          </button>
          <span aria-live="polite">
            {page} / {pageCount}
          </span>
          <button
            className="icon-button"
            type="button"
            aria-label="Next page"
            disabled={page >= pageCount || drawing || !!error}
            onClick={() => setPage(page + 1)}
          >
            <ChevronRight size={19} />
          </button>
        </div>
        <a className="text-button" href={url} target="_blank" rel="noreferrer">
          Open PDF <ExternalLink size={15} aria-hidden="true" />
        </a>
      </div>
    </>
  );
}
