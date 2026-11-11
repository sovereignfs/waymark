import { ImportRefusal, type ImportItem, type ImportPlace, type ImportReader } from '../import/job';
import { MAX_FILE_BYTES } from '../media/service';
import { type Export, JSON_NAME, SENTENCES, isPhotoFile, parseExport } from './format';
import { ZipError, openZip } from './zip';

/**
 * **The reader of a Waymark file** (DESIGN.md §22), for the import job (8.1): a file made by Export, made into new rows for whoever imports it. It is a reader like any other, so everything the job does is done
 * for it: a lease, steps with a cursor kept after each, a restart carries on, a cancel, the file deleted at the end, a notice. What is its own:
 *
 *  - **The whole file is checked before anything is written** (`open`): the ZIP is opened by its directory, `waymark.json` is read within a bound and parsed by `parseExport` (the format and version, then every place and
 *    check-in by the rules a device's change meets, and that the file hangs together), and every photo the file lists must be a file of the ZIP no larger than a photo may be. A file that is not a Waymark file, is from a
 *    newer version, or is damaged is refused with a sentence of ours (`ImportRefusal`) and nothing has been made.
 *  - **New rows for the importer, once.** The job gives a place, a check-in and a photo ids made from the importer's account and the file's own ids, so the ids here are not the ones in the file, a second import of the same file
 *    makes the same ids and so creates nothing, and a check-in the importer deleted since stays deleted. What the importer already has is left as it is, not overwritten.
 *  - **The importer's profile and settings are not touched:** a file brings places, check-ins and photos, and an account keeps the name and choices it has.
 *  - **A photo is read from the ZIP only when its check-in is going to be made**, one at a time (`load`), and the job stores it through the media store, which judges it by its bytes and re-encodes it.
 */
const MAX_JSON_BYTES = 256 * 1024 * 1024;

export const waymarkReader: ImportReader = {
  source: 'waymark',
  async open(file, context) {
    const plain = await file.materialize();
    const cleanup = () => plain.remove().catch(() => undefined);
    let zip: Awaited<ReturnType<typeof openZip>>;
    let document: Export;
    try {
      zip = await openZip(plain.path);
    } catch (error) {
      await cleanup();
      if (error instanceof ZipError) throw new ImportRefusal(SENTENCES.notWaymark);
      throw error;
    }
    try {
      let json: unknown;
      try {
        const bytes = await zip.read(JSON_NAME, MAX_JSON_BYTES);
        json = JSON.parse(bytes.toString('utf8'));
      } catch (error) {
        if (error instanceof ZipError) throw new ImportRefusal(SENTENCES.notWaymark);
        if (error instanceof SyntaxError) throw new ImportRefusal(SENTENCES.unreadable);
        throw error;
      }
      const parsed = parseExport(json, context.now());
      if (!parsed.ok) throw new ImportRefusal(parsed.sentence);
      document = parsed.value;
      // Every photo the file lists is a file of the ZIP, and no larger than a photo may be: checked now, with the rest, and not found out half way.
      const sizes = new Map(zip.entries.map((entry) => [entry.name, entry.size]));
      for (const photo of document.photos) {
        const size = sizes.get(photo.file);
        if (!isPhotoFile(photo.file) || size === undefined || size > MAX_FILE_BYTES)
          throw new ImportRefusal(SENTENCES.broken);
      }
    } catch (error) {
      await zip.close().catch(() => undefined);
      await cleanup();
      throw error;
    }

    const places = new Map(document.places.map((place) => [place.id, place]));
    const visited = new Set(document.checkins.map((checkin) => checkin.placeId));
    const unvisited = document.places.filter((place) => !visited.has(place.id));
    const placeOf = (place: Export['places'][number]): ImportPlace => ({
      key: place.id,
      ...(place.sourceId ? { sourceId: place.sourceId } : {}),
      name: place.name,
      lat: place.lat,
      lng: place.lng,
      ...(place.address ? { address: place.address } : {}),
      ...(place.category ? { category: place.category } : {}),
      source: place.source,
      ...(place.tz ? { tz: place.tz } : {}),
    });
    const photos = new Map(document.photos.map((photo) => [photo.id, photo]));
    const opened = zip;
    return {
      async checkins({ cursor, limit }) {
        const batch = document.checkins.slice(cursor, cursor + limit);
        const items: ImportItem[] = [];
        for (const checkin of batch) {
          const place = places.get(checkin.placeId);
          // `parseExport` has checked that every check-in is at a place of the file.
          if (!place) continue;
          items.push({
            externalId: checkin.id,
            ...(checkin.externalId ? { rowExternalId: checkin.externalId } : {}),
            at: checkin.at,
            tz: checkin.tz,
            offsetMin: checkin.offsetMin,
            ...(checkin.note ? { note: checkin.note } : {}),
            companions: checkin.companions,
            source: checkin.source,
            photos: (checkin.photos ?? []).flatMap((id) => {
              const listed = photos.get(id);
              // A photo the file names and does not hold never reached the server: it is not brought.
              return listed
                ? [{ key: id, load: () => opened.read(listed.file, MAX_FILE_BYTES) }]
                : [];
            }),
            place: placeOf(place),
          });
        }
        // After the check-ins, the places that have none, in steps of their own: the cursor counts both.
        const total = document.checkins.length + unvisited.length;
        const lone =
          batch.length < limit
            ? unvisited
                .slice(
                  Math.max(0, cursor - document.checkins.length),
                  Math.max(0, cursor - document.checkins.length) + (limit - batch.length),
                )
                .map(placeOf)
            : [];
        const next = cursor + batch.length + lone.length;
        return { items, places: lone, cursor: next, done: next >= total };
      },
      async close() {
        await opened.close().catch(() => undefined);
        await cleanup();
      },
    };
  },
};
