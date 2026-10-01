/**
 * The Manyfold Data mark: a 5 × 5 grid of data cells. The filled cells spell M and the
 * center cell is the one blue. public/favicon.svg draws the same grid.
 */

const M = ['10001', '11011', '10101', '10001', '10001'];
const PITCH = 4.6;
const CELL = 3.8;

export function LogoMark({ size = 20 }: { size?: number }) {
  return (
    <svg className="logo-mark" width={size} height={size} viewBox="0 0 22.2 22.2" aria-hidden="true" focusable="false">
      {M.flatMap((row, y) =>
        [...row].map((cell, x) => (
          <rect
            key={`${x}-${y}`}
            className={cell === '0' ? 'e' : x === 2 && y === 2 ? 'a' : 'k'}
            x={x * PITCH}
            y={y * PITCH}
            width={CELL}
            height={CELL}
            rx="1"
          />
        )),
      )}
    </svg>
  );
}

/** Mark and wordmark: "Manyfold" with "Data" in muted gray. */
export function Logo() {
  return (
    <>
      <LogoMark />
      <span className="wordmark">
        Manyfold <span>Data</span>
      </span>
    </>
  );
}
