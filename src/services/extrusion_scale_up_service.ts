export type ExtrusionScaleUpInput = {
  sourceScrewDiameterMm: number;
  targetScrewDiameterMm: number;
  sourceThroughputKgH: number;
  sourceScrewSpeedRpm: number;
  sourceBarrelTemperatureProfileC?: string | null;
  sourceMeltTemperatureC?: number | null;
  capacityExponent?: number | null;
  sourceFreeVolumeL?: number | null;
  targetFreeVolumeL?: number | null;
  sourceMeltDensityKgL?: number | null;
  targetMeltDensityKgL?: number | null;
  sourceLengthToDiameter?: number | null;
  targetLengthToDiameter?: number | null;
  sourceScrewConfiguration?: string | null;
  targetScrewConfiguration?: string | null;
  sourceSmeKwhKg?: number | null;
  sourceTorqueNm?: number | null;
  sourceNoLoadTorqueNm?: number | null;
  targetNominalPowerKw?: number | null;
  targetMaxTorqueNm?: number | null;
  targetNoLoadTorqueNm?: number | null;
  targetMechanicalEfficiency?: number | null;
  targetCenterDistanceCm?: number | null;
  targetTorqueDensityLimitNmCm3?: number | null;
  materialHeatCapacityKjKgC?: number | null;
  mechanicalToHeatFraction?: number | null;
  targetMaxScrewSpeedRpm?: number | null;
  targetMaxTipSpeedMs?: number | null;
  temperatureOffsetC?: number | null;
  materialTemperatureMinC?: number | null;
  materialTemperatureMaxC?: number | null;
};

export type ExtrusionScaleUpRecommendation = {
  throughputKgH: number;
  screwSpeedRpm: number;
  residenceTimeS: number | null;
  tipSpeedMs: number;
  meltTemperatureC: number | null;
  barrelTemperatureProfileC: number[];
  d3ThroughputTargetKgH: number;
  throughputMultiplierVsD3: number;
  capacityExponent: number;
  sourceSmeKwhKg: number | null;
  sourceSmeBasis: "measured_torque" | "entered_target" | null;
  requiredPowerKw: number | null;
  requiredTorqueNm: number | null;
  motorPowerLoadPct: number | null;
  motorTorqueLoadPct: number | null;
  torqueDensityNmCm3: number | null;
  adiabaticTemperatureRiseC: number | null;
  assumptions: string[];
  warnings: string[];
  errors: string[];
  isWithinConfiguredLimits: boolean;
  limits: { rpmLimited: boolean; tipSpeedLimited: boolean };
};

const round = (value: number, digits = 2) => Number(value.toFixed(digits));
const positive = (value: number | null | undefined) => Number.isFinite(value) && Number(value) > 0;

function parseProfile(value: string | null | undefined) {
  return String(value || "")
    .split(/[;,\s]+/)
    .filter((item) => item.trim() !== "")
    .map((item) => Number(item.replace(",", ".")))
    .filter((item) => Number.isFinite(item));
}

function withinRange(value: number, min: number | null | undefined, max: number | null | undefined) {
  let result = value;
  if (positive(min)) result = Math.max(Number(min), result);
  if (positive(max)) result = Math.min(Number(max), result);
  return result;
}

