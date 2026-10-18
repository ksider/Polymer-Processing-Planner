export type QualificationArtifactFeature = {
  code: string;
  label: string;
  category: string;
  nominal_size_um: number;
  measurement: string;
  /** A short, human-readable location on the fixed physical artifact. */
  location: string;
  /** Practical observation method from the NIST inspection guidance. */
  inspection_hint: string;
  /** Zone used by the lightweight artifact map in Step 4. */
  map_zone: "fine" | "xy" | "lateral" | "baseline";
  /** Which calculated Step 4 result may use this observation. */
  analysis_role: "resolution" | "xy_boundary" | "scale_reference";
};

export type QualificationArtifactPreset = {
  code: string;
  name: string;
  description: string;
  source_url: string;
  /** Official NIST archives. Kept external so the study always points to the source release. */
  model_downloads: Array<{
    format: "STL" | "AMF" | "STEP";
    url: string;
    description: string;
  }>;
  publication_url: string;
  engineering_drawing_url: string;
  inspection_sheet_url: string;
  nominal_geometry: Array<{ label: string; value: string }>;
  features: QualificationArtifactFeature[];
};

/**
 * NIST distributes one AM Test Artifact in several file formats (STL, AMF,
 * STEP, drawing and inspection workbook).  The entries below are nominal
 * dimensions from its public inspection workbook; the downloadable drawing
 * remains the authoritative GD&T reference.
 */
