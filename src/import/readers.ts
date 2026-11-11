import type { ImportReader, ImportSource } from './job';

/**
 * The readers this build has, by service (DESIGN.md §16, §26.2). **Empty until 8.2**, which adds Swarm's after it has been fixed against a real export: until then an upload is refused before anything is
 * stored, and an import that somehow names a service with no reader ends as failed with a sentence. A later importer is a reader added here and nothing else.
 */
export const READERS: Readonly<Partial<Record<ImportSource, ImportReader>>> = {};
