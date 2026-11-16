// The date and the setup the model is told of (system prompt plan; design, "Notes to the model").

// The local date as YYYY-MM-DD (design, "The date"), for the prompt's date line and the date note.
export const localDate = (d = new Date()): string =>
  `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
