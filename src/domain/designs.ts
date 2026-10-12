import { seededShuffle } from "../lib/rng.js";

export type FactorConfig = {
  paramDefId: number;
  code: string;
  label: string;
  mode: "FIXED" | "RANGE" | "LIST";
  rangeMin?: number | null;
  rangeMax?: number | null;
  list?: number[] | null;
  levelCount?: number | null;
  fixedValue?: number | null;
};

export type DesignRun = {
  values: Record<number, number>;
  coded?: Record<number, number>;
};

function interleaveCenters<T>(runs: T[], centers: T[]): T[] {
  if (centers.length === 0) return runs.slice();
  const result: T[] = [];
  let runIndex = 0;
  for (let i = 0; i < centers.length; i += 1) {
    const remainingCenters = centers.length - i;
    const remainingRuns = runs.length - runIndex;
    const take = Math.floor(remainingRuns / (remainingCenters + 1));
    for (let j = 0; j < take; j += 1) {
      result.push(runs[runIndex]);
      runIndex += 1;
    }
    result.push(centers[i]);
  }
  while (runIndex < runs.length) {
    result.push(runs[runIndex]);
    runIndex += 1;
  }
  return result;
}

function cartesian<T>(sets: T[][]): T[][] {
  if (!sets.length) return [[]];
  return sets.reduce<T[][]>((acc, set) => {
    const next: T[][] = [];
    for (const prefix of acc) {
      for (const item of set) {
        next.push([...prefix, item]);
      }
    }
    return next;
  }, [[]]);
}

function levelsFromConfig(config: FactorConfig): number[] {
  if (config.mode === "LIST") {
    return (config.list ?? []).filter((val) => Number.isFinite(val));
  }
  if (config.mode === "RANGE") {
    const min = config.rangeMin;
    const max = config.rangeMax;
    if (min == null || max == null) return [];
    if (config.levelCount === 3) {
      return [min, (min + max) / 2, max];
    }
    return [min, max];
  }
  if (config.fixedValue != null) return [config.fixedValue];
  return [];
}

export function buildSimDesign(factors: FactorConfig[], seed: number, maxRuns: number): DesignRun[] {
  const usable = factors.filter((factor) => levelsFromConfig(factor).length > 0);
  const sets = usable.map((factor) => levelsFromConfig(factor));
  const combos = cartesian(sets);
  const runs = combos.slice(0, maxRuns).map((combo) => {
    const values: Record<number, number> = {};
    usable.forEach((factor, idx) => {
      values[factor.paramDefId] = combo[idx];
    });
    return { values };
  });
  return seededShuffle(runs, seed);
}

export function buildFfaDesign(factors: FactorConfig[], seed: number, maxRuns: number): DesignRun[] {
  const sets = factors.map((factor) => levelsFromConfig(factor));
  const combos = cartesian(sets);
  const runs = combos.slice(0, maxRuns).map((combo) => {
    const values: Record<number, number> = {};
    factors.forEach((factor, idx) => {
      values[factor.paramDefId] = combo[idx];
    });
    return { values };
  });
  return seededShuffle(runs, seed);
}

