import { SELECTION_DOMAIN } from '../state/store.js';

// ONE PLACE THAT TURNS A CLICKED ROAD INTO A SELECTION.
//
// The map reports two things about a click and nothing else: which corridor was clicked, and which collection it was drawn
// from. Only the application knows what that means, so each domain routes to the selection path that already owns it -
// discovery results through the discovery action, everything in the candidate list (the pilot's corridors among them)
// through the candidate action. The map never learns store internals, and no prefix of an id is ever consulted: a
// corridor's identity and its selection domain are separate facts.
//
// A click that cannot be honoured selects nothing and throws nothing: a corridor that has left its collection since the
// map drew it is a stale click, not a crash.
export function createCorridorSelection({ store, revealDiscoveryRow = () => false } = {}) {
  return function selectMapCorridor(selection = {}) {
    const { id, domain } = selection ?? {};
    if (!id) return false;
    try {
      if (domain === SELECTION_DOMAIN.DISCOVERY) {
        store.selectDiscovery(id);
        // The list is revealed rather than focused, so the map does not steal the keyboard from wherever a person was.
        revealDiscoveryRow(id);
        return true;
      }
      if (domain === SELECTION_DOMAIN.CANDIDATE) {
        store.select(id);
        return true;
      }
    } catch {
      // The store is the authority on what exists; a refusal here is an honest no-op.
      return false;
    }
    // No domain, or a domain this build does not know: not selectable, and never guessed.
    return false;
  };
}
