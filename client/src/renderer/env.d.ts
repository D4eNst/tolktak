declare module '*.css';
/** Set at build time, see build.mjs. */
declare const __DEFAULT_SERVER__: string;
declare module '*?text' {
  const text: string;
  export default text;
}
declare module '*?binary' {
  const bytes: Uint8Array;
  export default bytes;
}