export const nistAmTestArtifactPreset: QualificationArtifactPreset = {
  code: "nist_am_test_artifact",
  name: "NIST AM Test Artifact",
  description: "Fixed official NIST dimensional test artifact with positive/negative fine features, pins, holes, staircases and reference geometry.",
  source_url: "https://www.nist.gov/el/intelligent-systems-division-73500/production-systems-group/nist-additive-manufacturing-test",
  model_downloads: [
    { format: "STL", url: "https://www.nist.gov/document/nist-test-artifact-stlzip", description: "Triangulated model for slicing and printing" },
    { format: "AMF", url: "https://www.nist.gov/document/nist-test-artifact-amfzip", description: "Additive Manufacturing File model" },
    { format: "STEP", url: "https://www.nist.gov/document/nisttestartifactver3bzip", description: "CAD exchange model" }
  ],
  publication_url: "https://doi.org/10.6028/jres.119.017",
  engineering_drawing_url: "https://www.nist.gov/document/engineeringdrawingpdf",
  inspection_sheet_url: "https://www.nist.gov/document/test-artifact-inspection-sheetxlsx",
  nominal_geometry: [
    { label: "Overall artifact height", value: "17 mm" },
    { label: "H-to-opposite-side distance", value: "100 mm" },
    { label: "X/Y pin and hole diameter", value: "Ø4 mm" },
    { label: "Lateral hole diameters", value: "Ø3 mm; Ø6 mm" },
    { label: "Lateral square width / height", value: "3 mm; 6 mm" }
  ],
  features: [
    { code: "positive_fine_025", label: "Positive fine feature · 0.25 mm", category: "Positive fine", nominal_size_um: 250, measurement: "Presence and width", location: "Top face, upper-right fine-feature bank", inspection_hint: "View under an optical microscope at 5×; record whether the pin is distinct, then its width.", map_zone: "fine", analysis_role: "resolution" },
    { code: "positive_fine_050", label: "Positive fine feature · 0.50 mm", category: "Positive fine", nominal_size_um: 500, measurement: "Presence and width", location: "Top face, upper-right fine-feature bank", inspection_hint: "View under an optical microscope at 5×; record whether the pin is distinct, then its width.", map_zone: "fine", analysis_role: "xy_boundary" },
    { code: "positive_fine_100", label: "Positive fine feature · 1.00 mm", category: "Positive fine", nominal_size_um: 1000, measurement: "Presence and width", location: "Top face, upper-right fine-feature bank", inspection_hint: "View under an optical microscope at 5×; measure the printed width.", map_zone: "fine", analysis_role: "xy_boundary" },
    { code: "positive_fine_150", label: "Positive fine feature · 1.50 mm", category: "Positive fine", nominal_size_um: 1500, measurement: "Presence and width", location: "Top face, upper-right fine-feature bank", inspection_hint: "View under an optical microscope at 5×; measure the printed width.", map_zone: "fine", analysis_role: "xy_boundary" },
    { code: "positive_fine_200", label: "Positive fine feature · 2.00 mm", category: "Positive fine", nominal_size_um: 2000, measurement: "Presence and width", location: "Top face, upper-right fine-feature bank", inspection_hint: "View under an optical microscope at 5×; measure the printed width.", map_zone: "fine", analysis_role: "xy_boundary" },
    { code: "negative_fine_025", label: "Negative fine feature · 0.25 mm", category: "Negative fine", nominal_size_um: 250, measurement: "Open/not open and width", location: "Top face, upper-right fine-feature bank", inspection_hint: "View under an optical microscope at 5×; first confirm the gap is open, then measure its width.", map_zone: "fine", analysis_role: "resolution" },
    { code: "negative_fine_050", label: "Negative fine feature · 0.50 mm", category: "Negative fine", nominal_size_um: 500, measurement: "Open/not open and width", location: "Top face, upper-right fine-feature bank", inspection_hint: "View under an optical microscope at 5×; first confirm the gap is open, then measure its width.", map_zone: "fine", analysis_role: "resolution" },
    { code: "negative_fine_100", label: "Negative fine feature · 1.00 mm", category: "Negative fine", nominal_size_um: 1000, measurement: "Open/not open and width", location: "Top face, upper-right fine-feature bank", inspection_hint: "View under an optical microscope at 5×; first confirm the gap is open, then measure its width.", map_zone: "fine", analysis_role: "resolution" },
    { code: "negative_fine_150", label: "Negative fine feature · 1.50 mm", category: "Negative fine", nominal_size_um: 1500, measurement: "Open/not open and width", location: "Top face, upper-right fine-feature bank", inspection_hint: "View under an optical microscope at 5×; first confirm the gap is open, then measure its width.", map_zone: "fine", analysis_role: "resolution" },
    { code: "negative_fine_200", label: "Negative fine feature · 2.00 mm", category: "Negative fine", nominal_size_um: 2000, measurement: "Open/not open and width", location: "Top face, upper-right fine-feature bank", inspection_hint: "View under an optical microscope at 5×; first confirm the gap is open, then measure its width.", map_zone: "fine", analysis_role: "resolution" },
    { code: "xy_pin_or_hole_400", label: "X/Y pin or hole · Ø4 mm", category: "Pins and holes", nominal_size_um: 4000, measurement: "Average diameter and position", location: "Top face, the Ø4 mm pins and holes along the X and Y axes", inspection_hint: "For diameter, take at least six points distributed over 360°; use the inspection sheet for position checks.", map_zone: "xy", analysis_role: "xy_boundary" },
    { code: "lateral_hole_300", label: "Lateral hole · Ø3 mm", category: "Lateral feature", nominal_size_um: 3000, measurement: "Diameter and roundness", location: "Vertical side wall, circular lateral feature", inspection_hint: "Measure the diameter from the side; use at least six points over 360° if roundness is also inspected.", map_zone: "lateral", analysis_role: "resolution" },
    { code: "lateral_hole_600", label: "Lateral hole · Ø6 mm", category: "Lateral feature", nominal_size_um: 6000, measurement: "Diameter and roundness", location: "Vertical side wall, circular lateral feature", inspection_hint: "Measure the diameter from the side; use at least six points over 360° if roundness is also inspected.", map_zone: "lateral", analysis_role: "resolution" },
    { code: "lateral_square_300", label: "Lateral square · 3 mm", category: "Lateral feature", nominal_size_um: 3000, measurement: "Width and height", location: "Vertical side wall, square lateral feature", inspection_hint: "Measure width and height from the side; record the relevant dimension in this row.", map_zone: "lateral", analysis_role: "resolution" },
    { code: "lateral_square_600", label: "Lateral square · 6 mm", category: "Lateral feature", nominal_size_um: 6000, measurement: "Width and height", location: "Vertical side wall, square lateral feature", inspection_hint: "Measure width and height from the side; record the relevant dimension in this row.", map_zone: "lateral", analysis_role: "resolution" },
    { code: "h_to_opposite_side_100", label: "H to opposite side · 100 mm", category: "Scale reference", nominal_size_um: 100000, measurement: "Opposite-side distance", location: "Across the diamond plate: from side H to the opposite side", inspection_hint: "Use a calibrated long-baseline method. This is the sole reference for the calculated global XY scale correction.", map_zone: "baseline", analysis_role: "scale_reference" }
  ]
};

const presets = new Map<string, QualificationArtifactPreset>([
  [nistAmTestArtifactPreset.code, nistAmTestArtifactPreset]
]);

export function getQualificationArtifactPreset(code: unknown) {
  return presets.get(String(code || "")) ?? null;
}

export function getQualificationArtifactFeature(presetCode: unknown, featureCode: unknown) {
  return getQualificationArtifactPreset(presetCode)?.features
    .find((feature) => feature.code === String(featureCode || "")) ?? null;
}