export function buildBbdDesign(
  factors: FactorConfig[],
  seed: number,
  centerPoints: number
): { runs: DesignRun[]; codedLevels: Array<Record<number, number>> } {
  const usable = factors.filter((factor) => levelsFromConfig(factor).length === 3);
  const levelMap = new Map<number, number[]>();
  usable.forEach((factor) => {
    levelMap.set(factor.paramDefId, levelsFromConfig(factor));
  });

  const codedRuns: Array<Record<number, number>> = [];
  for (let i = 0; i < usable.length; i += 1) {
    for (let j = i + 1; j < usable.length; j += 1) {
      const base: Record<number, number> = {};
      usable.forEach((factor) => {
        base[factor.paramDefId] = 0;
      });
      const idA = usable[i].paramDefId;
      const idB = usable[j].paramDefId;
      const pairs: Array<[number, number]> = [
        [-1, -1],
        [-1, 1],
        [1, -1],
        [1, 1]
      ];
      for (const [a, b] of pairs) {
        const coded = { ...base };
        coded[idA] = a;
        coded[idB] = b;
        codedRuns.push(coded);
      }
    }
  }
  for (let c = 0; c < centerPoints; c += 1) {
    const coded: Record<number, number> = {};
    usable.forEach((factor) => {
      coded[factor.paramDefId] = 0;
    });
    codedRuns.push(coded);
  }

  const isCenter = (coded: Record<number, number>) =>
    usable.every((factor) => coded[factor.paramDefId] === 0);
  const centers = codedRuns.filter(isCenter);
  const nonCenters = codedRuns.filter((coded) => !isCenter(coded));
  const shuffledNonCenters = seededShuffle(nonCenters, seed);
  const shuffled = interleaveCenters(shuffledNonCenters, centers);
  const runs = shuffled.map((coded) => {
    const values: Record<number, number> = {};
    for (const factor of usable) {
      const levels = levelMap.get(factor.paramDefId) ?? [];
      const codedValue = coded[factor.paramDefId];
      const index = codedValue === -1 ? 0 : codedValue === 1 ? 2 : 1;
      values[factor.paramDefId] = levels[index];
    }
    return { values, coded };
  });
  return { runs, codedLevels: shuffled };
}

/** Face-centred central composite design: 2^k factorial + 2k axial + centres. */
export function buildCcdDesign(
  factors: FactorConfig[],
  seed: number,
  centerPoints: number
): { runs: DesignRun[]; codedLevels: Array<Record<number, number>> } {
  const usable = factors.filter((factor) => levelsFromConfig(factor).length === 3);
  const levelMap = new Map(usable.map((factor) => [factor.paramDefId, levelsFromConfig(factor)]));
  const codedRuns: Array<Record<number, number>> = [];
  for (const signs of cartesian(usable.map(() => [-1, 1]))) {
    const coded: Record<number, number> = {};
    usable.forEach((factor, index) => { coded[factor.paramDefId] = signs[index]; });
    codedRuns.push(coded);
  }
  usable.forEach((factor) => {
    for (const sign of [-1, 1]) {
      const coded: Record<number, number> = {};
      usable.forEach((other) => { coded[other.paramDefId] = other.paramDefId === factor.paramDefId ? sign : 0; });
      codedRuns.push(coded);
    }
  });
  for (let index = 0; index < centerPoints; index += 1) {
    const coded: Record<number, number> = {};
    usable.forEach((factor) => { coded[factor.paramDefId] = 0; });
    codedRuns.push(coded);
  }
  const centres = codedRuns.filter((coded) => usable.every((factor) => coded[factor.paramDefId] === 0));
  const nonCentres = codedRuns.filter((coded) => !usable.every((factor) => coded[factor.paramDefId] === 0));
  const shuffled = interleaveCenters(seededShuffle(nonCentres, seed), centres);
  const runs = shuffled.map((coded) => {
    const values: Record<number, number> = {};
    usable.forEach((factor) => {
      const levels = levelMap.get(factor.paramDefId) ?? [];
      values[factor.paramDefId] = levels[coded[factor.paramDefId] === -1 ? 0 : coded[factor.paramDefId] === 1 ? 2 : 1];
    });
    return { values, coded };
  });
  return { runs, codedLevels: shuffled };
}

export function buildScreenDesign(
  factors: FactorConfig[],
  seed: number,
  maxRuns: number
): DesignRun[] {
  const sets = factors.map((factor) => {
    const levels = levelsFromConfig(factor);
    return levels.slice(0, 2);
  });
  const combos = cartesian(sets);
  const shuffled = seededShuffle(combos, seed);
  const sampled = shuffled.slice(0, Math.min(maxRuns, combos.length));
  return sampled.map((combo) => {
    const values: Record<number, number> = {};
    factors.forEach((factor, idx) => {
      values[factor.paramDefId] = combo[idx];
    });
    return { values };
  });
}
