import * as Linking from 'expo-linking';

import { encodeRoutinePayload, type SharedRoutine } from '../domain/sharing.ts';

/**
 * Links, built for the runtime that is actually running.
 *
 * `Linking.createURL` returns `shift://squad/A3F9K2` from a standalone build and
 * `exp://192.168.1.20:8081/--/squad/A3F9K2` from Expo Go. Hardcoding the
 * production scheme would mean a QR code that only works in the build you
 * cannot install without a paid Apple Developer account — which is exactly the
 * build you are not using while testing whether the QR code works.
 *
 * The receiving end does not care either way: `canonicalShiftUrl` throws the
 * scheme away before anything reads the payload.
 */

export function routineLink(routine: SharedRoutine): string {
  return Linking.createURL(`routine/${encodeRoutinePayload(routine)}`);
}

export function squadLink(joinCode: string): string {
  return Linking.createURL(`squad/${joinCode}`);
}
