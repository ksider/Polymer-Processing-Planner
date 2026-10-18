export type QualificationStudyGuide = {
  title: string;
  goal: string;
  theory: string;
  procedure: string[];
  interpretation: string[];
  handoff: string;
  references: string;
};

// Operational summaries of .ai/experiment/extrusion.md, kept with the
// process template so that the guide stays coupled to the actual stage.
const extrusionGuides: Record<number, QualificationStudyGuide> = {
  1: {
    title: "Material rheology & thermal profile",
    goal: "Set the safe temperature window, thermal-hold limit and melt-flow baseline before running the extruder.",
    theory: "Melt viscosity changes with shear rate and temperature. DSC identifies melting transitions; TGA and thermal hold reveal the onset of unacceptable degradation. Capillary pressure and flow give the apparent flow curve.",
    procedure: ["Use the declared resin grade and dry, conditioned material.", "Run the capillary sweep at three temperatures and across the planned shear-rate range; wait for pressure stability before recording each point.", "Run the thermal-hold series at fixed shear, then import the DSC and TGA curves from the instrument."],
    interpretation: ["Read the flow curves as viscosity versus shear rate; a sharp change or pressure instability marks an unsuitable condition.", "Use DSC/TGA and the hold series to select Tmin, Tmax and the maximum safe thermal exposure."],
    handoff: "Pass processing-temperature limits, reference viscosity and thermal-hold limit to the feeder, pumping and energy stages.",
    references: "ISO 11443, ISO 1133, ISO 11357, ISO 11358"
  },
  2: {
    title: "Gravimetric feeder stability",
    goal: "Establish which feeder speeds produce a stable, repeatable mass-flow rate for this material.",
    theory: "The feeder calibration relates screw speed F to measured throughput Q. The coefficient of variation, CV = σ/Q̄ × 100%, separates stable dosing from fluctuations that would obscure process effects.",
    procedure: ["Keep material bulk density, feeder screw and ambient conditions fixed.", "At each feeder-speed level record loss-in-weight throughput for 15–30 minutes using the same sampling cadence.", "Record the mean and standard deviation after the controller has stabilised."],
    interpretation: ["Accept points with CV ≤ 1.5% over the observation window.", "The accepted points define Q(F); do not extrapolate the calibration beyond their measured range."],
    handoff: "Pass the stable throughput range and F-to-Q calibration to the operating-window and RTD generators.",
    references: "Filled Polymer Systems; Shah"
  },
  3: {
    title: "Pumping and operating window",
    goal: "Map the screw–die operating region that stays below the pressure and motor-torque limits.",
    theory: "Specific throughput Q/N compares conditions at different screw speeds. A process point is acceptable only while melt pressure and torque remain inside their limits; separate pump-curve runs identify the screw-characteristic coefficients.",
    procedure: ["Generate the N × Q matrix only within the stable feeder range from Step 2.", "After changing a point, allow at least five minutes for pressure and torque to settle before recording pressure, torque and melt temperature.", "Use the separate pump-curve matrix when fitting the pumping characteristic."],
    interpretation: ["Reject points with pressure drift above ±1 bar/min or torque drift above ±1% during the steady-state window.", "Read the operating-window map as allowed Q–N combinations, not as independent limits."],
    handoff: "Pass accepted Q–N points and pressure/torque boundaries to energy mapping and RTD.",
    references: "Malkin & Isayev; Shaw"
  },
  4: {
    title: "Energy and melt-temperature map",
    goal: "Determine how screw speed, throughput and barrel temperature affect SME and dissipative melt heating.",
    theory: "Mechanical power comes from screw speed and torque. SME relates net torque to mass flow; the difference between melt and barrel-set temperature reveals viscous heating.",
    procedure: ["Use conditions inside the accepted Step 3 operating window.", "For every N × Q × barrel-temperature point, stabilise melt temperature and torque for 8–10 minutes.", "Record torque, no-load torque, measured melt temperature and heater power."],
    interpretation: ["Read SME against Q/N to compare loading conditions, and melt temperature against N to detect excess dissipation.", "Keep only points that remain within the material thermal window from Step 1."],
    handoff: "Pass the usable SME and melt-temperature range to downstream mixing, RTD and DOE work.",
    references: "Filled Polymer Systems; Schramm"
  },
  5: {
    title: "Residence time distribution & self-wiping",
    goal: "Measure residence-time spread, channel fill and signs of stagnant material at valid Q–N conditions.",
    theory: "A short, known tracer addition is followed at the outlet over time. The normalised response gives mean residence time t̄; the 10–90% cumulative width characterises axial mixing and tailing. Fill follows from actual Q, t̄, free volume and melt density.",
    procedure: ["Work only at a stable Step 3 operating point and record actual throughput.", "Add one short pre-weighed tracer portion at the feed zone, then collect outlet samples at a fixed interval until 2–3 samples have returned to baseline.", "Open Samples in the run, enter time and the consistently measured relative tracer signal, then save to calculate RTD metrics."],
    interpretation: ["Compare normalised C(t) curves for early breakthrough, broad tails and different spreading between conditions.", "Read t̄ and degree of fill against measured Q/N; a long tail can indicate poor self-wiping or stagnant zones."],
    handoff: "Pass representative t̄, RTD width and fill to mixing, reaction-kinetics and scale-up work.",
    references: "Filled Polymer Systems"
  },
  6: {
    title: "Side feeding & solid filler incorporation",
    goal: "Establish the maximum stable filler or fibre rate without accumulation at the side feeder.",
    theory: "The usable filler fraction depends on matrix and filler mass flow. A stable feeding point must be maintained without powder build-up; fibre products also require a separate retention check.",
    procedure: ["Hold main screw speed and matrix flow at an accepted operating point.", "Increase the side-feeder rate stepwise and observe the feed port for at least 10 minutes at each point.", "Record actual filler flow, side-feeder torque and whether material accumulates at the port."],
    interpretation: ["Use the calculated filler mass fraction, not side-feeder rpm, as the transferable formulation variable.", "The last point without accumulation is the upper candidate bound for a filler DOE factor."],
    handoff: "Pass the accepted filler-loading range and fibre-retention response to DOE.",
    references: "Filled Polymer Systems"
  },
  7: {
    title: "Liquid additive dosing & injection pressure",
    goal: "Find liquid-addition conditions that maintain a positive injection-pressure margin without melt slip or backflow.",
    theory: "Liquid fraction is liquid flow divided by total mass flow. Injection pressure must exceed barrel pressure by a stable margin so that the melt cannot flow back through the injection port.",
    procedure: ["Hold polymer flow and injection-zone temperature fixed.", "Sweep liquid dosing rate across the intended range at selected screw speeds.", "Record injection and barrel pressure, then confirm no liquid backflow."],
    interpretation: ["Use liquid mass fraction as the formulation factor and pressure differential as the operating constraint.", "Reject a point with backflow even if its calculated pressure differential is positive."],
    handoff: "Pass the no-backflow liquid-fraction range and pressure constraint to DOE.",
    references: "Filled Polymer Systems; Shah"
  },
  8: {
    title: "Devolatilization & vacuum degassing",
    goal: "Select a vacuum regime that removes volatiles without carryover into the vacuum line.",
    theory: "Devolatilisation efficiency is the reduction from initial to residual volatile content. Vacuum level is an operating constraint, while residual volatiles and carryover are quality responses.",
    procedure: ["Test vacuum levels at the low and high accepted Q/N boundaries.", "At each condition record vacuum stability, residual volatile content and material caught in the vacuum trap.", "Stop or reject a point if melt rises into the vent or carryover becomes unacceptable."],
    interpretation: ["Higher vacuum is not automatically better if it increases carryover.", "Choose the least severe vacuum that reaches the residual-volatiles requirement."],
    handoff: "Pass the selected vacuum setting as a fixed DOE condition and residual volatiles as a response gate.",
    references: "Filled Polymer Systems; thermal-characterisation methods"
  },
  9: {
    title: "Reactive extrusion & conversion kinetics",
    goal: "Match reaction-zone temperature and available residence time to the required conversion without thermal damage.",
    theory: "The first REX window is measured against paired screw-speed/throughput conditions. REX-specific RTD is optional at first, but is required before claiming a minimum residence time or a confirmed Damköhler number. The displayed kapp is an apparent first-order estimate from the measured chemical result and REX RTD, not a universal material constant.",
    procedure: ["Hold the reagent formulation and delivery route fixed, then pair practical screw-speed and throughput conditions with reaction-temperature levels.", "Run long enough to confirm stable chemical result and MFR for 15 minutes.", "Record the off-line FTIR/Raman, titration, GC or validated-manual result against the run. Add an RTD measurement from the same REX condition when kinetic confirmation is needed."],
    interpretation: ["A point can be an operating-window candidate without RTD, but it cannot establish minimum residence time or Da until REX-specific RTD is recorded.", "Reject conditions outside the configured chemical-result, MFR, thermal or stability limits."],
    handoff: "Pass accepted reaction temperature and reagent level as candidate DOE factors. Pass minimum residence time only from a REX-specific RTD-confirmed point.",
    references: "Menczel & Prime; ISO 1133"
  },
  10: {
    title: "Scale-up: lab to pilot to production",
    goal: "Transfer a validated formulation to a larger extruder while preserving the relevant energy, filling and melt-temperature state.",
    theory: "The first production throughput estimate scales with screw diameter cubed: Q₂ = Q₁ × (D₂/D₁)³. It is a starting point, not a production setpoint. Tip speed is πDN/60; production verification must also show SME and melt-temperature parity with the source process.",
    procedure: ["Enter comparable source-machine diameter, throughput and SME target, plus the production screw diameter.", "Generate a small sweep around the D³ throughput target at several production screw speeds.", "At steady state record torque, no-load torque, melt temperature, pressure and the product morphology measurement used for release."],
    interpretation: ["Keep only points with stable SME and melt-temperature parity; a correct D³ throughput does not prove equivalent mixing by itself.", "Use tip speed, melt temperature and pressure as hard production constraints, then choose the accepted point closest to the source energy state."],
    handoff: "Pass the accepted production N–Q centre and its constraints as the starting point for a production DOE, with the source result retained as provenance.",
    references: "Filled Polymer Systems; Shaw; Schramm"
  }
};

