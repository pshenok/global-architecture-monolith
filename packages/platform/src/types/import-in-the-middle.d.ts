// import-in-the-middle ships register-hooks.d.ts but no .d.mts, which TS reports as
// TS7016 under module nodenext. Minimal ambient declaration of what we use.
declare module 'import-in-the-middle/register-hooks.mjs' {
  export function register(options?: {
    include?: Array<string | RegExp>;
    exclude?: Array<string | RegExp>;
  }): void;
}
