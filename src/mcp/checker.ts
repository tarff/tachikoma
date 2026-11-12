import type { JsonSchemaType, JsonSchemaValidator, jsonSchemaValidator } from "@modelcontextprotocol/client";
import { AjvJsonSchemaValidator } from "@modelcontextprotocol/client/validators/ajv";

// The library's own JSON Schema checker, without its console warnings (Task 5's code review). For a format it does not
// know, such as Pydantic's "path", ajv warns on the console with the format and its place in the schema, a server's own
// text, which Ink would print raw above the window and -p to stderr. The compile is synchronous and ajv looks console.warn
// up when it warns, so it is swapped for nothing only while a compile runs, and put back however the compile ends. Used
// for Tachikoma's own checks of input schemas (servers.ts) and as the Client's checker of output schemas (server.ts).
export class Checker implements jsonSchemaValidator {
  readonly #ajv = new AjvJsonSchemaValidator();

  getValidator<T>(schema: JsonSchemaType): JsonSchemaValidator<T> {
    const warn = console.warn;
    console.warn = () => {};
    try {
      return this.#ajv.getValidator<T>(schema);
    } finally {
      console.warn = warn;
    }
  }
}
