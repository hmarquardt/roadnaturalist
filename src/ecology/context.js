import { COVERAGE } from '../domain/corridor.js';

export function summarizeEcoregions(result) {
  const coverage = result?.coverage ?? COVERAGE.UNKNOWN;
  const level3 = result?.level3 ?? null;
  const level4 = result?.level4 ?? null;
  return {
    kind: 'ECOLOGICAL_CONTEXT',
    coverage,
    label: coverage === COVERAGE.NONE ? 'Outside published ecoregion scope' : level4?.primary?.name ?? level3?.primary?.name ?? 'Ecoregion unresolved',
    level3,
    level4,
    spansMultiple: Boolean(result?.spansMultiple),
    provenance: result?.provenance ?? null,
    diagnostics: result?.diagnostics ?? null,
    interpretation: 'EPA ecoregions describe broad ecological context, not a species occurrence.'
  };
}
