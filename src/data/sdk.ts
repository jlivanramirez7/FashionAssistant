// Firestore-SDK-bound helpers shared by the data modules.

import { Timestamp, deleteField } from "firebase/firestore";
import type { WriteHelpers } from "./convert";

export const writeHelpers: WriteHelpers = {
  toTimestamp: (ms: number) => Timestamp.fromMillis(ms),
  deleteField: () => deleteField(),
};