// The six injection studies use the same guide surface as extrusion. Each
// guide describes only the fields and calculations that the corresponding
// qualification step actually records.
const injectionGuides: Record<number, QualificationStudyGuide> = {
  1: {
    title: "Fill-rate response & relative-viscosity proxy",
    goal: "Choose an initial injection-speed range that fills consistently without an excessive pressure demand.",
    theory: "This is a moulding response study, not a capillary rheometer. The step uses fill time as a shear-rate proxy (1/tfill) and peak injection pressure × fill time × intensification coefficient as a relative comparison between runs.",
    procedure: ["Use a dry, conditioned material and one fixed mould, melt-temperature profile, transfer setting and shot size.", "Increase injection speed through practical levels; for each level allow the machine and mould to stabilise before recording fill time and peak injection pressure.", "Keep only fully filled, repeatable shots; enter the machine intensification coefficient in the step settings before comparing the derived proxy."],
    interpretation: ["Compare relative viscosity only between runs from this same moulding setup; it is not an absolute material viscosity.", "Select a speed range with repeatable filling and adequate pressure headroom for the following studies."],
    handoff: "Pass the selected injection-speed range to cavity balance, pressure-drop and cosmetic-window studies.",
    references: "Scientific Molding; ISO 294-1"
  },
  2: {
    title: "Cavity balance",
    goal: "Verify that all active cavities fill to a comparable part mass at the chosen fill condition.",
    theory: "Part mass is a direct, practical proxy for cavity fill. The calculated cavity-weight variation compares the populated cavity weights within one run; defect tags retain cavity-specific evidence that a mean value would hide.",
    procedure: ["Hold the Step 1 speed, material state, mould temperature, transfer and hold settings fixed.", "After steady operation, collect and weigh one part from every active cavity for each run; configure only the cavities installed in the mould.", "Record cavity-specific visual defects together with their weights rather than pooling them into one defect note."],
    interpretation: ["Investigate a persistent cavity-to-cavity mass difference before widening process settings; it can originate in the mould, hot runner or venting.", "Use the balanced condition as the baseline for pressure-drop and cosmetic-window tests."],
    handoff: "Pass the balanced fill condition and the target part weight to the pressure and gate-seal studies.",
    references: "Scientific Molding; ISO 294-4"
  },
  3: {
    title: "Pressure-drop profile",
    goal: "Locate where available injection pressure is consumed from the machine through the mould to the part.",
    theory: "Pressure is recorded along the flow path: air shot, sprue, runner, then 10%, 50% and 95% part fill. The profile is a diagnostic sequence; maximum pressure as a fraction of machine capacity is a headroom check, not a material property.",
    procedure: ["Use the balanced Step 2 condition and the selected injection speed from Step 1.", "Run a repeatable short-shot sequence or use available in-cavity/process pressure measurements at the named flow-path locations.", "Record the machine pressure limit and every available pressure location consistently; do not invent a value for an uninstrumented location."],
    interpretation: ["A large local pressure increase identifies the restriction to investigate, such as gate, runner or thin section.", "Keep a practical margin below machine maximum pressure before proceeding to the cosmetic window."],
    handoff: "Pass the feasible injection-speed range and pressure headroom to the cosmetic process-window study.",
    references: "Scientific Molding; ASTM D3641"
  },
  4: {
    title: "Cosmetic process window",
    goal: "Find the melt-temperature and hold-pressure combinations that avoid short shots and flash.",
    theory: "The study treats melt temperature and hold pressure as controlled factors, while short shot and flash are acceptance observations. The acceptable window is the measured combinations that pass both observations, not an extrapolated rectangle.",
    procedure: ["Keep the injection-speed condition, mould temperature, material and transfer setting fixed.", "Run the planned melt-temperature × hold-pressure matrix and allow the moulding cycle to stabilise at each point.", "Record short shot and flash separately for every condition; mark the run excluded if an unrelated interruption occurred."],
    interpretation: ["Reject a combination with either short shot or flash even when the other response is acceptable.", "Prefer a point within the measured acceptable region rather than directly on a defect boundary."],
    handoff: "Pass the selected melt temperature and hold pressure to gate-seal and cooling-time studies.",
    references: "Scientific Molding; ISO 294-1"
  },
  5: {
    title: "Gate-seal study",
    goal: "Find the shortest hold time after which additional packing no longer increases part mass.",
    theory: "While the gate remains open, increasing hold time can add mass to the part. The mass plateau indicates gate freeze/seal under the fixed material, melt temperature and hold-pressure condition.",
    procedure: ["Fix the accepted Step 4 melt temperature and hold pressure, together with injection speed and cooling condition.", "Increase hold time in ordered levels; after stabilisation, weigh parts with the same balance and sampling method.", "Include levels on both sides of the apparent mass plateau; repeat the plateau point if the difference is close to measurement noise."],
    interpretation: ["Choose the first reproducible mass plateau, not the longest hold time tested.", "If no plateau is observed, extend the study or verify the gate, transfer and part-mass measurement before declaring a result."],
    handoff: "Pass the gate-seal time as a fixed lower bound to cooling-time optimisation and production setup.",
    references: "Scientific Molding; ISO 294-4"
  },
  6: {
    title: "Cooling-time optimisation",
    goal: "Find the shortest cooling time that preserves surface quality and the critical dimension.",
    theory: "Cooling time is a cycle-time factor. Cosmetic approval and the measured critical dimension are separate release responses; a visually acceptable part can still miss its dimensional requirement.",
    procedure: ["Fix the accepted fill, melt-temperature, hold-pressure and gate-seal condition from the preceding studies.", "Reduce cooling time in controlled increments, allowing thermal steady state before sampling each point.", "For every point record cosmetic approval and measure the same named critical feature with a consistent gauge and conditioning state."],
    interpretation: ["The recommended cooling time is the shortest measured point that passes both cosmetic and dimensional criteria.", "Investigate warpage, sticking or dimensional drift before reducing cooling time further."],
    handoff: "Pass the selected cooling time and its cosmetic/dimensional checks to the production recipe and DOE constraints.",
    references: "Scientific Molding; ISO 294-4"
  }
};

