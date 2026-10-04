/**
 * The only globals the SDK may use beyond ES2023: APIs every supported runtime
 * (Node, browsers, edge workers, React Native) provides. `tsconfig.build.json`
 * compiles `src` against this file instead of Node's types.
 */
declare class TextEncoder {
  encode(input?: string): Uint8Array<ArrayBuffer>;
}
declare class TextDecoder {
  decode(input?: Uint8Array): string;
}
