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
    theory: "The Damköhler number Da = k × t̄ compares reaction rate with time available in the extruder. Conversion and product MFR are measured responses; residence time from RTD is a constraint rather than a free estimate.",
    procedure: ["Choose RTD-validated operating points and set the reaction-zone temperature.", "Run long enough to confirm stable conversion and MFR for 15 minutes.", "Record conversion, product MFR and the rate constant used for the Da calculation."],
    interpretation: ["Use Da and conversion together: a high calculated Da does not override an unstable product response.", "Reject conditions outside the material thermal window or below the required residence time."],
    handoff: "Pass reaction temperature and reagent level as candidate DOE factors; keep minimum residence time as a constraint.",
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

export function getQualificationStudyGuide(processTypeCode: string, stepNumber: number) {
  return processTypeCode === "extrusion_v1" ? extrusionGuides[stepNumber] ?? null : null;
}