const slaDlpGuides: Record<number, QualificationStudyGuide> = {
  1: {
    title: "Resin conditioning & recoating window",
    goal: "Find resin-temperature and wait-time settings that repeatedly produce a uniform, bubble-free layer on the target printer.",
    theory: "Resin flow and recovery affect levelling, but this stage qualifies the printer setting rather than characterising the material on a rheometer. Any external rheology belongs to material evidence and is not entered as run points here.",
    procedure: ["Identify and condition the resin batch and printer/vat setup.", "Run a planned temperature × wait-before-exposure matrix at the selected layer height.", "Record observed levelling time, layer uniformity and bubbles for every condition."],
    interpretation: ["Treat a condition as usable only when the layer is uniform and bubble-free.", "Confirm only the measured temperature/wait region; do not infer a universal viscosity limit."],
    handoff: "Pass the validated resin-temperature window, target temperature and minimum wait before exposure to the following exposure studies.",
    references: "Reviewed SLA/DLP qualification methodology"
  },
  2: {
    title: "Photocure working curve",
    goal: "Determine critical exposure Ec and penetration depth Dp from measured cured-depth data.",
    theory: "The Jacobs relation Cd = Dp ln(E/Ec) is fitted against calibrated exposure dose. Wavelength, irradiance method, resin temperature and fit quality are part of the result.",
    procedure: ["Set wavelength, resin temperature and the fixed optical condition once in Experiment setup.", "Choose either exposure time or measured irradiance as the varying parameter; each run records only that level and its measured cured depth.", "Review the run-derived graph and calculated Ec, Dp and R², then confirm the outputs."],
    interpretation: ["Reject a fit with non-positive Dp/Ec or fewer than three valid, non-excluded runs. Record a reviewed working-curve decision separately; R² alone cannot accept the curve.", "This is not a photo-rheology test: viscosity in the LVE region or activation time under irradiation requires a separate oscillatory photo-rheology study. Photo-DSC may support kinetics but does not replace measured cure depth."],
    handoff: "Pass reviewed Ec, Dp and fit quality as provenance for the layer-exposure window.",
    references: "Jacobs working curve; reviewed SLA/DLP qualification methodology"
  },
  3: {
    title: "Exposure & layer window",
    goal: "Measure a usable exposure region for each qualified layer height without undercure, bleed, blocked channels or delamination.",
    theory: "Exposure dose and layer height interact. The overcure ratio is a model diagnostic and cannot by itself prove layer adhesion.",
    procedure: ["Keep resin temperature and optical configuration fixed.", "Run the planned exposure × layer-height combinations and measure the printed features.", "Repeat candidate boundaries before confirming a validated range."],
    interpretation: ["Treat pass/fail as the intersection of all declared quality responses.", "Retain explored and validated ranges separately."],
    handoff: "Pass the layer-specific exposure range and nominal point to resolution work and DOE.",
    references: "Jacobs working curve; reviewed SLA/DLP qualification methodology"
  },
  4: {
    title: "Resolution & dimensional accuracy",
    goal: "Measure the fixed NIST artifact at the qualified optical/exposure condition and derive a repeatable starting point for dimensional correction.",
    theory: "Optical spread and cure shrinkage create a difference between the fixed NIST nominal and measured geometry. A long baseline is needed for global scale; small features describe resolution rather than global shrinkage.",
    procedure: ["Use the fixed NIST AM Test Artifact and one declared conditioning method.", "Measure the prescribed fine features, X/Y pins or holes, lateral elements and H-to-opposite-side baseline with the location-specific hint.", "Enter only measured size and reproduction status; do not enter nominal size or compensation into an element row."],
    interpretation: ["A feature not reproduced is evidence, not a numeric zero.", "The calculated XY boundary offset and scale correction are starting estimates; confirm them with one reprinted artifact before releasing a slicer profile."],
    handoff: "Pass the minimum reproduced feature plus the calculated, reprint-confirmed correction to the print profile and DOE.",
    references: "Reviewed SLA/DLP qualification methodology"
  },
  5: {
    title: "Green strength & peel force",
    goal: "Verify that lift and support conditions do not cause separation or green-part failure.",
    theory: "Average peel force divided by layer area is a comparison metric, not a local stress model. Green modulus must not be used as a failure-strength criterion.",
    procedure: ["Record the vat film, support geometry and fixed layer height.", "Select exposure levels inside the Step 3 working window, then measure peak peel force across the selected lift speeds and representative layer areas.", "Record green tensile strength and print/support failures separately."],
    interpretation: ["Reject observed separation regardless of the average-stress value.", "Do not transfer a lift result to a different vat film, support geometry, exposure or unsupported area range."],
    handoff: "Pass validated lift speed and its layer-area/exposure/support scope as a constraint; pass green strength as measured evidence.",
    references: "Reviewed SLA/DLP qualification methodology"
  },
  6: {
    title: "Wash, post-cure & conversion",
    goal: "Select wash and post-cure conditions that achieve the required conversion and properties without excess shrinkage or embrittlement.",
    theory: "FTIR conversion requires chemistry-appropriate reaction and reference bands. Tg, ΔTg from the declared baseline, residual enthalpy, shrinkage and strength provide independent supporting responses.",
    procedure: ["Record the fixed wash method, wash duration, post-cure source, baseline print condition, baseline Tg and baseline FTIR band areas.", "Generate the declared post-cure time × temperature × irradiance conditions.", "Use the same reviewed FTIR/DSC method across the series; qualify a changed wash procedure as a separate study rather than mixing it into this matrix."],
    interpretation: ["Do not compare conversion values calculated with different band definitions.", "Choose a measured plateau or requirement-compliant region rather than the longest cure by default."],
    handoff: "Pass the confirmed wash/post-cure programme, conversion and Tg to final qualification.",
    references: "FTIR/DSC methods applicable to the resin chemistry"
  },
  7: {
    title: "Final mechanical & thermal qualification",
    goal: "Confirm released part properties and their applicability across declared orientations and resin batches.",
    theory: "Final properties belong to the complete material, printer, exposure, wash, post-cure and conditioning chain.",
    procedure: ["Print specimens using the selected profile in every required orientation.", "Test tensile, flexural, HDT/Tg and dimensional responses required by the application.", "Repeat boundary or batch checks defined by the release specification."],
    interpretation: ["Report orientation effects and variation rather than collapsing unlike specimens into one mean.", "Release only properties supported by the linked runs and methods."],
    handoff: "Publish the versioned SLA/DLP print profile and material-property evidence with its application scope.",
    references: "ISO 527; ISO 178; ISO 75; reviewed SLA/DLP qualification methodology"
  },
  8: {
    title: "Additional resin-flow characterisation",
    goal: "Compare the flow of a declared resin batch or vat-temperature condition without turning it into a printer-setting qualification.",
    theory: "A steady-shear curve records viscosity against shear rate before exposure. It does not measure tan δ, gel point or cure kinetics, and it does not prove that the printer formed a uniform layer.",
    procedure: ["Use the same resin batch and conditioning state for every compared curve.", "Record a separate curve for each declared temperature; select and record one reference shear rate for like-for-like comparison.", "Import every curve directly and only report a flow index when the reviewed fit is valid for the measured range."],
    interpretation: ["Compare viscosity at the same temperature and shear rate; do not compare arbitrary points from different curves.", "Use the result to investigate batch, formulation or vat-heating changes. Confirm recoating time and layer uniformity only in Step 1 on the printer."],
    handoff: "Keep the curves and reviewed material assessment as provenance. They do not create a process window, DOE factor range or exposure setting.",
    references: "Steady-shear rheometry; material-specific test method"
  }
};

export function getQualificationStudyGuide(processTypeCode: string, stepNumber: number) {
  if (processTypeCode === "extrusion_v1") return extrusionGuides[stepNumber] ?? null;
  if (processTypeCode === "injection") return injectionGuides[stepNumber] ?? null;
  if (processTypeCode === "sla_dlp") return slaDlpGuides[stepNumber] ?? null;
  return null;
}
