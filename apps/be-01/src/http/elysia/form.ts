/** A decoded form remains untrusted until the endpoint's strict body schema validates it. */
export type DecodedForm =
  | { ok: true; fields: Record<string, FormDataEntryValue | FormDataEntryValue[]> }
  | { ok: false };

type FormMedia = 'application/x-www-form-urlencoded' | 'multipart/form-data';

/**
 * Decodes buffered form bytes without coercion: repeated fields remain arrays and
 * files remain Files. Reading the request happens outside this parser's catch.
 * Bun reports malformed multipart syntax as TypeError with these parser messages;
 * unrelated TypeErrors still propagate rather than disguising an infrastructure fault.
 */
export async function decodeForm(
  bytes: ArrayBuffer,
  contentType: string,
  media: FormMedia,
): Promise<DecodedForm> {
  let entries: Iterable<[string, FormDataEntryValue]>;
  if (media === 'application/x-www-form-urlencoded') {
    entries = new URLSearchParams(new TextDecoder().decode(bytes));
  } else {
    try {
      entries = await new Response(bytes, { headers: { 'content-type': contentType } }).formData();
    } catch (cause) {
      // Proof: removing this modeled case made the mounted malformed multipart test return 500 instead of 400;
      // broadening to every TypeError hid the injected parser outage (400 instead of 500).
      if (
        cause instanceof TypeError &&
        (cause.message ===
          "Can't decode form data from body because of incorrect MIME type/boundary" ||
          cause.message.startsWith('FormData parse error '))
      )
        return { ok: false };
      throw cause;
    }
  }
  const fields = new Map<string, FormDataEntryValue | FormDataEntryValue[]>();
  for (const [name, value] of entries) {
    const previous = fields.get(name);
    // Proof: flattening duplicates or stringifying Files made the mounted form validation test return 200 instead of 400.
    fields.set(
      name,
      previous === undefined
        ? value
        : Array.isArray(previous)
          ? [...previous, value]
          : [previous, value],
    );
  }
  return { ok: true, fields: Object.fromEntries(fields) };
}
