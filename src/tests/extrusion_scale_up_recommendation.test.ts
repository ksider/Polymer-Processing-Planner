import assert from "node:assert/strict";
import test from "node:test";
import { calculateExtrusionScaleUpRecommendation } from "../services/extrusion_scale_up_service.js";

const baseInput = {
  sourceScrewDiameterMm: 25,
  targetScrewDiameterMm: 50,
  sourceThroughputKgH: 10,
  sourceScrewSpeedRpm: 200,
  sourceFreeVolumeL: 0.25,
  targetFreeVolumeL: 2,
  sourceMeltDensityKgL: 1,
  targetMeltDensityKgL: 1,
  sourceBarrelTemperatureProfileC: "170, 180, 190",
  sourceMeltTemperatureC: 195,
  capacityExponent: 3
};

test("scale-up recommendation preserves D3 throughput and comparable fill", () => {
  const result = calculateExtrusionScaleUpRecommendation(baseInput);
  assert.equal(result.throughputKgH, 80);
  assert.equal(result.screwSpeedRpm, 200);
  assert.equal(result.residenceTimeS, 90);
  assert.equal(result.tipSpeedMs, 0.524);
  assert.deepEqual(result.barrelTemperatureProfileC, [170, 180, 190]);
  assert.equal(result.meltTemperatureC, 195);
  assert.equal(result.throughputMultiplierVsD3, 1);
  assert.equal(result.warnings.some((warning) => warning.includes("free volumes")), false);
});

test("scale-up recommendation respects a tip-speed cap and calculates residence from target free volume", () => {
  const result = calculateExtrusionScaleUpRecommendation({ ...baseInput, targetMaxTipSpeedMs: 0.4 });
  assert.equal(result.limits.tipSpeedLimited, true);
  assert.equal(result.screwSpeedRpm, 152.79);
  assert.equal(result.throughputKgH, 61.12);
  assert.equal(result.residenceTimeS, 117.81);
  assert.equal(result.warnings.some((warning) => warning.includes("Screw-speed limit")), true);
});

test("scale-up recommendation applies temperature bounds without using RTD as an input", () => {
  const result = calculateExtrusionScaleUpRecommendation({
    ...baseInput,
    temperatureOffsetC: 20,
    materialTemperatureMaxC: 200
  });
  assert.equal(result.throughputKgH, 80);
  assert.equal(result.screwSpeedRpm, 200);
  assert.equal(result.residenceTimeS, 90);
  assert.deepEqual(result.barrelTemperatureProfileC, [190, 200, 200]);
  assert.equal(result.meltTemperatureC, 200);
  assert.equal(result.warnings.some((warning) => warning.includes("clamped")), true);
});

test("scale-up recommendation calculates machine demand and reports configured overloads", () => {
  const result = calculateExtrusionScaleUpRecommendation({
    ...baseInput,
    sourceTorqueNm: 100,
    sourceNoLoadTorqueNm: 10,
    targetNominalPowerKw: 5,
    targetMaxTorqueNm: 200,
    targetNoLoadTorqueNm: 10,
    targetCenterDistanceCm: 4,
    targetTorqueDensityLimitNmCm3: 1,
    materialHeatCapacityKjKgC: 2,
    mechanicalToHeatFraction: 0.9
  });
  assert.equal(result.sourceSmeBasis, "measured_torque");
  assert.equal(result.sourceSmeKwhKg, 0.1885);
  assert.equal(result.requiredPowerKw, 15.08);
  assert.equal(result.requiredTorqueNm, 730);
  assert.equal(result.motorPowerLoadPct, 317.48);
  assert.equal(result.motorTorqueLoadPct, 365);
  assert.equal(result.errors.length, 3);
  assert.equal(result.isWithinConfiguredLimits, false);
  assert.equal(result.warnings.some((warning) => warning.includes("adiabatic")), true);
});
