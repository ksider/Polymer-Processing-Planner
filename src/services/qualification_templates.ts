export type QualificationFieldDefinition = {
  code: string;
  label: string;
  field_type: "number" | "text" | "tag" | "boolean";
  unit?: string | null;
  group_label?: string | null;
  required?: number;
  is_enabled?: number;
  is_derived?: number;
  allowed_values_json?: string | null;
  derived_formula_code?: string | null;
};

type QualificationGeneratorSetupField = {
  code: string;
  label: string;
  unit: string | null;
  minimum?: number;
  required?: boolean;
};

type QualificationRunGeneratorLevelField = {
  code: string;
  label: string;
  unit: string;
  example_levels: string;
  minimum?: number;
};

type SingleFactorSweepGeneratorDefinition = {
  type: "single_factor_sweep";
  title: string;
  description: string;
  default_variable_code: string;
  setup_fields: QualificationGeneratorSetupField[];
  variable_fields: Array<QualificationRunGeneratorLevelField & {
    fixed_setup_code: string;
    fixed_setup_label: string;
  }>;
};

export type ExposureLayerMatrixGeneratorDefinition = {
  type: "exposure_layer_matrix";
  title: string;
  description: string;
  setup_fields: QualificationGeneratorSetupField[];
  variable_fields: [QualificationRunGeneratorLevelField, QualificationRunGeneratorLevelField];
};

export type PeelForceMatrixGeneratorDefinition = {
  type: "peel_force_matrix";
  title: string;
  description: string;
  variable_fields: [QualificationRunGeneratorLevelField, QualificationRunGeneratorLevelField, QualificationRunGeneratorLevelField];
};

export type PostCureMatrixGeneratorDefinition = {
  type: "post_cure_matrix";
  title: string;
  description: string;
  variable_fields: [QualificationRunGeneratorLevelField, QualificationRunGeneratorLevelField, QualificationRunGeneratorLevelField];
};

export type QualificationRunGeneratorDefinition =
  | SingleFactorSweepGeneratorDefinition
  | ExposureLayerMatrixGeneratorDefinition
  | PeelForceMatrixGeneratorDefinition
  | PostCureMatrixGeneratorDefinition;

export type QualificationStepDefinition = {
  step_number: number;
  name: string;
  default_runs: number;
  is_optional?: boolean;
  activation_description?: string;
  run_generator?: QualificationRunGeneratorDefinition;
  fields: QualificationFieldDefinition[];
};

export type QualificationSeriesDefinition = {
  code: string;
  label: string;
  description: string;
  contract_version: number;
  /** CSV keeps a measured instrument trace; run_fields makes one table row one plotted point. */
  source?: "csv" | "run_fields";
  x: { code: string; label: string; unit: string; derived_formula_code?: string; scale?: "linear" | "log" };
  y: { code: string; label: string; unit: string };
  minimum_points: number;
};

export type QualificationOutputDefinition = {
  group: string;
  code: string;
  label: string;
  unit: string | null;
  field_type: "number" | "text";
  /** Manual outputs are recorded by an operator; summary outputs are materialized from run evidence. */
  value_source?: "manual" | "summary";
  /** Dot path within the calculated step summary when value_source is summary. */
  summary_key?: string;
  allowed_values?: Array<{ value: string; label: string }>;
  description: string;
};

export type QualificationProcessTemplate = {
  processTypeCode: string;
  steps: QualificationStepDefinition[];
  compactLabelsByCode?: Record<string, string>;
  seriesByStep?: Record<number, QualificationSeriesDefinition[]>;
  outputsByStep?: Record<number, QualificationOutputDefinition[]>;
};

const orientationValues = JSON.stringify(["XY", "XZ", "YZ", "Z", "45deg", "other"]);
const filmValues = JSON.stringify(["FEP", "PFA", "nFEP", "ACF", "PDMS", "other"]);
const washValues = JSON.stringify(["IPA", "ethanol", "water", "TPM", "other"]);
const rheologyProgramValues = JSON.stringify(["steady_shear", "three_interval_thixotropy", "other"]);
const flowBehaviourValues = JSON.stringify(["Newtonian", "shear-thinning", "shear-thickening", "mixed"]);

