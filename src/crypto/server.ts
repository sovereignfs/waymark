import { getConfig } from '../config/current';
import { Sealer } from './sealed';

/** The server's sealer, from the instance key it was started with (`WAYMARK_ENCRYPTION_KEY`, which is required): the one every table is written and read through. */
let sealer: Sealer | undefined;

export function serverSealer(): Sealer {
  sealer ??= new Sealer(getConfig().encryption);
  return sealer;
}
