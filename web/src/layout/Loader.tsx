/**
 * The explicit "something is loading" element: a CSS spinner plus a label, announced politely via
 * role="status". Used by the shell's users gate, every page's first-load branch, and the lazy
 * route fallback — one look instead of a bare "loading…" text line.
 */
export function Loader({ label = 'loading…' }: { label?: string }) {
  return (
    <p className="loader" role="status">
      <span className="spinner" aria-hidden="true" />
      {label}
    </p>
  );
}
