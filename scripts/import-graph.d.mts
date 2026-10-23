export function importsOf(code: string): { static: string[]; dynamic: string[]; urls: string[] };
export function modulesIn(code: string): string[];
export function filesReachableFrom(
  distDirectory: string | URL,
  entry: string,
  options?: { throughDynamicImports?: boolean },
): string[];
export function engineReachability(
  distDirectory: string | URL,
  engine: string,
  entry?: string,
): { staticallyImportedBy: string[]; isReached: boolean };
export function assertEngineLoadsLazily(distDirectory: string | URL, engine: string, entry?: string): void;
