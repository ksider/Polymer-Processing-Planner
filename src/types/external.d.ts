declare module "better-sqlite3";

declare module "jstat" {
  export const mean: (values: number[]) => number;
  export const stdev: (values: number[], flag?: boolean) => number;
  export const models: {
    ols: (y: number[], x: number[][]) => { coef: number[]; r2: number };
  };
  const jStat: {
    mean: typeof mean;
    stdev: typeof stdev;
    models: typeof models;
  };
  export default jStat;
}

declare module "papaparse" {
  export type ParseResult<T> = { data: T[] };
  export type ParseConfig<T> = {
    delimiter?: string;
    skipEmptyLines?: boolean;
  };
  export function parse<T>(input: string, config?: ParseConfig<T>): ParseResult<T>;
  const Papa: { parse: typeof parse };
  export default Papa;
}
