/**
 * The only globals the SDK may use beyond ES2023: APIs every supported runtime
 * (Node, browsers, edge workers, React Native) provides. `tsconfig.build.json`
 * compiles `src` against this file instead of Node's types.
 */
declare class TextEncoder {
  encode(input?: string): Uint8Array<ArrayBuffer>;
}
declare class TextDecoder {
  constructor(label?: string, options?: { fatal?: boolean });
  decode(input?: Uint8Array): string;
}
declare class URL {
  constructor(input: string, base?: string);
  readonly protocol: string;
  readonly username: string;
  readonly password: string;
  readonly hash: string;
  pathname: string;
  readonly search: string;
  toString(): string;
}
interface AbortSignal {
  readonly aborted: boolean;
  readonly reason: unknown;
  throwIfAborted(): void;
  addEventListener(
    type: "abort",
    listener: () => void,
    options?: { once?: boolean },
  ): void;
  removeEventListener(type: "abort", listener: () => void): void;
}
declare function setTimeout(callback: () => void, delayMs: number): unknown;
declare function clearTimeout(timer: unknown): void;
declare function atob(input: string): string;
declare function btoa(input: string): string;
