import { waymarkReader } from '../portability/reader';
import type { ImportReader, ImportSource } from './job';

/**
 * The readers this build has, by service (DESIGN.md §16, §22, §26.2). **A file made by Export is read** (15.2); **Swarm's is 8.2's**, added after it has been fixed against a real export: until then a Swarm upload is
 * refused before anything is stored, and an import that somehow names a service with no reader ends as failed with a sentence. A later importer is a reader added here and nothing else.
 */
export const READERS: Readonly<Partial<Record<ImportSource, ImportReader>>> = {
  // A file made by Export (DESIGN.md §22, 15.2).
  waymark: waymarkReader,
};
