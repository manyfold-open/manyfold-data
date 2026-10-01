// The slice of node:fs the stylesheet test uses (see node-sqlite.d.ts for why).
declare module 'node:fs' {
  export function readFileSync(path: URL, encoding: 'utf8'): string;
}
