import { verifyDerivedPromotion } from './promotion.js';

// READ THIS CORRIDOR'S OWN ROAD, VERIFY IT, AND WIDEN ONLY IF THE EXACT IDENTITY IS NOT THERE.
//
// The derived row names the source features its corridor was composed from, and reconstruction is verified against
// exactly that set. So the first read asks for those features by id: one road, not every road in the bounding box. The
// verification contract is unchanged - the same verifier, the same exact source-feature identity, the same segment
// check, the same metre of geometry drift - and it is what decides whether the narrow read was enough.
//
// THE WIDENED READ IS THE OLD READ, kept for one honest case: a corridor whose composed unit needs source rows the
// derived identity does not name. If the narrow read cannot be verified, the same read as before runs and is verified
// by the same rule, so a corridor that used to reconstruct still does and one that genuinely does not still fails
// closed with the verifier's own reason.
export async function readRoadSourceEvidence({ readNetwork, derived, sourceFeatureIds = null, segmentIndex = null,
  segmentCount = null, bbox = null, roadClasses = null, limit = undefined, debug = () => {} } = {}) {
  if (typeof readNetwork !== 'function') throw new TypeError('Reading a corridor road needs a network reader');
  const wanted = [...(sourceFeatureIds ?? derived?.sourceFeatureIds ?? [])].map(String).filter(id => id.length);
  const verify = features => verifyDerivedPromotion({ derived, features, sourceFeatureIds: wanted,
    segmentIndex, segmentCount });
  const read = async options => {
    const started = Date.now();
    const road = await readNetwork({ bbox, roadClasses, ...(limit === undefined ? {} : { limit }), ...options });
    if (road.coverage !== 'FULL' && road.coverage !== 'PARTIAL') throw new Error('the raw road network could not be read back');
    return { road, ms: Date.now() - started };
  };

  if (wanted.length) {
    const narrow = await read({ sourceFeatureIds: wanted });
    debug('narrow', { wanted: wanted.length, features: narrow.road.features?.length ?? null, ms: narrow.ms });
    try {
      return { road: narrow.road, verified: verify(narrow.road.features), narrowed: true, widened: false,
        narrowMs: narrow.ms, narrowFeatures: narrow.road.features?.length ?? null };
    } catch (error) {
      // The narrow read is not evidence about the corridor; it is evidence that this corridor needs more than its named
      // features, and the widest read the product has is what decides.
      debug('narrow-unverified', { wanted: wanted.length, features: narrow.road.features?.length ?? null,
        reason: String(error.message ?? error).slice(0, 240) });
    }
  }
  const broad = await read({});
  return { road: broad.road, verified: verify(broad.road.features), narrowed: false, widened: Boolean(wanted.length),
    narrowMs: wanted.length ? undefined : null, broadMs: broad.ms };
}