export function calculateExtrusionScaleUpRecommendation(input: ExtrusionScaleUpInput): ExtrusionScaleUpRecommendation {
  const required: Array<[string, number]> = [
    ["source screw diameter", input.sourceScrewDiameterMm],
    ["production screw diameter", input.targetScrewDiameterMm],
    ["source throughput", input.sourceThroughputKgH],
    ["source screw speed", input.sourceScrewSpeedRpm]
  ];
  const missing = required.find(([, value]) => !positive(value));
  if (missing) throw new Error(`Enter a positive ${missing[0]}`);

  const warnings: string[] = [];
  const errors: string[] = [];
  const assumptions: string[] = [];
  if (positive(input.materialTemperatureMinC) && positive(input.materialTemperatureMaxC) && Number(input.materialTemperatureMinC) > Number(input.materialTemperatureMaxC)) {
    throw new Error("Material temperature minimum cannot exceed the maximum");
  }
  const diameterRatio = input.targetScrewDiameterMm / input.sourceScrewDiameterMm;
  const exponent = positive(input.capacityExponent) ? Number(input.capacityExponent) : 3;
  if (exponent < 2.8 || exponent > 3) throw new Error("Capacity exponent must be between 2.8 and 3.0");

  const hasComparableFreeVolumes = positive(input.sourceFreeVolumeL) && positive(input.targetFreeVolumeL);
  const geometricVolumeRatio = hasComparableFreeVolumes
    ? Number(input.targetFreeVolumeL) / Number(input.sourceFreeVolumeL)
    : Math.pow(diameterRatio, 3);
  const capacityRatio = Math.pow(diameterRatio, exponent);
  if (hasComparableFreeVolumes) assumptions.push("Target and source free volumes are used to preserve comparable fill at the recommended screw speed.");
  else warnings.push("Comparable source and production free volumes are not entered; screw speed uses screw-diameter geometry as an estimate.");

  const hasDensities = positive(input.sourceMeltDensityKgL) && positive(input.targetMeltDensityKgL);
  const densityRatio = hasDensities ? Number(input.targetMeltDensityKgL) / Number(input.sourceMeltDensityKgL) : 1;
  if (!hasDensities) warnings.push("Melt-density correction is not applied; source and production density are assumed equal.");
  if (positive(input.sourceLengthToDiameter) && positive(input.targetLengthToDiameter) && Math.abs(Number(input.sourceLengthToDiameter) - Number(input.targetLengthToDiameter)) > 0.1) {
    warnings.push("Source and production L/D differ; confirm that the process zones remain geometrically comparable.");
  }
  if (input.sourceScrewConfiguration?.trim() && input.targetScrewConfiguration?.trim() && input.sourceScrewConfiguration.trim().toLowerCase() !== input.targetScrewConfiguration.trim().toLowerCase()) {
    warnings.push("Source and production screw-configuration notes differ; review mixing and conveying elements before transfer.");
  }

  const requestedThroughput = input.sourceThroughputKgH * capacityRatio * densityRatio;
  const candidateRpm = input.sourceScrewSpeedRpm
    * (requestedThroughput / input.sourceThroughputKgH)
    / densityRatio
    / geometricVolumeRatio;
  let screwSpeedRpm = candidateRpm;
  let rpmLimited = false;
  let tipSpeedLimited = false;

  if (positive(input.targetMaxScrewSpeedRpm) && screwSpeedRpm > Number(input.targetMaxScrewSpeedRpm)) {
    screwSpeedRpm = Number(input.targetMaxScrewSpeedRpm);
    rpmLimited = true;
  }
  if (positive(input.targetMaxTipSpeedMs)) {
    const rpmAtTipLimit = Number(input.targetMaxTipSpeedMs) * 60_000 / (Math.PI * input.targetScrewDiameterMm);
    if (screwSpeedRpm > rpmAtTipLimit) {
      screwSpeedRpm = rpmAtTipLimit;
      tipSpeedLimited = true;
    }
  }

  const wasLimited = screwSpeedRpm < candidateRpm;
  const throughputKgH = wasLimited
    ? input.sourceThroughputKgH * (screwSpeedRpm / input.sourceScrewSpeedRpm) * densityRatio * geometricVolumeRatio
    : requestedThroughput;
  const residenceTimeS = positive(input.targetFreeVolumeL) && positive(input.targetMeltDensityKgL)
    ? Number(input.targetFreeVolumeL) * Number(input.targetMeltDensityKgL) / throughputKgH * 3600
    : null;
  if (residenceTimeS == null) warnings.push("Enter production free volume and melt density to estimate residence time.");
  if (wasLimited) warnings.push("Screw-speed limit reduces the initial throughput.");

  const offset = Number(input.temperatureOffsetC || 0);
  const profile = parseProfile(input.sourceBarrelTemperatureProfileC);
  const adjustedProfile = profile.map((temperature) => withinRange(temperature + offset, input.materialTemperatureMinC, input.materialTemperatureMaxC));
  if (!profile.length) warnings.push("No barrel-temperature profile is entered; set the production zones before the first trial.");
  if (profile.some((temperature, index) => temperature + offset !== adjustedProfile[index])) warnings.push("One or more barrel-temperature recommendations were clamped to the material range.");
  const meltTemperatureC = positive(input.sourceMeltTemperatureC)
    ? withinRange(Number(input.sourceMeltTemperatureC) + offset, input.materialTemperatureMinC, input.materialTemperatureMaxC)
    : null;
  if (meltTemperatureC != null && positive(input.sourceMeltTemperatureC) && meltTemperatureC !== Number(input.sourceMeltTemperatureC) + offset) warnings.push("The melt-temperature recommendation was clamped to the material range.");

  const d3ThroughputTargetKgH = input.sourceThroughputKgH * Math.pow(diameterRatio, 3);
  const sourceSmeFromTorque = positive(input.sourceTorqueNm) && Number(input.sourceTorqueNm) > Number(input.sourceNoLoadTorqueNm || 0)
    ? input.sourceScrewSpeedRpm * (Number(input.sourceTorqueNm) - Number(input.sourceNoLoadTorqueNm || 0)) / (9549 * input.sourceThroughputKgH)
    : null;
  const sourceSmeKwhKg = sourceSmeFromTorque ?? (positive(input.sourceSmeKwhKg) ? Number(input.sourceSmeKwhKg) : null);
  const sourceSmeBasis = sourceSmeFromTorque != null ? "measured_torque" as const : sourceSmeKwhKg != null ? "entered_target" as const : null;
  if (sourceSmeKwhKg == null) warnings.push("Source SME is not available; power, torque and dissipation checks cannot yet be calculated.");
  else if (sourceSmeBasis === "entered_target") warnings.push("Power and torque checks use the entered source SME target; replace it with measured source torque when available.");

  const requiredPowerKw = sourceSmeKwhKg == null ? null : sourceSmeKwhKg * throughputKgH;
  const targetNoLoadTorqueNm = positive(input.targetNoLoadTorqueNm)
    ? Number(input.targetNoLoadTorqueNm)
    : positive(input.targetMaxTorqueNm) ? Number(input.targetMaxTorqueNm) * 0.05 : 0;
  const requiredTorqueNm = requiredPowerKw == null ? null : 9549 * requiredPowerKw / screwSpeedRpm + targetNoLoadTorqueNm;
  const mechanicalEfficiency = positive(input.targetMechanicalEfficiency) ? Number(input.targetMechanicalEfficiency) : 0.95;
  const motorPowerLoadPct = requiredPowerKw != null && positive(input.targetNominalPowerKw)
    ? requiredPowerKw / (Number(input.targetNominalPowerKw) * mechanicalEfficiency) * 100
    : null;
  const motorTorqueLoadPct = requiredTorqueNm != null && positive(input.targetMaxTorqueNm)
    ? requiredTorqueNm / Number(input.targetMaxTorqueNm) * 100
    : null;
  const torqueDensityNmCm3 = requiredTorqueNm != null && positive(input.targetCenterDistanceCm)
    ? (requiredTorqueNm - targetNoLoadTorqueNm) / (2 * Math.pow(Number(input.targetCenterDistanceCm), 3))
    : null;
  const heatCapacity = positive(input.materialHeatCapacityKjKgC) ? Number(input.materialHeatCapacityKjKgC) : 2.1;
  const heatFraction = positive(input.mechanicalToHeatFraction) ? Number(input.mechanicalToHeatFraction) : 0.9;
  const adiabaticTemperatureRiseC = sourceSmeKwhKg == null ? null : sourceSmeKwhKg * 3600 * heatFraction / heatCapacity;
  if (motorPowerLoadPct != null && motorPowerLoadPct > 95) errors.push("Required mechanical power exceeds 95% of the configured production motor capacity.");
  if (motorTorqueLoadPct != null && motorTorqueLoadPct > 90) errors.push("Required shaft torque exceeds 90% of the configured production torque limit.");
  if (torqueDensityNmCm3 != null && positive(input.targetTorqueDensityLimitNmCm3) && torqueDensityNmCm3 > Number(input.targetTorqueDensityLimitNmCm3)) errors.push("Required torque density exceeds the configured shaft-load limit.");
  if (adiabaticTemperatureRiseC != null && adiabaticTemperatureRiseC > 35) warnings.push("The adiabatic dissipation estimate is above 35 °C; confirm barrel cooling and measured melt temperature.");
  return {
    throughputKgH: round(throughputKgH),
    screwSpeedRpm: round(screwSpeedRpm),
    residenceTimeS: residenceTimeS == null ? null : round(residenceTimeS),
    tipSpeedMs: round(Math.PI * (input.targetScrewDiameterMm / 1000) * screwSpeedRpm / 60, 3),
    meltTemperatureC: meltTemperatureC == null ? null : round(meltTemperatureC),
    barrelTemperatureProfileC: adjustedProfile.map((temperature) => round(temperature)),
    d3ThroughputTargetKgH: round(d3ThroughputTargetKgH),
    throughputMultiplierVsD3: round(throughputKgH / d3ThroughputTargetKgH, 3),
    capacityExponent: exponent,
    sourceSmeKwhKg: sourceSmeKwhKg == null ? null : round(sourceSmeKwhKg, 4),
    sourceSmeBasis,
    requiredPowerKw: requiredPowerKw == null ? null : round(requiredPowerKw),
    requiredTorqueNm: requiredTorqueNm == null ? null : round(requiredTorqueNm),
    motorPowerLoadPct: motorPowerLoadPct == null ? null : round(motorPowerLoadPct),
    motorTorqueLoadPct: motorTorqueLoadPct == null ? null : round(motorTorqueLoadPct),
    torqueDensityNmCm3: torqueDensityNmCm3 == null ? null : round(torqueDensityNmCm3),
    adiabaticTemperatureRiseC: adiabaticTemperatureRiseC == null ? null : round(adiabaticTemperatureRiseC),
    assumptions,
    warnings,
    errors,
    isWithinConfiguredLimits: errors.length === 0,
    limits: { rpmLimited, tipSpeedLimited }
  };
}
