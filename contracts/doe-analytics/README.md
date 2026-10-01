# DOE analytics contract

Version 1.0 is shared by Planner and the internal R service. The TypeScript
types live in `src/modules/doe_analysis/analytics_contract.ts`; these schemas
describe the serialized service boundary.

Contract changes are additive within version 1.0. A breaking field or semantic
change requires a new contract version and a separate endpoint or negotiated
upgrade.