export const slaDlpTemplate: QualificationProcessTemplate = {
  processTypeCode: "sla_dlp",
  compactLabelsByCode: {
    resin_temp_c: "T resin",
    wait_before_exposure_s: "t wait",
    recoat_delay_s: "t level",
    layer_uniformity_ok: "Uniform",
    bubbles_present: "Bubbles",
    wavelength_nm: "λ",
    irradiance_mw_cm2: "Irrad.",
    exposure_time_s: "t exp",
    exposure_dose_mj_cm2: "Dose",
    cure_depth_um: "Cd",
    critical_exposure_ec_mj_cm2: "Ec",
    penetration_depth_dp_um: "Dp",
    working_curve_r_squared: "R²",
    layer_height_um: "h layer",
    target_overcure_pct: "Target U_z",
    bottom_exposure_s: "t bottom",
    actual_layer_thickness_um: "h actual",
    xy_bleed_um: "XY bleed",
    minimum_open_channel_um: "Min channel",
    delamination_present: "Delam.",
    overcure_pct: "Overcure",
    artifact_feature_code: "Element",
    measured_feature_size_um: "Measured",
    feature_reproduced: "Reproduced",
    dimensional_error_um: "Δdim",
    absolute_dimensional_error_um: "|Δdim|",
    relative_dimensional_error_pct: "Rel. Δ",
    vat_film_type: "Film",
    support_neck_diameter_mm: "Ø support",
    lift_speed_mm_s: "v lift",
    layer_area_mm2: "A layer",
    peel_force_n: "F peel",
    green_tensile_strength_mpa: "σ green",
    print_failure: "Failure",
    average_peel_stress_mpa: "σ peel",
    wash_method: "Wash",
    wash_time_min: "t wash",
    post_cure_time_min: "t post",
    post_cure_temp_c: "T post",
    post_cure_irradiance_mw_cm2: "Irrad. post",
    reaction_band_uncured: "A rxn,u",
    reference_band_uncured: "A ref,u",
    reaction_band_cured: "A rxn,c",
    reference_band_cured: "A ref,c",
    residual_enthalpy_j_g: "ΔH res",
    final_tg_c: "Tg",
    post_cure_delta_tg_c: "ΔTg",
    post_cure_shrinkage_pct: "Shrinkage",
    tensile_strength_mpa: "σt",
    final_conversion_pct: "α FTIR",
    build_orientation: "Orient.",
    resin_batch: "Batch",
    rheology_program: "Method",
    sla_reference_shear_rate_s_inv: "γ ref",
    sla_reference_viscosity_pa_s: "η ref",
    sla_flow_behaviour_class: "Flow type",
    elastic_modulus_mpa: "E",
    elongation_break_pct: "εb",
    flexural_strength_mpa: "σf",
    hdt_c: "HDT"
  },
  steps: [
    {
      step_number: 1,
      name: "Resin Conditioning & Recoating Window",
      default_runs: 6,
      fields: [
        { code: "resin_batch", label: "Resin batch", field_type: "text", group_label: "Inputs", required: 1 },
        { code: "resin_temp_c", label: "Resin temperature", field_type: "number", unit: "°C", group_label: "Inputs", required: 1 },
        { code: "layer_height_um", label: "Layer height", field_type: "number", unit: "µm", group_label: "Inputs", required: 1 },
        { code: "wait_before_exposure_s", label: "Wait before exposure", field_type: "number", unit: "s", group_label: "Inputs", required: 1 },
        { code: "recoat_delay_s", label: "Observed levelling time", field_type: "number", unit: "s", group_label: "Measurements" },
        { code: "layer_uniformity_ok", label: "Layer uniformity OK", field_type: "boolean", group_label: "Measurements", required: 1 },
        { code: "bubbles_present", label: "Bubbles observed", field_type: "boolean", group_label: "Measurements" }
      ]
    },
    {
      step_number: 2,
      name: "Photocure Working Curve",
      default_runs: 7,
      run_generator: {
        type: "single_factor_sweep",
        title: "Jacobs exposure-run generator",
        description: "Choose one independently varied optical parameter. Dose is derived as irradiance × exposure time; every generated row is one physical exposure and cured-depth measurement.",
        default_variable_code: "exposure_time_s",
        setup_fields: [
          { code: "jacobs_wavelength_nm", label: "Wavelength", unit: "nm", minimum: 1 },
          { code: "jacobs_resin_temp_c", label: "Resin temperature", unit: "°C" }
        ],
        variable_fields: [
          {
            code: "exposure_time_s",
            label: "Exposure time",
            unit: "s",
            example_levels: "1; 1.5; 2; 2.5; 3",
            minimum: 0.000001,
            fixed_setup_code: "jacobs_fixed_irradiance_mw_cm2",
            fixed_setup_label: "Fixed measured irradiance"
          },
          {
            code: "irradiance_mw_cm2",
            label: "Measured irradiance",
            unit: "mW/cm²",
            example_levels: "2; 3; 4; 5; 6",
            minimum: 0.000001,
            fixed_setup_code: "jacobs_fixed_exposure_time_s",
            fixed_setup_label: "Fixed exposure time"
          }
        ]
      },
      fields: [
        { code: "irradiance_mw_cm2", label: "Measured irradiance", field_type: "number", unit: "mW/cm²", group_label: "Inputs", required: 1, is_enabled: 0 },
        { code: "exposure_time_s", label: "Exposure time", field_type: "number", unit: "s", group_label: "Inputs", required: 1 },
        { code: "exposure_dose_mj_cm2", label: "Exposure dose", field_type: "number", unit: "mJ/cm²", group_label: "Derived", is_derived: 1, derived_formula_code: "sla_exposure_dose" },
        { code: "cure_depth_um", label: "Cured depth", field_type: "number", unit: "µm", group_label: "Measurements", required: 1 }
      ]
    },
    {
      step_number: 3,
      name: "Exposure & Layer Window",
      default_runs: 6,
      run_generator: {
        type: "exposure_layer_matrix",
        title: "Exposure × layer run generator",
        description: "Enter layer heights and target overcure levels. The generator uses Ec and Dp from Step 2 plus the fixed measured irradiance to calculate the dose and exposure time for every matrix cell.",
        setup_fields: [
          { code: "exposure_window_wavelength_nm", label: "Wavelength", unit: "nm", minimum: 1, required: true },
          { code: "exposure_window_resin_temp_c", label: "Resin temperature", unit: "°C", required: true },
          { code: "exposure_window_irradiance_mw_cm2", label: "Measured irradiance", unit: "mW/cm²", minimum: 0.000001, required: true },
          { code: "exposure_window_bottom_exposure_s", label: "Bottom-layer exposure", unit: "s", minimum: 0, required: false }
        ],
        variable_fields: [
          { code: "layer_height_um", label: "Layer heights", unit: "µm", example_levels: "25; 50; 75", minimum: 1 },
          { code: "target_overcure_pct", label: "Target overcure", unit: "%", example_levels: "20; 50; 100", minimum: -99.999 }
        ]
      },
      fields: [
        { code: "layer_height_um", label: "Layer height", field_type: "number", unit: "µm", group_label: "Inputs", required: 1 },
        { code: "target_overcure_pct", label: "Target overcure", field_type: "number", unit: "%", group_label: "Inputs", is_derived: 1 },
        { code: "exposure_time_s", label: "Layer exposure", field_type: "number", unit: "s", group_label: "Inputs", required: 1 },
        { code: "exposure_dose_mj_cm2", label: "Exposure dose", field_type: "number", unit: "mJ/cm²", group_label: "Derived", is_derived: 1, derived_formula_code: "sla_exposure_dose" },
        { code: "cure_depth_um", label: "Cure depth", field_type: "number", unit: "µm", group_label: "Measurements" },
        { code: "actual_layer_thickness_um", label: "Actual layer thickness", field_type: "number", unit: "µm", group_label: "Measurements" },
        { code: "xy_bleed_um", label: "XY bleed", field_type: "number", unit: "µm", group_label: "Measurements" },
        { code: "minimum_open_channel_um", label: "Minimum open channel", field_type: "number", unit: "µm", group_label: "Measurements" },
        { code: "delamination_present", label: "Delamination observed", field_type: "boolean", group_label: "Measurements" },
        { code: "overcure_pct", label: "Overcure ratio", field_type: "number", unit: "%", group_label: "Derived", is_derived: 1, derived_formula_code: "sla_overcure_ratio" }
      ]
    },
    {
      step_number: 4,
      name: "Resolution & Dimensional Accuracy",
      default_runs: 0,
      fields: [
        { code: "artifact_feature_code", label: "NIST model element", field_type: "text", group_label: "Measurement plan", required: 1 },
        { code: "measured_feature_size_um", label: "Measured feature size", field_type: "number", unit: "µm", group_label: "Measurements", required: 1 },
        { code: "feature_reproduced", label: "Feature reproduced", field_type: "boolean", group_label: "Measurements" },
        { code: "dimensional_error_um", label: "Feature-size error", field_type: "number", unit: "µm", group_label: "Derived", is_derived: 1, derived_formula_code: "sla_dimensional_error" },
        { code: "absolute_dimensional_error_um", label: "Absolute feature-size error", field_type: "number", unit: "µm", group_label: "Derived", is_derived: 1, derived_formula_code: "sla_absolute_dimensional_error" },
        { code: "relative_dimensional_error_pct", label: "Relative feature-size error", field_type: "number", unit: "%", group_label: "Derived", is_derived: 1, derived_formula_code: "sla_relative_dimensional_error" }
      ]
    },
    {
      step_number: 5,
      name: "Green Strength & Peel Force",
      default_runs: 5,
      run_generator: {
        type: "peel_force_matrix",
        title: "Lift speed × layer-area × exposure run generator",
        description: "Generate one peel test for every lift-speed, representative-layer-area and layer-exposure combination. Vat film, support geometry and layer height are fixed experiment conditions, not run-table columns.",
        variable_fields: [
          { code: "lift_speed_mm_s", label: "Lift speed", unit: "mm/s", example_levels: "0.8; 1.2; 1.6; 2.0", minimum: 0.000001 },
          { code: "layer_area_mm2", label: "Representative layer area", unit: "mm²", example_levels: "600; 900; 1200", minimum: 0.000001 },
          { code: "exposure_time_s", label: "Layer exposure", unit: "s", example_levels: "1.8; 2.1; 2.4", minimum: 0.000001 }
        ]
      },
      fields: [
        { code: "vat_film_type", label: "Vat film", field_type: "tag", group_label: "Inputs", allowed_values_json: filmValues },
        { code: "support_neck_diameter_mm", label: "Support neck diameter", field_type: "number", unit: "mm", group_label: "Inputs" },
        { code: "lift_speed_mm_s", label: "Lift speed", field_type: "number", unit: "mm/s", group_label: "Inputs", required: 1 },
        { code: "layer_area_mm2", label: "Layer area", field_type: "number", unit: "mm²", group_label: "Inputs", required: 1 },
        { code: "exposure_time_s", label: "Layer exposure", field_type: "number", unit: "s", group_label: "Inputs" },
        { code: "peel_force_n", label: "Peak peel force", field_type: "number", unit: "N", group_label: "Measurements", required: 1 },
        { code: "green_tensile_strength_mpa", label: "Green tensile strength", field_type: "number", unit: "MPa", group_label: "Measurements" },
        { code: "print_failure", label: "Print/support failure", field_type: "boolean", group_label: "Measurements" },
        { code: "average_peel_stress_mpa", label: "Average peel stress", field_type: "number", unit: "MPa", group_label: "Derived", is_derived: 1, derived_formula_code: "sla_average_peel_stress" }
      ]
    },
    {
      step_number: 6,
      name: "Wash, Post-Cure & Conversion",
      default_runs: 6,
      run_generator: {
        type: "post_cure_matrix",
        title: "Post-cure time × temperature × irradiance run generator",
        description: "Generate one post-cure condition for every time, temperature and measured-irradiance combination. Wash method, wash duration, source and baseline print condition are fixed in experiment setup, not run-table columns.",
        variable_fields: [
          { code: "post_cure_time_min", label: "Post-cure time", unit: "min", example_levels: "0; 5; 10; 20; 30; 45", minimum: 0 },
          { code: "post_cure_temp_c", label: "Post-cure temperature", unit: "°C", example_levels: "50; 60; 70", minimum: 0.000001 },
          { code: "post_cure_irradiance_mw_cm2", label: "Post-cure irradiance", unit: "mW/cm²", example_levels: "6; 8; 10", minimum: 0.000001 }
        ]
      },
      fields: [
        { code: "wash_method", label: "Wash method", field_type: "tag", group_label: "Inputs", allowed_values_json: washValues },
        { code: "wash_time_min", label: "Wash time", field_type: "number", unit: "min", group_label: "Inputs" },
        { code: "post_cure_time_min", label: "Post-cure time", field_type: "number", unit: "min", group_label: "Inputs", required: 1 },
        { code: "post_cure_temp_c", label: "Post-cure temperature", field_type: "number", unit: "°C", group_label: "Inputs", required: 1 },
        { code: "post_cure_irradiance_mw_cm2", label: "Post-cure irradiance", field_type: "number", unit: "mW/cm²", group_label: "Inputs" },
        { code: "reaction_band_uncured", label: "Uncured reaction-band area", field_type: "number", group_label: "Measurements" },
        { code: "reference_band_uncured", label: "Uncured reference-band area", field_type: "number", group_label: "Measurements" },
        { code: "reaction_band_cured", label: "Cured reaction-band area", field_type: "number", group_label: "Measurements" },
        { code: "reference_band_cured", label: "Cured reference-band area", field_type: "number", group_label: "Measurements" },
        { code: "residual_enthalpy_j_g", label: "Residual enthalpy", field_type: "number", unit: "J/g", group_label: "Measurements" },
        { code: "final_tg_c", label: "Final Tg", field_type: "number", unit: "°C", group_label: "Measurements" },
        { code: "post_cure_shrinkage_pct", label: "Post-cure shrinkage", field_type: "number", unit: "%", group_label: "Measurements" },
        { code: "tensile_strength_mpa", label: "Tensile strength", field_type: "number", unit: "MPa", group_label: "Measurements" },
        { code: "final_conversion_pct", label: "FTIR conversion", field_type: "number", unit: "%", group_label: "Derived", is_derived: 1, derived_formula_code: "sla_ftir_conversion" },
        { code: "post_cure_delta_tg_c", label: "Change in Tg", field_type: "number", unit: "°C", group_label: "Derived", is_derived: 1, derived_formula_code: "sla_post_cure_delta_tg" }
      ]
    },
    {
      step_number: 7,
      name: "Final Mechanical & Thermal Qualification",
      default_runs: 6,
      fields: [
        { code: "build_orientation", label: "Build orientation", field_type: "tag", group_label: "Inputs", required: 1, allowed_values_json: orientationValues },
        { code: "tensile_strength_mpa", label: "Tensile strength", field_type: "number", unit: "MPa", group_label: "Measurements", required: 1 },
        { code: "elastic_modulus_mpa", label: "Elastic modulus", field_type: "number", unit: "MPa", group_label: "Measurements" },
        { code: "elongation_break_pct", label: "Elongation at break", field_type: "number", unit: "%", group_label: "Measurements" },
        { code: "flexural_strength_mpa", label: "Flexural strength", field_type: "number", unit: "MPa", group_label: "Measurements" },
        { code: "hdt_c", label: "Heat deflection temperature", field_type: "number", unit: "°C", group_label: "Measurements" },
        { code: "final_tg_c", label: "Final Tg", field_type: "number", unit: "°C", group_label: "Measurements" },
        { code: "dimensional_error_um", label: "Dimensional error", field_type: "number", unit: "µm", group_label: "Measurements" }
      ]
    },
    {
      step_number: 8,
      name: "Additional: Resin Flow Characterisation",
      default_runs: 3,
      is_optional: true,
      activation_description: "Use only to compare a resin batch, formulation or vat-temperature condition. It records material evidence and does not qualify recoating settings.",
      fields: [
        { code: "resin_batch", label: "Resin batch", field_type: "text", group_label: "Inputs", required: 1 },
        { code: "resin_temp_c", label: "Resin temperature", field_type: "number", unit: "°C", group_label: "Inputs", required: 1 },
        { code: "rheology_program", label: "Rheology programme", field_type: "tag", group_label: "Inputs", required: 1, allowed_values_json: rheologyProgramValues },
        { code: "sla_reference_shear_rate_s_inv", label: "Reference shear rate", field_type: "number", unit: "s⁻¹", group_label: "Inputs", required: 1 },
        { code: "sla_reference_viscosity_pa_s", label: "Reference viscosity", field_type: "number", unit: "Pa·s", group_label: "Measurements", required: 1 },
        { code: "sla_flow_behaviour_class", label: "Flow behaviour", field_type: "tag", group_label: "Measurements", allowed_values_json: flowBehaviourValues }
      ]
    }
  ],
  seriesByStep: {
    2: [{
      code: "jacobs_working_curve",
      label: "Jacobs working curve",
      description: "Built from the non-excluded run table: one calibrated exposure and one cured-depth measurement per run. Ec, Dp and R² are fitted from these points.",
      contract_version: 1,
      source: "run_fields",
      x: { code: "exposure_dose_mj_cm2", label: "Exposure dose", unit: "mJ/cm²", derived_formula_code: "sla_exposure_dose", scale: "log" },
      y: { code: "cure_depth_um", label: "Cure depth", unit: "µm" },
      minimum_points: 3
    }],
    7: [{
      code: "stress_strain_curve",
      label: "Stress-strain curve",
      description: "Measured engineering stress-strain series for the selected build orientation and conditioning state.",
      contract_version: 1,
      x: { code: "strain_pct", label: "Strain", unit: "%" },
      y: { code: "stress_mpa", label: "Stress", unit: "MPa" },
      minimum_points: 3
    }],
    8: [{
      code: "resin_flow_curve",
      label: "Resin flow curve",
      description: "Measured viscosity against shear rate for one resin batch and temperature. Compare like-for-like runs only; this curve does not accept a recoating setting.",
      contract_version: 1,
      x: { code: "shear_rate_s_inv", label: "Shear rate", unit: "s⁻¹" },
      y: { code: "viscosity_pa_s", label: "Viscosity", unit: "Pa·s" },
      minimum_points: 3
    }]
  },
  outputsByStep: {
    1: [
      { group: "recoat_window", code: "resin_temp_window_min_c", label: "Minimum validated resin temperature", unit: "°C", field_type: "number", description: "Lower resin-temperature boundary represented by uniform, bubble-free layer trials." },
      { group: "recoat_window", code: "resin_temp_window_max_c", label: "Maximum validated resin temperature", unit: "°C", field_type: "number", description: "Upper resin-temperature boundary represented by uniform, bubble-free layer trials." },
      { group: "recoat_window", code: "resin_temp_target_c", label: "Target resin temperature", unit: "°C", field_type: "number", description: "Reviewed operating temperature inside the validated recoating window." },
      { group: "recoat_window", code: "minimum_recoat_delay_s", label: "Minimum wait before exposure", unit: "s", field_type: "number", description: "Shortest confirmed wait at the target temperature that produces a uniform, bubble-free layer." }
    ],
    2: [
      {
        group: "working_curve",
        code: "critical_exposure_ec_mj_cm2",
        label: "Critical exposure Ec",
        unit: "mJ/cm²",
        field_type: "number",
        value_source: "summary",
        summary_key: "jacobs_working_curve.critical_exposure_ec_mj_cm2",
        description: "Automatically calculated from the non-excluded Jacobs dose/depth runs."
      },
      {
        group: "working_curve",
        code: "penetration_depth_dp_um",
        label: "Penetration depth Dp",
        unit: "µm",
        field_type: "number",
        value_source: "summary",
        summary_key: "jacobs_working_curve.penetration_depth_dp_um",
        description: "Automatically calculated from the non-excluded Jacobs dose/depth runs."
      },
      {
        group: "working_curve",
        code: "working_curve_r_squared",
        label: "Working-curve R²",
        unit: null,
        field_type: "number",
        value_source: "summary",
        summary_key: "jacobs_working_curve.r_squared",
        description: "Automatically calculated fit-quality diagnostic; it is not a printing setting."
      }
    ],
    3: [
      { group: "exposure_window", code: "qualified_layer_height_um", label: "Qualified layer height", unit: "µm", field_type: "number", description: "Layer height to which the confirmed exposure window applies." },
      { group: "exposure_window", code: "exposure_window_min_s", label: "Minimum validated exposure", unit: "s", field_type: "number", description: "Lower confirmed exposure boundary at the recorded fixed conditions." },
      { group: "exposure_window", code: "exposure_window_max_s", label: "Maximum validated exposure", unit: "s", field_type: "number", description: "Upper confirmed exposure boundary at the recorded fixed conditions." },
      { group: "exposure_window", code: "nominal_exposure_s", label: "Nominal exposure", unit: "s", field_type: "number", description: "Reviewed working point inside the measured acceptable region." }
    ],
    4: [
      { group: "resolution", code: "minimum_feature_size_um", label: "Minimum reproduced feature", unit: "µm", field_type: "number", value_source: "summary", summary_key: "dimensional_measurement.minimum_reproduced_feature_um", description: "Smallest NIST fine feature marked as reproduced; nominal dimensions remain in the fixed preset." },
      { group: "compensation", code: "xy_compensation_mm", label: "Suggested XY boundary offset", unit: "mm", field_type: "number", value_source: "summary", summary_key: "dimensional_measurement.suggested_xy_boundary_offset_mm", description: "Median external-feature error converted to a per-boundary offset. It is a starting estimate, not a released slicer setting." },
      { group: "compensation", code: "shrinkage_compensation_pct", label: "Suggested XY scale correction", unit: "%", field_type: "number", value_source: "summary", summary_key: "dimensional_measurement.suggested_xy_scale_compensation_pct", description: "Calculated only from NIST H-to-opposite-side measurement. Confirm by reprinting the artifact before release." }
    ],
    5: [
      { group: "peel", code: "validated_lift_speed_mm_s", label: "Validated lift speed", unit: "mm/s", field_type: "number", description: "Confirmed lift speed for the recorded layer-area, exposure and support conditions." },
      { group: "peel", code: "maximum_average_peel_stress_mpa", label: "Maximum observed average peel stress", unit: "MPa", field_type: "number", value_source: "summary", summary_key: "peel_force.maximum_average_peel_stress_mpa", description: "Largest calculated Fpeel / Alayer among non-excluded runs; an engineering comparison metric, not a local failure stress." },
      { group: "green_strength", code: "green_strength_mpa", label: "Median green tensile strength", unit: "MPa", field_type: "number", value_source: "summary", summary_key: "peel_force.median_green_tensile_strength_mpa", description: "Median measured green tensile strength from non-failed, non-excluded matrix runs; descriptive evidence, not a failure threshold." },
      { group: "supports", code: "support_geometry_constraints", label: "Support geometry constraints", unit: null, field_type: "text", description: "Reviewed support, layer-area and exposure applicability of the lift-speed result." }
    ],
    6: [
      { group: "post_cure", code: "post_cure_time_min", label: "Post-cure time", unit: "min", field_type: "number", description: "Confirmed post-cure duration." },
      { group: "post_cure", code: "post_cure_temp_c", label: "Post-cure temperature", unit: "°C", field_type: "number", description: "Confirmed post-cure temperature." },
      { group: "post_cure", code: "post_cure_irradiance_mw_cm2", label: "Post-cure irradiance", unit: "mW/cm²", field_type: "number", description: "Measured irradiance for the confirmed post-cure programme." },
      { group: "post_cure", code: "final_tg_c", label: "Final Tg", unit: "°C", field_type: "number", description: "Confirmed glass-transition temperature after post-cure." }
    ],
    7: [
      { group: "material_card", code: "qualified_tensile_strength_mpa", label: "Median XY tensile strength", unit: "MPa", field_type: "number", value_source: "summary", summary_key: "final_mechanical.xy_tensile_median_mpa", description: "Median tensile strength for non-excluded XY specimens under the declared conditioning method." },
      { group: "material_card", code: "qualified_elastic_modulus_mpa", label: "Median XY elastic modulus", unit: "MPa", field_type: "number", value_source: "summary", summary_key: "final_mechanical.xy_modulus_median_mpa", description: "Median elastic modulus for non-excluded XY specimens under the declared conditioning method." },
      { group: "material_card", code: "orientation_anisotropy_ratio", label: "Z / XY tensile ratio", unit: null, field_type: "number", value_source: "summary", summary_key: "final_mechanical.z_to_xy_tensile_ratio", description: "Median Z tensile strength divided by median XY tensile strength; it describes orientation anisotropy, not a universal material property." },
      { group: "material_card", code: "sla_print_profile", label: "Released SLA/DLP print profile", unit: null, field_type: "text", description: "Versioned profile identifier or concise release statement." }
    ],
    8: [
      { group: "material_evidence", code: "sla_rheology_reference_viscosity_pa_s", label: "Reviewed reference viscosity", unit: "Pa·s", field_type: "number", description: "Viscosity selected from the measured flow curve at its declared temperature and reference shear rate." },
      { group: "material_evidence", code: "sla_flow_behavior_index_n", label: "Flow behaviour index n", unit: null, field_type: "number", description: "Report only when a reviewed power-law fit is applicable to the measured range." },
      { group: "material_evidence", code: "sla_rheology_assessment", label: "Rheology assessment", unit: null, field_type: "text", description: "Scope and comparison conclusion for material evidence; it is not a printer-setting acceptance rule." }
    ]
  }
};
