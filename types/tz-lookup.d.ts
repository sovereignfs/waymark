// tz-lookup ships no types. It answers an IANA zone name for a latitude and longitude, and throws for a point that is not on the globe.
declare module 'tz-lookup' {
  export default function tzLookup(latitude: number, longitude: number): string;
}
