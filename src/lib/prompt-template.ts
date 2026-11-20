// ---------------------------------------------------------------------------
// The one way a prompt template is filled (DISTRY-PROMPT-PARTS-1120).
//
// A template names its data as `{{name}}`. Filling is ONE pass over the
// template: a value that itself contains `{{...}}` (a skill quoting a
// writer's `{{founderName}}`) is inserted verbatim, never re-read.
// ---------------------------------------------------------------------------

const PLACEHOLDER = /\{\{([A-Za-z][A-Za-z0-9]*)\}\}/g;

/** The placeholder names a template uses, in order of first use. */
export function placeholdersIn(template: string): string[] {
  const seen: string[] = [];
  for (const m of template.matchAll(PLACEHOLDER)) if (!seen.includes(m[1]!)) seen.push(m[1]!);
  return seen;
}

/** Fill `{{name}}` from `values`; a name the template uses with no value THROWS (never an empty guess). */
export function fillTemplate(template: string, values: Record<string, string>): string {
  return template.replace(PLACEHOLDER, (whole, name: string) => {
    if (!Object.prototype.hasOwnProperty.call(values, name)) {
      throw new Error(`Prompt template uses {{${name}}} but no value was given for it (known: ${Object.keys(values).join(", ") || "none"}).`);
    }
    return values[name]!;
  });
}
