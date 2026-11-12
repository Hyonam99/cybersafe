// Error shown to the user as a form message.
export class AppError extends Error {
  constructor(message, field) { super(message); this.field = field; }
}
export const need = (cond, message, field) => { if (!cond) throw new AppError(message, field); };
