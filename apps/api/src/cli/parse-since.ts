const ISO_TIME =
  /^(\d{4}-\d{2}-\d{2})T\d{2}:\d{2}(?::\d{2}(?:\.\d{1,3})?)?(Z|([+-])(\d{2}):(\d{2}))$/;

/** `--since`: a full ISO time with a zone; refuses typos such as 2026-02-30, which Date rolls over. */
export function parseSince(value: string | undefined): Date | undefined {
  const match = value === undefined ? null : ISO_TIME.exec(value);
  if (!value || !match) return undefined;
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return undefined;
  const [, day, zone, sign, hours, minutes] = match;
  const offsetMinutes = zone === 'Z' ? 0 : Number(hours) * 60 + Number(minutes);
  const local = new Date(date.getTime() + (sign === '-' ? -1 : 1) * offsetMinutes * 60_000);
  return local.toISOString().slice(0, 10) === day ? date : undefined;
}
