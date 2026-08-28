import { create } from 'zustand';

import { codeFromUrl } from '../domain/joinCode.ts';
import { decodeRoutineLink, type SharedRoutine } from '../domain/sharing.ts';

/**
 * Whatever arrived from outside the app and has not been dealt with yet.
 *
 * A deep link is handled in two halves: the router notices the URL, and a
 * screen decides what to do about it. Passing a decoded routine through a
 * navigation parameter would mean re-encoding it into a string, and a scanned
 * QR could then reach the workout screen without any screen having shown the
 * user what they were about to accept. A store keeps the payload in one place
 * and leaves the decision where it belongs — on a screen, in front of a person.
 *
 * Nothing here acts on its own. `offer*` records that something is waiting;
 * only a tap consumes it.
 */

interface InboundState {
  /** A routine opened from a link, awaiting a look and a decision. */
  routine: SharedRoutine | null;
  /** A squad code from a scanned QR or a tapped link. */
  squadCode: string | null;

  /** Decode a URL. Returns where it should be shown, or null if it is not ours. */
  offerUrl: (url: string) => '/routines' | '/squad' | null;
  clearRoutine: () => void;
  clearSquadCode: () => void;
}

export const useInbound = create<InboundState>((set) => ({
  routine: null,
  squadCode: null,

  offerUrl: (url) => {
    const routine = decodeRoutineLink(url);
    if (routine) {
      set({ routine });
      return '/routines';
    }

    const code = codeFromUrl(url);
    if (code) {
      set({ squadCode: code });
      return '/squad';
    }

    // Anything else — a marketing link, a malformed paste, a scheme we do not
    // own. Silently ignored: an error toast for a link the user did not
    // knowingly open is noise.
    return null;
  },

  clearRoutine: () => set({ routine: null }),
  clearSquadCode: () => set({ squadCode: null }),
}));
